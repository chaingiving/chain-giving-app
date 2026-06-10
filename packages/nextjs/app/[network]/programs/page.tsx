"use client";

import { Address } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { ProgramCard } from "~~/components/ProgramCard";
import { ProgramRoleBadges, useProgramRoles } from "~~/components/ProgramRoleBadges";
import { cgOrganizationAbi } from "~~/contracts/cgOrganizationAbi";
import { useScaffoldReadContract } from "~~/hooks/scaffold-eth";

const ProgramRow = ({
  programAddress,
  orgAddress,
  orgName,
  userAddress,
}: {
  programAddress: Address;
  orgAddress: Address;
  orgName?: string;
  userAddress?: Address;
}) => {
  const roles = useProgramRoles({ programAddress, orgAddress, userAddress });
  return <ProgramCard address={programAddress} orgName={orgName} roleBadges={<ProgramRoleBadges roles={roles} />} />;
};

const OrgPrograms = ({ orgAddress, userAddress }: { orgAddress: Address; userAddress?: Address }) => {
  const { data: orgName } = useReadContract({
    address: orgAddress,
    abi: cgOrganizationAbi,
    functionName: "name",
    query: { refetchInterval: 30000 },
  });

  const { data: programAddresses } = useReadContract({
    address: orgAddress,
    abi: cgOrganizationAbi,
    functionName: "getPrograms",
    args: [0n, BigInt(100)],
    query: { refetchInterval: 5000 },
  });

  if (!programAddresses || programAddresses.length === 0) return null;

  return (
    <>
      {programAddresses.map(addr => (
        <ProgramRow
          key={addr}
          programAddress={addr}
          orgAddress={orgAddress}
          orgName={orgName ?? undefined}
          userAddress={userAddress}
        />
      ))}
    </>
  );
};

const ProgramsPage = () => {
  const { address: connectedAddress } = useAccount();

  const { data: orgCount } = useScaffoldReadContract({
    contractName: "CGRegistry",
    functionName: "organizationCount",
    watch: true,
  });

  const { data: orgAddresses } = useScaffoldReadContract({
    contractName: "CGRegistry",
    functionName: "getOrganizations",
    args: [0n, BigInt(100)],
    watch: true,
  });

  const totalOrgs = Number(orgCount ?? 0n);

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl">
      <h1 className="text-3xl font-bold mb-6">All Programs</h1>

      {totalOrgs === 0 ? (
        <div className="text-center py-12">
          <p className="opacity-60 mb-4">No programs yet.</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {orgAddresses?.map((orgAddr: Address) => (
            <OrgPrograms key={orgAddr} orgAddress={orgAddr} userAddress={connectedAddress} />
          ))}
        </div>
      )}
    </div>
  );
};

export default ProgramsPage;
