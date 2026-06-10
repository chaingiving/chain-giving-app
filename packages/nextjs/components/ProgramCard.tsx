"use client";

import Link from "next/link";
import { Address as AddressDisplay } from "@scaffold-ui/components";
import { Address } from "viem";
import { cgProgramAbi } from "~~/contracts/cgProgramAbi";
import { useNetworkHref } from "~~/hooks/scaffold-eth";
import { useReadContract } from "~~/hooks/scaffold-eth/useNetworkRead";

export const PROGRAM_STATES = ["Active", "Executing", "Completed", "Cancelled"] as const;
const PROGRAM_STATE_COLORS = ["badge-cg", "badge-warning", "badge-info", "badge-error"] as const;

export const ProgramCard = ({
  address,
  orgName,
  roleBadges,
}: {
  address: Address;
  orgName?: string;
  roleBadges?: React.ReactNode;
}) => {
  const { data: name } = useReadContract({
    address,
    abi: cgProgramAbi,
    functionName: "name",
    query: { refetchInterval: 30000 },
  });

  const { data: state } = useReadContract({
    address,
    abi: cgProgramAbi,
    functionName: "state",
    query: { refetchInterval: 10000 },
  });

  const stateIndex = Number(state ?? 0);
  const networkHref = useNetworkHref();

  return (
    <Link
      href={networkHref(`/program/${address}`)}
      className="card bg-base-100 shadow-md hover:shadow-lg transition-shadow"
    >
      <div className="card-body p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            <h3 className="card-title text-lg">{name || "Loading..."}</h3>
            {roleBadges}
          </div>
          <span className={`badge ${PROGRAM_STATE_COLORS[stateIndex]} badge-sm`}>{PROGRAM_STATES[stateIndex]}</span>
        </div>
        <div className="flex items-center gap-4 text-sm opacity-60">
          {orgName && <span>Org: {orgName}</span>}
          <AddressDisplay address={address} size="xs" disableAddressLink />
        </div>
      </div>
    </Link>
  );
};
