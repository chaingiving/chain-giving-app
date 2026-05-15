import { Abi, Address, Chain, WalletClient, createWalletClient, custom, encodeFunctionData, numberToHex } from "viem";
import { writeContract as viemWriteContract } from "viem/actions";
import { useAccount, useSendCalls, useWalletClient } from "wagmi";
import { useTransactor } from "~~/hooks/scaffold-eth";
import { useOrgGasSponsorship } from "~~/hooks/useOrgGasSponsorship";
import { wagmiConfig } from "~~/services/web3/wagmiConfig";
import { getParsedError, notification } from "~~/utils/scaffold-eth";

// Reown AppKit's wagmi adapter occasionally surfaces the chain id in CAIP-2
// form (e.g. "eip155:84532") instead of the numeric form. Anything that ends
// up calling BigInt(chainId) — viem's EIP-1559 tx serializer in particular —
// blows up with `SyntaxError: Cannot convert eip155:N to a BigInt`.
const toNumericChainId = (raw: number | string | undefined): number | undefined => {
  if (raw == null) return undefined;
  if (typeof raw === "number") return raw;
  const tail = raw.split(":").pop();
  const parsed = tail ? Number(tail) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

// Reown's embedded-wallet provider can answer `eth_chainId` with the CAIP-2
// form ("eip155:N"). viem then runs that through `hexToNumber` →
// `BigInt("eip155:N")` and throws. This proxy repairs that single response so
// every downstream viem action (writeContract, sendTransaction, …) sees a
// well-formed hex chain id.
const wrapProvider = (provider: { request: (args: any) => Promise<unknown> }) => ({
  request: async (args: any) => {
    const result = await provider.request(args);
    if (args?.method === "eth_chainId" && typeof result === "string" && result.startsWith("eip155:")) {
      const tail = result.split(":")[1];
      const n = Number(tail);
      if (Number.isFinite(n)) return numberToHex(n);
    }
    return result;
  },
});

const buildSafeWalletClient = (raw: WalletClient, chain: Chain) =>
  createWalletClient({
    account: raw.account,
    chain,
    transport: custom(wrapProvider({ request: raw.request.bind(raw) as any })),
  });

type ContractCall = {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  /**
   * Set to `false` to bypass paymaster sponsorship and send a plain transaction
   * even when the wallet supports EIP-5792 and the org has budget. Use for
   * owner-only ops that the CGPaymaster allowlist will reject anyway.
   */
  sponsored?: boolean;
};

/**
 * Hook that provides a `write` function for sending contract calls with
 * automatic gas sponsorship via EIP-5792 + CGPaymaster when available,
 * falling back to a regular `writeContract` call otherwise.
 *
 * Usage:
 * ```ts
 * const { write, isSponsorshipAvailable } = useSponsoredWrite(orgAddress);
 * await write({ address, abi, functionName, args });
 * ```
 */
export function useSponsoredWrite(orgAddress: Address | undefined) {
  const { chainId: rawChainId } = useAccount();
  const chainId = toNumericChainId(rawChainId as number | string | undefined);
  const { isSponsorshipAvailable, isPaymasterSupported, hasBudget, orgBalance, orgBalanceFormatted, isEIP5792Wallet } =
    useOrgGasSponsorship(orgAddress);

  const { sendCallsAsync } = useSendCalls();
  const { data: walletClient } = useWalletClient();
  const writeTx = useTransactor();

  const write = async (call: ContractCall): Promise<boolean> => {
    try {
      const useSponsorship = call.sponsored !== false && isSponsorshipAvailable && orgAddress;
      if (useSponsorship) {
        // Use EIP-5792 sendCalls with paymasterService capability
        const paymasterServiceUrl = `${window.location.origin}/api/paymaster`;

        await sendCallsAsync({
          calls: [
            {
              to: call.address,
              data: encodeFunctionData({
                abi: call.abi as Abi,
                functionName: call.functionName,
                args: call.args ?? [],
              }),
              value: call.value,
            },
          ],
          capabilities: {
            paymasterService: {
              url: paymasterServiceUrl,
              context: { orgAddress },
            },
          },
          chainId,
        } as any);

        notification.success("Transaction sponsored by organization gas budget");
        return true;
      }

      // Fallback: build a wallet client backed by Reown's provider but with the
      // `eth_chainId` response sanitised, then call viem.writeContract directly
      // with an explicit Chain object resolved from wagmiConfig.
      if (!walletClient) throw new Error("Wallet not connected");
      const chain = chainId ? wagmiConfig.chains.find((c: Chain) => c.id === chainId) : undefined;
      if (!chain) throw new Error(`Unsupported chain: ${String(rawChainId)}`);

      const safeClient = buildSafeWalletClient(walletClient, chain);

      await writeTx(() =>
        viemWriteContract(safeClient, {
          address: call.address,
          abi: call.abi as Abi,
          functionName: call.functionName,
          args: (call.args ?? []) as any,
          value: call.value,
          chain,
          account: walletClient.account,
        } as any),
      );
      return true;
    } catch (e) {
      const errorMessage = getParsedError(e);
      notification.error(errorMessage);
      return false;
    }
  };

  return {
    write,
    isSponsorshipAvailable,
    isPaymasterSupported,
    hasBudget,
    isEIP5792Wallet,
    orgBalance,
    orgBalanceFormatted,
  };
}
