import { expect } from "chai";
import { ethers } from "hardhat";
import {
  CGPaymaster,
  CGRegistry,
  CGOrganization,
  CGProgramFactory,
  CGComponentFactory,
  MockEntryPoint,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Default inner call used by encodeExecute — uses an allowlisted selector so paymaster
 *  validation tests can focus on org/target/balance logic without crafting payloads. */
const DEFAULT_INNER_DATA = new ethers.Interface(["function donate(uint256)"]).encodeFunctionData("donate", [1n]);

/** ABI-encodes an execute(address,uint256,bytes) call as a smart-account would.
 *  `data` defaults to a `donate(1)` payload so it passes CGPaymaster's selector allowlist. */
function encodeExecute(target: string, value = 0n, data: string = DEFAULT_INNER_DATA): string {
  const iface = new ethers.Interface(["function execute(address,uint256,bytes)"]);
  return iface.encodeFunctionData("execute", [target, value, data]);
}

/** Builds the paymasterAndData field: paymaster address (20 b) + org address (20 b). */
function buildPaymasterAndData(paymasterAddress: string, orgAddress: string): string {
  return ethers.concat([paymasterAddress, orgAddress]);
}

/** Returns a minimal UserOperation targeting `callTarget` and sponsored by `org`. */
function buildUserOp(sender: string, callTarget: string, paymasterAddress: string, orgAddress: string): object {
  return {
    sender,
    nonce: 0n,
    initCode: "0x",
    callData: encodeExecute(callTarget),
    callGasLimit: 100_000n,
    verificationGasLimit: 100_000n,
    preVerificationGas: 50_000n,
    maxFeePerGas: ethers.parseUnits("1", "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
    paymasterAndData: buildPaymasterAndData(paymasterAddress, orgAddress),
    signature: "0x",
  };
}

const USER_OP_HASH = ethers.ZeroHash;
const MAX_COST = ethers.parseEther("0.005");
const DEPOSIT = ethers.parseEther("0.1");
const LOW_THRESHOLD = ethers.parseEther("0.01");

// ── Fixture ───────────────────────────────────────────────────────────────────

async function deployFixture() {
  const [deployer, orgOwner, alice, bob] = await ethers.getSigners();

  // Deploy the full CG stack
  const ComponentFactoryF = await ethers.getContractFactory("CGComponentFactory");
  const componentFactory: CGComponentFactory = await ComponentFactoryF.deploy();

  const ProgramFactoryF = await ethers.getContractFactory("CGProgramFactory");
  const programFactory: CGProgramFactory = await ProgramFactoryF.deploy(await componentFactory.getAddress());

  const RegistryF = await ethers.getContractFactory("CGRegistry");
  const registry: CGRegistry = await RegistryF.deploy(await programFactory.getAddress());

  // Transfer CGProgramFactory ownership to registry (mirrors prod deployment)
  await programFactory.transferOwnership(await registry.getAddress());

  // Create an organisation owned by orgOwner
  const orgTx = await registry.createOrganization("Test Org", orgOwner.address);
  const orgReceipt = await orgTx.wait();
  const orgCreatedLog = orgReceipt!.logs.find(
    l => l.topics[0] === registry.interface.getEvent("OrganizationCreated")!.topicHash,
  );
  const orgAddress = registry.interface.decodeEventLog(
    "OrganizationCreated",
    orgCreatedLog!.data,
    orgCreatedLog!.topics,
  ).organization as string;
  const org: CGOrganization = await ethers.getContractAt("CGOrganization", orgAddress);

  // Deploy MockEntryPoint + CGPaymaster
  const MockEntryPointF = await ethers.getContractFactory("MockEntryPoint");
  const mockEntryPoint: MockEntryPoint = await MockEntryPointF.deploy();

  const PaymasterF = await ethers.getContractFactory("CGPaymaster");
  const cgPaymaster: CGPaymaster = await PaymasterF.deploy(
    await mockEntryPoint.getAddress(),
    await registry.getAddress(),
    LOW_THRESHOLD,
  );

  // Create a program so we have a valid child contract to test targeting
  const programTx = await org.connect(orgOwner).createProgram("Aid Program", false);
  const programReceipt = await programTx.wait();
  const programCreatedLog = programReceipt!.logs.find(
    l => l.topics[0] === org.interface.getEvent("ProgramCreated")!.topicHash,
  );
  const programAddress = org.interface.decodeEventLog(
    "ProgramCreated",
    programCreatedLog!.data,
    programCreatedLog!.topics,
  ).program as string;

  const program = await ethers.getContractAt("CGProgram", programAddress);
  const tokenAddress = await program.token();

  return {
    deployer,
    orgOwner,
    alice,
    bob,
    registry,
    org,
    orgAddress,
    program,
    programAddress,
    tokenAddress,
    mockEntryPoint,
    cgPaymaster,
  };
}

// Helper: impersonate a contract address so we can call onlyEntryPoint functions
async function impersonate(address: string): Promise<HardhatEthersSigner> {
  await ethers.provider.send("hardhat_impersonateAccount", [address]);
  await ethers.provider.send("hardhat_setBalance", [address, "0x56BC75E2D63100000"]); // 100 ETH
  return ethers.getSigner(address);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CGPaymaster", function () {
  // ── Deployment ──────────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("stores entryPoint, registry, and lowBalanceThreshold", async () => {
      const { cgPaymaster, mockEntryPoint, registry } = await deployFixture();
      expect(await cgPaymaster.entryPoint()).to.equal(await mockEntryPoint.getAddress());
      expect(await cgPaymaster.registry()).to.equal(await registry.getAddress());
      expect(await cgPaymaster.lowBalanceThreshold()).to.equal(LOW_THRESHOLD);
    });

    it("sets deployer as owner", async () => {
      const { cgPaymaster, deployer } = await deployFixture();
      expect(await cgPaymaster.owner()).to.equal(deployer.address);
    });
  });

  // ── depositFor ──────────────────────────────────────────────────────────────

  describe("depositFor", function () {
    it("credits orgBalance and forwards ETH to EntryPoint", async () => {
      const { cgPaymaster, orgAddress, mockEntryPoint, alice } = await deployFixture();

      await expect(cgPaymaster.connect(alice).depositFor(orgAddress, { value: DEPOSIT }))
        .to.emit(cgPaymaster, "Deposited")
        .withArgs(orgAddress, DEPOSIT, alice.address);

      expect(await cgPaymaster.orgBalance(orgAddress)).to.equal(DEPOSIT);
      expect(await mockEntryPoint.balanceOf(await cgPaymaster.getAddress())).to.equal(DEPOSIT);
    });

    it("reverts for an address that is not a registered org", async () => {
      const { cgPaymaster, alice } = await deployFixture();
      await expect(cgPaymaster.depositFor(alice.address, { value: DEPOSIT })).to.be.revertedWithCustomError(
        cgPaymaster,
        "NotRegisteredOrg",
      );
    });
  });

  // ── validatePaymasterUserOp ─────────────────────────────────────────────────

  describe("validatePaymasterUserOp", function () {
    it("validates successfully when org has balance and target is a program", async () => {
      const { cgPaymaster, orgAddress, programAddress, mockEntryPoint, alice } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      const userOp = buildUserOp(alice.address, programAddress, await cgPaymaster.getAddress(), orgAddress);

      // staticCall to read return values without sending a transaction
      const [, validationData] = await cgPaymaster
        .connect(entryPointSigner)
        .validatePaymasterUserOp.staticCall(userOp, USER_OP_HASH, MAX_COST);

      expect(validationData).to.equal(0n); // 0 = valid
    });

    it("validates successfully when target is the CGToken (child of program)", async () => {
      const { cgPaymaster, orgAddress, tokenAddress, mockEntryPoint, alice } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      const userOp = buildUserOp(alice.address, tokenAddress, await cgPaymaster.getAddress(), orgAddress);
      const [, validationData] = await cgPaymaster
        .connect(entryPointSigner)
        .validatePaymasterUserOp.staticCall(userOp, USER_OP_HASH, MAX_COST);

      expect(validationData).to.equal(0n);
    });

    it("validates successfully when target is the org itself", async () => {
      const { cgPaymaster, orgAddress, mockEntryPoint, alice } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      const userOp = buildUserOp(alice.address, orgAddress, await cgPaymaster.getAddress(), orgAddress);
      const [, validationData] = await cgPaymaster
        .connect(entryPointSigner)
        .validatePaymasterUserOp.staticCall(userOp, USER_OP_HASH, MAX_COST);

      expect(validationData).to.equal(0n);
    });

    it("reserves maxCost from orgBalance", async () => {
      const { cgPaymaster, orgAddress, programAddress, mockEntryPoint, alice } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      const userOp = buildUserOp(alice.address, programAddress, await cgPaymaster.getAddress(), orgAddress);
      await cgPaymaster.connect(entryPointSigner).validatePaymasterUserOp(userOp, USER_OP_HASH, MAX_COST);

      expect(await cgPaymaster.orgBalance(orgAddress)).to.equal(DEPOSIT - MAX_COST);
    });

    it("reverts if org is not registered", async () => {
      const { cgPaymaster, programAddress, mockEntryPoint, alice } = await deployFixture();

      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());
      const userOp = buildUserOp(
        alice.address,
        programAddress,
        await cgPaymaster.getAddress(),
        alice.address, // not a registered org
      );

      await expect(
        cgPaymaster.connect(entryPointSigner).validatePaymasterUserOp(userOp, USER_OP_HASH, MAX_COST),
      ).to.be.revertedWithCustomError(cgPaymaster, "NotRegisteredOrg");
    });

    it("reverts if org balance is insufficient", async () => {
      const { cgPaymaster, orgAddress, programAddress, mockEntryPoint, alice } = await deployFixture();

      // No deposit — orgBalance is 0
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());
      const userOp = buildUserOp(alice.address, programAddress, await cgPaymaster.getAddress(), orgAddress);

      await expect(
        cgPaymaster.connect(entryPointSigner).validatePaymasterUserOp(userOp, USER_OP_HASH, MAX_COST),
      ).to.be.revertedWithCustomError(cgPaymaster, "InsufficientOrgBalance");
    });

    it("reverts if target does not belong to the org", async () => {
      const { cgPaymaster, orgAddress, mockEntryPoint, alice } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      // Target is a random EOA — not in the org
      const userOp = buildUserOp(
        alice.address,
        alice.address, // not an org contract
        await cgPaymaster.getAddress(),
        orgAddress,
      );

      await expect(
        cgPaymaster.connect(entryPointSigner).validatePaymasterUserOp(userOp, USER_OP_HASH, MAX_COST),
      ).to.be.revertedWithCustomError(cgPaymaster, "InvalidCallTarget");
    });

    it("reverts if callData is too short", async () => {
      const { cgPaymaster, orgAddress, mockEntryPoint, alice } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      const userOp = {
        ...buildUserOp(alice.address, alice.address, await cgPaymaster.getAddress(), orgAddress),
        callData: "0x1234", // too short
      };

      await expect(
        cgPaymaster.connect(entryPointSigner).validatePaymasterUserOp(userOp, USER_OP_HASH, MAX_COST),
      ).to.be.revertedWithCustomError(cgPaymaster, "InvalidCallData");
    });

    it("reverts if callData uses an unexpected selector", async () => {
      const { cgPaymaster, orgAddress, programAddress, mockEntryPoint, alice } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      // Swap selector to executeBatch — not supported
      const iface = new ethers.Interface(["function executeBatch(address[],uint256[],bytes[])"]);
      const badCallData = iface.encodeFunctionData("executeBatch", [[programAddress], [0n], ["0x"]]);

      const userOp = {
        ...buildUserOp(alice.address, programAddress, await cgPaymaster.getAddress(), orgAddress),
        callData: badCallData,
      };

      await expect(
        cgPaymaster.connect(entryPointSigner).validatePaymasterUserOp(userOp, USER_OP_HASH, MAX_COST),
      ).to.be.revertedWithCustomError(cgPaymaster, "InvalidCallData");
    });

    it("reverts when called by anyone other than the EntryPoint", async () => {
      const { cgPaymaster, orgAddress, programAddress, alice } = await deployFixture();

      const userOp = buildUserOp(alice.address, programAddress, await cgPaymaster.getAddress(), orgAddress);
      await expect(
        cgPaymaster.connect(alice).validatePaymasterUserOp(userOp, USER_OP_HASH, MAX_COST),
      ).to.be.revertedWithCustomError(cgPaymaster, "OnlyEntryPoint");
    });

    it("reverts if inner selector is not on the sponsorship allowlist", async () => {
      const { cgPaymaster, orgAddress, programAddress, mockEntryPoint, alice } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      // setBeneficiaries is an owner-only admin op — must NOT be sponsorable.
      const adminIface = new ethers.Interface(["function setBeneficiaries(uint256,address[],uint256[])"]);
      const innerData = adminIface.encodeFunctionData("setBeneficiaries", [0n, [alice.address], [1n]]);
      const userOp = {
        ...buildUserOp(alice.address, programAddress, await cgPaymaster.getAddress(), orgAddress),
        callData: encodeExecute(programAddress, 0n, innerData),
      };

      await expect(
        cgPaymaster.connect(entryPointSigner).validatePaymasterUserOp(userOp, USER_OP_HASH, MAX_COST),
      ).to.be.revertedWithCustomError(cgPaymaster, "InvalidCallData");
    });

    it("sponsors CGToken user ops (safeTransferFrom on the token)", async () => {
      const { cgPaymaster, orgAddress, tokenAddress, mockEntryPoint, alice, bob } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      const tokenIface = new ethers.Interface(["function safeTransferFrom(address,address,uint256,uint256,bytes)"]);
      const innerData = tokenIface.encodeFunctionData("safeTransferFrom", [alice.address, bob.address, 0n, 1n, "0x"]);
      const userOp = {
        ...buildUserOp(alice.address, tokenAddress, await cgPaymaster.getAddress(), orgAddress),
        callData: encodeExecute(tokenAddress, 0n, innerData),
      };

      const [, validationData] = await cgPaymaster
        .connect(entryPointSigner)
        .validatePaymasterUserOp.staticCall(userOp, USER_OP_HASH, MAX_COST);
      expect(validationData).to.equal(0n);
    });
  });

  // ── postOp ──────────────────────────────────────────────────────────────────

  describe("postOp", function () {
    it("refunds unused gas and emits GasCharged", async () => {
      const { cgPaymaster, orgAddress, programAddress, mockEntryPoint, alice } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      const userOp = buildUserOp(alice.address, programAddress, await cgPaymaster.getAddress(), orgAddress);
      await cgPaymaster.connect(entryPointSigner).validatePaymasterUserOp(userOp, USER_OP_HASH, MAX_COST);

      // Construct context as the contract encodes it: abi.encode(org, maxCost)
      const context = ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [orgAddress, MAX_COST]);

      const actualCost = MAX_COST / 2n;
      const expectedRemaining = DEPOSIT - actualCost; // MAX_COST reserved, half refunded

      await expect(cgPaymaster.connect(entryPointSigner).postOp(0, context, actualCost))
        .to.emit(cgPaymaster, "GasCharged")
        .withArgs(orgAddress, actualCost, expectedRemaining);

      expect(await cgPaymaster.orgBalance(orgAddress)).to.equal(expectedRemaining);
    });

    it("emits LowBalance when remaining balance falls below the threshold", async () => {
      const { cgPaymaster, orgAddress, programAddress, mockEntryPoint, alice } = await deployFixture();

      // Deposit so that after the full charge, remaining = LOW_THRESHOLD - 1 (strictly below threshold)
      const tinyDeposit = LOW_THRESHOLD + MAX_COST - 1n;
      await cgPaymaster.depositFor(orgAddress, { value: tinyDeposit });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      const userOp = buildUserOp(alice.address, programAddress, await cgPaymaster.getAddress(), orgAddress);
      await cgPaymaster.connect(entryPointSigner).validatePaymasterUserOp(userOp, USER_OP_HASH, MAX_COST);

      // actualCost = MAX_COST → refund = 0 → remaining = LOW_THRESHOLD - 1 < threshold
      const context = ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [orgAddress, MAX_COST]);
      await expect(cgPaymaster.connect(entryPointSigner).postOp(0, context, MAX_COST))
        .to.emit(cgPaymaster, "LowBalance")
        .withArgs(orgAddress, LOW_THRESHOLD - 1n);
    });

    it("reverts when called by anyone other than the EntryPoint", async () => {
      const { cgPaymaster, alice } = await deployFixture();
      await expect(cgPaymaster.connect(alice).postOp(0, "0x", 0n)).to.be.revertedWithCustomError(
        cgPaymaster,
        "OnlyEntryPoint",
      );
    });
  });

  // ── withdraw ────────────────────────────────────────────────────────────────

  describe("withdraw", function () {
    it("allows the owner (default manager) to withdraw unused balance", async () => {
      const { cgPaymaster, orgAddress, deployer, alice } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });

      const before = await ethers.provider.getBalance(alice.address);
      await expect(cgPaymaster.connect(deployer).withdraw(orgAddress, alice.address, DEPOSIT))
        .to.emit(cgPaymaster, "Withdrawn")
        .withArgs(orgAddress, DEPOSIT, alice.address);

      expect(await cgPaymaster.orgBalance(orgAddress)).to.equal(0n);
      expect(await ethers.provider.getBalance(alice.address)).to.equal(before + DEPOSIT);
    });

    it("reverts if called by a non-manager", async () => {
      const { cgPaymaster, orgAddress, alice } = await deployFixture();
      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      await expect(
        cgPaymaster.connect(alice).withdraw(orgAddress, alice.address, DEPOSIT),
      ).to.be.revertedWithCustomError(cgPaymaster, "NotOrgManager");
    });

    it("reverts if amount exceeds org balance", async () => {
      const { cgPaymaster, orgAddress, deployer, alice } = await deployFixture();
      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      await expect(
        cgPaymaster.connect(deployer).withdraw(orgAddress, alice.address, DEPOSIT + 1n),
      ).to.be.revertedWithCustomError(cgPaymaster, "InsufficientOrgBalance");
    });
  });

  // ── transferManagement ──────────────────────────────────────────────────────

  describe("transferManagement", function () {
    it("allows the current manager to hand off management to a new address", async () => {
      const { cgPaymaster, orgAddress, orgOwner, deployer } = await deployFixture();

      await expect(cgPaymaster.connect(deployer).transferManagement(orgAddress, orgOwner.address))
        .to.emit(cgPaymaster, "ManagementTransferred")
        .withArgs(orgAddress, orgOwner.address);

      expect(await cgPaymaster.managerOf(orgAddress)).to.equal(orgOwner.address);
    });

    it("new manager can withdraw; old manager (owner) can no longer withdraw", async () => {
      const { cgPaymaster, orgAddress, orgOwner, deployer, alice } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      await cgPaymaster.connect(deployer).transferManagement(orgAddress, orgOwner.address);

      // Old manager (deployer) is blocked
      await expect(
        cgPaymaster.connect(deployer).withdraw(orgAddress, alice.address, DEPOSIT),
      ).to.be.revertedWithCustomError(cgPaymaster, "NotOrgManager");

      // New manager (orgOwner) succeeds
      await expect(cgPaymaster.connect(orgOwner).withdraw(orgAddress, alice.address, DEPOSIT)).to.not.be.reverted;
    });

    it("reverts if called by a non-manager", async () => {
      const { cgPaymaster, orgAddress, alice, bob } = await deployFixture();
      await expect(
        cgPaymaster.connect(alice).transferManagement(orgAddress, bob.address),
      ).to.be.revertedWithCustomError(cgPaymaster, "NotOrgManager");
    });
  });

  // ── setLowBalanceThreshold ──────────────────────────────────────────────────

  describe("setLowBalanceThreshold", function () {
    it("updates the threshold and emits an event", async () => {
      const { cgPaymaster, deployer } = await deployFixture();
      const newThreshold = ethers.parseEther("0.05");

      await expect(cgPaymaster.connect(deployer).setLowBalanceThreshold(newThreshold))
        .to.emit(cgPaymaster, "LowBalanceThresholdSet")
        .withArgs(newThreshold);

      expect(await cgPaymaster.lowBalanceThreshold()).to.equal(newThreshold);
    });

    it("reverts for non-owner", async () => {
      const { cgPaymaster, alice } = await deployFixture();
      await expect(cgPaymaster.connect(alice).setLowBalanceThreshold(1n)).to.be.revertedWithCustomError(
        cgPaymaster,
        "OwnableUnauthorizedAccount",
      );
    });
  });

  // ── totalDeposit / managerOf ────────────────────────────────────────────────

  describe("views", function () {
    it("totalDeposit reflects ETH held at MockEntryPoint", async () => {
      const { cgPaymaster, orgAddress } = await deployFixture();
      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      expect(await cgPaymaster.totalDeposit()).to.equal(DEPOSIT);
    });

    it("managerOf returns owner for unmanaged org, new address after transfer", async () => {
      const { cgPaymaster, orgAddress, deployer, orgOwner } = await deployFixture();

      expect(await cgPaymaster.managerOf(orgAddress)).to.equal(deployer.address);
      await cgPaymaster.connect(deployer).transferManagement(orgAddress, orgOwner.address);
      expect(await cgPaymaster.managerOf(orgAddress)).to.equal(orgOwner.address);
    });
  });
});
