import { Abi, Address, Chain, WalletClient, createWalletClient, custom, encodeFunctionData, numberToHex } from "viem";
import { writeContract as viemWriteContract } from "viem/actions";
import { useAccount, useSendCalls, useWalletClient } from "wagmi";
import { useTransactor } from "~~/hooks/scaffold-eth";
import { useOrgGasSponsorship } from "~~/hooks/useOrgGasSponsorship";
import { useSponsoredUserOp } from "~~/hooks/useSponsoredUserOp";
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
   * directly from the connected wallet. Use for owner-only admin ops that the
   * CGPaymaster allowlist would reject anyway (createProgram, setBeneficiaries,
   * execute, mint, …). Donations and other sponsorable ops should leave this
   * unset.
   */
  sponsored?: boolean;
};

/**
 * Send a contract call with automatic gas sponsorship.
 *
 * Resolution order for sponsorable calls (sponsored !== false):
 *   1. **EIP-5792** when the wallet is a smart account that advertises
 *      paymasterService support (Coinbase Smart Wallet, MetaMask Smart Account, Safe).
 *   2. **Kernel-via-Pimlico** when the wallet is EOA-backed (social, email,
 *      MetaMask EOA, WC EOAs) — we wrap it in a counterfactual Kernel v3.1
 *      account and submit the UserOp through our bundler proxy.
 *   3. No fallback — if neither path is viable, the call fails with a clear
 *      error. There is intentionally no user-paid donation path; admin orgs
 *      must top up CGPaymaster for their donors.
 *
 * Admin ops (`sponsored: false`) always use the direct wallet path.
 */
export function useSponsoredWrite(orgAddress: Address | undefined) {
  const { chainId: rawChainId } = useAccount();
  const chainId = toNumericChainId(rawChainId as number | string | undefined);
  const { sponsorshipMode, hasBudget, orgBalance, orgBalanceFormatted, isPaymasterSupported, isEIP5792Wallet } =
    useOrgGasSponsorship(orgAddress);

  const { sendCallsAsync } = useSendCalls();
  const { data: walletClient } = useWalletClient();
  const { sendCall: sendKernelCall, smartAddress } = useSponsoredUserOp(orgAddress);
  const writeTx = useTransactor();

  const write = async (call: ContractCall): Promise<boolean> => {
    try {
      const wantSponsored = call.sponsored !== false;

      if (wantSponsored && sponsorshipMode === "eip5792") {
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

      if (wantSponsored && sponsorshipMode === "kernel") {
        await sendKernelCall({
          address: call.address,
          abi: call.abi,
          functionName: call.functionName,
          args: call.args,
          value: call.value,
        });
        notification.success("Transaction sponsored by organization gas budget");
        return true;
      }

      if (wantSponsored && sponsorshipMode === "none") {
        // No fallback. Surface why so the org admin (or the donor) can act.
        const reason = !orgAddress
          ? "Sponsoring organization unknown"
          : !hasBudget
            ? "Organization has no gas budget — ask the org to top up"
            : "Gas sponsorship is disabled or unavailable for your wallet";
        throw new Error(reason);
      }

      // Admin op (sponsored: false) — send directly from the connected wallet.
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
    sponsorshipMode,
    /** Convenience: true when either sponsored path is viable for this org+wallet. */
    isSponsorshipAvailable: sponsorshipMode !== "none",
    isPaymasterSupported,
    hasBudget,
    isEIP5792Wallet,
    orgBalance,
    orgBalanceFormatted,
    /** Kernel smart-account address (defined once the user has sent at least one
     *  UserOp this session; use useEffectiveAddress for the persistent display value). */
    kernelAddress: smartAddress,
  };
}
