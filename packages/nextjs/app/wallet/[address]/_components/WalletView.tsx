"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TopUpModal } from "./TopUpModal";
import { Address as AddressDisplay } from "@scaffold-ui/components";
import { Address, erc20Abi, formatUnits, isAddress, isAddressEqual, parseUnits } from "viem";
import { useAccount, useBalance, useReadContract, useSendTransaction, useWriteContract } from "wagmi";
import { ArrowDownOnSquareIcon } from "@heroicons/react/24/outline";
import { AddressInputWithQr } from "~~/components/AddressInputWithQr";
import { AuthProviderInfo, SignOutButton } from "~~/components/AuthSession";
import { CurrencyLogo } from "~~/components/CurrencyLogo";
import { cgOrganizationAbi } from "~~/contracts/cgOrganizationAbi";
import { cgProgramAbi } from "~~/contracts/cgProgramAbi";
import { cgTokenAbi } from "~~/contracts/cgTokenAbi";
import { DonationCurrency, getDonationCurrencies } from "~~/contracts/donationCurrencies";
import { useBlockExplorerLink, useScaffoldReadContract, useTargetNetwork } from "~~/hooks/scaffold-eth";
import { useCGTokenWrite } from "~~/hooks/useCGTokenWrite";
import { useEffectiveAddress } from "~~/hooks/useEffectiveAddress";
import { useSponsoredGasPreference } from "~~/hooks/useSponsoredGasPreference";
import { getParsedError, notification } from "~~/utils/scaffold-eth";

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// ── Single token row with balance + actions ──────────────────────────────────

function WalletTokenRow({
  walletAddress,
  tokenAddress,
  tokenId,
  programName,
  programAddress,
  orgAddress,
  isOwnWallet,
}: {
  walletAddress: Address;
  tokenAddress: Address;
  tokenId: bigint;
  programName: string;
  programAddress: Address;
  orgAddress: Address;
  isOwnWallet: boolean;
}) {
  const [showTransfer, setShowTransfer] = useState(false);
  const [showBurn, setShowBurn] = useState(false);
  const [transferTo, setTransferTo] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
  const [burnAmount, setBurnAmount] = useState("");
  const write = useCGTokenWrite(tokenAddress, orgAddress);

  const { data: tokenType } = useReadContract({
    address: tokenAddress,
    abi: cgTokenAbi,
    functionName: "getTokenType",
    args: [tokenId],
    query: { refetchInterval: 5000 },
  });

  const { data: balance, refetch: refetchBalance } = useReadContract({
    address: tokenAddress,
    abi: cgTokenAbi,
    functionName: "balanceOf",
    args: [walletAddress, tokenId],
    query: { refetchInterval: 5000 },
  });

  const tt = tokenType as TokenTypeInfo | undefined;
  const userBalance = balance as bigint | undefined;

  if (!tt || userBalance === undefined || userBalance === 0n) return null;

  const handleTransfer = async () => {
    if (!isAddress(transferTo)) {
      notification.error("Invalid recipient address");
      return;
    }
    const amt = Number(transferAmount);
    if (!transferAmount || !Number.isInteger(amt) || amt <= 0) {
      notification.error("Amount must be a positive integer");
      return;
    }
    if (BigInt(amt) > userBalance) {
      notification.error("Amount exceeds balance");
      return;
    }
    const ok = await write("safeTransferFrom", [walletAddress, transferTo as Address, tokenId, BigInt(amt), "0x"]);
    if (ok) {
      setTransferTo("");
      setTransferAmount("");
      setShowTransfer(false);
      refetchBalance();
    }
  };

  const handleBurn = async () => {
    const amt = Number(burnAmount);
    if (!burnAmount || !Number.isInteger(amt) || amt <= 0) {
      notification.error("Amount must be a positive integer");
      return;
    }
    if (BigInt(amt) > userBalance) {
      notification.error("Amount exceeds balance");
      return;
    }
    const ok = await write("burn", [walletAddress, tokenId, BigInt(amt)]);
    if (ok) {
      setBurnAmount("");
      setShowBurn(false);
      refetchBalance();
    }
  };

  const supplyLabel =
    tt.maxSupply === 0n ? "Fungible" : tt.maxSupply === 1n ? "NFT (max 1)" : `Max ${tt.maxSupply.toString()}`;

  return (
    <div className="border border-base-300 rounded-lg p-3 sm:p-4 flex flex-col gap-3 min-w-0">
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        <span className="badge badge-outline badge-sm">#{tokenId.toString()}</span>
        <span className="font-semibold text-base break-all">
          {tt.name} ({tt.symbol})
        </span>
        <span className="badge badge-ghost badge-sm">{supplyLabel}</span>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-sm">
        <span className="opacity-70">
          Program:{" "}
          <Link href={`/program/${programAddress}`} className="link">
            {programName}
          </Link>
        </span>
        <span className="font-medium">
          Balance: <span className="font-bold">{userBalance.toString()}</span>
        </span>
      </div>

      {isOwnWallet && (
        <div className="flex flex-wrap gap-2">
          {tt.transferable && (
            <button
              className="btn btn-sm btn-outline"
              onClick={() => {
                setShowTransfer(v => !v);
                setShowBurn(false);
              }}
            >
              Transfer
            </button>
          )}
          {tt.burnable && (
            <button
              className="btn btn-sm btn-outline btn-error"
              onClick={() => {
                setShowBurn(v => !v);
                setShowTransfer(false);
              }}
            >
              Burn
            </button>
          )}
        </div>
      )}

      {showTransfer && (
        <div className="flex flex-col gap-2 p-3 bg-base-200 rounded-lg">
          <p className="text-sm font-medium">Transfer tokens</p>
          <AddressInputWithQr value={transferTo} onChange={setTransferTo} placeholder="Recipient address" />
          <div className="flex flex-wrap gap-2 items-center">
            <div className="flex flex-1 min-w-[10rem] input input-bordered input-sm items-center pr-1 gap-1">
              <input
                type="number"
                min="1"
                step="1"
                className="flex-1 bg-transparent outline-none min-w-0"
                placeholder="Amount"
                value={transferAmount}
                onChange={e => setTransferAmount(e.target.value)}
              />
              <button
                className="btn btn-ghost btn-xs text-xs px-1 h-5 min-h-0 opacity-60 hover:opacity-100"
                onClick={() => setTransferAmount(userBalance.toString())}
                title="Use full balance"
              >
                Max
              </button>
            </div>
            <button className="btn btn-sm btn-primary" onClick={handleTransfer}>
              Send
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => setShowTransfer(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {showBurn && (
        <div className="flex flex-col gap-2 p-3 bg-base-200 rounded-lg">
          <p className="text-sm font-medium">Burn tokens (irreversible)</p>
          <div className="flex flex-wrap gap-2 items-center">
            <div className="flex flex-1 min-w-[10rem] input input-bordered input-sm items-center pr-1 gap-1">
              <input
                type="number"
                min="1"
                step="1"
                className="flex-1 bg-transparent outline-none min-w-0"
                placeholder="Amount to burn"
                value={burnAmount}
                onChange={e => setBurnAmount(e.target.value)}
              />
              <button
                className="btn btn-ghost btn-xs text-xs px-1 h-5 min-h-0 opacity-60 hover:opacity-100"
                onClick={() => setBurnAmount(userBalance.toString())}
                title="Use full balance"
              >
                Max
              </button>
            </div>
            <button className="btn btn-sm btn-error" onClick={handleBurn}>
              Burn
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => setShowBurn(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tokens within a single program ───────────────────────────────────────────

function ProgramTokens({
  walletAddress,
  programAddress,
  orgAddress,
  isOwnWallet,
}: {
  walletAddress: Address;
  programAddress: Address;
  orgAddress: Address;
  isOwnWallet: boolean;
}) {
  const { data: programName } = useReadContract({
    address: programAddress,
    abi: cgProgramAbi,
    functionName: "name",
    query: { refetchInterval: 30000 },
  });

  const { data: tokenAddress } = useReadContract({
    address: programAddress,
    abi: cgProgramAbi,
    functionName: "token",
    query: { refetchInterval: 30000 },
  });

  const { data: tokenTypes } = useReadContract({
    address: programAddress,
    abi: cgProgramAbi,
    functionName: "getTokenTypes",
    query: { enabled: !!tokenAddress, refetchInterval: 5000 },
  });

  const types = tokenTypes as TokenTypeInfo[] | undefined;

  if (!tokenAddress || !types || types.length === 0) return null;

  return (
    <>
      {types.map(tt => (
        <WalletTokenRow
          key={`${programAddress}-${tt.tokenId}`}
          walletAddress={walletAddress}
          tokenAddress={tokenAddress as Address}
          tokenId={tt.tokenId}
          programName={(programName as string) ?? "Unknown"}
          programAddress={programAddress}
          orgAddress={orgAddress}
          isOwnWallet={isOwnWallet}
        />
      ))}
    </>
  );
}

// ── Programs within a single organization ────────────────────────────────────

function OrgTokens({
  walletAddress,
  orgAddress,
  isOwnWallet,
}: {
  walletAddress: Address;
  orgAddress: Address;
  isOwnWallet: boolean;
}) {
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
        <ProgramTokens
          key={addr}
          walletAddress={walletAddress}
          programAddress={addr}
          orgAddress={orgAddress}
          isOwnWallet={isOwnWallet}
        />
      ))}
    </>
  );
}

// ── Donation currency balance row (renders nothing if zero) ─────────────────

function CurrencyBalanceRow({
  walletAddress,
  currency,
  isOwnWallet,
}: {
  walletAddress: Address;
  currency: DonationCurrency;
  isOwnWallet: boolean;
}) {
  const [showTransfer, setShowTransfer] = useState(false);
  const [showTopUp, setShowTopUp] = useState(false);
  const [transferTo, setTransferTo] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
  const [isPending, setIsPending] = useState(false);
  const { writeContractAsync } = useWriteContract();

  const { data: balance, refetch: refetchBalance } = useReadContract({
    address: currency.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [walletAddress],
    query: { refetchInterval: 5000 },
  });

  // Visitors viewing someone else's wallet don't need to see zero rows; only
  // suppress for them. The wallet owner always sees every supported currency
  // so they can top up.
  const safeBalance = balance ?? 0n;
  if (!isOwnWallet && safeBalance === 0n) return null;

  const handleTransfer = async () => {
    if (!isAddress(transferTo)) {
      notification.error("Invalid recipient address");
      return;
    }
    let amountWei: bigint;
    try {
      amountWei = parseUnits(transferAmount, currency.decimals);
    } catch {
      notification.error("Invalid amount");
      return;
    }
    if (amountWei <= 0n) {
      notification.error("Amount must be positive");
      return;
    }
    if (amountWei > safeBalance) {
      notification.error("Amount exceeds balance");
      return;
    }
    setIsPending(true);
    try {
      await writeContractAsync({
        address: currency.address,
        abi: erc20Abi,
        functionName: "transfer",
        args: [transferTo as Address, amountWei],
      });
      setTransferTo("");
      setTransferAmount("");
      setShowTransfer(false);
      refetchBalance();
    } catch (e) {
      notification.error(getParsedError(e));
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="border border-base-300 rounded-lg p-3 sm:p-4 flex flex-col gap-3 min-w-0">
      <div className="flex flex-wrap items-center gap-2 sm:gap-3 min-w-0">
        <CurrencyLogo currency={currency} size={28} />
        <div className="flex flex-col min-w-0">
          <span className="font-semibold text-base">{currency.symbol}</span>
          <span className="text-xs opacity-60 truncate">{currency.name}</span>
        </div>
        <span className="ml-auto font-mono font-bold text-lg break-all">
          {formatUnits(safeBalance, currency.decimals)}
        </span>
        {isOwnWallet && (
          <div className="flex gap-2 w-full sm:w-auto">
            <button
              className="btn btn-sm btn-outline gap-1 flex-1 sm:flex-none"
              onClick={() => setShowTopUp(true)}
              title={`How to top up ${currency.symbol}`}
            >
              <ArrowDownOnSquareIcon className="h-4 w-4" />
              Receive
            </button>
            <button
              className="btn btn-sm btn-outline flex-1 sm:flex-none"
              onClick={() => setShowTransfer(v => !v)}
              disabled={safeBalance === 0n}
            >
              Transfer
            </button>
          </div>
        )}
      </div>

      {showTransfer && (
        <div className="flex flex-col gap-2 p-3 bg-base-200 rounded-lg">
          <p className="text-sm font-medium flex items-center gap-1.5">
            Transfer <CurrencyLogo currency={currency} /> {currency.symbol}
          </p>
          <AddressInputWithQr value={transferTo} onChange={setTransferTo} placeholder="Recipient address" />
          <div className="flex flex-wrap gap-2 items-center">
            <div className="flex flex-1 min-w-[10rem] input input-bordered input-sm items-center pr-1 gap-1">
              <input
                type="number"
                min="0"
                step="any"
                className="flex-1 bg-transparent outline-none min-w-0"
                placeholder={`Amount (${currency.symbol})`}
                value={transferAmount}
                onChange={e => setTransferAmount(e.target.value)}
              />
              <button
                className="btn btn-ghost btn-xs text-xs px-1 h-5 min-h-0 opacity-60 hover:opacity-100"
                onClick={() => setTransferAmount(formatUnits(safeBalance, currency.decimals))}
                title="Use full balance"
              >
                Max
              </button>
            </div>
            <button className="btn btn-sm btn-primary" disabled={isPending} onClick={handleTransfer}>
              {isPending ? <span className="loading loading-spinner loading-xs" /> : "Send"}
            </button>
            <button className="btn btn-sm btn-ghost" disabled={isPending} onClick={() => setShowTransfer(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {showTopUp && (
        <TopUpModal walletAddress={walletAddress} currency={currency} onClose={() => setShowTopUp(false)} />
      )}
    </div>
  );
}

// ── Native asset row (symbol varies per chain — USDC on Arc, ETH on most L1/L2s) ──

const NATIVE_LOGO_BY_SYMBOL: Record<string, string> = {
  ETH: "/currencies/eth.svg",
  USDC: "/currencies/usdc.svg",
  EURC: "/currencies/eurc.svg",
};

function NativeAssetRow({ walletAddress, isOwnWallet }: { walletAddress: Address; isOwnWallet: boolean }) {
  const [showTopUp, setShowTopUp] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferTo, setTransferTo] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
  const [isPending, setIsPending] = useState(false);
  const { chainId } = useAccount();
  const { targetNetwork } = useTargetNetwork();
  const { sendTransactionAsync } = useSendTransaction();
  const effectiveChainId = chainId ?? targetNetwork.id;
  const { data, refetch: refetchBalance } = useBalance({
    address: walletAddress,
    chainId: effectiveChainId,
    query: { refetchInterval: 5000 },
  });

  const symbol = data?.symbol ?? targetNetwork.nativeCurrency?.symbol ?? "ETH";
  const decimals = data?.decimals ?? targetNetwork.nativeCurrency?.decimals ?? 18;
  const value = data?.value ?? 0n;
  const logoSrc = NATIVE_LOGO_BY_SYMBOL[symbol.toUpperCase()] ?? "/currencies/eth.svg";

  if (!isOwnWallet && value === 0n) return null;

  const handleTransfer = async () => {
    if (!isAddress(transferTo)) {
      notification.error("Invalid recipient address");
      return;
    }
    let amountWei: bigint;
    try {
      amountWei = parseUnits(transferAmount, decimals);
    } catch {
      notification.error("Invalid amount");
      return;
    }
    if (amountWei <= 0n) {
      notification.error("Amount must be positive");
      return;
    }
    if (amountWei > value) {
      notification.error("Amount exceeds balance");
      return;
    }
    setIsPending(true);
    try {
      await sendTransactionAsync({ to: transferTo as Address, value: amountWei });
      setTransferTo("");
      setTransferAmount("");
      setShowTransfer(false);
      refetchBalance();
    } catch (e) {
      notification.error(getParsedError(e));
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="border border-base-300 rounded-lg p-3 sm:p-4 flex flex-col gap-3 min-w-0">
      <div className="flex flex-wrap items-center gap-2 sm:gap-3 min-w-0">
        <span className="inline-flex items-center justify-center w-7 h-7 shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logoSrc} alt={symbol} width={28} height={28} className="inline-block align-middle" />
        </span>
        <div className="flex flex-col min-w-0">
          <span className="font-semibold text-base">{symbol}</span>
          <span className="text-xs opacity-60 truncate">Native Coin</span>
        </div>
        <span className="ml-auto font-mono font-bold text-lg break-all">{formatUnits(value, decimals)}</span>
        {isOwnWallet && (
          <div className="flex gap-2 w-full sm:w-auto">
            <button
              className="btn btn-sm btn-outline gap-1 flex-1 sm:flex-none"
              onClick={() => setShowTopUp(true)}
              title={`How to top up ${symbol}`}
            >
              <ArrowDownOnSquareIcon className="h-4 w-4" />
              Receive
            </button>
            <button
              className="btn btn-sm btn-outline flex-1 sm:flex-none"
              onClick={() => setShowTransfer(v => !v)}
              disabled={value === 0n}
            >
              Transfer
            </button>
          </div>
        )}
      </div>

      {showTransfer && (
        <div className="flex flex-col gap-2 p-3 bg-base-200 rounded-lg">
          <p className="text-sm font-medium flex items-center gap-1.5">Transfer {symbol}</p>
          <AddressInputWithQr value={transferTo} onChange={setTransferTo} placeholder="Recipient address" />
          <div className="flex flex-wrap gap-2 items-center">
            <div className="flex flex-1 min-w-[10rem] input input-bordered input-sm items-center pr-1 gap-1">
              <input
                type="number"
                min="0"
                step="any"
                className="flex-1 bg-transparent outline-none min-w-0"
                placeholder={`Amount (${symbol})`}
                value={transferAmount}
                onChange={e => setTransferAmount(e.target.value)}
              />
              <button
                className="btn btn-ghost btn-xs text-xs px-1 h-5 min-h-0 opacity-60 hover:opacity-100"
                onClick={() => setTransferAmount(formatUnits(value, decimals))}
                title="Use full balance"
              >
                Max
              </button>
            </div>
            <button className="btn btn-sm btn-primary" disabled={isPending} onClick={handleTransfer}>
              {isPending ? <span className="loading loading-spinner loading-xs" /> : "Send"}
            </button>
            <button className="btn btn-sm btn-ghost" disabled={isPending} onClick={() => setShowTransfer(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {showTopUp && (
        <TopUpModal walletAddress={walletAddress} native={{ symbol }} onClose={() => setShowTopUp(false)} />
      )}
    </div>
  );
}

// ── Donation currencies section ──────────────────────────────────────────────

function DonationCurrencyBalances({ walletAddress, isOwnWallet }: { walletAddress: Address; isOwnWallet: boolean }) {
  const { chainId } = useAccount();
  const { targetNetwork } = useTargetNetwork();
  // When the wallet is disconnected, useAccount().chainId is undefined; fall
  // back to the target network so the supported-currency list is still right.
  const currencies = getDonationCurrencies(chainId ?? targetNetwork.id);

  if (currencies.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {currencies.map(c => (
        <CurrencyBalanceRow key={c.address} walletAddress={walletAddress} currency={c} isOwnWallet={isOwnWallet} />
      ))}
    </div>
  );
}

// ── Sponsored-gas opt-out toggle ────────────────────────────────────────────

// Mount-gated to avoid a hydration mismatch: the persisted value lives in
// localStorage and is only read on the client.
function SponsoredGasToggle() {
  const { enabled, setEnabled } = useSponsoredGasPreference();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return (
    <label
      className="cursor-pointer flex items-center gap-2 text-xs"
      title="When off, you'll pay your own gas for every transaction."
    >
      <span className="opacity-70">Sponsored gas</span>
      <input
        type="checkbox"
        className="toggle toggle-primary toggle-xs"
        checked={enabled}
        onChange={e => setEnabled(e.target.checked)}
      />
    </label>
  );
}

// ── Main wallet view ─────────────────────────────────────────────────────────

export const WalletView = ({ address }: { address: Address }) => {
  const { address: connectedAddress } = useAccount();
  // For Kernel-sponsored users the route address is their counterfactual Kernel,
  // not their EOA. Match against the effective on-chain identity so the page
  // still recognises this as the user's own wallet.
  const { address: effectiveAddress } = useEffectiveAddress();

  const isOwnWallet =
    (effectiveAddress && isAddressEqual(effectiveAddress, address)) ||
    (connectedAddress ? isAddressEqual(connectedAddress, address) : false);
  const addressLink = useBlockExplorerLink(address);

  const { data: orgAddresses, isLoading } = useScaffoldReadContract({
    contractName: "CGRegistry",
    functionName: "getOrganizations",
    args: [0n, BigInt(100)],
    watch: true,
  });

  return (
    <div className="flex flex-col gap-6 px-2 sm:px-4 py-8 max-w-5xl mx-auto w-full">
      <div className="card bg-base-100 shadow-xl">
        <div className="card-body p-4 sm:p-6 lg:p-8">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="card-title text-2xl">Wallet</h2>
            {isOwnWallet && <span className="badge badge-primary">Your Account</span>}
          </div>

          <div className="flex flex-wrap items-center gap-2 mt-2 min-w-0">
            <span className="hidden sm:inline-flex">
              <AddressDisplay address={address} format="long" blockExplorerAddressLink={addressLink} />
            </span>
            <span className="sm:hidden inline-flex">
              <AddressDisplay address={address} format="short" blockExplorerAddressLink={addressLink} />
            </span>
            {isOwnWallet && (
              <div className="ml-auto flex flex-wrap items-center gap-3">
                <AuthProviderInfo />
                <SponsoredGasToggle />
                <SignOutButton size="sm" />
              </div>
            )}
          </div>

          <div className="divider" />

          <h3 className="card-title">Chain.Giving Tokens</h3>

          {isLoading ? (
            <div className="flex justify-center py-8">
              <span className="loading loading-spinner loading-lg" />
            </div>
          ) : !orgAddresses || orgAddresses.length === 0 ? (
            <p className="opacity-60 text-sm">No programs exist yet. No tokens to display.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {orgAddresses.map((orgAddr: string) => (
                <OrgTokens key={orgAddr} walletAddress={address} orgAddress={orgAddr} isOwnWallet={isOwnWallet} />
              ))}
              <p className="opacity-50 text-sm italic mt-2">
                If you don&apos;t see any tokens, this wallet may not hold any yet.
              </p>
            </div>
          )}

          <div className="divider" />

          <h3 className="card-title">Supported Currencies</h3>
          <div className="flex flex-col gap-2">
            <NativeAssetRow walletAddress={address} isOwnWallet={isOwnWallet} />
            <DonationCurrencyBalances walletAddress={address} isOwnWallet={isOwnWallet} />
          </div>
        </div>
      </div>
    </div>
  );
};
