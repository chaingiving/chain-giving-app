import { createSmartAccountClient } from "permissionless";
import { toKernelSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import {
  type Account,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
  createPublicClient,
  http,
  numberToHex,
  toHex,
  zeroAddress,
} from "viem";
import { entryPoint07Address } from "viem/account-abstraction";

/**
 * Smart-account client factory for the Kernel-via-Pimlico sponsorship path.
 *
 * The connected EOA (or AppKit social/email signer) becomes the ECDSA owner of a
 * counterfactual Kernel v3.1 account. The same EOA + index always derives the
 * same Kernel address, so donations made through this account remain recoverable
 * by reconnecting with the same EOA on any device.
 *
 * UserOps go to our bundler proxy at /api/bundler/{chainId}, which forwards to
 * Pimlico with a server-side API key. Paymaster RPCs go to /api/paymaster which
 * returns CGPaymaster v0.7 sponsorship blobs.
 *
 * This path is only viable for wallets that expose an EOA signer. Wallets that
 * are themselves smart accounts (Coinbase Smart Wallet, MetaMask Smart Account,
 * Safe) must use the EIP-5792 path instead — see useSponsoredWrite.
 */

const ENTRY_POINT = {
  address: entryPoint07Address as Address,
  version: "0.7" as const,
};

const KERNEL_VERSION = "0.3.1" as const;

type GetKernelClientArgs = {
  walletClient: WalletClient;
  publicClient: PublicClient;
  chain: Chain;
  orgAddress: Address;
};

/** Build a raw publicClient bound to the chain's HTTP RPC, bypassing wagmi's
 *  adapter wrapping. Reown's embedded wallet routes some wagmi-provided RPC
 *  calls through the W3mFrame, which allowlists a narrow set of methods and
 *  rejects creation-style `eth_call` ({data, no to}) — the exact shape
 *  Pimlico's getSenderAddress uses to derive a Kernel's counterfactual
 *  address. We need a wallet-free path for those reads. */
function chainPublicClient(chain: Chain) {
  const url = chain.rpcUrls?.default?.http?.[0];
  return createPublicClient({ chain, transport: url ? http(url) : http() });
}

export async function getKernelClient({ walletClient, chain, orgAddress }: GetKernelClientArgs) {
  const owner = assertWalletWithAccount(walletClient);
  const rawClient = chainPublicClient(chain);

  const account = await toKernelSmartAccount({
    client: rawClient,
    entryPoint: ENTRY_POINT,
    owners: [owner],
    version: KERNEL_VERSION,
    index: 0n,
    // Skip Kernel's MetaFactory wrapper and call KernelFactory directly. On
    // Arc Testnet the MetaFactory at 0xd703… is deployed but the inner
    // KernelFactory isn't whitelisted there (the deployment was missing the
    // post-deploy approveFactory step), so going through MetaFactory reverts
    // with NotApproved (0xc88357cc) → AA13. KernelFactory is permissionless.
    useMetaFactory: false,
  });

  const bundlerUrl = `/api/bundler/${chain.id}`;
  const bundlerTransport = http(bundlerUrl);

  const pimlico = createPimlicoClient({
    chain,
    transport: bundlerTransport,
    entryPoint: ENTRY_POINT,
  });

  return createSmartAccountClient({
    account,
    chain,
    bundlerTransport,
    paymaster: {
      getPaymasterData: userOp =>
        callPaymaster("pm_getPaymasterData", userOp, chain.id, orgAddress) as Promise<{
          paymaster: Address;
          paymasterData: `0x${string}`;
          paymasterVerificationGasLimit: bigint;
          paymasterPostOpGasLimit: bigint;
        }>,
      getPaymasterStubData: userOp =>
        callPaymaster("pm_getPaymasterStubData", userOp, chain.id, orgAddress) as Promise<{
          paymaster: Address;
          paymasterData: `0x${string}`;
          paymasterVerificationGasLimit: bigint;
          paymasterPostOpGasLimit: bigint;
        }>,
    },
    userOperation: {
      estimateFeesPerGas: async () => {
        const { fast } = await pimlico.getUserOperationGasPrice();
        return fast;
      },
    },
  });
}

/** JSON.stringify replacer that hex-encodes BigInts at any depth.
 *  Needed because the UserOperation passed to getPaymasterStubData can carry
 *  nested BigInts that a shallow walk misses. ERC-7677 expects hex-string numerics. */
const bigIntReplacer = (_key: string, value: unknown) => (typeof value === "bigint" ? numberToHex(value) : value);

async function callPaymaster(
  method: "pm_getPaymasterData" | "pm_getPaymasterStubData",
  userOp: any,
  chainId: number,
  orgAddress: Address,
) {
  const res = await fetch("/api/paymaster", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      {
        jsonrpc: "2.0",
        id: 1,
        method,
        params: [userOp, entryPoint07Address, toHex(chainId), { orgAddress }],
      },
      bigIntReplacer,
    ),
  });
  const json = await res.json();
  if (json.error) {
    throw new Error(`Paymaster RPC ${method}: ${json.error.message ?? "unknown error"}`);
  }
  const r = json.result;
  // viem's account-abstraction PaymasterActions expect bigint hex strings parsed.
  return {
    paymaster: r.paymaster as Address,
    paymasterData: r.paymasterData as `0x${string}`,
    paymasterVerificationGasLimit: BigInt(r.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: BigInt(r.paymasterPostOpGasLimit),
  };
}

/** Returns the counterfactual Kernel address for an EOA without instantiating
 *  the full client — useful for showing the address in the UI before any
 *  sponsored UserOp has been sent.
 *
 *  The passed `publicClient` is ignored in favour of a freshly built
 *  chain-bound HTTP client — see chainPublicClient(). Reown's embedded wallet
 *  rejects Pimlico's creation-style `eth_call`, so we must avoid any client
 *  whose transport routes through the wallet provider. */
export async function deriveKernelAddress(publicClient: PublicClient, walletClient: WalletClient): Promise<Address> {
  if (!walletClient.account) return zeroAddress;
  const chain = publicClient.chain;
  if (!chain) return zeroAddress;
  const owner = assertWalletWithAccount(walletClient);
  const account = await toKernelSmartAccount({
    client: chainPublicClient(chain),
    entryPoint: ENTRY_POINT,
    owners: [owner],
    version: KERNEL_VERSION,
    index: 0n,
    useMetaFactory: false,
  });
  return account.address;
}

/** Narrow a wagmi/AppKit-provided WalletClient to one with a guaranteed Account.
 *  permissionless's toKernelSmartAccount requires WalletClient<Transport, Chain|undefined, Account>
 *  (no `| undefined` on account), so we cast after the runtime check. */
function assertWalletWithAccount(walletClient: WalletClient): WalletClient<Transport, Chain | undefined, Account> {
  if (!walletClient.account) throw new Error("Wallet client has no account");
  return walletClient as WalletClient<Transport, Chain | undefined, Account>;
}
