"use client";

import { type Address as ViemAddress, isAddressEqual, zeroAddress } from "viem";
import { cgOrganizationAbi } from "~~/contracts/cgOrganizationAbi";
import { cgProgramAbi } from "~~/contracts/cgProgramAbi";
import { useReadContract } from "~~/hooks/scaffold-eth/useNetworkRead";

const crowdfundingContributionsAbi = [
  {
    inputs: [{ name: "", type: "address" }],
    name: "contributions",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export type ProgramRoles = {
  isOwner: boolean;
  hasContribution: boolean;
  isUser: boolean;
  anyRole: boolean;
};

export const useProgramRoles = ({
  programAddress,
  orgAddress,
  userAddress,
}: {
  programAddress: ViemAddress;
  orgAddress: ViemAddress;
  userAddress?: ViemAddress;
}): ProgramRoles => {
  const enabled = !!userAddress;

  const { data: orgOwner } = useReadContract({
    address: orgAddress,
    abi: cgOrganizationAbi,
    functionName: "owner",
    query: { enabled, refetchInterval: 30000 },
  });

  const { data: cfInfo } = useReadContract({
    address: programAddress,
    abi: cgProgramAbi,
    functionName: "getCrowdfundingInfo",
    query: { enabled, refetchInterval: 30000 },
  });

  const cfAddress = cfInfo?.addr;
  const hasCrowdfunding = !!cfAddress && !isAddressEqual(cfAddress, zeroAddress);

  const { data: contributed } = useReadContract({
    address: cfAddress,
    abi: crowdfundingContributionsAbi,
    functionName: "contributions",
    args: userAddress ? [userAddress] : undefined,
    query: { enabled: enabled && hasCrowdfunding, refetchInterval: 30000 },
  });

  const { data: distInfos } = useReadContract({
    address: programAddress,
    abi: cgProgramAbi,
    functionName: "getAllDistributionsInfo",
    query: { enabled, refetchInterval: 30000 },
  });

  const isOwner = !!userAddress && !!orgOwner && isAddressEqual(orgOwner, userAddress);
  const hasContribution = typeof contributed === "bigint" && contributed > 0n;
  const isUser = !!userAddress && !!distInfos?.some(d => d.beneficiaries.some(b => isAddressEqual(b, userAddress)));

  return { isOwner, hasContribution, isUser, anyRole: isOwner || hasContribution || isUser };
};

export const ProgramRoleBadges = ({ roles }: { roles: ProgramRoles }) => {
  if (!roles.anyRole) return null;
  return (
    <>
      {roles.isOwner && <span className="badge badge-warning badge-sm">Owner</span>}
      {roles.hasContribution && <span className="badge badge-success badge-sm">Contributor</span>}
      {roles.isUser && <span className="badge badge-primary badge-sm">User</span>}
    </>
  );
};
