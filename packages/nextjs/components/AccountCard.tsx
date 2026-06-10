"use client";

import Link from "next/link";
import { Address as AddressDisplay } from "@scaffold-ui/components";
import { QRCodeSVG } from "qrcode.react";
import { type Address as ViemAddress, getAddress } from "viem";
import { CheckCircleIcon, DocumentDuplicateIcon, WalletIcon } from "@heroicons/react/24/outline";
import { AuthProviderInfo, SignOutButton } from "~~/components/AuthSession";
import { BlockieAvatar } from "~~/components/scaffold-eth";
import { useCopyToClipboard, useNetworkHref, useTargetNetwork } from "~~/hooks/scaffold-eth";
import scaffoldConfig from "~~/scaffold.config";
import { getBlockExplorerAddressLink } from "~~/utils/scaffold-eth";

type AccountCardProps = {
  address: ViemAddress;
  onLinkClick?: () => void;
};

const truncate = (address: string) => `${address.slice(0, 6)}...${address.slice(-4)}`;

// ENS-free address display: blockie + truncated address + copy + explorer link.
// Used when scaffoldConfig.enableEnsResolution is false to avoid the mainnet
// round-trip baked into @scaffold-ui's Address component.
const PlainAddress = ({ address, explorerLink }: { address: ViemAddress; explorerLink?: string }) => {
  const checksum = getAddress(address);
  const { copyToClipboard, isCopiedToClipboard } = useCopyToClipboard();

  return (
    <div className="flex items-center gap-2">
      <BlockieAvatar address={checksum} size={28} />
      {explorerLink ? (
        <a
          href={explorerLink}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-sm font-medium hover:underline"
        >
          {truncate(checksum)}
        </a>
      ) : (
        <span className="font-mono text-sm font-medium">{truncate(checksum)}</span>
      )}
      <button
        type="button"
        onClick={() => copyToClipboard(checksum)}
        className="btn btn-ghost btn-xs btn-square"
        aria-label="Copy address"
      >
        {isCopiedToClipboard ? (
          <CheckCircleIcon className="h-4 w-4 text-success" />
        ) : (
          <DocumentDuplicateIcon className="h-4 w-4 opacity-70" />
        )}
      </button>
    </div>
  );
};

export const AccountCard = ({ address, onLinkClick }: AccountCardProps) => {
  const { targetNetwork } = useTargetNetwork();
  const networkHref = useNetworkHref();
  const explorerLink = getBlockExplorerAddressLink(targetNetwork, address);

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="my-2 font-medium">Your Account</p>
      <div className="cg-qr-pulse p-3 bg-base-100 rounded-2xl shadow-inner">
        <QRCodeSVG
          value={address}
          size={160}
          bgColor="#ffffff"
          fgColor="#258597"
          level="H"
          imageSettings={{
            src: "/logo.svg",
            width: 36,
            height: 36,
            excavate: true,
          }}
        />
        <style>{`
          .cg-qr-pulse svg image {
            transform-box: fill-box;
            transform-origin: center;
            animation: cg-qr-pulse 2.6s ease-in-out infinite;
          }
          @keyframes cg-qr-pulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.06); }
          }
          @media (prefers-reduced-motion: reduce) {
            .cg-qr-pulse svg image { animation: none; }
          }
        `}</style>
      </div>
      {scaffoldConfig.enableEnsResolution ? (
        <AddressDisplay address={address} chain={targetNetwork} blockExplorerAddressLink={explorerLink} />
      ) : (
        <PlainAddress address={address} explorerLink={explorerLink} />
      )}
      <AuthProviderInfo className="justify-center" />
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Link href={networkHref(`/wallet/${address}`)} className="btn btn-sm btn-outline gap-2" onClick={onLinkClick}>
          <WalletIcon className="h-4 w-4" />
          View Wallet
        </Link>
        <SignOutButton size="sm" />
      </div>
    </div>
  );
};
