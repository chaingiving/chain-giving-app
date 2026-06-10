import { useReadContract as useWagmiReadContract, useReadContracts as useWagmiReadContracts } from "wagmi";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";

/**
 * Reads pinned to the URL-selected network (the `[network]` path segment) rather
 * than the wallet's connected chain.
 *
 * The active network is canonical per `useTargetNetwork`, so data must follow the
 * URL: switching chains (e.g. baseSepolia → arcTestnet) re-targets every read
 * immediately, even before — or without — the wallet switching. Wagmi's bare
 * `useReadContract` defaults `chainId` to the wallet's chain, which makes the page
 * render the wrong network's data whenever the wallet lags or can't switch.
 *
 * Drop-in replacements for wagmi's hooks: swap the import and call sites are
 * unchanged. A caller that passes an explicit `chainId` still wins (it spreads
 * after the default).
 */
export const useReadContract: typeof useWagmiReadContract = ((config?: any) => {
  const { targetNetwork } = useTargetNetwork();
  return useWagmiReadContract({ chainId: targetNetwork.id, ...config });
}) as typeof useWagmiReadContract;

export const useReadContracts: typeof useWagmiReadContracts = ((config?: any) => {
  const { targetNetwork } = useTargetNetwork();
  const contracts = config?.contracts?.map((c: any) => ({ chainId: targetNetwork.id, ...c }));
  return useWagmiReadContracts({ ...config, contracts });
}) as typeof useWagmiReadContracts;
