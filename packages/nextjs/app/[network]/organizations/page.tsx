"use client";

import { useState } from "react";
import Link from "next/link";
import { Address as AddressDisplay } from "@scaffold-ui/components";
import { Address, isAddressEqual } from "viem";
import { useAccount } from "wagmi";
import { TrashIcon } from "@heroicons/react/24/outline";
import { AddressInputWithQr } from "~~/components/AddressInputWithQr";
import { cgOrganizationAbi } from "~~/contracts/cgOrganizationAbi";
import { useNetworkHref, useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { useReadContract } from "~~/hooks/scaffold-eth/useNetworkRead";

const PAGE_SIZE = 10;

const OrgCard = ({ address, canRemove }: { address: Address; canRemove: boolean }) => {
  const { address: connectedAddress } = useAccount();
  const networkHref = useNetworkHref();
  const { writeContractAsync: writeRegistry } = useScaffoldWriteContract({ contractName: "CGRegistry" });
  const [isRemoving, setIsRemoving] = useState(false);

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
    query: { refetchInterval: 30000 },
  });

  const isOwner = connectedAddress && owner ? isAddressEqual(connectedAddress, owner) : false;

  const handleRemove = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!window.confirm(`Remove organization "${name ?? address}" from the registry?`)) return;
    setIsRemoving(true);
    try {
      await writeRegistry({ functionName: "removeOrganization", args: [address] });
    } catch (err) {
      console.error("Failed to remove organization:", err);
    } finally {
      setIsRemoving(false);
    }
  };

  return (
    <Link
      href={networkHref(`/organization/${address}`)}
      className="card bg-base-100 shadow-md hover:shadow-lg transition-shadow"
    >
      <div className="card-body p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="card-title text-lg">{name || "Loading..."}</h3>
          {canRemove && (
            <button
              className="btn btn-ghost btn-xs text-error"
              onClick={handleRemove}
              disabled={isRemoving}
              aria-label="Remove organization"
            >
              {isRemoving ? <span className="loading loading-spinner loading-xs" /> : <TrashIcon className="h-4 w-4" />}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 text-sm opacity-70">
          <span>Address:</span>
          <AddressDisplay address={address} size="sm" disableAddressLink />
        </div>
        <div className="flex items-center gap-2 text-sm opacity-70">
          <span>Owner:</span>
          <AddressDisplay address={owner} size="sm" disableAddressLink />
          {isOwner && <span className="badge badge-info badge-sm">You</span>}
        </div>
        <div className="text-sm opacity-70">
          {programCount?.toString() ?? "0"} {programCount === 1n ? "program" : "programs"}
        </div>
      </div>
    </Link>
  );
};

const OrganizationsPage = () => {
  const { address: connectedAddress } = useAccount();
  const [newOrgName, setNewOrgName] = useState("");
  const [newOrgOwner, setNewOrgOwner] = useState("");
  const [page, setPage] = useState(0);

  const { data: orgCount } = useScaffoldReadContract({
    contractName: "CGRegistry",
    functionName: "organizationCount",
    watch: true,
  });

  const { data: registryOwner } = useScaffoldReadContract({
    contractName: "CGRegistry",
    functionName: "owner",
  });

  const { data: orgAddresses } = useScaffoldReadContract({
    contractName: "CGRegistry",
    functionName: "getOrganizations",
    args: [BigInt(page * PAGE_SIZE), BigInt(PAGE_SIZE)],
    watch: true,
  });

  const { writeContractAsync: writeRegistry, isPending } = useScaffoldWriteContract({ contractName: "CGRegistry" });

  const isRegistryOwner = connectedAddress && registryOwner ? isAddressEqual(connectedAddress, registryOwner) : false;
  const totalOrgs = Number(orgCount ?? 0n);
  const totalPages = Math.max(1, Math.ceil(totalOrgs / PAGE_SIZE));

  const handleCreateOrg = async () => {
    if (!newOrgName.trim() || !newOrgOwner) return;
    try {
      await writeRegistry({ functionName: "createOrganization", args: [newOrgName.trim(), newOrgOwner] });
      setNewOrgName("");
      setNewOrgOwner("");
    } catch (e) {
      console.error("Failed to create organization:", e);
    }
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl">
      <h1 className="text-3xl font-bold mb-6">Organizations</h1>

      {isRegistryOwner && (
        <div className="card bg-base-200 shadow-md border border-base-300 mb-8">
          <div className="card-body p-6">
            <h2 className="card-title text-lg">Create New Organization</h2>
            <div className="flex flex-col gap-3">
              <input
                type="text"
                placeholder="Organization Name"
                className="input input-bordered"
                value={newOrgName}
                onChange={e => setNewOrgName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleCreateOrg()}
              />
              <div>
                <label className="label">
                  <span className="label-text text-sm">Owner Address</span>
                </label>
                <AddressInputWithQr value={newOrgOwner} onChange={setNewOrgOwner} placeholder="Owner address" />
              </div>
              <button
                className="btn btn-primary btn-sm w-fit"
                onClick={handleCreateOrg}
                disabled={isPending || !newOrgName.trim() || !newOrgOwner}
              >
                {isPending ? <span className="loading loading-spinner loading-sm" /> : "Create Organization"}
              </button>
            </div>
          </div>
        </div>
      )}

      {totalOrgs === 0 ? (
        <p className="text-center opacity-60 py-8">No organizations yet.</p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {orgAddresses?.map((addr: string) => <OrgCard key={addr} address={addr} canRemove={isRegistryOwner} />)}
          </div>

          {totalPages > 1 && (
            <div className="flex justify-center gap-2 mt-6">
              <button className="btn btn-sm" onClick={() => setPage(p => p - 1)} disabled={page === 0}>
                Previous
              </button>
              <span className="btn btn-sm btn-ghost no-animation">
                {page + 1} / {totalPages}
              </span>
              <button className="btn btn-sm" onClick={() => setPage(p => p + 1)} disabled={page >= totalPages - 1}>
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default OrganizationsPage;
