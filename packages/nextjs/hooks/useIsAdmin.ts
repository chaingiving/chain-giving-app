import { Address, isAddressEqual } from "viem";
import { useAccount } from "wagmi";
import { cgOrganizationAbi } from "~~/contracts/cgOrganizationAbi";
import { useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { useReadContracts } from "~~/hooks/scaffold-eth/useNetworkRead";

/**
 * `true` when the connected wallet is the CGRegistry owner OR the owner of
 * any registered CGOrganization. Used to gate admin-only UI surfaces.
 */
export function useIsAdmin(): boolean {
  const { address: connectedAddress } = useAccount();

  const { data: registryOwner } = useScaffoldReadContract({
    contractName: "CGRegistry",
    functionName: "owner",
  });

  const { data: orgCount } = useScaffoldReadContract({
    contractName: "CGRegistry",
    functionName: "organizationCount",
  });

  const { data: orgAddresses } = useScaffoldReadContract({
    contractName: "CGRegistry",
    functionName: "getOrganizations",
    args: [0n, orgCount ?? 0n],
    query: { enabled: orgCount !== undefined && orgCount > 0n },
  });

  const ownerCalls = (orgAddresses ?? []).map((orgAddr: string) => ({
    address: orgAddr as Address,
    abi: cgOrganizationAbi,
    functionName: "owner" as const,
  }));

  const { data: ownerResults } = useReadContracts({
    contracts: ownerCalls,
    query: { enabled: !!connectedAddress && ownerCalls.length > 0 },
  });

  if (!connectedAddress) return false;
  if (registryOwner && isAddressEqual(connectedAddress, registryOwner)) return true;
  if (ownerResults) {
    for (const r of ownerResults) {
      const owner = r?.result as Address | undefined;
      if (owner && isAddressEqual(connectedAddress, owner)) return true;
    }
  }
  return false;
}
