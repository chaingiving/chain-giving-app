"use client";

import { useState } from "react";
import { Address as AddressDisplay } from "@scaffold-ui/components";
import { Address, isAddress, isAddressEqual } from "viem";
import { useAccount } from "wagmi";
import { AddressInputWithQr } from "~~/components/AddressInputWithQr";
import { EmbeddedWalletButton } from "~~/components/ConnectButton";
import { RainbowKitCustomConnectButton } from "~~/components/scaffold-eth";
import { cgTokenAbi } from "~~/contracts/cgTokenAbi";
import { useBlockExplorerLink, useNetworkHref } from "~~/hooks/scaffold-eth";
import { useReadContract } from "~~/hooks/scaffold-eth/useNetworkRead";
import { useCGTokenWrite } from "~~/hooks/useCGTokenWrite";
import { useProgramOrganization } from "~~/hooks/useProgramOrganization";
import { notification } from "~~/utils/scaffold-eth";

type TokenType = {
  name: string;
  symbol: string;
  maxSupply: bigint;
  totalMinted: bigint;
  transferable: boolean;
  burnable: boolean;
};

function TokenTypeCard({
  tokenAddress,
  tokenId,
  connectedAddress,
  orgAddress,
}: {
  tokenAddress: Address;
  tokenId: bigint;
  connectedAddress: Address | undefined;
  orgAddress: Address | undefined;
}) {
  const [transferTo, setTransferTo] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
  const [burnAmount, setBurnAmount] = useState("");
  const [showTransfer, setShowTransfer] = useState(false);
  const [showBurn, setShowBurn] = useState(false);
  const write = useCGTokenWrite(tokenAddress, orgAddress);

  const { data: tokenType, isLoading: typeLoading } = useReadContract({
    address: tokenAddress,
    abi: cgTokenAbi,
    functionName: "getTokenType",
    args: [tokenId],
    query: { refetchInterval: 5000 },
  });

  const { data: balance, refetch: refetchBalance } = useReadContract({
    address: tokenAddress,
    abi: cgTokenAbi,
    functionName: "balanceOf",
    args: connectedAddress ? [connectedAddress, tokenId] : undefined,
    query: { enabled: !!connectedAddress, refetchInterval: 5000 },
  });

  const tt = tokenType as TokenType | undefined;
  const userBalance = balance as bigint | undefined;

  const handleTransfer = async () => {
    if (!connectedAddress) return;
    if (!isAddress(transferTo)) {
      notification.error("Invalid recipient address");
      return;
    }
    const amt = Number(transferAmount);
    if (!transferAmount || !Number.isInteger(amt) || amt <= 0) {
      notification.error("Amount must be a positive integer");
      return;
    }
    if (userBalance !== undefined && BigInt(amt) > userBalance) {
      notification.error("Amount exceeds your balance");
      return;
    }
    const ok = await write("safeTransferFrom", [connectedAddress, transferTo as Address, tokenId, BigInt(amt), "0x"]);
    if (ok) {
      setTransferTo("");
      setTransferAmount("");
      setShowTransfer(false);
      refetchBalance();
    }
  };

  const handleBurn = async () => {
    if (!connectedAddress) return;
    const amt = Number(burnAmount);
    if (!burnAmount || !Number.isInteger(amt) || amt <= 0) {
      notification.error("Amount must be a positive integer");
      return;
    }
    if (userBalance !== undefined && BigInt(amt) > userBalance) {
      notification.error("Amount exceeds your balance");
      return;
    }
    const ok = await write("burn", [connectedAddress, tokenId, BigInt(amt)]);
    if (ok) {
      setBurnAmount("");
      setShowBurn(false);
      refetchBalance();
    }
  };

  if (typeLoading) {
    return (
      <div className="border border-base-300 rounded-lg p-4">
        <span className="loading loading-spinner loading-sm" />
      </div>
    );
  }

  if (!tt) return null;

  const supplyLabel =
    tt.maxSupply === 0n ? "Fungible" : tt.maxSupply === 1n ? "NFT (max 1)" : `Max ${tt.maxSupply.toString()}`;

  return (
    <div className="border border-base-300 rounded-lg p-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge badge-outline badge-sm">#{tokenId.toString()}</span>
        <span className="font-semibold text-base">
          {tt.name} ({tt.symbol})
        </span>
        <span className="badge badge-ghost badge-sm">{supplyLabel}</span>
      </div>

      <div className="flex flex-wrap gap-4 text-sm opacity-70">
        <span>Total minted: {tt.totalMinted.toString()}</span>
        {connectedAddress && (
          <span className="font-medium text-base-content opacity-100">
            Your balance: <span className="font-bold">{userBalance?.toString() ?? "0"}</span>
          </span>
        )}
      </div>

      {connectedAddress && userBalance !== undefined && userBalance > 0n && (
        <div className="flex flex-wrap gap-2">
          {tt.transferable && (
            <button
              className="btn btn-sm btn-outline"
              onClick={() => {
                setShowTransfer(v => !v);
                setShowBurn(false);
              }}
            >
              Transfer
            </button>
          )}
          {tt.burnable && (
            <button
              className="btn btn-sm btn-outline btn-error"
              onClick={() => {
                setShowBurn(v => !v);
                setShowTransfer(false);
              }}
            >
              Burn
            </button>
          )}
        </div>
      )}

      {showTransfer && (
        <div className="flex flex-col gap-2 p-3 bg-base-200 rounded-lg">
          <p className="text-sm font-medium">Transfer tokens</p>
          <AddressInputWithQr value={transferTo} onChange={setTransferTo} placeholder="Recipient address" />
          <div className="flex gap-2 items-center">
            <div className="flex flex-1 input input-bordered input-sm items-center pr-1 gap-1">
              <input
                type="number"
                min="1"
                step="1"
                className="flex-1 bg-transparent outline-none min-w-0"
                placeholder="Amount"
                value={transferAmount}
                onChange={e => setTransferAmount(e.target.value)}
              />
              <button
                className="btn btn-ghost btn-xs text-xs px-1 h-5 min-h-0 opacity-60 hover:opacity-100"
                onClick={() => setTransferAmount(userBalance?.toString() ?? "")}
                title="Use full balance"
              >
                Max
              </button>
            </div>
            <button className="btn btn-sm btn-primary" onClick={handleTransfer}>
              Send
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => setShowTransfer(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {showBurn && (
        <div className="flex flex-col gap-2 p-3 bg-base-200 rounded-lg">
          <p className="text-sm font-medium">Burn tokens (irreversible)</p>
          <div className="flex gap-2 items-center">
            <div className="flex flex-1 input input-bordered input-sm items-center pr-1 gap-1">
              <input
                type="number"
                min="1"
                step="1"
                className="flex-1 bg-transparent outline-none min-w-0"
                placeholder="Amount to burn"
                value={burnAmount}
                onChange={e => setBurnAmount(e.target.value)}
              />
              <button
                className="btn btn-ghost btn-xs text-xs px-1 h-5 min-h-0 opacity-60 hover:opacity-100"
                onClick={() => setBurnAmount(userBalance?.toString() ?? "")}
                title="Use full balance"
              >
                Max
              </button>
            </div>
            <button className="btn btn-sm btn-error" onClick={handleBurn}>
              Burn
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => setShowBurn(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export const CGTokenView = ({ address }: { address: Address }) => {
  const { address: connectedAddress } = useAccount();

  const {
    data: nextTokenId,
    isLoading,
    error,
  } = useReadContract({
    address,
    abi: cgTokenAbi,
    functionName: "nextTokenId",
    query: { refetchInterval: 5000 },
  });

  const { data: ownerAddress } = useReadContract({
    address,
    abi: cgTokenAbi,
    functionName: "owner",
    query: { refetchInterval: 5000 },
  });

  const addressLink = useBlockExplorerLink(address);
  const ownerLink = useBlockExplorerLink(ownerAddress as Address | undefined);
  const networkHref = useNetworkHref();
  const isOwner = connectedAddress && ownerAddress ? isAddressEqual(connectedAddress, ownerAddress as Address) : false;

  // Token owner is the CGProgram; resolve the parent org for gas sponsorship
  const programAddress = ownerAddress as Address | undefined;
  const { orgAddress } = useProgramOrganization(programAddress);

  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-[60vh]">
        <span className="loading loading-spinner loading-lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex justify-center items-center min-h-[60vh]">
        <div className="text-center">
          <p className="text-error text-lg">Failed to load token data.</p>
          <p className="text-sm opacity-60 mt-2">This address may not be a valid CGToken contract.</p>
        </div>
      </div>
    );
  }

  const tokenCount = nextTokenId != null ? Number(nextTokenId as bigint) : 0;
  const tokenIds = Array.from({ length: tokenCount }, (_, i) => BigInt(i));

  return (
    <div className="flex flex-col gap-6 px-4 py-8 max-w-5xl mx-auto">
      <div className="card bg-base-100 shadow-xl">
        <div className="card-body">
          <h2 className="card-title text-2xl">CGToken (ERC-1155)</h2>

          <div className="flex flex-col gap-2 mt-2">
            <div>
              <p className="text-sm opacity-60">Token Contract Address</p>
              <AddressDisplay address={address} blockExplorerAddressLink={addressLink} />
            </div>
            {ownerAddress && !isAddressEqual(ownerAddress as Address, "0x0000000000000000000000000000000000000000") && (
              <div>
                <p className="text-sm opacity-60">Owner (Program Contract)</p>
                <div className="flex items-center gap-2">
                  <AddressDisplay address={ownerAddress as Address} blockExplorerAddressLink={ownerLink} />
                  {isOwner && <span className="badge badge-info badge-sm">You</span>}
                  <a href={networkHref(`/program/${ownerAddress}`)} className="btn btn-xs btn-outline">
                    View Program
                  </a>
                </div>
              </div>
            )}
          </div>

          <div className="divider" />

          <h3 className="card-title">Token Types ({tokenCount})</h3>

          {!connectedAddress && (
            <div className="flex flex-col gap-3">
              <div className="alert text-sm text-blue-700 dark:text-blue-300">
                <span>Connect your wallet to see your token balances and spend tokens.</span>
              </div>
              <div className="flex flex-wrap gap-3 justify-center">
                <EmbeddedWalletButton size="md" />
                <RainbowKitCustomConnectButton size="md" />
              </div>
            </div>
          )}

          {tokenCount === 0 ? (
            <p className="opacity-60 text-sm">No token types defined yet.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {tokenIds.map(tokenId => (
                <TokenTypeCard
                  key={tokenId.toString()}
                  tokenAddress={address}
                  tokenId={tokenId}
                  connectedAddress={connectedAddress}
                  orgAddress={orgAddress}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
