"use client";

import { Address, formatEther } from "viem";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";
import { useOrgGasSponsorship } from "~~/hooks/useOrgGasSponsorship";

/**
 * Displays the gas sponsorship status for an organization.
 * Shows the org's gas budget from CGPaymaster and whether
 * the connected wallet can use sponsored transactions.
 */
export const OrgGasSponsorshipBadge = ({ orgAddress }: { orgAddress: Address }) => {
  const { hasBudget, orgBalance, isLoading } = useOrgGasSponsorship(orgAddress);
  const { targetNetwork } = useTargetNetwork();
  const gasSymbol = targetNetwork.nativeCurrency?.symbol ?? "ETH";

  if (isLoading) {
    return <span className="loading loading-dots loading-xs" />;
  }

  if (!hasBudget) {
    return (
      <div className="tooltip tooltip-bottom" data-tip="No gas budget deposited for this organization in CGPaymaster">
        <span className="badge badge-ghost badge-sm gap-1">
          <GasIcon />
          No gas budget
        </span>
      </div>
    );
  }

  return (
    <div
      className="tooltip tooltip-bottom"
      data-tip={`Transactions will be sponsored from this organization's gas budget (${formatEther(orgBalance ?? 0n)} ${gasSymbol} remaining)`}
    >
      <span className="badge badge-success badge-lg gap-1">
        <GasIcon />
        Gas sponsored
      </span>
    </div>
  );
};

function GasIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        d="M9.879 16.121A3 3 0 1012.015 11L11 14H9c0 .768.293 1.536.879 2.121z"
      />
    </svg>
  );
}
