"use client";

import { useState } from "react";
import Link from "next/link";
import { Address as AddressDisplay, EtherInput } from "@scaffold-ui/components";
import { Address, isAddressEqual, parseEther } from "viem";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { ProgramCard } from "~~/components/ProgramCard";
import { cgOrganizationAbi } from "~~/contracts/cgOrganizationAbi";
import { cgProgramAbi } from "~~/contracts/cgProgramAbi";
import {
  useNetworkHref,
  useScaffoldReadContract,
  useScaffoldWriteContract,
  useTargetNetwork,
} from "~~/hooks/scaffold-eth";
import { useOrgGasSponsorship } from "~~/hooks/useOrgGasSponsorship";
import { useSponsoredWrite } from "~~/hooks/useSponsoredWrite";

export const CGOrganizationView = ({ address }: { address: Address }) => {
  const { address: connectedAddress } = useAccount();
  const [newProgramName, setNewProgramName] = useState("");
  const [lockDistributions, setLockDistributions] = useState(false);
  const [depositAmount, setDepositAmount] = useState("");
  const [depositKey, setDepositKey] = useState(0);
  const [sponsorshipOpen, setSponsorshipOpen] = useState(false);

  const { data: name } = useReadContract({
    address,
    abi: cgOrganizationAbi,
    functionName: "name",
    query: { refetchInterval: 30000 },
  });

  const { data: owner } = useReadContract({
    address,
    abi: cgOrganizationAbi,
    functionName: "owner",
    query: { refetchInterval: 30000 },
  });

  const { data: programCount } = useReadContract({
    address,
    abi: cgOrganizationAbi,
    functionName: "programCount",
    query: { refetchInterval: 5000 },
  });

  const { data: programAddresses } = useReadContract({
    address,
    abi: cgOrganizationAbi,
    functionName: "getPrograms",
    args: [0n, BigInt(100)],
    query: { refetchInterval: 5000 },
  });

  const { data: programStates } = useReadContracts({
    contracts: (programAddresses ?? []).map(addr => ({
      address: addr,
      abi: cgProgramAbi,
      functionName: "state" as const,
    })),
    query: { enabled: !!programAddresses?.length, refetchInterval: 10000 },
  });

  const programCounts = programStates?.reduce(
    (acc, r) => {
      if (r.status !== "success") return acc;
      const s = Number(r.result);
      if (s === 0 || s === 1) acc.active++;
      if (s === 2) acc.completed++;
      if (s === 3) acc.cancelled++;
      return acc;
    },
    { active: 0, completed: 0, cancelled: 0 },
  );

  // createProgram is onlyOwner — not sponsored by CGPaymaster; this hook routes through a plain tx.
  const { write: sponsoredWrite } = useSponsoredWrite(address);

  const { data: registryOwner } = useScaffoldReadContract({
    contractName: "CGRegistry",
    functionName: "owner",
  });

  const { orgBalanceFormatted, isLoading: sponsorshipLoading } = useOrgGasSponsorship(address);
  const { targetNetwork } = useTargetNetwork();
  const networkHref = useNetworkHref();
  const gasSymbol = targetNetwork.nativeCurrency?.symbol ?? "ETH";

  // Direct write to CGPaymaster for depositing sponsorship funds (not itself sponsored)
  const { writeContractAsync: depositForOrg, isPending: isDepositing } = useScaffoldWriteContract({
    contractName: "CGPaymaster",
  });

  const isOwner = connectedAddress && owner ? isAddressEqual(connectedAddress, owner) : false;
  const isRegistryOwner =
    connectedAddress && registryOwner ? isAddressEqual(connectedAddress, registryOwner as Address) : false;
  const canManageSponsorship = isOwner || isRegistryOwner;

  const handleDeposit = async () => {
    if (!depositAmount) return;
    try {
      await depositForOrg({
        functionName: "depositFor",
        args: [address],
        value: parseEther(depositAmount),
      });
      setDepositAmount("");
      setDepositKey(k => k + 1);
    } catch {
      // useScaffoldWriteContract handles error notifications
    }
  };

  const handleCreateProgram = async () => {
    if (!newProgramName.trim()) return;
    const success = await sponsoredWrite({
      address,
      abi: cgOrganizationAbi,
      functionName: "createProgram",
      args: [newProgramName.trim(), lockDistributions],
      sponsored: false,
    });
    if (success) {
      setNewProgramName("");
      setLockDistributions(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl">
      <div className="mb-6">
        <Link href={networkHref("/organizations")} className="btn btn-ghost btn-sm gap-1 mb-2">
          &larr; All Organizations
        </Link>
        <h1 className="text-3xl font-bold">{name || "Loading..."}</h1>
        <div className="flex items-center gap-2 mt-1 text-sm opacity-70">
          <span>Organization Address:</span>
          <AddressDisplay address={address} size="sm" />
        </div>
        <div className="flex items-center gap-2 mt-1 text-sm opacity-70">
          <span>Organization Owner:</span>
          <AddressDisplay address={owner} size="sm" />
          {isOwner && <span className="badge badge-info badge-sm">You</span>}
        </div>
        <div className="text-sm opacity-60 mt-1">
          Programs: {programCount?.toString() ?? "0"}
          {programCounts &&
            ` (${programCounts.completed} completed, ${programCounts.active} active${
              programCounts.cancelled > 0 ? `, ${programCounts.cancelled} cancelled` : ""
            })`}
        </div>
        {canManageSponsorship && (
          <div className="mt-1">
            <div className="flex items-center gap-2 text-sm">
              <span className="opacity-70">Gas Sponsorship Balance:</span>
              {sponsorshipLoading ? (
                <span className="loading loading-dots loading-xs" />
              ) : (
                <span className="font-medium">
                  {orgBalanceFormatted ?? "0"} {gasSymbol}
                </span>
              )}
              <button className="btn btn-secondary btn-xs" onClick={() => setSponsorshipOpen(o => !o)}>
                {sponsorshipOpen ? "Hide" : "Deposit"}
              </button>
            </div>
            {sponsorshipOpen && (
              <div className="flex gap-2 items-end mt-2">
                <div className="grow">
                  <EtherInput key={depositKey} onValueChange={({ valueInEth }) => setDepositAmount(valueInEth)} />
                </div>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleDeposit}
                  disabled={!depositAmount || isDepositing}
                >
                  {isDepositing ? <span className="loading loading-spinner loading-xs" /> : "Deposit"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {isOwner && (
        <div className="card bg-base-200 shadow-md border border-base-300 mb-8">
          <div className="card-body p-6">
            <h2 className="card-title text-lg">Create New Program</h2>
            <div className="flex flex-col gap-3">
              <input
                type="text"
                placeholder="Program Name"
                className="input input-bordered"
                value={newProgramName}
                onChange={e => setNewProgramName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleCreateProgram()}
              />
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="checkbox checkbox-sm"
                  checked={lockDistributions}
                  onChange={e => setLockDistributions(e.target.checked)}
                />
                <span className="text-sm">Lock distributions after first contribution</span>
              </label>
              <button
                className="btn btn-primary btn-sm w-fit"
                onClick={handleCreateProgram}
                disabled={!newProgramName.trim()}
              >
                Create Program
              </button>
            </div>
          </div>
        </div>
      )}

      {!programAddresses || programAddresses.length === 0 ? (
        <p className="text-center opacity-60 py-8">No programs yet.</p>
      ) : (
        <div className="grid gap-4">
          {programAddresses.map(addr => (
            <ProgramCard key={addr} address={addr} />
          ))}
        </div>
      )}
    </div>
  );
};
