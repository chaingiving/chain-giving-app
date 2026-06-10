"use client";

import { useEffect, useState } from "react";
import { Address as AddressDisplay } from "@scaffold-ui/components";
import { QRCodeSVG } from "qrcode.react";
import { Address } from "viem";
import { useAccount } from "wagmi";
import { CurrencyLogo } from "~~/components/CurrencyLogo";
import { DonationCurrency } from "~~/contracts/donationCurrencies";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";
import { useSiweAuth } from "~~/hooks/useSiweAuth";
import { getBlockExplorerAddressLink, notification } from "~~/utils/scaffold-eth";

// CDP faucet supports these chains; keep in sync with app/api/faucet/route.ts.
const FAUCET_CHAIN_IDS = new Set<number>([84532]);
const FAUCET_TOKEN_BY_SYMBOL: Record<string, string> = { USDC: "usdc", EURC: "eurc", ETH: "eth" };

// Circle's testnet faucet drips USDC/EURC on Arc Testnet (and other Circle-
// supported testnets). External link; CDP doesn't proxy Arc.
const ARC_TESTNET_ID = 5042002;
const CIRCLE_FAUCET_URL = "https://faucet.circle.com/";
const CIRCLE_FAUCET_TOKENS = new Set(["USDC", "EURC"]);

// Mirrors the backend rate-limit window so the UI cooldown matches.
const FAUCET_COOLDOWN_MS = 60 * 60 * 1000;
const cooldownKey = (walletAddress: string, token: string) => `cg-faucet:${walletAddress.toLowerCase()}:${token}`;

function readCooldown(walletAddress: string, token: string): number {
  if (typeof window === "undefined") return 0;
  const raw = window.localStorage.getItem(cooldownKey(walletAddress, token));
  if (!raw) return 0;
  const until = Number(raw);
  return Number.isFinite(until) && until > Date.now() ? until : 0;
}

function writeCooldown(walletAddress: string, token: string, until: number) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(cooldownKey(walletAddress, token), String(until));
}

type Props = {
  walletAddress: Address;
  /** ERC-20 currency. Omit when `native` is true. */
  currency?: DonationCurrency;
  /** When set, render the modal for the chain's native asset (e.g. ETH). */
  native?: { symbol: string };
  onClose: () => void;
};

export function TopUpModal({ walletAddress, currency, native, onClose }: Props) {
  const { chain } = useAccount();
  const { targetNetwork } = useTargetNetwork();
  const network = chain ?? targetNetwork;
  const [faucetPending, setFaucetPending] = useState(false);
  const { ensureSignedIn } = useSiweAuth();

  const symbol = native ? native.symbol : (currency?.symbol ?? "");
  const faucetSupported = FAUCET_CHAIN_IDS.has(network.id) && FAUCET_TOKEN_BY_SYMBOL[symbol] !== undefined;
  const faucetToken = FAUCET_TOKEN_BY_SYMBOL[symbol];
  const showCircleFaucetLink = network.id === ARC_TESTNET_ID && CIRCLE_FAUCET_TOKENS.has(symbol);

  const [cooldownUntil, setCooldownUntil] = useState(() =>
    faucetSupported && faucetToken ? readCooldown(walletAddress, faucetToken) : 0,
  );
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!cooldownUntil) return;
    const timeout = window.setTimeout(() => {
      setCooldownUntil(0);
      forceTick(t => t + 1);
    }, cooldownUntil - Date.now());
    return () => window.clearTimeout(timeout);
  }, [cooldownUntil]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const requestFaucet = async () => {
    if (!faucetToken) return;
    setFaucetPending(true);
    try {
      try {
        await ensureSignedIn();
      } catch (err) {
        notification.error(err instanceof Error ? err.message : "Wallet sign-in required");
        return;
      }
      const res = await fetch("/api/faucet", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: walletAddress,
          token: faucetToken,
          chainId: network.id,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; transactionHash?: string };
      if (!res.ok) {
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get("Retry-After")) || FAUCET_COOLDOWN_MS / 1000;
          const until = Date.now() + retryAfter * 1000;
          writeCooldown(walletAddress, faucetToken, until);
          setCooldownUntil(until);
        }
        notification.error(data.error || "Faucet request failed");
        return;
      }
      const until = Date.now() + FAUCET_COOLDOWN_MS;
      writeCooldown(walletAddress, faucetToken, until);
      setCooldownUntil(until);
      notification.success(
        data.transactionHash ? `Faucet sent! tx ${data.transactionHash.slice(0, 10)}…` : "Faucet request submitted",
      );
    } catch (err) {
      notification.error((err as Error).message || "Network error");
    } finally {
      setFaucetPending(false);
    }
  };

  return (
    <div className="modal modal-open">
      <div className="modal-box flex flex-col items-center gap-3 w-[calc(100%-1rem)] max-w-lg p-4 sm:p-6 min-w-0">
        <button className="btn btn-ghost btn-sm btn-circle absolute right-2 top-2" onClick={onClose}>
          ✕
        </button>
        <div className="flex items-center gap-2">
          {currency && <CurrencyLogo currency={currency} size={20} />}
          <p className="font-semibold text-base">Receive {symbol}</p>
        </div>
        <p className="text-xs text-center opacity-80">
          Send <span className="font-semibold">{symbol}</span> on <span className="font-semibold">{network.name}</span>{" "}
          to this address.
        </p>
        <div className="p-3 bg-base-100 rounded-2xl shadow-inner">
          <QRCodeSVG
            value={walletAddress}
            size={144}
            bgColor="#ffffff"
            fgColor="#258597"
            level="H"
            imageSettings={{ src: "/logo.svg", width: 32, height: 32, excavate: true }}
          />
        </div>
        <div className="max-w-full overflow-hidden">
          <span className="hidden sm:inline-flex">
            <AddressDisplay
              address={walletAddress}
              format="long"
              blockExplorerAddressLink={getBlockExplorerAddressLink(network, walletAddress)}
            />
          </span>
          <span className="sm:hidden inline-flex">
            <AddressDisplay
              address={walletAddress}
              format="short"
              blockExplorerAddressLink={getBlockExplorerAddressLink(network, walletAddress)}
            />
          </span>
        </div>
        <div className="w-full text-[11px] opacity-60 flex flex-col gap-1 min-w-0">
          <span>
            <strong>Network:</strong> {network.name}
          </span>
          {currency && (
            <span className="break-all">
              <strong>{currency.symbol} contract:</strong> {currency.address}
            </span>
          )}
          {native && (
            <span>
              <strong>Asset:</strong> native {symbol}
            </span>
          )}
        </div>
        {faucetSupported && (
          <div className="w-full flex flex-col gap-2 border-t border-base-300 pt-3">
            <p className="text-xs">On testnet you can request a small amount of test tokens.</p>
            <button
              className="btn btn-primary btn-sm"
              disabled={faucetPending || cooldownUntil > Date.now()}
              onClick={requestFaucet}
            >
              {faucetPending ? (
                <span className="loading loading-spinner loading-xs" />
              ) : cooldownUntil > Date.now() ? (
                `Available in ${formatCooldown(cooldownUntil - Date.now())}`
              ) : (
                `Get test ${symbol}`
              )}
            </button>
          </div>
        )}
        {showCircleFaucetLink && (
          <div className="w-full flex flex-col gap-2 border-t border-base-300 pt-3">
            <p className="text-xs">You can request a small amount of test tokens from Circle&apos;s faucet.</p>
            <a className="btn btn-primary btn-sm" href={CIRCLE_FAUCET_URL} target="_blank" rel="noopener noreferrer">
              Open Circle faucet
            </a>
          </div>
        )}
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </div>
  );
}

function formatCooldown(ms: number): string {
  const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
  const minutes = Math.ceil(totalSeconds / 60);
  if (minutes >= 60) return `${Math.ceil(minutes / 60)}h`;
  return `${minutes}m`;
}
