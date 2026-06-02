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

// Reown's blockchain-api proxy doesn't route chains it hasn't onboarded; for
// those we have to feed AppKit the RPC URL directly via customRpcUrls so the
// embedded wallet (W3mFrame) bypasses the proxy and hits the chain RPC
// straight. Keyed by CAIP-2 chain id; the value is an array of { url } so
// AppKit can fall back across multiple endpoints.
const customRpcUrls: Record<string, { url: string }[]> = {};
for (const chain of enabledChains) {
  const url = chain.rpcUrls?.default?.http?.[0];
  if (url) customRpcUrls[`eip155:${chain.id}`] = [{ url }];
}

// createAppKit instantiates Reown's Lit-based modal web components, which can't
// run during SSG/SSR. Defer to the client.
if (typeof window !== "undefined") {
  createAppKit({
    adapters: [wagmiAdapter],
    projectId: scaffoldConfig.walletConnectProjectId,
    networks: enabledChains as any,
    customRpcUrls,
    // Without metadata.icons set, Reown's modal fetches
    // api.web3modal.com/public/getAssetImage/undefined → 404 + a loopback-CORS
    // warning on localhost. Point at our own logo to silence it. Safe to read
    // window.location here — we're inside the typeof-window-defined guard.
    metadata: {
      name: "Chain.Giving",
      description: "Charitable giving programs with ETH crowdfunding + ERC-1155 token distribution",
      url: window.location.origin,
      icons: [`${window.location.origin}/logo.svg`],
    },
    features: {
      email: true,
      socials: ["google", "apple", "facebook", "discord", "github"],
      connectMethodsOrder: ["email", "social", "wallet"],
      emailShowWallets: false,
      collapseWallets: true,
      allWallets: false,
      // Trim Reown's modal to the auth surface only. Chain.Giving funds users
      // via the org's paymaster — the on-ramp (auto-popup on zero balance),
      // swap, and send tabs add no value and clutter the wallet UX.
      onramp: false,
      swaps: false,
      send: false,
    },
  });
}

export const wagmiConfig = wagmiAdapter.wagmiConfig;
