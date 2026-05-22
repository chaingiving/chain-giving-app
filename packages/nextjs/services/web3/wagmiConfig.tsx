import { wagmiConnectors } from "./wagmiConnectors";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { createAppKit } from "@reown/appkit/react";
import { fallback, http } from "viem";
import scaffoldConfig, { DEFAULT_ALCHEMY_API_KEY, ScaffoldConfig } from "~~/scaffold.config";
import { getAlchemyHttpUrl } from "~~/utils/scaffold-eth";

const { targetNetworks } = scaffoldConfig;

// Only expose chain.giving's supported networks to wagmi/RainbowKit. ETH price
// still works because fetchPriceFromUniswap calls Alchemy mainnet directly,
// outside the wagmi config.
export const enabledChains = targetNetworks;

// Build per-chain transports with the same RPC fallback logic as before.
const transports = Object.fromEntries(
  enabledChains.map(chain => {
    let rpcFallbacks = [http()];
    const rpcOverrideUrl = (scaffoldConfig.rpcOverrides as ScaffoldConfig["rpcOverrides"])?.[chain.id];
    if (rpcOverrideUrl) {
      rpcFallbacks = [http(rpcOverrideUrl), ...rpcFallbacks];
    } else {
      const alchemyHttpUrl = getAlchemyHttpUrl(chain.id);
      if (alchemyHttpUrl) {
        const isUsingDefaultKey = scaffoldConfig.alchemyApiKey === DEFAULT_ALCHEMY_API_KEY;
        rpcFallbacks = isUsingDefaultKey
          ? [...rpcFallbacks, http(alchemyHttpUrl)]
          : [http(alchemyHttpUrl), ...rpcFallbacks];
      }
    }
    return [chain.id, fallback(rpcFallbacks)];
  }),
);

// WagmiAdapter replaces createConfig and adds Reown's embedded wallet connector.
// The RainbowKit connectors are passed through so MetaMask, Ledger, Safe, etc. still work.
const wagmiAdapter = new WagmiAdapter({
  networks: enabledChains as any,
  projectId: scaffoldConfig.walletConnectProjectId,
  ssr: true,
  transports,
  pollingInterval: scaffoldConfig.pollingInterval,
  connectors: wagmiConnectors(),
});

// createAppKit instantiates Reown's Lit-based modal web components, which can't
// run during SSG/SSR. Defer to the client.
if (typeof window !== "undefined") {
  createAppKit({
    adapters: [wagmiAdapter],
    projectId: scaffoldConfig.walletConnectProjectId,
    networks: enabledChains as any,
    features: {
      email: true,
      socials: ["google", "apple", "facebook", "discord", "github"],
      connectMethodsOrder: ["email", "social", "wallet"],
      emailShowWallets: false,
      collapseWallets: true,
      allWallets: false,
    },
  });
}

export const wagmiConfig = wagmiAdapter.wagmiConfig;
