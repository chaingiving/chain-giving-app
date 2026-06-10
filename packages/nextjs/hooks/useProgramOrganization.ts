import { Address, zeroAddress } from "viem";
import { cgOrganizationAbi } from "~~/contracts/cgOrganizationAbi";
import { useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { useReadContracts } from "~~/hooks/scaffold-eth/useNetworkRead";

/**
 * Resolves the parent CGOrganization address for a given CGProgram.
 * Iterates through all registered orgs and checks `isProgram(programAddress)`.
 */
export function useProgramOrganization(programAddress: Address | undefined) {
  // Get all org addresses from registry
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

  // Check isProgram on each org
  const isProgramCalls = (orgAddresses ?? []).map((orgAddr: string) => ({
    address: orgAddr as Address,
    abi: cgOrganizationAbi,
    functionName: "isProgram" as const,
    args: [programAddress ?? zeroAddress] as const,
  }));

  const { data: isProgramResults } = useReadContracts({
    contracts: isProgramCalls,
    query: { enabled: isProgramCalls.length > 0 && !!programAddress },
  });

  // Find the org that owns this program
  let orgAddress: Address | undefined;
  if (isProgramResults && orgAddresses) {
    for (let i = 0; i < isProgramResults.length; i++) {
      if (isProgramResults[i]?.result === true) {
        orgAddress = orgAddresses[i] as Address;
        break;
      }
    }
  }

  return {
    orgAddress,
    isLoading: !programAddress ? false : orgCount === undefined || (orgCount > 0n && !isProgramResults),
  };
}
