import { useCallback, useState } from "react";
import { type Abi, type Address, encodeFunctionData } from "viem";
import { usePublicClient, useWalletClient } from "wagmi";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";
import { getKernelClient } from "~~/services/web3/smartAccount";

/**
 * Send a single contract call as a sponsored Kernel UserOperation.
 *
 * The connected EOA signer is wrapped in a counterfactual Kernel v3.1 account.
 * The call is sponsored by the supplied `orgAddress` via CGPaymaster; the EOA
 * never pays gas. The first sponsored UserOp from a given EOA deploys the Kernel
 * (adds ~350-450k gas, also charged to the org).
 *
 * Returns `{ sendCall, smartAddress, isPending }`. `smartAddress` is the
 * counterfactual Kernel address — stable across sessions for the same EOA.
 */

type Call = {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
};

export function useSponsoredUserOp(orgAddress: Address | undefined) {
  const { data: walletClient } = useWalletClient();
  const { targetNetwork } = useTargetNetwork();
  const publicClient = usePublicClient({ chainId: targetNetwork.id });
  const [smartAddress, setSmartAddress] = useState<Address>();
  const [isPending, setIsPending] = useState(false);

  const sendCalls = useCallback(
    async (calls: Call[]) => {
      if (!walletClient) throw new Error("Wallet not connected");
      if (!publicClient) throw new Error("Public client not available for chain");
      if (!orgAddress) throw new Error("Missing sponsoring org address");
      if (calls.length === 0) throw new Error("No calls to send");

      setIsPending(true);
      try {
        const client = await getKernelClient({
          walletClient,
          publicClient,
          chain: targetNetwork,
          orgAddress,
        });
        setSmartAddress(client.account.address);

        const userOpHash = await client.sendUserOperation({
          calls: calls.map(c => ({
            to: c.address,
            data: encodeFunctionData({
              abi: c.abi as Abi,
              functionName: c.functionName,
              args: c.args ?? [],
            }),
            value: c.value ?? 0n,
          })),
        });
        return client.waitForUserOperationReceipt({ hash: userOpHash });
      } finally {
        setIsPending(false);
      }
    },
    [walletClient, publicClient, orgAddress, targetNetwork],
  );

  // Backwards-compatible single-call wrapper.
  const sendCall = useCallback((call: Call) => sendCalls([call]), [sendCalls]);

  return { sendCall, sendCalls, smartAddress, isPending };
}
