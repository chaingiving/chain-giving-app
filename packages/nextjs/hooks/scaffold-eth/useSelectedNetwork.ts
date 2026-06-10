import { useTargetNetwork } from "./useTargetNetwork";
import scaffoldConfig from "~~/scaffold.config";
import { AllowedChainIds } from "~~/utils/scaffold-eth";
import { ChainWithAttributes, NETWORKS_EXTRA_DATA } from "~~/utils/scaffold-eth/networks";

/**
 * Given a chainId, retrieves the network object from `scaffold.config`,
 * if not found defaults to the network selected by `useTargetNetwork`
 * (i.e. the `[network]` URL segment).
 */
export function useSelectedNetwork(chainId?: AllowedChainIds): ChainWithAttributes {
  const { targetNetwork } = useTargetNetwork();
  const explicit = scaffoldConfig.targetNetworks.find(n => n.id === chainId);

  if (explicit) {
    return { ...explicit, ...NETWORKS_EXTRA_DATA[explicit.id] };
  }

  return targetNetwork;
}
