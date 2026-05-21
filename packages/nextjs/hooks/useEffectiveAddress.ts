import { useEffect, useState } from "react";
import type { Address } from "viem";
import { useAccount, useCapabilities, usePublicClient, useWalletClient } from "wagmi";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";
import { deriveKernelAddress } from "~~/services/web3/smartAccount";

/**
 * The address that represents the user on-chain across the app.
 *
 * - When the wallet is itself a smart account (EIP-5792 capable), the connected
 *   address IS the on-chain identity — return it unchanged.
 * - When the wallet is EOA-backed, donations go through a counterfactual Kernel
 *   account. Return the derived Kernel address so that "/wallet/[me]", donor
 *   recognition, and contribution lookups all see the same identity.
 *
 * `mode` reflects which path was used to compute the address so callers can
 * adjust copy ("Your smart account" vs "Your wallet").
 */
export function useEffectiveAddress(): {
  address: Address | undefined;
  mode: "connected" | "kernel" | "unknown";
  isResolving: boolean;
} {
  const { address: connectedAddress } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { targetNetwork } = useTargetNetwork();
  const publicClient = usePublicClient({ chainId: targetNetwork.id });
  const { data: walletCapabilities, isSuccess: isEIP5792Wallet } = useCapabilities({
    account: connectedAddress,
  });

  const [kernelAddress, setKernelAddress] = useState<Address>();
  const [isResolving, setIsResolving] = useState(false);

  const isSmartAccountWallet = isEIP5792Wallet && !!walletCapabilities;

  useEffect(() => {
    if (isSmartAccountWallet) return;
    if (!walletClient || !publicClient || !connectedAddress) {
      setKernelAddress(undefined);
      return;
    }

    let cancelled = false;
    setIsResolving(true);
    deriveKernelAddress(publicClient, walletClient)
      .then(addr => {
        if (!cancelled) setKernelAddress(addr);
      })
      .catch(() => {
        if (!cancelled) setKernelAddress(undefined);
      })
      .finally(() => {
        if (!cancelled) setIsResolving(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isSmartAccountWallet, walletClient, publicClient, connectedAddress]);

  if (!connectedAddress) {
    return { address: undefined, mode: "unknown", isResolving: false };
  }

  if (isSmartAccountWallet) {
    return { address: connectedAddress, mode: "connected", isResolving: false };
  }

  return {
    address: kernelAddress ?? connectedAddress,
    mode: kernelAddress ? "kernel" : "unknown",
    isResolving,
  };
}
