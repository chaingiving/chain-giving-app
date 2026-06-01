import { Address } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { cgTokenAbi } from "~~/contracts/cgTokenAbi";
import { useSponsoredWrite } from "~~/hooks/useSponsoredWrite";
import { deriveKernelAddress } from "~~/services/web3/smartAccount";

// EIP-712 typed-data shape mirroring CGToken.APPROVAL_FOR_ALL_TYPEHASH. The
// off-chain signature lets a sponsored smart account grant itself operator
// status on the user's behalf without the user paying gas to bootstrap.
const APPROVAL_TYPES = {
  ApprovalForAll: [
    { name: "owner", type: "address" },
    { name: "operator", type: "address" },
    { name: "approved", type: "bool" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

// Functions whose sponsored execution requires the smart account to be an
// approved operator on the token holder. If not yet approved, we prepend a
// setApprovalForAllWithSignature call inside the same UserOp.
const NEEDS_OPERATOR = new Set(["safeTransferFrom", "safeBatchTransferFrom", "burn", "burnBatch"]);

export function useCGTokenWrite(tokenAddress: Address, orgAddress?: Address) {
  const { write: sponsoredWrite, writeBatch, sponsorshipMode } = useSponsoredWrite(orgAddress);
  const { address: connectedAddress, chainId } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  return async (functionName: string, args: readonly unknown[]) => {
    // For functions that don't need operator status, or when sponsorship isn't
    // engaged (msg.sender == owner directly), fall through to the simple path.
    if (
      !NEEDS_OPERATOR.has(functionName) ||
      sponsorshipMode === "none" ||
      !connectedAddress ||
      !walletClient ||
      !publicClient
    ) {
      return sponsoredWrite({ address: tokenAddress, abi: cgTokenAbi, functionName, args });
    }

    // Resolve the actual msg.sender for this sponsorship path *now*, not from a
    // possibly-stale React state. For EIP-5792 wallets it's the connected smart
    // account; for the Kernel path it's the deterministically-derived Kernel
    // address. Using useEffectiveAddress here would race with its useEffect.
    const operatorAddress =
      sponsorshipMode === "eip5792" ? connectedAddress : await deriveKernelAddress(publicClient, walletClient);

    // safeTransferFrom / burn / etc. all have `from` as their first argument.
    const owner = args[0] as Address;

    // If msg.sender (smart account) will equal the owner, no operator gate
    // applies. Sponsored single-call is enough.
    if (owner.toLowerCase() === operatorAddress.toLowerCase()) {
      return sponsoredWrite({ address: tokenAddress, abi: cgTokenAbi, functionName, args });
    }

    const isApproved = (await publicClient.readContract({
      address: tokenAddress,
      abi: cgTokenAbi,
      functionName: "isApprovedForAll",
      args: [owner, operatorAddress],
    })) as boolean;

    if (isApproved) {
      return sponsoredWrite({ address: tokenAddress, abi: cgTokenAbi, functionName, args });
    }

    // First sponsored op against this token from this owner — sign an off-chain
    // approval and batch it with the actual call in one UserOp. Paymaster
    // sponsors both (selectors are on the allowlist).
    const nonce = (await publicClient.readContract({
      address: tokenAddress,
      abi: cgTokenAbi,
      functionName: "nonces",
      args: [owner],
    })) as bigint;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60);

    const signature = await walletClient.signTypedData({
      account: owner,
      domain: {
        name: "CGToken",
        version: "1",
        chainId: chainId ?? publicClient.chain?.id,
        verifyingContract: tokenAddress,
      },
      types: APPROVAL_TYPES,
      primaryType: "ApprovalForAll",
      message: {
        owner,
        operator: operatorAddress,
        approved: true,
        nonce,
        deadline,
      },
    });

    // CGToken accepts both ECDSA (EOAs) and ERC-1271 (smart wallets) via
    // SignatureChecker, so the raw signature hex passes through unchanged.
    return writeBatch([
      {
        address: tokenAddress,
        abi: cgTokenAbi,
        functionName: "setApprovalForAllWithSignature",
        args: [owner, operatorAddress, true, deadline, signature],
      },
      {
        address: tokenAddress,
        abi: cgTokenAbi,
        functionName,
        args,
      },
    ]);
  };
}
