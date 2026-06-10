"use client";

import { useEffect, useRef } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";

/**
 * Mirrors the URL's `[network]` segment onto the connected wallet.
 *
 * The URL is the canonical source of truth for the active network; this
 * component prompts the wallet to switch chain whenever the URL and the
 * wallet diverge — covering both the "click network in dropdown" path and
 * direct URL navigation (deep links, refreshes).
 *
 * We track the last id we attempted so a user-rejected `switchChain` doesn't
 * cause a re-prompt loop while they're still on the same URL.
 */
export const ChainSync = () => {
  const { targetNetwork } = useTargetNetwork();
  const { chain, isConnected } = useAccount();
  const { switchChain } = useSwitchChain();
  const lastAttemptedId = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!isConnected || !chain) return;
    if (chain.id === targetNetwork.id) return;
    if (lastAttemptedId.current === targetNetwork.id) return;
    lastAttemptedId.current = targetNetwork.id;
    switchChain({ chainId: targetNetwork.id });
  }, [isConnected, chain, targetNetwork.id, switchChain]);

  return null;
};
