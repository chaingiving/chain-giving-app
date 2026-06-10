import { useMemo } from "react";
import { useParams } from "next/navigation";
import scaffoldConfig from "~~/scaffold.config";
import { ChainWithAttributes, NETWORKS_EXTRA_DATA, chainForSlug } from "~~/utils/scaffold-eth";

/**
 * The active network is encoded in the URL as the first path segment
 * (`/baseSepolia/...`, `/arcTestnet/...`, ...). This hook reads it from
 * `useParams()`.
 *
 * If the URL doesn't have a network segment (e.g. on `/api/*` or the root
 * redirect mid-flight) we fall back to the first configured target network.
 *
 * A useful read-only mirror of "which chain is the user looking at right now",
 * separate from `useAccount().chain` which is "which chain the wallet is on".
 * Those can diverge: the wallet might still be on Base Sepolia while the user
 * navigated to /arcTestnet/programs, and we'll render Arc Testnet data
 * regardless.
 */
export function useTargetNetwork(): { targetNetwork: ChainWithAttributes } {
  const params = useParams();
  const slug = typeof params?.network === "string" ? params.network : undefined;

  return useMemo(() => {
    const resolved = chainForSlug(slug);
    if (resolved) return { targetNetwork: resolved };
    const fallback = scaffoldConfig.targetNetworks[0];
    return { targetNetwork: { ...fallback, ...NETWORKS_EXTRA_DATA[fallback.id] } };
  }, [slug]);
}
