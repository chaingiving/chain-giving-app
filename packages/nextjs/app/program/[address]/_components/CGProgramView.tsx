"use client";

import { type ChangeEvent, type ReactNode, useEffect, useState } from "react";
import Link from "next/link";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAppKit } from "@reown/appkit/react";
import { Address as AddressDisplay } from "@scaffold-ui/components";
import { Address, erc20Abi, formatUnits, isAddress, isAddressEqual, parseUnits, zeroAddress } from "viem";
import { useAccount, usePublicClient, useReadContract, useWalletClient, useWriteContract } from "wagmi";
import {
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
  ArrowsPointingOutIcon,
  CreditCardIcon,
  EnvelopeIcon,
  HashtagIcon,
  InformationCircleIcon,
  LockClosedIcon,
  SparklesIcon,
  TrashIcon,
  WalletIcon,
} from "@heroicons/react/24/outline";
import { AddressInputWithQr } from "~~/components/AddressInputWithQr";
import { CurrencyLogo } from "~~/components/CurrencyLogo";
import { DonateWithFiatButton } from "~~/components/DonateWithFiatButton";
import { OrgGasSponsorshipBadge } from "~~/components/OrgGasSponsorshipBadge";
import { cgOrganizationAbi } from "~~/contracts/cgOrganizationAbi";
import { cgProgramAbi } from "~~/contracts/cgProgramAbi";
import { DonationCurrency, findCurrency, getDonationCurrencies } from "~~/contracts/donationCurrencies";
import { useBlockExplorerLink, useTargetNetwork } from "~~/hooks/scaffold-eth";
import { useProgramOrganization } from "~~/hooks/useProgramOrganization";
import { useSponsoredWrite } from "~~/hooks/useSponsoredWrite";
import { signErc2612Permit } from "~~/utils/permit";
import { getParsedError, notification } from "~~/utils/scaffold-eth";

const cgCrowdfundingAbi = [
  {
    name: "contributions",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  { name: "cancelContribution", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { name: "refund", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] },
  {
    type: "event",
    name: "ContributionReceived",
    inputs: [
      { name: "donor", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

const PROGRAM_STATES = ["Active", "Executing", "Completed", "Cancelled"] as const;
const CROWDFUNDING_STATES = ["Active", "Withdrawn", "Cancelled"] as const;
const DISTRIBUTION_STATES = ["Draft", "Ready", "Distributed"] as const;

const STATE_COLORS: Record<string, string> = {
  Active: "badge-cg",
  Executing: "badge-warning",
  Completed: "badge-info",
  Cancelled: "badge-error",
  Withdrawn: "badge-info",
  Draft: "badge-ghost",
  Ready: "badge-success",
  Distributed: "badge-info",
};

type TokenTypeInfo = {
  tokenId: bigint;
  name: string;
  symbol: string;
  maxSupply: bigint;
  totalMinted: bigint;
  uri: string;
  transferable: boolean;
  burnable: boolean;
};

type CrowdfundingInfo = {
  addr: Address;
  currency: Address;
  fundingTarget: bigint;
  deadline: bigint;
  state: number;
  totalRaised: bigint;
  totalTracked: bigint;
  isFunded: boolean;
};

type DistributionInfo = {
  addr: Address;
  tokenId: bigint;
  state: number;
  beneficiaryCount: bigint;
  totalRequired: bigint;
  beneficiaries: Address[];
  amounts: bigint[];
};

type UserEntry = {
  id: string;
  address: string;
  amount: string;
};

function useContractRead<T>(address: Address, functionName: string, args?: readonly unknown[]) {
  const result = useReadContract({
    address,
    abi: cgProgramAbi,
    functionName: functionName as any,
    args: args as any,
    query: { refetchInterval: 5000 },
  });
  return { ...result, data: result.data as T | undefined };
}

function useCGProgramWrite(programAddress: Address, orgAddress: Address | undefined) {
  const { write: sponsoredWrite } = useSponsoredWrite(orgAddress);

  // All CGProgram functions reached through this factory are onlyOwner — paymaster
  // refuses to sponsor them, so always send as a regular tx.
  return async (functionName: string, args?: readonly unknown[], value?: bigint) => {
    return sponsoredWrite({
      address: programAddress,
      abi: cgProgramAbi,
      functionName,
      args,
      value,
      sponsored: false,
    });
  };
}

function validateUsers(entries: UserEntry[]): { addresses: Address[]; amounts: bigint[] } | null {
  const nonEmpty = entries.filter(e => e.address || e.amount);
  if (nonEmpty.length === 0) {
    notification.error("Add at least one user");
    return null;
  }
  for (let i = 0; i < nonEmpty.length; i++) {
    if (!isAddress(nonEmpty[i].address)) {
      notification.error(`Row ${i + 1}: invalid address`);
      return null;
    }
    if (!nonEmpty[i].amount || Number(nonEmpty[i].amount) <= 0 || !Number.isInteger(Number(nonEmpty[i].amount))) {
      notification.error(`Row ${i + 1}: amount must be a positive integer`);
      return null;
    }
  }
  return {
    addresses: nonEmpty.map(e => e.address as Address),
    amounts: nonEmpty.map(e => BigInt(e.amount)),
  };
}

export const CGProgramView = ({ address }: { address: Address }) => {
  const { address: connectedAddress } = useAccount();
  const { orgAddress } = useProgramOrganization(address);

  const { data: name, isLoading: nameLoading, error: nameError } = useContractRead<string>(address, "name");
  const { data: state } = useContractRead<number>(address, "state");
  const { data: owner } = useContractRead<Address>(address, "owner");
  const { data: lockDistributions } = useContractRead<boolean>(address, "lockDistributions");
  const { data: tokenAddress } = useContractRead<Address>(address, "token");
  const { data: tokenTypes } = useContractRead<TokenTypeInfo[]>(address, "getTokenTypes");
  const { data: crowdfundingInfo } = useContractRead<CrowdfundingInfo>(address, "getCrowdfundingInfo");
  const { data: distributionsInfo } = useContractRead<DistributionInfo[]>(address, "getAllDistributionsInfo");

  const isOwner = connectedAddress && owner ? isAddressEqual(connectedAddress, owner) : false;
  const programState = PROGRAM_STATES[state ?? 0];
  const isActive = state === 0;

  if (nameLoading) {
    return (
      <div className="flex justify-center items-center min-h-[60vh]">
        <span className="loading loading-spinner loading-lg" />
      </div>
    );
  }

  if (nameError) {
    return (
      <div className="flex justify-center items-center min-h-[60vh]">
        <div className="text-center">
          <p className="text-error text-lg">Failed to load program data.</p>
          <p className="text-sm opacity-60 mt-2">This address may not be a valid CGProgram contract.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 px-4 py-8 max-w-7xl mx-auto">
      <div className="card bg-base-100 shadow-xl">
        <div className="card-body">
          <ProgramSection
            address={address}
            name={name}
            programState={programState}
            owner={owner}
            lockDistributions={lockDistributions}
            isOwner={isOwner}
            orgAddress={orgAddress}
          />
        </div>
      </div>

      <div className="card bg-base-100 shadow-xl">
        <div className="card-body">
          <CrowdfundingSection
            crowdfundingInfo={crowdfundingInfo}
            programAddress={address}
            isActive={isActive}
            isOwner={isOwner}
            lockDistributions={lockDistributions}
            distributions={distributionsInfo ?? []}
            connectedAddress={connectedAddress}
            orgAddress={orgAddress}
          />
        </div>
      </div>

      <div className="card bg-base-100 shadow-xl">
        <div className="card-body flex flex-col gap-6">
          <TokenSection
            tokenAddress={tokenAddress}
            tokenTypes={tokenTypes ?? []}
            programAddress={address}
            isOwner={isOwner}
            isActive={isActive}
            orgAddress={orgAddress}
          />
          <DistributionsSection
            distributions={distributionsInfo ?? []}
            tokenTypes={tokenTypes ?? []}
            programAddress={address}
            isActive={isActive}
            isOwner={isOwner}
            crowdfundingHasContributions={
              crowdfundingInfo != null &&
              !isAddressEqual(crowdfundingInfo.addr, zeroAddress) &&
              crowdfundingInfo.totalRaised > 0n
            }
            orgAddress={orgAddress}
          />
          {isOwner && isActive && (
            <OwnerActions
              address={address}
              crowdfundingInfo={crowdfundingInfo}
              distributions={distributionsInfo ?? []}
              orgAddress={orgAddress}
            />
          )}
        </div>
      </div>
    </div>
  );
};

function ProgramSection({
  address,
  name,
  programState,
  owner,
  lockDistributions,
  isOwner,
  orgAddress,
}: {
  address: Address;
  name: string | undefined;
  programState: string;
  owner: Address | undefined;
  lockDistributions: boolean | undefined;
  isOwner: boolean;
  orgAddress: Address | undefined;
}) {
  const addressLink = useBlockExplorerLink(address);
  const ownerLink = useBlockExplorerLink(owner);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="card-title text-3xl">{name || "CGProgram"}</h2>
        <div className="flex items-center gap-2 flex-wrap">
          {orgAddress && <OrgGasSponsorshipBadge orgAddress={orgAddress} />}
          {lockDistributions && (
            <span
              className="tooltip tooltip-bottom"
              data-tip="When locked, all distributions must be marked as Ready before the crowdfunding can accept contributions. This guarantees contributors know exactly how funds will be allocated."
            >
              <span className="badge badge-warning badge-lg cursor-help">Distributions Locked</span>
            </span>
          )}
          <span className={`badge ${STATE_COLORS[programState]} badge-lg`}>{programState}</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        {orgAddress && <ProgramOrganizationLink orgAddress={orgAddress} />}
        <div className="flex items-center gap-2 min-w-0">
          <span className="opacity-60 shrink-0">Address:</span>
          <AddressDisplay address={address} blockExplorerAddressLink={addressLink} />
        </div>
        <div className="flex items-center gap-2 min-w-0">
          <span className="opacity-60 shrink-0">Owner:</span>
          {owner && <AddressDisplay address={owner} blockExplorerAddressLink={ownerLink} />}
          {isOwner && <span className="badge badge-info badge-sm">You</span>}
        </div>
      </div>
    </>
  );
}

function ProgramOrganizationLink({ orgAddress }: { orgAddress: Address }) {
  const { data: orgName } = useReadContract({
    address: orgAddress,
    abi: cgOrganizationAbi,
    functionName: "name",
    query: { refetchInterval: 30000 },
  });

  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="opacity-60 shrink-0">Organization:</span>
      <Link href={`/organization/${orgAddress}`} className="link link-primary font-medium">
        {(orgName as string | undefined) ?? "View organization"}
      </Link>
    </div>
  );
}

function TokenSection({
  tokenAddress,
  tokenTypes,
  programAddress,
  isOwner,
  isActive,
  orgAddress,
}: {
  tokenAddress: Address | undefined;
  tokenTypes: TokenTypeInfo[];
  programAddress: Address;
  isOwner: boolean;
  isActive: boolean;
  orgAddress: Address | undefined;
}) {
  const tokenLink = useBlockExplorerLink(tokenAddress);
  const [showCreateForm, setShowCreateForm] = useState(false);

  if (!tokenAddress || isAddressEqual(tokenAddress, zeroAddress)) return null;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <h3 className="card-title">Token Contract (ERC-1155)</h3>
          <AddressDisplay address={tokenAddress} blockExplorerAddressLink={tokenLink} />
        </div>
        <a href={`/token/${tokenAddress}`} className="btn btn-sm btn-outline">
          View &amp; Spend Tokens
        </a>
      </div>

      <div className="flex items-center justify-between mt-2">
        <h3 className="card-title">Token Types ({tokenTypes.length})</h3>
        {isOwner && isActive && !showCreateForm && (
          <button className="btn btn-sm btn-secondary" onClick={() => setShowCreateForm(true)}>
            Create Token Type
          </button>
        )}
      </div>

      {showCreateForm && (
        <CreateTokenTypeForm
          programAddress={programAddress}
          orgAddress={orgAddress}
          onDone={() => setShowCreateForm(false)}
        />
      )}

      {tokenTypes.length === 0 && !showCreateForm ? (
        <p className="opacity-60 text-sm">No token types defined yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {tokenTypes.map(tt => (
            <div key={tt.tokenId.toString()} className="border border-base-300 rounded-lg p-3 text-sm">
              <div className="flex items-center gap-2 mb-1">
                <span className="badge badge-outline badge-sm">#{tt.tokenId.toString()}</span>
                <span className="font-semibold">
                  {tt.name} ({tt.symbol})
                </span>
                <span className="badge badge-ghost badge-sm">
                  {tt.maxSupply === 0n ? "Fungible" : tt.maxSupply === 1n ? "NFT (max 1)" : `Max ${tt.maxSupply}`}
                </span>
              </div>
              <div className="flex gap-4 text-xs opacity-70">
                <span>Minted: {tt.totalMinted.toString()}</span>
                {tt.uri && <span>URI: {tt.uri}</span>}
              </div>
              <div className="flex gap-2 mt-1">
                <span className={`badge badge-xs ${tt.transferable ? "badge-success" : "badge-error"}`}>
                  {tt.transferable ? "Transferable" : "Non-transferable"}
                </span>
                <span className={`badge badge-xs ${tt.burnable ? "badge-success" : "badge-error"}`}>
                  {tt.burnable ? "Burnable" : "Non-burnable"}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function CrowdfundingSection({
  crowdfundingInfo,
  programAddress,
  isActive,
  isOwner,
  lockDistributions,
  distributions,
  connectedAddress,
  orgAddress,
}: {
  crowdfundingInfo: CrowdfundingInfo | undefined;
  programAddress: Address;
  isActive: boolean;
  isOwner: boolean;
  lockDistributions: boolean | undefined;
  distributions: DistributionInfo[];
  connectedAddress: Address | undefined;
  orgAddress: Address | undefined;
}) {
  const [donateAmount, setDonateAmount] = useState("");
  const [donateMode, setDonateMode] = useState<"crypto" | "card">("crypto");
  const [isPending, setIsPending] = useState(false);
  const { chainId } = useAccount();
  const { targetNetwork } = useTargetNetwork();
  const cfLink = useBlockExplorerLink(crowdfundingInfo?.addr);
  const { writeContractAsync: writeContract } = useWriteContract();
  const { data: walletClient } = useWalletClient();
  const donatePublicClient = usePublicClient();
  // Donations always run directly from the connected wallet. Sponsorship can't
  // help here in practice: USDC's permit only verifies ECDSA signatures (no
  // ERC-1271), so smart-account-held funds can't be permit-spent — and pulling
  // tokens from the EOA via a smart-account msg.sender fails on allowance.
  const donorAddress = connectedAddress;

  const cfAddr = crowdfundingInfo?.addr;
  const isValidCf = cfAddr && !isAddressEqual(cfAddr, zeroAddress);
  // When the wallet is disconnected, useAccount().chainId is undefined; fall
  // back to the target network so we can still resolve the donation currency
  // and render an enabled donate form for visitors before they sign in.
  const effectiveChainId = chainId ?? targetNetwork.id;
  const currency = findCurrency(effectiveChainId, crowdfundingInfo?.currency);
  const symbol = currency?.symbol ?? "tokens";
  const decimals = currency?.decimals ?? 18;

  const { data: userContribution, refetch: refetchUserContribution } = useReadContract({
    address: isValidCf ? cfAddr : undefined,
    abi: cgCrowdfundingAbi,
    functionName: "contributions",
    args: donorAddress ? [donorAddress] : undefined,
    query: { enabled: !!isValidCf && !!donorAddress, refetchInterval: 5000 },
  });

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: crowdfundingInfo?.currency,
    abi: erc20Abi,
    functionName: "allowance",
    args: donorAddress ? [donorAddress, programAddress] : undefined,
    query: {
      enabled: !!crowdfundingInfo?.currency && !!donorAddress && !!currency,
      refetchInterval: 5000,
    },
  });

  const { data: userBalance } = useReadContract({
    address: crowdfundingInfo?.currency,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: donorAddress ? [donorAddress] : undefined,
    query: {
      enabled: !!crowdfundingInfo?.currency && !!donorAddress && !!currency,
      refetchInterval: 5000,
    },
  });

  const writeCf = async (functionName: "cancelContribution" | "refund") => {
    if (!cfAddr || isPending) return;
    setIsPending(true);
    try {
      await writeContract({
        address: cfAddr,
        abi: cgCrowdfundingAbi,
        functionName,
      });
      refetchUserContribution();
    } catch (e) {
      notification.error(getParsedError(e));
    } finally {
      setIsPending(false);
    }
  };

  const isZeroAddr = !crowdfundingInfo || isAddressEqual(crowdfundingInfo.addr, zeroAddress);

  if (isZeroAddr) {
    return (
      <div>
        <h3 className="card-title">Crowdfunding</h3>
        <p className="opacity-60">No crowdfunding configured for this program.</p>
        {isOwner && isActive && <SetCrowdfundingForm programAddress={programAddress} orgAddress={orgAddress} />}
      </div>
    );
  }

  const cfState = CROWDFUNDING_STATES[crowdfundingInfo.state] ?? "Unknown";
  const isCfActive = crowdfundingInfo.state === 0;
  const isCfCancelled = crowdfundingInfo.state === 2;
  // totalRaised on the contract returns the live balance while ACTIVE and the frozen amount
  // after WITHDRAWN, so we can use it directly here.
  const directTransfers =
    crowdfundingInfo.totalRaised > crowdfundingInfo.totalTracked
      ? crowdfundingInfo.totalRaised - crowdfundingInfo.totalTracked
      : 0n;
  const progress =
    crowdfundingInfo.fundingTarget > 0n
      ? Number((crowdfundingInfo.totalRaised * 10000n) / crowdfundingInfo.fundingTarget) / 100
      : 0;

  const allDistributionsReady = distributions.length > 0 && distributions.every(d => d.state === 1);
  const donateLocked = lockDistributions && !allDistributionsReady;
  const unknownCurrency = !currency;

  const handleDonate = async () => {
    if (!donateAmount || isPending || !connectedAddress) return;
    if (!currency) {
      notification.error("Donation currency is not in the recognized list for this network.");
      return;
    }
    let amountWei: bigint;
    try {
      amountWei = parseUnits(donateAmount, decimals);
    } catch {
      notification.error("Invalid amount");
      return;
    }
    if (amountWei <= 0n) {
      notification.error("Amount must be positive");
      return;
    }

    if (!walletClient || !donatePublicClient) {
      notification.error("Wallet not ready");
      return;
    }

    setIsPending(true);
    try {
      // Single-tx permit path when the currency supports EIP-2612, otherwise a
      // two-tx approve + donate. Both run directly from the connected wallet.
      if (currency.permit) {
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60);
        const { v, r, s } = await signErc2612Permit({
          publicClient: donatePublicClient,
          walletClient,
          token: currency.address,
          owner: connectedAddress,
          spender: programAddress,
          value: amountWei,
          deadline,
        });
        await writeContract({
          address: programAddress,
          abi: cgProgramAbi,
          functionName: "donateWithPermit",
          args: [amountWei, deadline, v, r, s],
        });
      } else {
        const currentAllowance = (allowance as bigint | undefined) ?? 0n;
        if (currentAllowance < amountWei) {
          await writeContract({
            address: currency.address,
            abi: erc20Abi,
            functionName: "approve",
            args: [programAddress, amountWei],
          });
          await refetchAllowance();
        }
        await writeContract({
          address: programAddress,
          abi: cgProgramAbi,
          functionName: "donate",
          args: [amountWei],
        });
      }

      setDonateAmount("");
      refetchUserContribution();
      refetchAllowance();
    } catch (e) {
      notification.error(getParsedError(e));
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <h3 className="card-title">Crowdfunding</h3>
        <span className={`badge ${STATE_COLORS[cfState]}`}>{cfState}</span>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm mt-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="opacity-60 shrink-0">Contract:</span>
          <AddressDisplay address={crowdfundingInfo.addr} blockExplorerAddressLink={cfLink} />
        </div>
        <div className="flex items-center gap-2 min-w-0">
          <span className="opacity-60 shrink-0">Currency:</span>
          <CurrencyLogo currency={currency} />
          <span className="font-medium">{symbol}</span>
          <AddressDisplay address={crowdfundingInfo.currency} />
        </div>
      </div>

      <CrowdfundingStats
        crowdfundingInfo={crowdfundingInfo}
        currency={currency}
        symbol={symbol}
        decimals={decimals}
        isCfActive={isCfActive}
        directTransfers={directTransfers}
      />

      <div className="mt-3 relative h-6 rounded-full bg-base-300 overflow-hidden">
        <div
          className="h-full bg-primary transition-[width] duration-500"
          style={{ width: `${Math.min(progress, 100)}%` }}
        />
        <span className="absolute inset-0 flex items-center justify-center text-xs font-bold text-white mix-blend-difference pointer-events-none">
          {progress.toFixed(1)}%
        </span>
      </div>

      {connectedAddress && userContribution !== undefined && userContribution > 0n && (
        <div className="mt-4 p-4 rounded-xl bg-base-200 border border-base-300">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide opacity-60 mb-0.5">Your contribution</p>
              <p className="text-2xl font-bold font-mono flex items-center gap-2">
                {formatUnits(userContribution, decimals)} <CurrencyLogo currency={currency} size={22} /> {symbol}
              </p>
            </div>
            <div className="flex gap-2">
              {isCfActive && (
                <button
                  className="btn btn-sm btn-outline btn-error"
                  disabled={isPending}
                  onClick={() => writeCf("cancelContribution")}
                >
                  {isPending ? <span className="loading loading-spinner loading-xs" /> : "Cancel contribution"}
                </button>
              )}
              {isCfCancelled && (
                <button className="btn btn-sm btn-warning" disabled={isPending} onClick={() => writeCf("refund")}>
                  {isPending ? <span className="loading loading-spinner loading-xs" /> : "Claim refund"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {isCfCancelled && connectedAddress && userContribution === 0n && (
        <div className="mt-4 p-3 rounded-xl bg-base-200 border border-base-300 text-sm opacity-60 text-center">
          This program was cancelled. You have no contribution to refund.
        </div>
      )}

      <DirectTransfersPanel
        crowdfundingInfo={crowdfundingInfo}
        programAddress={programAddress}
        isOwner={isOwner}
        currency={currency}
        symbol={symbol}
        decimals={decimals}
        orgAddress={orgAddress}
      />

      {isCfActive && (
        <div className="mt-4">
          {donateLocked && (
            <div role="alert" className="alert alert-warning mb-3 py-2 text-sm">
              <WarningIcon />
              <span>
                Donations are locked until all distributions are defined and marked as &quot;Ready&quot; by the program
                owner.
              </span>
            </div>
          )}
          {connectedAddress && unknownCurrency && (
            <div role="alert" className="alert alert-warning mb-3 py-2 text-sm">
              <WarningIcon />
              <span>Donation currency is not in the recognized list for this network. Donations are disabled.</span>
            </div>
          )}
          {!unknownCurrency &&
            (() => {
              const showCardTab = currency?.symbol === "USDC" || currency?.symbol === "EURC";
              const tabBase =
                "py-4 text-lg font-bold flex items-center justify-center gap-2 transition-colors focus-visible:outline-none";
              const tabActive = "text-blue-700 dark:text-blue-300 border-b-2 border-current -mb-px";
              const tabInactive = "text-gray-600 dark:text-gray-400 hover:bg-base-300/60";
              return (
                <div className="mt-3 w-full max-w-md mx-auto bg-base-200 rounded-lg overflow-hidden">
                  <h3 className="text-2xl font-bold flex items-center gap-2 justify-center py-3 px-4 m-0 text-blue-700 dark:text-blue-300">
                    Donate <CurrencyLogo currency={currency} size={24} /> {symbol}
                  </h3>
                  <div
                    role="tablist"
                    className={`grid ${showCardTab ? "grid-cols-2" : "grid-cols-1"} border-b border-base-300`}
                  >
                    <button
                      role="tab"
                      type="button"
                      className={`${tabBase} ${donateMode === "crypto" ? tabActive : tabInactive}`}
                      onClick={() => setDonateMode("crypto")}
                    >
                      <CurrencyLogo currency={currency} size={20} /> Pay with crypto
                    </button>
                    {showCardTab && (
                      <button
                        role="tab"
                        type="button"
                        className={`${tabBase} ${donateMode === "card" ? tabActive : tabInactive}`}
                        onClick={() => setDonateMode("card")}
                      >
                        <CreditCardIcon className="h-5 w-5" />
                        Pay with card
                      </button>
                    )}
                  </div>

                  <div className="flex flex-col gap-3 p-4 text-center items-center">
                    {donateMode === "crypto" && (
                      <div className="flex flex-col text-base max-w-full">
                        <p>Benefit from on-chain tracking. Your donation is:</p>
                        <ul className="list-disc list-inside text-left w-fit mx-auto">
                          <li>Cancellable until the program ends</li>
                          <li>Refundable if the program is cancelled</li>
                        </ul>
                        {!connectedAddress && (
                          <div
                            role="alert"
                            className="alert py-2 text-sm text-left mt-2 text-blue-700 dark:text-blue-300"
                          >
                            <InformationCircleIcon className="h-5 w-5 shrink-0" />
                            <div>To pay with crypto, sign in or connect a wallet first.</div>
                          </div>
                        )}
                      </div>
                    )}
                    {donateMode === "card" && (
                      <div className="flex flex-col gap-2 max-w-full">
                        <p className="text-base">
                          A third-party provider (Coinbase) will charge your card and send the equivalent crypto to the
                          program.
                        </p>
                        {!connectedAddress && (
                          <div role="alert" className="alert py-2 text-sm text-left text-blue-700 dark:text-blue-300">
                            <InformationCircleIcon className="h-5 w-5 shrink-0" />
                            <div>To pay with card, sign in with your email or any available option first.</div>
                          </div>
                        )}
                        <div role="alert" className="alert alert-warning py-2 text-sm text-left">
                          <WarningIcon />
                          <span>Card donations cannot be cancelled or refunded through Chain.Giving.</span>
                        </div>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2 items-center justify-center">
                      {donateMode === "crypto" && connectedAddress && (
                        <div className="flex w-40 input input-bordered input-md items-center pr-1 gap-1">
                          <input
                            type="number"
                            min="0"
                            step="any"
                            className="flex-1 bg-transparent outline-none min-w-0 text-center text-sm placeholder:text-xs"
                            placeholder={`Amount (${symbol})`}
                            value={donateAmount}
                            onChange={e => setDonateAmount(e.target.value)}
                          />
                          {userBalance !== undefined && (userBalance as bigint) > 0n && (
                            <button
                              className="btn btn-ghost btn-xs text-xs px-1 h-5 min-h-0 opacity-60 hover:opacity-100"
                              onClick={() => setDonateAmount(formatUnits(userBalance as bigint, decimals))}
                              title="Use full balance"
                            >
                              Max
                            </button>
                          )}
                        </div>
                      )}
                      {donateMode === "crypto" ? (
                        connectedAddress ? (
                          <button
                            className="btn btn-md btn-primary"
                            onClick={handleDonate}
                            disabled={!donateAmount || donateLocked || isPending}
                          >
                            {isPending ? <span className="loading loading-spinner loading-xs" /> : "Donate"}
                          </button>
                        ) : (
                          <SignInActions />
                        )
                      ) : currency?.symbol === "USDC" || currency?.symbol === "EURC" ? (
                        <DonateWithFiatButton
                          asset={currency.symbol}
                          targetAddress={crowdfundingInfo.addr}
                          disabled={donateLocked}
                        />
                      ) : null}
                    </div>
                    {donateMode === "crypto" && connectedAddress && (
                      <div className="flex flex-wrap items-center justify-center gap-2 text-xs opacity-80">
                        <span className="flex items-center gap-1">
                          In your wallet:
                          <span className="font-mono font-semibold flex items-center gap-1">
                            {userBalance !== undefined ? formatUnits(userBalance as bigint, decimals) : "…"}
                            <CurrencyLogo currency={currency} size={12} />
                            {symbol}
                          </span>
                        </span>
                        <Link
                          href={`/wallet/${donorAddress ?? connectedAddress}`}
                          className="btn btn-xs btn-ghost btn-link no-underline px-1 gap-1"
                        >
                          <WalletIcon className="h-3.5 w-3.5" />
                          Go to wallet
                        </Link>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}
        </div>
      )}
    </div>
  );
}

function formatTimeLeft(deadline: bigint, now: number): { primary: string; secondary: string | null } {
  const left = Number(deadline) - Math.floor(now / 1000);
  if (left <= 0) return { primary: "ended", secondary: null };
  const days = Math.floor(left / 86400);
  const hours = Math.floor((left % 86400) / 3600);
  const minutes = Math.floor((left % 3600) / 60);
  if (days > 0) {
    return { primary: `${days} ${days === 1 ? "day" : "days"}`, secondary: `${hours}h ${minutes}min` };
  }
  if (hours > 0) {
    return { primary: `${hours}h`, secondary: `${minutes}min` };
  }
  return { primary: `${minutes}min`, secondary: null };
}

function CrowdfundingStats({
  crowdfundingInfo,
  currency,
  symbol,
  decimals,
  isCfActive,
  directTransfers,
}: {
  crowdfundingInfo: CrowdfundingInfo;
  currency: DonationCurrency | undefined;
  symbol: string;
  decimals: number;
  isCfActive: boolean;
  directTransfers: bigint;
}) {
  const publicClient = usePublicClient();
  const [contributorCount, setContributorCount] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    (async () => {
      try {
        const events = await publicClient.getContractEvents({
          address: crowdfundingInfo.addr,
          abi: cgCrowdfundingAbi,
          eventName: "ContributionReceived",
          fromBlock: "earliest",
        });
        if (cancelled) return;
        const donors = new Set(events.map(e => (e.args as { donor?: string }).donor).filter(Boolean));
        setContributorCount(donors.size);
      } catch {
        if (!cancelled) setContributorCount(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, crowdfundingInfo.addr, crowdfundingInfo.totalTracked]);

  const timeLeft = formatTimeLeft(crowdfundingInfo.deadline, now);

  return (
    <div className="flex flex-col sm:flex-row sm:items-start gap-4 sm:gap-8 mt-4 border-l-4 border-[#0c53bf] dark:border-[#93bbfb] pl-4 sm:pl-6 justify-center">
      <div className="flex flex-col items-start">
        <div className="flex items-center gap-1.5 text-[#0c53bf] dark:text-[#93bbfb] font-bold text-2xl sm:text-3xl">
          <span className="font-mono">{formatUnits(crowdfundingInfo.totalRaised, decimals)}</span>
          <CurrencyLogo currency={currency} size={24} />
        </div>
        <span className="text-xs sm:text-sm opacity-60">
          raised of {formatUnits(crowdfundingInfo.fundingTarget, decimals)} {symbol} goal
        </span>
        {isCfActive && directTransfers > 0n && (
          <span className="text-xs opacity-60">
            Including {formatUnits(directTransfers, decimals)} in direct transfers
          </span>
        )}
      </div>
      <div className="flex flex-col items-start">
        <span className="font-bold text-2xl sm:text-3xl">{contributorCount ?? "…"}</span>
        <span className="text-xs sm:text-sm opacity-60">{contributorCount === 1 ? "contributor" : "contributors"}</span>
      </div>
      <div className="flex flex-col items-start">
        <span className="whitespace-nowrap">
          <span className="font-bold text-2xl sm:text-3xl">{timeLeft.primary}</span>
          {timeLeft.secondary && (
            <span className="font-bold text-sm sm:text-base ml-1 opacity-80">{timeLeft.secondary}</span>
          )}
        </span>
        <span className="text-xs sm:text-sm opacity-60">time to go</span>
      </div>
    </div>
  );
}

function SignInActionsInner() {
  const { open } = useAppKit();
  return (
    <ConnectButton.Custom>
      {({ openConnectModal, mounted }) => (
        <>
          <button className="btn btn-md btn-error gap-2" type="button" onClick={() => open()}>
            <EnvelopeIcon className="h-4 w-4" />
            Sign in
          </button>
          <button className="btn btn-md btn-primary gap-2" type="button" onClick={openConnectModal} disabled={!mounted}>
            <WalletIcon className="h-4 w-4" />
            Connect Wallet
          </button>
        </>
      )}
    </ConnectButton.Custom>
  );
}

// useAppKit reads global state populated by createAppKit, which only runs in
// the browser (see services/web3/wagmiConfig.tsx). Defer until mount so SSG
// never invokes it.
function SignInActions() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return <SignInActionsInner />;
}

function DirectTransfersPanel({
  crowdfundingInfo,
  programAddress,
  isOwner,
  currency,
  symbol,
  decimals,
  orgAddress,
}: {
  crowdfundingInfo: CrowdfundingInfo;
  programAddress: Address;
  isOwner: boolean;
  currency: DonationCurrency | undefined;
  symbol: string;
  decimals: number;
  orgAddress: Address | undefined;
}) {
  const [returnTo, setReturnTo] = useState("");
  const [returnAmount, setReturnAmount] = useState("");
  const [sweepTo, setSweepTo] = useState("");
  const [isPending, setIsPending] = useState(false);
  const { write: sponsoredWrite } = useSponsoredWrite(orgAddress);

  const { data: cfBalance, refetch: refetchBalance } = useReadContract({
    address: crowdfundingInfo.currency,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [crowdfundingInfo.addr],
    query: { refetchInterval: 5000 },
  });

  const balance = (cfBalance as bigint | undefined) ?? 0n;
  const directTransfers = balance > crowdfundingInfo.totalTracked ? balance - crowdfundingInfo.totalTracked : 0n;
  const isCancelled = crowdfundingInfo.state === 2;
  const canSweep = isCancelled && directTransfers > 0n;
  const sweepable = canSweep ? directTransfers : 0n;

  // Owner-only panel; non-owners see the direct-transfer total inline in the Crowdfunding card.
  if (!isOwner) return null;
  if (directTransfers === 0n) return null;

  const handleReturn = async () => {
    if (isPending) return;
    if (!isAddress(returnTo)) {
      notification.error("Invalid recipient address");
      return;
    }
    let amount: bigint;
    try {
      amount = parseUnits(returnAmount, decimals);
    } catch {
      notification.error("Invalid amount");
      return;
    }
    if (amount <= 0n || amount > directTransfers) {
      notification.error(`Amount must be between 0 and ${formatUnits(directTransfers, decimals)} ${symbol}`);
      return;
    }
    setIsPending(true);
    try {
      const success = await sponsoredWrite({
        address: programAddress,
        abi: cgProgramAbi,
        functionName: "returnUntracked",
        args: [returnTo as Address, amount],
        sponsored: false,
      });
      if (success) {
        setReturnTo("");
        setReturnAmount("");
        refetchBalance();
      }
    } finally {
      setIsPending(false);
    }
  };

  const handleSweep = async () => {
    if (isPending) return;
    if (!isAddress(sweepTo)) {
      notification.error("Invalid recipient address");
      return;
    }
    setIsPending(true);
    try {
      const success = await sponsoredWrite({
        address: programAddress,
        abi: cgProgramAbi,
        functionName: "sweepUntracked",
        args: [sweepTo as Address],
        sponsored: false,
      });
      if (success) {
        setSweepTo("");
        refetchBalance();
      }
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="mt-4 p-4 rounded-xl bg-base-200 border border-base-300 flex flex-col gap-3">
      {directTransfers > 0n && (
        <div className="flex flex-col">
          <p className="text-sm font-medium">Refund direct transfers</p>
          <p className="text-xs opacity-60">
            Manually return direct transfers to a sender you identified off-chain. Limited to the direct-transfer
            balance — tracked donations are always reserved for refunds.
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="grow">
              <AddressInputWithQr value={returnTo} onChange={setReturnTo} placeholder="Recipient address" />
            </div>
            <input
              type="number"
              className="input input-bordered sm:w-40"
              value={returnAmount}
              onChange={e => setReturnAmount(e.target.value)}
              placeholder={`Amount (${symbol})`}
              min="0"
              step="any"
            />
            <button
              className="btn btn-secondary"
              onClick={handleReturn}
              disabled={isPending || !returnTo || !returnAmount}
            >
              Return
            </button>
          </div>
        </div>
      )}

      {canSweep && (
        <div className="flex flex-col gap-2 border-t border-base-300 pt-3">
          <p className="text-sm font-medium">Sweep non-refundable balance</p>
          <p className="text-xs opacity-60">
            Crowdfunding is cancelled. {formatUnits(sweepable, decimals)} <CurrencyLogo currency={currency} size={12} />{" "}
            {symbol} can be swept to a recovery address. The contract always reserves tracked balance for donor refunds.
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="grow">
              <AddressInputWithQr value={sweepTo} onChange={setSweepTo} placeholder="Recovery address" />
            </div>
            <button className="btn btn-warning" onClick={handleSweep} disabled={isPending || !sweepTo}>
              Sweep
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SetCrowdfundingForm({
  programAddress,
  orgAddress,
}: {
  programAddress: Address;
  orgAddress: Address | undefined;
}) {
  const { chainId } = useAccount();
  const publicClient = usePublicClient();
  const currencies = getDonationCurrencies(chainId);
  const [currencyAddress, setCurrencyAddress] = useState<Address | "">(currencies[0]?.address ?? "");
  const [target, setTarget] = useState("");
  const [deadlineDays, setDeadlineDays] = useState("");
  const write = useCGProgramWrite(programAddress, orgAddress);

  const selected: DonationCurrency | undefined = currencies.find(c => c.address === currencyAddress);

  const handleSet = async () => {
    if (!target || !deadlineDays || !selected) return;
    const days = Number(deadlineDays);
    if (!Number.isFinite(days) || days <= 0) {
      notification.error("Deadline must be at least 1 day");
      return;
    }
    let amount: bigint;
    try {
      amount = parseUnits(target, selected.decimals);
    } catch {
      notification.error("Invalid target amount");
      return;
    }
    if (amount <= 0n) {
      notification.error("Target must be positive");
      return;
    }

    // Use the chain's current block timestamp as the base — the local node's clock can drift
    // from wall-clock after tests run `time.increaseTo`, which would make Date.now() too early.
    let baseTs: bigint;
    try {
      const block = await publicClient!.getBlock();
      baseTs = block.timestamp;
    } catch {
      baseTs = BigInt(Math.floor(Date.now() / 1000));
    }
    const deadlineTimestamp = baseTs + BigInt(Math.floor(days * 86400));
    const success = await write("setCrowdfunding", [selected.address, amount, deadlineTimestamp]);
    if (success) {
      setTarget("");
      setDeadlineDays("");
    }
  };

  if (currencies.length === 0) {
    return (
      <div className="mt-4 border-t border-base-300 pt-4">
        <div role="alert" className="alert alert-warning text-sm">
          <span>No donation currencies are configured for this network.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 border-t border-base-300 pt-4">
      <p className="font-semibold mb-2">Set Crowdfunding</p>
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="grow">
          <label className="label">
            <span className="label-text">Currency</span>
          </label>
          <select
            className="select select-bordered w-full"
            value={currencyAddress}
            onChange={e => setCurrencyAddress(e.target.value as Address)}
          >
            {currencies.map(c => (
              <option key={c.address} value={c.address}>
                {c.symbol} — {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grow">
          <label className="label">
            <span className="label-text flex items-center gap-1.5">
              Target (<CurrencyLogo currency={selected} /> {selected?.symbol ?? ""})
            </span>
          </label>
          <input
            type="number"
            className="input input-bordered w-full"
            value={target}
            onChange={e => setTarget(e.target.value)}
            placeholder="1000"
            min="0"
            step="any"
          />
        </div>
        <div className="grow">
          <label className="label">
            <span className="label-text">Deadline (days from now)</span>
          </label>
          <input
            type="number"
            className="input input-bordered w-full"
            value={deadlineDays}
            onChange={e => setDeadlineDays(e.target.value)}
            placeholder="30"
          />
        </div>
        <div className="flex items-end">
          <button className="btn btn-secondary" onClick={handleSet} disabled={!target || !deadlineDays || !selected}>
            Set
          </button>
        </div>
      </div>
    </div>
  );
}

function DistributionsSection({
  distributions,
  tokenTypes,
  programAddress,
  isActive,
  isOwner,
  crowdfundingHasContributions,
  orgAddress,
}: {
  distributions: DistributionInfo[];
  tokenTypes: TokenTypeInfo[];
  programAddress: Address;
  isActive: boolean;
  isOwner: boolean;
  crowdfundingHasContributions: boolean;
  orgAddress: Address | undefined;
}) {
  const [showNewForm, setShowNewForm] = useState(false);

  return (
    <div>
      <div className="flex items-center justify-between">
        <h3 className="card-title">Distributions ({distributions.length})</h3>
        {isOwner && isActive && !showNewForm && tokenTypes.length > 0 && (
          <button className="btn btn-sm btn-secondary" onClick={() => setShowNewForm(true)}>
            New Distribution
          </button>
        )}
      </div>

      {isOwner && isActive && tokenTypes.length === 0 && (
        <p className="text-sm opacity-60 mt-2">Create at least one token type above before creating distributions.</p>
      )}

      {showNewForm && (
        <NewDistributionForm
          programAddress={programAddress}
          nextIndex={distributions.length}
          tokenTypes={tokenTypes}
          onDone={() => setShowNewForm(false)}
          orgAddress={orgAddress}
        />
      )}

      {distributions.length === 0 && !showNewForm ? (
        <p className="opacity-60 mt-2">No distributions yet.</p>
      ) : (
        <div className="flex flex-col gap-4 mt-2">
          {distributions.map((dist, i) => {
            const distState = DISTRIBUTION_STATES[dist.state] ?? "Unknown";
            const tokenType = tokenTypes.find(tt => tt.tokenId === dist.tokenId);
            return (
              <DistributionItem
                key={i}
                dist={dist}
                index={i}
                distState={distState}
                tokenType={tokenType}
                programAddress={programAddress}
                isActive={isActive}
                isOwner={isOwner}
                crowdfundingHasContributions={crowdfundingHasContributions}
                orgAddress={orgAddress}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function NewDistributionForm({
  programAddress,
  nextIndex,
  tokenTypes,
  onDone,
  orgAddress,
}: {
  programAddress: Address;
  nextIndex: number;
  tokenTypes: TokenTypeInfo[];
  onDone: () => void;
  orgAddress: Address | undefined;
}) {
  const [entries, setEntries] = useState<UserEntry[]>([{ id: crypto.randomUUID(), address: "", amount: "" }]);
  const [selectedTokenId, setSelectedTokenId] = useState<bigint>(tokenTypes[0]?.tokenId ?? 0n);
  const [isPending, setIsPending] = useState(false);
  const write = useCGProgramWrite(programAddress, orgAddress);

  const selectedTokenType = tokenTypes.find(tt => tt.tokenId === selectedTokenId);
  const isNft = selectedTokenType?.maxSupply === 1n;

  const handleCreate = async () => {
    const finalEntries = isNft ? entries.map(e => ({ ...e, amount: "1" })) : entries;
    const validated = validateUsers(finalEntries);
    if (!validated) return;

    setIsPending(true);
    try {
      const created = await write("createDistribution", [selectedTokenId]);
      if (!created) return;
      await write("setBeneficiaries", [BigInt(nextIndex), validated.addresses, validated.amounts]);
      notification.success("Distribution created with users");
      onDone();
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="border border-secondary rounded-xl p-4 mt-3">
      <div className="flex items-center justify-between mb-3">
        <span className="font-semibold">New Distribution</span>
        <button className="btn btn-sm btn-ghost" onClick={onDone}>
          Cancel
        </button>
      </div>

      <div className="mb-3">
        <label className="label">
          <span className="label-text">Token Type</span>
        </label>
        <select
          className="select select-bordered w-full max-w-xs"
          value={selectedTokenId.toString()}
          onChange={e => setSelectedTokenId(BigInt(e.target.value))}
        >
          {tokenTypes.map(tt => (
            <option key={tt.tokenId.toString()} value={tt.tokenId.toString()}>
              #{tt.tokenId.toString()} — {tt.name} ({tt.symbol}){" "}
              {tt.maxSupply === 0n ? "" : tt.maxSupply === 1n ? "· NFT" : `· Max ${tt.maxSupply}`}
            </option>
          ))}
        </select>
      </div>

      <UsersTableEditor entries={entries} onChange={setEntries} hideAmount={isNft} />
      <div className="mt-3">
        <button className="btn btn-primary btn-sm" onClick={handleCreate} disabled={isPending}>
          {isPending ? <span className="loading loading-spinner loading-xs" /> : "Create Distribution"}
        </button>
      </div>
    </div>
  );
}

function DistributionItem({
  dist,
  index,
  distState,
  tokenType,
  programAddress,
  isActive,
  isOwner,
  crowdfundingHasContributions,
  orgAddress,
}: {
  dist: DistributionInfo;
  index: number;
  distState: string;
  tokenType: TokenTypeInfo | undefined;
  programAddress: Address;
  isActive: boolean;
  isOwner: boolean;
  crowdfundingHasContributions: boolean;
  orgAddress: Address | undefined;
}) {
  const [showLockConfirm, setShowLockConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [editMode, setEditMode] = useState<"none" | "set" | "add" | "remove">("none");
  const write = useCGProgramWrite(programAddress, orgAddress);
  const distLink = useBlockExplorerLink(dist.addr);

  const deleteDisabledReason =
    crowdfundingHasContributions && dist.state !== 0
      ? "Crowdfunding has started — distributions cannot be removed"
      : null;

  const handleLockConfirm = async () => {
    const success = await write("markDistributionReady", [BigInt(index)]);
    if (success) setShowLockConfirm(false);
  };

  const handleDeleteConfirm = async () => {
    const success = await write("deleteDistribution", [BigInt(index)]);
    if (success) setShowDeleteConfirm(false);
  };

  return (
    <div className="border border-base-300 rounded-xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <span className="font-semibold">Distribution #{index}</span>
          {tokenType && (
            <span className="badge badge-outline badge-sm">
              {tokenType.name} ({tokenType.symbol})
            </span>
          )}
          <AddressDisplay address={dist.addr} blockExplorerAddressLink={distLink} />
        </div>
        <div className="flex items-center gap-2">
          <span className={`badge ${STATE_COLORS[distState] ?? "badge-ghost"}`}>{distState}</span>
          {isOwner && isActive && dist.state !== 2 && (
            <div className="tooltip tooltip-left" data-tip={deleteDisabledReason ?? "Delete distribution"}>
              <button
                className="btn btn-ghost btn-xs text-error"
                disabled={deleteDisabledReason !== null}
                onClick={() => setShowDeleteConfirm(true)}
                aria-label="Delete distribution"
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      </div>
      {tokenType?.maxSupply !== 1n && (
        <div className="text-sm">
          <span className="opacity-60">Total required:</span>{" "}
          <span className="font-mono">{dist.totalRequired.toString()} tokens</span>
        </div>
      )}

      {dist.beneficiaries.length > 0 && editMode !== "set" && editMode !== "remove" && (
        <div className="mt-3">
          <p className="text-sm opacity-60 mb-1">Users ({dist.beneficiaryCount.toString()})</p>
          <UsersReadTable users={dist.beneficiaries} amounts={dist.amounts} />
        </div>
      )}

      {isOwner && isActive && dist.state !== 2 && (
        <div className="mt-3">
          {editMode === "none" ? (
            <div className="flex gap-2 flex-wrap">
              {dist.state === 0 && (
                <>
                  <button className="btn btn-sm btn-outline" onClick={() => setEditMode("add")}>
                    + Add
                  </button>
                  {dist.beneficiaryCount > 0n && (
                    <>
                      <button className="btn btn-sm btn-outline btn-error" onClick={() => setEditMode("remove")}>
                        - Remove
                      </button>
                      <button className="btn btn-sm btn-outline" onClick={() => setEditMode("set")}>
                        Replace All
                      </button>
                      <button className="btn btn-sm btn-accent" onClick={() => setShowLockConfirm(true)}>
                        Confirm and Lock User List
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          ) : editMode === "set" ? (
            <EditUsersForm
              programAddress={programAddress}
              distributionIndex={index}
              tokenType={tokenType}
              existingUsers={dist.beneficiaries}
              existingAmounts={dist.amounts}
              onClose={() => setEditMode("none")}
              orgAddress={orgAddress}
            />
          ) : editMode === "add" ? (
            <AddUsersForm
              programAddress={programAddress}
              distributionIndex={index}
              tokenType={tokenType}
              onClose={() => setEditMode("none")}
              orgAddress={orgAddress}
            />
          ) : editMode === "remove" ? (
            <RemoveUsersPanel
              programAddress={programAddress}
              distributionIndex={index}
              users={dist.beneficiaries}
              amounts={dist.amounts}
              onClose={() => setEditMode("none")}
              orgAddress={orgAddress}
            />
          ) : null}
        </div>
      )}

      {/* Lock confirmation modal */}
      {showLockConfirm && (
        <div className="modal modal-open">
          <div className="modal-box">
            <h3 className="font-bold text-lg">Lock User List</h3>
            <p className="py-4">
              This will permanently lock the user list for Distribution #{index}. This action cannot be undone.
            </p>
            <div className="modal-action">
              <button className="btn btn-ghost" onClick={() => setShowLockConfirm(false)}>
                Cancel
              </button>
              <button className="btn btn-accent" onClick={handleLockConfirm}>
                Confirm and Lock
              </button>
            </div>
          </div>
          <div className="modal-backdrop" onClick={() => setShowLockConfirm(false)} />
        </div>
      )}

      {/* Delete distribution confirmation modal */}
      {showDeleteConfirm && (
        <div className="modal modal-open">
          <div className="modal-box">
            <h3 className="font-bold text-lg">Delete Distribution</h3>
            <p className="py-4">
              Are you sure you want to delete Distribution #{index}? It will be permanently removed from the program.
            </p>
            <div className="modal-action">
              <button className="btn btn-ghost" onClick={() => setShowDeleteConfirm(false)}>
                Go Back
              </button>
              <button className="btn btn-error" onClick={handleDeleteConfirm}>
                Delete Distribution
              </button>
            </div>
          </div>
          <div className="modal-backdrop" onClick={() => setShowDeleteConfirm(false)} />
        </div>
      )}
    </div>
  );
}

function UsersReadTable({ users, amounts }: { users: Address[]; amounts: bigint[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="table table-xs">
        <thead>
          <tr>
            <th>Account</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {users.map((b, j) => (
            <UserRow key={b} address={b} amount={amounts[j]} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UserRow({ address, amount }: { address: Address; amount: bigint }) {
  const link = useBlockExplorerLink(address);
  return (
    <tr>
      <td>
        <AddressDisplay address={address} blockExplorerAddressLink={link} />
      </td>
      <td className="font-mono">{amount.toString()} tokens</td>
    </tr>
  );
}

function WarningIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className={`h-5 w-5 shrink-0 ${className}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
      />
    </svg>
  );
}

// Common CSV delimiters in the wild: comma (RFC4180), semicolon (Excel in
// many EU locales), tab (TSV exports), pipe (data feeds).
const CSV_SEPARATORS = [",", ";", "\t", "|"] as const;

// Counts how many times `sep` appears at the top level of `line`, ignoring
// any occurrences inside double-quoted regions (with "" as escaped quote).
function countSeparatorOutsideQuotes(line: string, sep: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i++;
        continue;
      }
      inQuotes = !inQuotes;
    } else if (!inQuotes && c === sep) {
      count++;
    }
  }
  return count;
}

// Picks the most plausible separator by sampling the first non-empty lines,
// preferring whichever yields the highest and most consistent column count.
function detectCsvSeparator(text: string): string {
  const sample = text
    .split(/\r?\n/)
    .filter(l => l.trim().length > 0)
    .slice(0, 20);
  if (sample.length === 0) return ",";
  let best = ",";
  let bestScore = -Infinity;
  for (const sep of CSV_SEPARATORS) {
    const counts = sample.map(l => countSeparatorOutsideQuotes(l, sep));
    const total = counts.reduce((a, b) => a + b, 0);
    if (total === 0) continue;
    const avg = total / counts.length;
    const variance = counts.reduce((acc, n) => acc + (n - avg) ** 2, 0) / counts.length;
    const score = avg - variance; // reward many separators, penalise inconsistent rows
    if (score > bestScore) {
      bestScore = score;
      best = sep;
    }
  }
  return best;
}

// RFC4180-flavoured parser: handles quoted cells, "" escapes, and CRLF/LF.
function parseCsv(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let cellHasOpenedQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"' && cell.length === 0 && !cellHasOpenedQuote) {
      inQuotes = true;
      cellHasOpenedQuote = true;
      continue;
    }
    if (c === "\r") continue;
    if (c === "\n") {
      row.push(cell);
      cell = "";
      cellHasOpenedQuote = false;
      rows.push(row);
      row = [];
      continue;
    }
    if (c === sep) {
      row.push(cell);
      cell = "";
      cellHasOpenedQuote = false;
      continue;
    }
    cell += c;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter(r => r.some(c => c.trim().length > 0));
}

function UsersTableEditor({
  entries,
  onChange,
  hideAmount = false,
}: {
  entries: UserEntry[];
  onChange: (entries: UserEntry[]) => void;
  hideAmount?: boolean;
}) {
  const updateEntry = (index: number, field: keyof UserEntry, value: string) => {
    const updated = [...entries];
    updated[index] = { ...updated[index], [field]: value };
    onChange(updated);
  };

  const addRow = () => onChange([...entries, { id: crypto.randomUUID(), address: "", amount: "" }]);

  const removeRow = (index: number) => onChange(entries.filter((_, i) => i !== index));

  const handleDownload = () => {
    const header = hideAmount ? "address" : "address,amount";
    const rows = entries
      .filter(e => e.address || e.amount)
      .map(e => (hideAmount ? e.address : `${e.address},${e.amount}`));
    const csv = [header, ...rows].join("\n") + "\n";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "users.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      // Strip a leading UTF-8 BOM (Excel-style exports).
      const text = String(reader.result ?? "").replace(/^﻿/, "");
      const sep = detectCsvSeparator(text);
      const rows = parseCsv(text, sep);
      if (rows.length === 0) {
        notification.error("CSV is empty");
        return;
      }
      const firstCell = rows[0][0]?.trim().toLowerCase() ?? "";
      const dataRows = firstCell.startsWith("0x") ? rows : rows.slice(1);
      if (dataRows.length === 0) {
        notification.error("No user rows found in CSV");
        return;
      }
      const parsed: UserEntry[] = dataRows.map(cells => ({
        id: crypto.randomUUID(),
        address: (cells[0] ?? "").trim(),
        amount: hideAmount ? "1" : (cells[1] ?? "").trim(),
      }));
      onChange(parsed);
      const sepName = sep === "\t" ? "tab" : sep === "," ? "comma" : sep === ";" ? "semicolon" : "pipe";
      notification.success(
        `Loaded ${parsed.length} user${parsed.length === 1 ? "" : "s"} from CSV (${sepName}-separated)`,
      );
    };
    reader.readAsText(file);
  };

  const hasContent = entries.some(e => e.address || e.amount);

  return (
    <>
      <div className="flex flex-wrap gap-2 mb-2">
        <label className="btn btn-xs btn-outline gap-1 cursor-pointer">
          <ArrowUpTrayIcon className="h-3.5 w-3.5" />
          Upload CSV
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={handleUpload} />
        </label>
        <button type="button" className="btn btn-xs btn-outline gap-1" onClick={handleDownload} disabled={!hasContent}>
          <ArrowDownTrayIcon className="h-3.5 w-3.5" />
          Download CSV
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="table table-sm">
          <thead>
            <tr>
              <th className={hideAmount ? "w-11/12" : "w-7/12"}>Account</th>
              {!hideAmount && <th className="w-4/12">Amount (tokens)</th>}
              <th className="w-1/12" />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, i) => (
              <tr key={entry.id}>
                <td>
                  <AddressInputWithQr
                    value={entry.address}
                    onChange={val => updateEntry(i, "address", val)}
                    placeholder="0x..."
                  />
                </td>
                {!hideAmount && (
                  <td>
                    <input
                      type="number"
                      className="input input-bordered input-sm w-full"
                      value={entry.amount}
                      onChange={e => updateEntry(i, "amount", e.target.value)}
                      placeholder="1"
                      min="1"
                      step="1"
                    />
                  </td>
                )}
                <td>
                  <button
                    className="btn btn-ghost btn-xs text-error"
                    onClick={() => removeRow(i)}
                    disabled={entries.length <= 1}
                  >
                    X
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="btn btn-ghost btn-xs mt-1" onClick={addRow}>
          + Add row
        </button>
      </div>
    </>
  );
}

function EditUsersForm({
  programAddress,
  distributionIndex,
  tokenType,
  existingUsers,
  existingAmounts,
  onClose,
  orgAddress,
}: {
  programAddress: Address;
  distributionIndex: number;
  tokenType: TokenTypeInfo | undefined;
  existingUsers: Address[];
  existingAmounts: bigint[];
  onClose: () => void;
  orgAddress: Address | undefined;
}) {
  const [entries, setEntries] = useState<UserEntry[]>(() =>
    existingUsers.length > 0
      ? existingUsers.map((addr, i) => ({
          id: crypto.randomUUID(),
          address: addr,
          amount: existingAmounts[i]?.toString() ?? "1",
        }))
      : [{ id: crypto.randomUUID(), address: "", amount: "" }],
  );
  const write = useCGProgramWrite(programAddress, orgAddress);
  const isNft = tokenType?.maxSupply === 1n;

  const handleSet = async () => {
    const finalEntries = isNft ? entries.map(e => ({ ...e, amount: "1" })) : entries;
    const validated = validateUsers(finalEntries);
    if (!validated) return;

    const success = await write("setBeneficiaries", [
      BigInt(distributionIndex),
      validated.addresses,
      validated.amounts,
    ]);
    if (success) onClose();
  };

  return (
    <div className="flex flex-col gap-2 w-full border border-base-300 rounded-lg p-3">
      <p className="text-sm font-medium opacity-70">Replace entire user list</p>
      <UsersTableEditor entries={entries} onChange={setEntries} hideAmount={isNft} />
      <div className="flex gap-2">
        <button className="btn btn-sm btn-primary" onClick={handleSet}>
          Confirm
        </button>
        <button className="btn btn-sm btn-ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function AddUsersForm({
  programAddress,
  distributionIndex,
  tokenType,
  onClose,
  orgAddress,
}: {
  programAddress: Address;
  distributionIndex: number;
  tokenType: TokenTypeInfo | undefined;
  onClose: () => void;
  orgAddress: Address | undefined;
}) {
  const [entries, setEntries] = useState<UserEntry[]>([{ id: crypto.randomUUID(), address: "", amount: "" }]);
  const write = useCGProgramWrite(programAddress, orgAddress);
  const isNft = tokenType?.maxSupply === 1n;

  const handleAdd = async () => {
    const finalEntries = isNft ? entries.map(e => ({ ...e, amount: "1" })) : entries;
    const validated = validateUsers(finalEntries);
    if (!validated) return;

    const success = await write("addBeneficiaries", [
      BigInt(distributionIndex),
      validated.addresses,
      validated.amounts,
    ]);
    if (success) onClose();
  };

  return (
    <div className="flex flex-col gap-2 w-full border border-base-300 rounded-lg p-3">
      <p className="text-sm font-medium">Add Users</p>
      <UsersTableEditor entries={entries} onChange={setEntries} hideAmount={isNft} />
      <div className="flex gap-2">
        <button className="btn btn-sm btn-primary" onClick={handleAdd}>
          Confirm
        </button>
        <button className="btn btn-sm btn-ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function RemoveUsersPanel({
  programAddress,
  distributionIndex,
  users,
  amounts,
  onClose,
  orgAddress,
}: {
  programAddress: Address;
  distributionIndex: number;
  users: Address[];
  amounts: bigint[];
  onClose: () => void;
  orgAddress: Address | undefined;
}) {
  const [selected, setSelected] = useState<Set<Address>>(new Set());
  const write = useCGProgramWrite(programAddress, orgAddress);

  const toggle = (addr: Address) => {
    const next = new Set(selected);
    if (next.has(addr)) next.delete(addr);
    else next.add(addr);
    setSelected(next);
  };

  const toggleAll = (checked: boolean) => setSelected(checked ? new Set(users) : new Set());

  const handleRemove = async () => {
    if (selected.size === 0) return;
    const success = await write("removeBeneficiaries", [BigInt(distributionIndex), [...selected]]);
    if (success) onClose();
  };

  return (
    <div className="flex flex-col gap-2 w-full border border-error/30 rounded-lg p-3">
      <p className="text-sm font-medium">Select users to remove</p>
      <div className="overflow-x-auto">
        <table className="table table-xs">
          <thead>
            <tr>
              <th className="w-8">
                <input
                  type="checkbox"
                  className="checkbox checkbox-xs"
                  checked={selected.size === users.length && users.length > 0}
                  onChange={e => toggleAll(e.target.checked)}
                />
              </th>
              <th>Account</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            {users.map((b, j) => (
              <RemovableRow
                key={b}
                address={b}
                amount={amounts[j]}
                checked={selected.has(b)}
                onToggle={() => toggle(b)}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2 items-center">
        <button className="btn btn-sm btn-error" onClick={handleRemove} disabled={selected.size === 0}>
          Remove{selected.size > 0 ? ` (${selected.size})` : ""}
        </button>
        <button className="btn btn-sm btn-ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function RemovableRow({
  address,
  amount,
  checked,
  onToggle,
}: {
  address: Address;
  amount: bigint;
  checked: boolean;
  onToggle: () => void;
}) {
  const link = useBlockExplorerLink(address);
  return (
    <tr>
      <td>
        <input type="checkbox" className="checkbox checkbox-xs" checked={checked} onChange={onToggle} />
      </td>
      <td>
        <AddressDisplay address={address} blockExplorerAddressLink={link} />
      </td>
      <td className="font-mono">{amount.toString()} tokens</td>
    </tr>
  );
}

function getExecuteDisabledReason(
  crowdfundingInfo: CrowdfundingInfo | undefined,
  distributions: DistributionInfo[],
): string | null {
  const hasCrowdfunding = crowdfundingInfo && !isAddressEqual(crowdfundingInfo.addr, zeroAddress);
  if (!hasCrowdfunding) return "No crowdfunding configured";
  if (distributions.length === 0) return "No distributions created";
  if (crowdfundingInfo.state !== 0) return "Crowdfunding is no longer active";
  if (!crowdfundingInfo.isFunded) return "Crowdfunding has not reached its target yet";

  const notReadyIndex = distributions.findIndex(d => d.state !== 1);
  if (notReadyIndex !== -1) return `Distribution #${notReadyIndex} is not ready`;

  return null;
}

function OwnerActions({
  address,
  crowdfundingInfo,
  distributions,
  orgAddress,
}: {
  address: Address;
  crowdfundingInfo: CrowdfundingInfo | undefined;
  distributions: DistributionInfo[];
  orgAddress: Address | undefined;
}) {
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showTransferConfirm, setShowTransferConfirm] = useState(false);
  const [newOwner, setNewOwner] = useState("");
  const [isPending, setIsPending] = useState(false);
  const write = useCGProgramWrite(address, orgAddress);

  const executeDisabledReason = getExecuteDisabledReason(crowdfundingInfo, distributions);
  const canExecute = executeDisabledReason === null;

  const handleCancelConfirm = async () => {
    setIsPending(true);
    const success = await write("cancel");
    setIsPending(false);
    if (success) setShowCancelConfirm(false);
  };

  const handleTransferConfirm = async () => {
    if (!isAddress(newOwner)) {
      notification.error("Invalid address");
      return;
    }
    setIsPending(true);
    const success = await write("transferOwnership", [newOwner]);
    setIsPending(false);
    if (success) {
      setShowTransferConfirm(false);
      setNewOwner("");
    }
  };

  return (
    <div>
      <div className="divider" />
      <h3 className="card-title">Owner Actions</h3>
      <div className="flex gap-3 mt-4">
        <div
          className="tooltip tooltip-bottom"
          data-tip={
            canExecute
              ? "Withdraw crowdfunded funds to the owner and distribute tokens to all users."
              : executeDisabledReason
          }
        >
          <button className="btn btn-primary" onClick={() => write("execute")} disabled={!canExecute}>
            Execute Program
          </button>
        </div>
        <div
          className="tooltip tooltip-bottom"
          data-tip="Permanently cancel the program. Contributors will be able to claim refunds."
        >
          <button className="btn btn-error" onClick={() => setShowCancelConfirm(true)}>
            Cancel Program
          </button>
        </div>
        <div>
          <button className="btn btn-warning" onClick={() => setShowTransferConfirm(true)}>
            Transfer Ownership
          </button>
        </div>
      </div>

      {/* Cancel program confirmation modal */}
      {showCancelConfirm && (
        <div className="modal modal-open">
          <div className="modal-box">
            <h3 className="font-bold text-lg">Cancel Program</h3>
            <div role="alert" className="alert alert-error my-4 py-2 text-sm">
              <WarningIcon />
              <span>
                This will permanently cancel the program. Contributors will be able to claim refunds. This action cannot
                be undone.
              </span>
            </div>
            <div className="modal-action">
              <button className="btn btn-ghost" onClick={() => setShowCancelConfirm(false)} disabled={isPending}>
                Go Back
              </button>
              <button className="btn btn-error" onClick={handleCancelConfirm} disabled={isPending}>
                {isPending && <span className="loading loading-spinner loading-sm" />}
                Confirm Cancellation
              </button>
            </div>
          </div>
          <div className="modal-backdrop" onClick={() => !isPending && setShowCancelConfirm(false)} />
        </div>
      )}

      {/* Transfer ownership confirmation modal */}
      {showTransferConfirm && (
        <div className="modal modal-open">
          <div className="modal-box">
            <h3 className="font-bold text-lg">Transfer Ownership</h3>
            <div role="alert" className="alert alert-warning my-4 py-2 text-sm">
              <WarningIcon />
              <span>
                You will permanently lose control of this program. Make sure the new owner address is correct.
              </span>
            </div>
            <div>
              <label className="label">
                <span className="label-text">New Owner Address</span>
              </label>
              <AddressInputWithQr value={newOwner} onChange={setNewOwner} placeholder="0x..." />
            </div>
            <div className="modal-action">
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setShowTransferConfirm(false);
                  setNewOwner("");
                }}
                disabled={isPending}
              >
                Cancel
              </button>
              <button
                className="btn btn-warning"
                onClick={handleTransferConfirm}
                disabled={!isAddress(newOwner) || isPending}
              >
                {isPending && <span className="loading loading-spinner loading-sm" />}
                Transfer Ownership
              </button>
            </div>
          </div>
          <div
            className="modal-backdrop"
            onClick={() => {
              if (isPending) return;
              setShowTransferConfirm(false);
              setNewOwner("");
            }}
          />
        </div>
      )}
    </div>
  );
}

function ChoiceCard({
  active,
  onClick,
  icon,
  title,
  description,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left p-4 rounded-xl border-2 transition-all flex gap-3 items-start ${
        active
          ? "border-primary bg-primary/10 shadow-md ring-1 ring-primary"
          : "border-base-300 bg-base-100 shadow-sm hover:border-primary/40 hover:shadow"
      }`}
    >
      <span className={active ? "text-primary shrink-0" : "opacity-70 shrink-0"}>{icon}</span>
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="font-semibold">{title}</span>
        <span className="text-xs opacity-70">{description}</span>
      </div>
    </button>
  );
}

function CreateTokenTypeForm({
  programAddress,
  orgAddress,
  onDone,
}: {
  programAddress: Address;
  orgAddress: Address | undefined;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [availability, setAvailability] = useState<"unlimited" | "limited">("unlimited");
  const [limitedKind, setLimitedKind] = useState<"unique" | "capped">("unique");
  const [cap, setCap] = useState("");
  const [uri, setUri] = useState("");
  const [transferable, setTransferable] = useState(true);
  const [burnable, setBurnable] = useState(true);
  const write = useCGProgramWrite(programAddress, orgAddress);

  const resetForm = () => {
    setName("");
    setSymbol("");
    setAvailability("unlimited");
    setLimitedKind("unique");
    setCap("");
    setUri("");
    setTransferable(true);
    setBurnable(true);
  };

  const handleCreate = async () => {
    if (!name || !symbol) {
      notification.error("Name and symbol are required");
      return;
    }
    let supply: bigint;
    if (availability === "unlimited") {
      supply = 0n;
    } else if (limitedKind === "unique") {
      supply = 1n;
    } else {
      const n = Number(cap);
      if (!cap || !Number.isInteger(n) || n < 2) {
        notification.error("Maximum supply must be a whole number ≥ 2");
        return;
      }
      supply = BigInt(n);
    }
    const success = await write("defineTokenType", [name, symbol, supply, uri, transferable, burnable]);
    if (success) {
      onDone();
      resetForm();
    }
  };

  return (
    <div className="border border-base-300 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="font-semibold">Create Token Type</span>
        <button className="btn btn-sm btn-ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="label">
            <span className="label-text">Name</span>
          </label>
          <input
            type="text"
            className="input input-bordered w-full"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Voucher"
          />
        </div>
        <div>
          <label className="label">
            <span className="label-text">Symbol</span>
          </label>
          <input
            type="text"
            className="input input-bordered w-full"
            value={symbol}
            onChange={e => setSymbol(e.target.value)}
            placeholder="VOUCHER"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="label">
            <span className="label-text">Availability</span>
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">
            <ChoiceCard
              active={availability === "unlimited"}
              onClick={() => setAvailability("unlimited")}
              icon={<ArrowsPointingOutIcon className="h-6 w-6" />}
              title="Unlimited"
              description="No cap on how many tokens of this type can exist. Holders can hold any amount."
            />
            {availability === "limited" ? (
              <div className="rounded-xl border-2 border-primary bg-primary/10 shadow-md ring-1 ring-primary p-4 flex flex-col gap-3">
                <div className="flex gap-3 items-start">
                  <span className="text-primary shrink-0">
                    <LockClosedIcon className="h-6 w-6" />
                  </span>
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="font-semibold">Limited</span>
                    <span className="text-xs opacity-70">Restrict how many tokens of this type can ever exist.</span>
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <ChoiceCard
                    active={limitedKind === "unique"}
                    onClick={() => setLimitedKind("unique")}
                    icon={<SparklesIcon className="h-5 w-5" />}
                    title="Unique (1 of 1)"
                    description="Exactly one token will ever exist — a one-of-a-kind certificate."
                  />
                  <ChoiceCard
                    active={limitedKind === "capped"}
                    onClick={() => setLimitedKind("capped")}
                    icon={<HashtagIcon className="h-5 w-5" />}
                    title="Capped"
                    description="A fixed maximum of tokens. Once reached, no more can be minted."
                  />
                  {limitedKind === "capped" && (
                    <div className="flex flex-col gap-1">
                      <label className="text-xs opacity-70">Maximum supply</label>
                      <input
                        type="number"
                        className="input input-bordered w-full sm:max-w-xs"
                        value={cap}
                        onChange={e => setCap(e.target.value)}
                        placeholder="100"
                        min="2"
                        step="1"
                      />
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <ChoiceCard
                active={false}
                onClick={() => setAvailability("limited")}
                icon={<LockClosedIcon className="h-6 w-6" />}
                title="Limited"
                description="Restrict how many tokens of this type can ever exist."
              />
            )}
          </div>
        </div>
        <div>
          <label className="label">
            <span className="label-text">
              Metadata URI <span className="opacity-60 text-xs">(optional)</span>
            </span>
          </label>
          <input
            type="text"
            className="input input-bordered w-full"
            value={uri}
            onChange={e => setUri(e.target.value)}
            placeholder="ipfs://..."
          />
        </div>
        <div className="flex flex-col gap-2">
          <label className="label">
            <span className="label-text">Token Permissions</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="toggle toggle-sm toggle-primary"
              checked={transferable}
              onChange={e => setTransferable(e.target.checked)}
            />
            <span className="label-text">
              Transferable
              <span className="opacity-60 text-xs ml-1">(holders can transfer to others)</span>
            </span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="toggle toggle-sm toggle-primary"
              checked={burnable}
              onChange={e => setBurnable(e.target.checked)}
            />
            <span className="label-text">
              Burnable
              <span className="opacity-60 text-xs ml-1">(holders can burn/redeem tokens)</span>
            </span>
          </label>
        </div>
      </div>
      <button className="btn btn-secondary btn-sm mt-3" onClick={handleCreate} disabled={!name || !symbol}>
        Create
      </button>
    </div>
  );
}
