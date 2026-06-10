"use client";

import { useState } from "react";
import { Contract } from "@scaffold-ui/debug-contracts";
import { useSessionStorage } from "usehooks-ts";
import { Abi, Address, isAddress } from "viem";
import { AddressInputWithQr } from "~~/components/AddressInputWithQr";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";

type DynamicContractUIProps = {
  contractName: string;
  abi: Abi;
};

export const DynamicContractUI = ({ contractName, abi }: DynamicContractUIProps) => {
  const { targetNetwork } = useTargetNetwork();
  const storageKey = `scaffoldEth2.dynamicDebugAddress.${contractName}`;
  const [storedAddress, setStoredAddress] = useSessionStorage<string>(storageKey, "", {
    initializeWithValue: false,
  });
  const [draft, setDraft] = useState<string>("");
  const [showModal, setShowModal] = useState(false);

  const hasAddress = isAddress(storedAddress);

  const openModal = () => {
    setDraft(storedAddress);
    setShowModal(true);
  };

  const confirm = () => {
    if (isAddress(draft)) {
      setStoredAddress(draft);
      setShowModal(false);
    }
  };

  const clear = () => {
    setStoredAddress("");
    setShowModal(false);
  };

  if (!hasAddress) {
    return (
      <>
        <div className="flex flex-col items-center gap-4 mt-14">
          <p className="text-2xl">Enter a {contractName} address to debug</p>
          <button className="btn btn-primary" onClick={openModal}>
            Set address
          </button>
        </div>
        {showModal && (
          <AddressModal
            contractName={contractName}
            draft={draft}
            setDraft={setDraft}
            onConfirm={confirm}
            onCancel={() => setShowModal(false)}
            onClear={hasAddress ? clear : undefined}
          />
        )}
      </>
    );
  }

  return (
    <>
      <div className="w-full max-w-7xl px-6 lg:px-10 flex items-center gap-3">
        <span className="text-sm opacity-70">Address:</span>
        <code className="text-xs break-all">{storedAddress}</code>
        <button className="btn btn-xs btn-secondary ml-auto" onClick={openModal}>
          Change
        </button>
      </div>
      <Contract
        contractName={contractName}
        contract={{ address: storedAddress as Address, abi }}
        chainId={targetNetwork.id}
      />
      {showModal && (
        <AddressModal
          contractName={contractName}
          draft={draft}
          setDraft={setDraft}
          onConfirm={confirm}
          onCancel={() => setShowModal(false)}
          onClear={clear}
        />
      )}
    </>
  );
};

type AddressModalProps = {
  contractName: string;
  draft: string;
  setDraft: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onClear?: () => void;
};

const AddressModal = ({ contractName, draft, setDraft, onConfirm, onCancel, onClear }: AddressModalProps) => {
  const isValid = isAddress(draft);
  return (
    <div className="modal modal-open">
      <div className="modal-box">
        <h3 className="font-bold text-lg mb-4">{contractName} address</h3>
        <AddressInputWithQr
          value={draft}
          onChange={value => setDraft(value as string)}
          placeholder={`0x... ${contractName} address`}
        />
        <div className="modal-action">
          {onClear && (
            <button className="btn btn-ghost" onClick={onClear}>
              Clear
            </button>
          )}
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!isValid} onClick={onConfirm}>
            Use address
          </button>
        </div>
      </div>
      <div className="modal-backdrop bg-black/40" onClick={onCancel} />
    </div>
  );
};
