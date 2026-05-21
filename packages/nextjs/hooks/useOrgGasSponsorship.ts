import { Address, formatEther } from "viem";
import { useAccount, useCapabilities, useReadContract } from "wagmi";
import { useDeployedContractInfo, useTargetNetwork } from "~~/hooks/scaffold-eth";
import { useSponsoredGasPreference } from "~~/hooks/useSponsoredGasPreference";

/**
 * Reads gas sponsorship state for an organization from CGPaymaster,
 * and detects whether the connected wallet supports EIP-5792 paymasterService.
 */
export function useOrgGasSponsorship(orgAddress: Address | undefined) {
  const { address: connectedAddress, chainId } = useAccount();
  const { targetNetwork } = useTargetNetwork();
  const { data: paymasterInfo } = useDeployedContractInfo({ contractName: "CGPaymaster" });
  const { enabled: userOptedIn } = useSponsoredGasPreference();

  // Read org balance from CGPaymaster
  const { data: orgBalance, isLoading: balanceLoading } = useReadContract({
    address: paymasterInfo?.address,
    abi: paymasterInfo?.abi,
    functionName: "orgBalance",
    args: orgAddress ? [orgAddress] : undefined,
    query: {
      enabled: !!paymasterInfo?.address && !!orgAddress,
      refetchInterval: 10000,
    },
  });

  // Read org manager
  const { data: orgManager } = useReadContract({
    address: paymasterInfo?.address,
    abi: paymasterInfo?.abi,
    functionName: "managerOf",
    args: orgAddress ? [orgAddress] : undefined,
    query: {
      enabled: !!paymasterInfo?.address && !!orgAddress,
      refetchInterval: 30000,
    },
  });

  // Detect wallet EIP-5792 capabilities
  const { data: walletCapabilities, isSuccess: isEIP5792Wallet } = useCapabilities({
    account: connectedAddress,
  });

  const currentChainId = chainId ?? targetNetwork.id;
  const chainCapabilities = walletCapabilities?.[currentChainId];
  const isPaymasterSupported = !!chainCapabilities?.paymasterService?.supported;

  const balance = orgBalance as bigint | undefined;
  const hasBudget = balance !== undefined && balance > 0n;
  // EIP-5792 wallets reject http:// paymasterService URLs. The Kernel path uses
  // our own same-origin /api/paymaster fetch so it doesn't depend on this gate.
  const isHttps = typeof window !== "undefined" && window.location.protocol === "https:";

  // Sponsorship resolution order:
  //   "eip5792" — wallet is itself a smart account that handles the paymasterService
  //               capability (Coinbase Smart Wallet, MetaMask Smart Account, Safe).
  //   "kernel"  — wallet is EOA-backed (social, email, MetaMask EOA, WC EOAs);
  //               we wrap it in a counterfactual Kernel v3.1 account.
  //   "none"    — no budget, user opted out, or the page isn't HTTPS (5792 case).
  const eip5792Available =
    !!paymasterInfo?.address && hasBudget && userOptedIn && isHttps && isEIP5792Wallet && isPaymasterSupported;
  // Kernel covers the residual case: EOA-backed wallet, org has budget.
  const kernelAvailable =
    !!paymasterInfo?.address && hasBudget && userOptedIn && !(isEIP5792Wallet && isPaymasterSupported);

  const sponsorshipMode: "eip5792" | "kernel" | "none" = eip5792Available
    ? "eip5792"
    : kernelAvailable
      ? "kernel"
      : "none";
  const isSponsorshipAvailable = sponsorshipMode !== "none";

  return {
    /** CGPaymaster contract address */
    paymasterAddress: paymasterInfo?.address,
    /** Org's remaining gas budget in wei */
    orgBalance: balance,
    /** Formatted gas budget for display */
    orgBalanceFormatted: balance !== undefined ? formatEther(balance) : undefined,
    /** Whether the org has a positive gas budget */
    hasBudget,
    /** Current org manager address */
    orgManager: orgManager as Address | undefined,
    /** Whether the connected wallet handled the EIP-5792 wallet_getCapabilities RPC */
    isEIP5792Wallet,
    /** Whether the wallet advertises paymasterService support on this chain */
    isPaymasterSupported,
    /** Which sponsorship code path will execute for this user on this org */
    sponsorshipMode,
    /** Whether gas sponsorship is fully available via either path */
    isSponsorshipAvailable,
    /** Loading state */
    isLoading: balanceLoading,
  };
}
