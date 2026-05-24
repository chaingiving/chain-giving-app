import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  encodeAbiParameters,
  keccak256,
  parseSignature,
  stringToHex,
} from "viem";

const EIP712_DOMAIN_ABI = [
  {
    type: "function",
    name: "eip712Domain",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "fields", type: "bytes1" },
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "extensions", type: "uint256[]" },
    ],
  },
] as const;

const NAME_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
] as const;

const DOMAIN_SEP_ABI = [
  {
    type: "function",
    name: "DOMAIN_SEPARATOR",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

const NONCES_ABI = [
  {
    type: "function",
    name: "nonces",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const DOMAIN_TYPEHASH = keccak256(
  stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);

/**
 * Resolve a token's EIP-712 domain (name + version) for permit signing.
 *
 * Preferred path: EIP-5267 `eip712Domain()` — Circle FiatToken v2.2+ and any
 * OZ v5 ERC20Permit support it directly.
 *
 * Fallback: read `name()` and `DOMAIN_SEPARATOR()`, then probe common versions
 * ("1" is OZ's default, "2" is Circle FiatToken v2.x) and pick whichever
 * reproduces the on-chain separator. Lets us survive tokens whose bytecode
 * predates EIP-5267 while still computing the correct signing domain.
 */
async function resolveDomain(
  publicClient: PublicClient,
  token: Address,
  chainId: number,
): Promise<{ name: string; version: string }> {
  try {
    const [, name, version] = await publicClient.readContract({
      address: token,
      abi: EIP712_DOMAIN_ABI,
      functionName: "eip712Domain",
    });
    return { name, version };
  } catch {
    // Fall through to DOMAIN_SEPARATOR matching.
  }

  const [name, onChainSeparator] = await Promise.all([
    publicClient.readContract({ address: token, abi: NAME_ABI, functionName: "name" }),
    publicClient.readContract({ address: token, abi: DOMAIN_SEP_ABI, functionName: "DOMAIN_SEPARATOR" }),
  ]);

  for (const candidate of ["1", "2"]) {
    const computed = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [DOMAIN_TYPEHASH, keccak256(stringToHex(name)), keccak256(stringToHex(candidate)), BigInt(chainId), token],
      ),
    );
    if (computed.toLowerCase() === onChainSeparator.toLowerCase()) {
      return { name, version: candidate };
    }
  }

  throw new Error("Could not resolve EIP-712 domain: DOMAIN_SEPARATOR did not match common version candidates");
}

/**
 * Build and sign an EIP-2612 permit for an ERC-20 token, returning the split (v, r, s)
 * that `donateWithPermit(amount, deadline, v, r, s)` expects.
 *
 * Note: the recovered owner of the resulting signature must match `owner` for the
 * on-chain permit to verify. This works for EOA owners only — smart-account
 * wallets cannot produce ECDSA signatures recoverable to a contract address.
 */
export async function signErc2612Permit(params: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  token: Address;
  owner: Address;
  spender: Address;
  value: bigint;
  deadline: bigint;
}): Promise<{ v: number; r: Hex; s: Hex }> {
  const { publicClient, walletClient, token, owner, spender, value, deadline } = params;

  const chainId = publicClient.chain?.id ?? (await publicClient.getChainId());
  const { name, version } = await resolveDomain(publicClient, token, chainId);

  const nonce = await publicClient.readContract({
    address: token,
    abi: NONCES_ABI,
    functionName: "nonces",
    args: [owner],
  });

  const signature = await walletClient.signTypedData({
    account: owner,
    domain: { name, version, chainId, verifyingContract: token },
    types: PERMIT_TYPES,
    primaryType: "Permit",
    message: { owner, spender, value, nonce, deadline },
  });

  const parsed = parseSignature(signature);
  const v = parsed.v !== undefined ? Number(parsed.v) : 27 + parsed.yParity;
  return { v, r: parsed.r, s: parsed.s };
}
