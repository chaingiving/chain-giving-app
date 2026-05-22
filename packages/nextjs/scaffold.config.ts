import * as chains from "viem/chains";

export type BaseConfig = {
  targetNetworks: readonly chains.Chain[];
  pollingInterval: number;
  alchemyApiKey: string;
  rpcOverrides?: Record<number, string>;
  walletConnectProjectId: string;
  burnerWalletMode: "localNetworksOnly" | "allNetworks" | "disabled";
  // When false, the header wallet UI never resolves ENS names. ENS adds a
  // mainnet round-trip per render and we don't surface ENS anywhere user-
  // facing yet — flip to true once we want it back.
  enableEnsResolution: boolean;
};

export type ScaffoldConfig = BaseConfig;

export const DEFAULT_ALCHEMY_API_KEY = "cR4WnXePioePZ5fFrnSiR";

const alchemyApiKey = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY || DEFAULT_ALCHEMY_API_KEY;

// Replace Base Sepolia's default public RPC with Alchemy so Reown's embedded
// wallet (which uses chain.rpcUrls.default) routes eth_sendTransaction through
// our Alchemy key instead of rpc.walletconnect.com.
const baseSepoliaWithAlchemy = {
  ...chains.baseSepolia,
  rpcUrls: {
    default: { http: [`https://base-sepolia.g.alchemy.com/v2/${alchemyApiKey}`] },
  },
} satisfies chains.Chain;

const scaffoldConfig = {
  // The networks on which your DApp is live
  targetNetworks: [baseSepoliaWithAlchemy, ...(process.env.NODE_ENV === "development" ? [chains.hardhat] : [])],
  // The interval at which your front-end polls the RPC servers for new data (it has no effect if you only target the local network (default is 4000))
  pollingInterval: 3000,
  // This is ours Alchemy's default API key.
  // You can get your own at https://dashboard.alchemyapi.io
  // It's recommended to store it in an env variable:
  // .env.local for local testing, and in the Vercel/system env config for live apps.
  alchemyApiKey,
  // If you want to use a different RPC for a specific network, you can add it here.
  // The key is the chain ID, and the value is the HTTP RPC URL
  rpcOverrides: {
    // Example:
    // [chains.mainnet.id]: "https://mainnet.rpc.buidlguidl.com",
  },
  // This is ours WalletConnect's default project ID.
  // You can get your own at https://cloud.walletconnect.com
  // It's recommended to store it in an env variable:
  // .env.local for local testing, and in the Vercel/system env config for live apps.
  // Default to Chain.Giving project ID
  walletConnectProjectId: process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID || "5a4882d8b717259a79ca0b5feb86e664",
  // Configure Burner Wallet visibility:
  // - "localNetworksOnly": only show when all target networks are local (hardhat/anvil)
  // - "allNetworks": show on any configured target networks
  // - "disabled": completely disable
  burnerWalletMode: "localNetworksOnly",
  enableEnsResolution: false,
} as const satisfies ScaffoldConfig;

export default scaffoldConfig;
