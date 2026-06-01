import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  baseAccount,
  ledgerWallet,
  metaMaskWallet,
  rainbowWallet,
  safeWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { rainbowkitBurnerWallet } from "burner-connector";
import * as chains from "viem/chains";
import scaffoldConfig, { type ScaffoldConfig } from "~~/scaffold.config";

const { burnerWalletMode, targetNetworks } = scaffoldConfig as ScaffoldConfig;

const hasOnlyLocalTargetNetworks = targetNetworks.every(network => network.id === (chains.hardhat as chains.Chain).id);
const showBurnerWallet =
  burnerWalletMode !== "disabled" && (burnerWalletMode === "allNetworks" || hasOnlyLocalTargetNetworks);

// burner-connector ships its own pinned RainbowKit + @wagmi/core under
// node_modules/burner-connector/node_modules/ — those nested copies emit a
// structurally identical Wallet/Connector type that TS treats as a distinct
// nominal type, so rainbowkitBurnerWallet doesn't unify with CreateWalletFn.
// Runtime is fine; cast at the boundary instead of forcing a yarn resolution.
const wallets = [
  metaMaskWallet,
  walletConnectWallet,
  ledgerWallet,
  baseAccount,
  rainbowWallet,
  safeWallet,
  ...(showBurnerWallet ? [rainbowkitBurnerWallet] : []),
] as Parameters<typeof connectorsForWallets>[0][number]["wallets"];

/**
 * wagmi connectors for the wagmi context
 */
export const wagmiConnectors = () => {
  // Only create connectors on client-side to avoid SSR issues
  // TODO: update when https://github.com/rainbow-me/rainbowkit/issues/2476 is resolved
  if (typeof window === "undefined") {
    return [];
  }

  return connectorsForWallets(
    [
      {
        groupName: "Supported Wallets",
        wallets,
      },
    ],

    {
      appName: "chain-giving",
      projectId: scaffoldConfig.walletConnectProjectId,
    },
  );
};
