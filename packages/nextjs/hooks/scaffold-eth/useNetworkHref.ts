import { useCallback } from "react";
import { useParams } from "next/navigation";
import scaffoldConfig from "~~/scaffold.config";
import { slugForChain } from "~~/utils/scaffold-eth";

/**
 * Returns a stable function that prefixes any in-app path with the current
 * network slug — `useNetworkHref()(path)` is what every internal Link / push
 * should use to stay on the same chain across navigation.
 *
 * Falls back to the first configured target network's slug when the URL
 * doesn't have a `[network]` segment (e.g. during the root redirect).
 */
export function useNetworkHref() {
  const params = useParams();
  const slug =
    typeof params?.network === "string" && params.network !== ""
      ? params.network
      : slugForChain(scaffoldConfig.targetNetworks[0]);

  return useCallback(
    (path: string) => {
      const normalized = path.startsWith("/") ? path : `/${path}`;
      return `/${slug}${normalized === "/" ? "" : normalized}`;
    },
    [slug],
  );
}
