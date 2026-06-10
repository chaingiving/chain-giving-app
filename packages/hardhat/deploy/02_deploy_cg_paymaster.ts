import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

// ERC-4337 EntryPoint v0.7 — canonical singleton, deterministically deployed at the same
// address on every EVM chain (Base, Base Sepolia, Optimism, Arbitrum, mainnet, …).
const ENTRY_POINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

// Emit a LowBalance event when an org's gas stash falls below 0.01 ETH.
const LOW_BALANCE_THRESHOLD = ethers.parseEther("0.01");

const deployCGPaymaster: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  const registry = await hre.deployments.get("CGRegistry");

  // On a local Hardhat network there is no live EntryPoint, so we deploy MockEntryPoint instead.
  let entryPointAddress: string;
  if (hre.network.name === "hardhat" || hre.network.name === "localhost") {
    const mockEntryPoint = await deploy("MockEntryPoint", {
      from: deployer,
      args: [],
      log: true,
      autoMine: true,
    });
    entryPointAddress = mockEntryPoint.address;
  } else {
    entryPointAddress = ENTRY_POINT_V07;
  }

  await deploy("CGPaymaster", {
    from: deployer,
    args: [entryPointAddress, registry.address, LOW_BALANCE_THRESHOLD],
    log: true,
    autoMine: true,
  });
};

export default deployCGPaymaster;

deployCGPaymaster.tags = ["CGPaymaster"];
deployCGPaymaster.dependencies = ["CGRegistry"];
