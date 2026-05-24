import deployedContracts from "./deployedContracts";
import type { Address } from "viem";

export type DonationCurrency = {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
  permit: boolean;
  logo: string;
};

// Real Circle deployments. Each address verified on Basescan as a Circle FiatTokenProxy.
// Re-verify against the "Circle" tag on Basescan before changing.
// On Arc, USDC is also the native gas token; the address below is the ERC-20 interface
// (6 decimals), distinct from the 18-decimal native gas-token representation.
const BASE_MAINNET = 8453;
const BASE_SEPOLIA = 84532;
const ARC_TESTNET = 5042002;
const HARDHAT = 31337;

const LOGO_USDC = "/currencies/usdc.svg";
const LOGO_EURC = "/currencies/eurc.svg";

const STATIC_CURRENCIES: Record<number, DonationCurrency[]> = {
  [BASE_MAINNET]: [
    {
      symbol: "USDC",
      name: "USD Coin",
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      decimals: 6,
      permit: true,
      logo: LOGO_USDC,
    },
    {
      symbol: "EURC",
      name: "Euro Coin",
      address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",
      decimals: 6,
      permit: true,
      logo: LOGO_EURC,
    },
  ],
  [BASE_SEPOLIA]: [
    {
      symbol: "USDC",
      name: "USD Coin (testnet)",
      address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      decimals: 6,
      permit: true,
      logo: LOGO_USDC,
    },
    {
      symbol: "EURC",
      name: "Euro Coin (testnet)",
      address: "0x808456652fdb597867f38412077A9182bf77359F",
      decimals: 6,
      permit: true,
      logo: LOGO_EURC,
    },
  ],
  [ARC_TESTNET]: [
    {
      symbol: "USDC",
      name: "USD Coin (testnet)",
      address: "0x3600000000000000000000000000000000000000",
      decimals: 6,
      permit: true,
      logo: LOGO_USDC,
    },
    {
      symbol: "EURC",
      name: "Euro Coin (testnet)",
      address: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
      decimals: 6,
      permit: true,
      logo: LOGO_EURC,
    },
  ],
};

/// Returns the list of donation currencies available on the given chain.
/// On hardhat, addresses are pulled from `deployedContracts` so they match the
/// most recent local deploy of MockUSDC / MockEURC.
export function getDonationCurrencies(chainId: number | undefined): DonationCurrency[] {
  if (chainId === undefined) return [];

  if (chainId === HARDHAT) {
    const local = deployedContracts as unknown as Record<number, Record<string, { address: Address }>>;
    const localContracts = local[HARDHAT] ?? {};
    const result: DonationCurrency[] = [];
    if (localContracts.MockUSDC) {
      result.push({
        symbol: "USDC",
        name: "USD Coin",
        address: localContracts.MockUSDC.address,
        decimals: 6,
        permit: true,
        logo: LOGO_USDC,
      });
    }
    if (localContracts.MockEURC) {
      result.push({
        symbol: "EURC",
        name: "Euro Coin",
        address: localContracts.MockEURC.address,
        decimals: 6,
        permit: true,
        logo: LOGO_EURC,
      });
    }
    return result;
  }

  return STATIC_CURRENCIES[chainId] ?? [];
}

export function findCurrency(chainId: number | undefined, address: Address | undefined): DonationCurrency | undefined {
  if (!address) return undefined;
  return getDonationCurrencies(chainId).find(c => c.address.toLowerCase() === address.toLowerCase());
}
