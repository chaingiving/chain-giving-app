"use client";

// @refresh reset
import { AddressInfoDropdown } from "./AddressInfoDropdown";
import { NetworkOptions } from "./NetworkOptions";
import { WrongNetworkDropdown } from "./WrongNetworkDropdown";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Address } from "viem";
import { ChevronDownIcon, WalletIcon } from "@heroicons/react/24/outline";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import { useIsHomePage } from "~~/hooks/useIsHomePage";
import scaffoldConfig from "~~/scaffold.config";

type Props = {
  hideOnHome?: boolean;
  size?: "sm" | "md";
};

/**
 * Custom Wagmi Connect Button (chain-icon + address pills, AccountCard popover)
 */
export const RainbowKitCustomConnectButton = ({ hideOnHome = false, size = "sm" }: Props) => {
  const { targetNetwork } = useTargetNetwork();
  const isHome = useIsHomePage();
  const btnSize = size === "md" ? "btn-md" : "btn-sm";

  return (
    <ConnectButton.Custom>
      {({ account, chain, openConnectModal, mounted }) => {
        const connected = mounted && account && chain;

        if (!connected) {
          if (hideOnHome && isHome) return null;
          return (
            <button className={`btn btn-primary ${btnSize} gap-2`} onClick={openConnectModal} type="button">
              <WalletIcon className="h-4 w-4" />
              Connect Wallet
            </button>
          );
        }

        if (chain.unsupported || chain.id !== targetNetwork.id) {
          return <WrongNetworkDropdown />;
        }

        const displayName = scaffoldConfig.enableEnsResolution ? account.displayName : undefined;

        return (
          <div className="flex items-center gap-2">
            {/* Network switcher. We deliberately don't use RainbowKit's openChainModal
                here: it only calls switchChain on the wallet and leaves the canonical
                `[network]` URL segment untouched, so the page never re-targets. This
                dropdown reuses NetworkOptions, which rewrites the URL (and nudges the
                wallet) — see NetworkOptions / ChainSync. */}
            <div className="dropdown dropdown-end">
              <label
                tabIndex={0}
                role="button"
                className="flex items-center gap-2 rounded-full bg-base-100 hover:bg-base-200 border border-base-300 shadow-md h-10 px-3 transition-colors cursor-pointer"
                aria-label={chain.name ? `Switch network (currently ${chain.name})` : "Switch network"}
              >
                {chain.hasIcon && chain.iconUrl ? (
                  <span
                    className="inline-flex h-6 w-6 rounded-full overflow-hidden shrink-0"
                    style={{ background: chain.iconBackground }}
                  >
                    {/* Chain icon comes from RainbowKit's registry; static remote URL */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={chain.iconUrl} alt={chain.name ?? "chain"} className="h-6 w-6" />
                  </span>
                ) : (
                  <span className="inline-flex h-6 w-6 rounded-full bg-base-300 shrink-0" />
                )}
                <ChevronDownIcon className="h-4 w-4 opacity-70" />
              </label>
              <ul
                tabIndex={0}
                className="dropdown-content menu z-2 p-2 mt-1 shadow-center shadow-accent bg-base-200 rounded-box gap-1"
              >
                <NetworkOptions />
              </ul>
            </div>
            <AddressInfoDropdown address={account.address as Address} displayName={displayName} />
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
};
