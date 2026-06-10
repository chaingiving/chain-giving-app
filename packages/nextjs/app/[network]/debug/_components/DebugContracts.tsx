"use client";

import { useEffect, useMemo } from "react";
import { ContractUI } from "./ContractUI";
import { DynamicContractUI } from "./DynamicContractUI";
import "@scaffold-ui/debug-contracts/styles.css";
import { useSessionStorage } from "usehooks-ts";
import { Abi } from "viem";
import { BarsArrowUpIcon } from "@heroicons/react/20/solid";
import { cgOrganizationAbi } from "~~/contracts/cgOrganizationAbi";
import { cgProgramAbi } from "~~/contracts/cgProgramAbi";
import { ContractName, GenericContract } from "~~/utils/scaffold-eth/contract";
import { useAllContracts } from "~~/utils/scaffold-eth/contractsData";

const selectedContractStorageKey = "scaffoldEth2.selectedContract";

const dynamicContracts: Record<string, { abi: Abi }> = {
  CGProgram: { abi: cgProgramAbi as Abi },
  CGOrganization: { abi: cgOrganizationAbi as Abi },
};

export function DebugContracts() {
  const contractsData = useAllContracts();
  const contractNames = useMemo(() => {
    const deployed = Object.keys(contractsData) as string[];
    const dynamic = Object.keys(dynamicContracts);
    return Array.from(new Set([...deployed, ...dynamic])).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
    );
  }, [contractsData]);

  const [selectedContract, setSelectedContract] = useSessionStorage<string>(
    selectedContractStorageKey,
    contractNames[0],
    { initializeWithValue: false },
  );

  useEffect(() => {
    if (!contractNames.includes(selectedContract)) {
      setSelectedContract(contractNames[0]);
    }
  }, [contractNames, selectedContract, setSelectedContract]);

  return (
    <div className="flex flex-col gap-y-6 lg:gap-y-8 py-8 lg:py-12 justify-center items-center">
      {contractNames.length === 0 ? (
        <p className="text-3xl mt-14">No contracts found!</p>
      ) : (
        <>
          {contractNames.length > 1 && (
            <div className="flex flex-row gap-2 w-full max-w-7xl pb-1 px-6 lg:px-10 flex-wrap">
              {contractNames.map(contractName => {
                const isDynamic = contractName in dynamicContracts;
                const deployed = contractsData[contractName as ContractName] as GenericContract | undefined;
                return (
                  <button
                    className={`btn btn-secondary btn-sm font-light hover:border-transparent ${
                      contractName === selectedContract
                        ? "bg-base-300 hover:bg-base-300 no-animation"
                        : "bg-base-100 hover:bg-secondary"
                    }`}
                    key={contractName}
                    onClick={() => setSelectedContract(contractName)}
                  >
                    {contractName}
                    {deployed?.external && (
                      <span className="tooltip tooltip-top tooltip-accent" data-tip="External contract">
                        <BarsArrowUpIcon className="h-4 w-4 cursor-pointer" />
                      </span>
                    )}
                    {isDynamic && <span className="badge badge-xs badge-info">dynamic</span>}
                  </button>
                );
              })}
            </div>
          )}
          {contractNames.map(contractName => {
            if (contractName !== selectedContract) return null;
            const dynamic = dynamicContracts[contractName];
            if (dynamic) {
              return <DynamicContractUI key={contractName} contractName={contractName} abi={dynamic.abi} />;
            }
            return <ContractUI key={contractName} contractName={contractName as ContractName} />;
          })}
        </>
      )}
    </div>
  );
}
