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
 *  validation tests can focus on org/target/balance logic without crafting payloads.
 *  setApprovalForAll(address,bool) is on the sponsored allowlist (CGToken user op);
 *  donate/cancel/refund were pruned from the allowlist in the EOA-direct migration. */
const DEFAULT_INNER_DATA = new ethers.Interface(["function setApprovalForAll(address,bool)"]).encodeFunctionData(
  "setApprovalForAll",
  [ethers.ZeroAddress, true],
);

/** ABI-encodes an execute(address,uint256,bytes) call (SimpleAccount / Coinbase Smart Wallet).
 *  `data` defaults to a `donate(1)` payload so it passes CGPaymaster's selector allowlist. */
function encodeExecute(target: string, value = 0n, data: string = DEFAULT_INNER_DATA): string {
  const iface = new ethers.Interface(["function execute(address,uint256,bytes)"]);
  return iface.encodeFunctionData("execute", [target, value, data]);
}

/** ABI-encodes an ERC-7579 execute(bytes32 mode, bytes executionData) call (Kernel v3).
 *  Mode = single execution (callType 0x00). executionData is the packed encoding
 *  abi.encodePacked(target, value, data) — NOT standard ABI.
 *
 *  `mode` lets tests override the mode word to exercise rejection paths. */
function encodeExecuteERC7579(
  target: string,
  value = 0n,
  data: string = DEFAULT_INNER_DATA,
  mode: string = ethers.ZeroHash, // callType=0x00 (single), execType=0x00, rest 0
): string {
  const iface = new ethers.Interface(["function execute(bytes32,bytes)"]);
  const executionData = ethers.concat([target, ethers.zeroPadValue(ethers.toBeHex(value), 32), data]);
  return iface.encodeFunctionData("execute", [mode, executionData]);
}

/** ABI-encodes an ERC-7579 BATCH execute (callType 0x01). executionData is
 *  abi.encode(Execution[]) where Execution = (address target, uint256 value, bytes callData). */
function encodeExecuteERC7579Batch(executions: Array<{ target: string; value?: bigint; data: string }>): string {
  const iface = new ethers.Interface(["function execute(bytes32,bytes)"]);
  const batchMode = "0x01" + "00".repeat(31);
  const executionData = ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(address,uint256,bytes)[]"],
    [executions.map(e => [e.target, e.value ?? 0n, e.data])],
  );
  return iface.encodeFunctionData("execute", [batchMode, executionData]);
}

/** Builds the v0.7 paymasterAndData field:
 *    [0:20]  paymaster address
 *    [20:36] verificationGasLimit (uint128)
 *    [36:52] postOpGasLimit       (uint128)
 *    [52:72] sponsoring org address                                           */
function buildPaymasterAndData(paymasterAddress: string, orgAddress: string): string {
  return ethers.concat([
    paymasterAddress,
    ethers.zeroPadValue(ethers.toBeHex(0x10000n), 16), // verificationGasLimit
    ethers.zeroPadValue(ethers.toBeHex(0x8000n), 16), // postOpGasLimit
    orgAddress,
  ]);
}

/** Returns a minimal v0.7 PackedUserOperation targeting `callTarget` and sponsored by `org`.
 *  accountGasLimits and gasFees are zeroed — the paymaster never reads them. */
function buildUserOp(sender: string, callTarget: string, paymasterAddress: string, orgAddress: string): object {
  return {
    sender,
    nonce: 0n,
    initCode: "0x",
    callData: encodeExecute(callTarget),
    accountGasLimits: ethers.ZeroHash,
    preVerificationGas: 50_000n,
    gasFees: ethers.ZeroHash,
    paymasterAndData: buildPaymasterAndData(paymasterAddress, orgAddress),
    signature: "0x",
  };
}

const USER_OP_HASH = ethers.ZeroHash;
const MAX_COST = ethers.parseEther("0.005");
const DEPOSIT = ethers.parseEther("0.1");
const LOW_THRESHOLD = ethers.parseEther("0.01");

const POST_OP_MODE_SUCCEEDED = 0;
const POST_OP_MODE_REVERTED = 1;
const POST_OP_MODE_POST_OP_REVERTED = 2;

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

  // ── validatePaymasterUserOp — SimpleAccount calldata ────────────────────────

  describe("validatePaymasterUserOp (SimpleAccount / execute(address,uint256,bytes))", function () {
    it("validates successfully when org has balance and target is a program", async () => {
      const { cgPaymaster, orgAddress, programAddress, mockEntryPoint, alice } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      const userOp = buildUserOp(alice.address, programAddress, await cgPaymaster.getAddress(), orgAddress);

      const [, validationData] = await cgPaymaster
        .connect(entryPointSigner)
        .validatePaymasterUserOp.staticCall(userOp, USER_OP_HASH, MAX_COST);

      expect(validationData).to.equal(0n);
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

    it("reverts if callData uses an unexpected outer selector", async () => {
      const { cgPaymaster, orgAddress, programAddress, mockEntryPoint, alice } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      // executeBatch is not in the allowlist — should revert
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

    it("reverts if paymasterAndData is shorter than 72 bytes", async () => {
      const { cgPaymaster, orgAddress, programAddress, mockEntryPoint, alice } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      // Truncated paymasterAndData — missing the trailing org address bytes
      const userOp = {
        ...buildUserOp(alice.address, programAddress, await cgPaymaster.getAddress(), orgAddress),
        paymasterAndData: ethers.concat([
          await cgPaymaster.getAddress(),
          ethers.zeroPadValue(ethers.toBeHex(0n), 16),
          ethers.zeroPadValue(ethers.toBeHex(0n), 16),
          "0x1234", // only 2 bytes of org address — too short
        ]),
      };

      await expect(
        cgPaymaster.connect(entryPointSigner).validatePaymasterUserOp(userOp, USER_OP_HASH, MAX_COST),
      ).to.be.revertedWithCustomError(cgPaymaster, "InvalidPaymasterData");
    });
  });

  // ── validatePaymasterUserOp — ERC-7579 / Kernel calldata ────────────────────

  describe("validatePaymasterUserOp (ERC-7579 / execute(bytes32,bytes))", function () {
    it("validates Kernel single-execution calldata targeting a program", async () => {
      const { cgPaymaster, orgAddress, programAddress, mockEntryPoint, alice } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      const userOp = {
        ...buildUserOp(alice.address, programAddress, await cgPaymaster.getAddress(), orgAddress),
        callData: encodeExecuteERC7579(programAddress),
      };

      const [, validationData] = await cgPaymaster
        .connect(entryPointSigner)
        .validatePaymasterUserOp.staticCall(userOp, USER_OP_HASH, MAX_COST);
      expect(validationData).to.equal(0n);
    });

    it("validates Kernel calldata targeting the CGToken", async () => {
      const { cgPaymaster, orgAddress, tokenAddress, mockEntryPoint, alice, bob } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      const tokenIface = new ethers.Interface(["function safeTransferFrom(address,address,uint256,uint256,bytes)"]);
      const innerData = tokenIface.encodeFunctionData("safeTransferFrom", [alice.address, bob.address, 0n, 1n, "0x"]);

      const userOp = {
        ...buildUserOp(alice.address, tokenAddress, await cgPaymaster.getAddress(), orgAddress),
        callData: encodeExecuteERC7579(tokenAddress, 0n, innerData),
      };

      const [, validationData] = await cgPaymaster
        .connect(entryPointSigner)
        .validatePaymasterUserOp.staticCall(userOp, USER_OP_HASH, MAX_COST);
      expect(validationData).to.equal(0n);
    });

    it("accepts Kernel batch execution (callType 0x01) when every inner call is sponsorable", async () => {
      const { cgPaymaster, orgAddress, programAddress, tokenAddress, mockEntryPoint, alice } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      // Two sponsorable calls bundled in one UserOp: a donate on the program,
      // and a safeTransferFrom on the token. Both selectors are allowlisted and
      // both targets belong to the org.
      const tokenIface = new ethers.Interface(["function safeTransferFrom(address,address,uint256,uint256,bytes)"]);
      const transferData = tokenIface.encodeFunctionData("safeTransferFrom", [
        alice.address,
        alice.address,
        0n,
        1n,
        "0x",
      ]);

      const userOp = {
        ...buildUserOp(alice.address, programAddress, await cgPaymaster.getAddress(), orgAddress),
        callData: encodeExecuteERC7579Batch([
          { target: programAddress, data: DEFAULT_INNER_DATA },
          { target: tokenAddress, data: transferData },
        ]),
      };

      const [, validationData] = await cgPaymaster
        .connect(entryPointSigner)
        .validatePaymasterUserOp.staticCall(userOp, USER_OP_HASH, MAX_COST);
      expect(validationData).to.equal(0n);
    });

    it("rejects Kernel batch execution when any inner selector is not on the allowlist", async () => {
      const { cgPaymaster, orgAddress, programAddress, mockEntryPoint, alice } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      const adminIface = new ethers.Interface(["function setBeneficiaries(uint256,address[],uint256[])"]);
      const adminData = adminIface.encodeFunctionData("setBeneficiaries", [0n, [alice.address], [1n]]);

      const userOp = {
        ...buildUserOp(alice.address, programAddress, await cgPaymaster.getAddress(), orgAddress),
        callData: encodeExecuteERC7579Batch([
          { target: programAddress, data: DEFAULT_INNER_DATA },
          { target: programAddress, data: adminData }, // setBeneficiaries is owner-only — never sponsored
        ]),
      };

      await expect(
        cgPaymaster.connect(entryPointSigner).validatePaymasterUserOp(userOp, USER_OP_HASH, MAX_COST),
      ).to.be.revertedWithCustomError(cgPaymaster, "InvalidCallData");
    });

    it("rejects Kernel batch execution when any target is outside the sponsoring org", async () => {
      const { cgPaymaster, orgAddress, programAddress, mockEntryPoint, alice } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      const userOp = {
        ...buildUserOp(alice.address, programAddress, await cgPaymaster.getAddress(), orgAddress),
        callData: encodeExecuteERC7579Batch([
          { target: programAddress, data: DEFAULT_INNER_DATA },
          { target: alice.address, data: DEFAULT_INNER_DATA }, // alice isn't an org contract
        ]),
      };

      // Matches the single-execution behavior: _isValidCall returns false, the
      // outer validatePaymasterUserOp reverts with InvalidCallTarget.
      await expect(
        cgPaymaster.connect(entryPointSigner).validatePaymasterUserOp(userOp, USER_OP_HASH, MAX_COST),
      ).to.be.revertedWithCustomError(cgPaymaster, "InvalidCallTarget");
    });

    it("rejects empty Kernel batch", async () => {
      const { cgPaymaster, orgAddress, programAddress, mockEntryPoint, alice } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      const userOp = {
        ...buildUserOp(alice.address, programAddress, await cgPaymaster.getAddress(), orgAddress),
        callData: encodeExecuteERC7579Batch([]),
      };

      await expect(
        cgPaymaster.connect(entryPointSigner).validatePaymasterUserOp(userOp, USER_OP_HASH, MAX_COST),
      ).to.be.revertedWithCustomError(cgPaymaster, "InvalidCallData");
    });

    it("rejects Kernel delegatecall execution (callType 0xff)", async () => {
      const { cgPaymaster, orgAddress, programAddress, mockEntryPoint, alice } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      const delegateMode = "0xff" + "00".repeat(31);
      const userOp = {
        ...buildUserOp(alice.address, programAddress, await cgPaymaster.getAddress(), orgAddress),
        callData: encodeExecuteERC7579(programAddress, 0n, DEFAULT_INNER_DATA, delegateMode),
      };

      await expect(
        cgPaymaster.connect(entryPointSigner).validatePaymasterUserOp(userOp, USER_OP_HASH, MAX_COST),
      ).to.be.revertedWithCustomError(cgPaymaster, "InvalidCallData");
    });

    it("rejects ERC-7579 with target outside the org", async () => {
      const { cgPaymaster, orgAddress, mockEntryPoint, alice } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      const userOp = {
        ...buildUserOp(alice.address, alice.address, await cgPaymaster.getAddress(), orgAddress),
        callData: encodeExecuteERC7579(alice.address),
      };

      await expect(
        cgPaymaster.connect(entryPointSigner).validatePaymasterUserOp(userOp, USER_OP_HASH, MAX_COST),
      ).to.be.revertedWithCustomError(cgPaymaster, "InvalidCallTarget");
    });

    it("rejects ERC-7579 with disallowed inner selector", async () => {
      const { cgPaymaster, orgAddress, programAddress, mockEntryPoint, alice } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      const adminIface = new ethers.Interface(["function setBeneficiaries(uint256,address[],uint256[])"]);
      const adminData = adminIface.encodeFunctionData("setBeneficiaries", [0n, [alice.address], [1n]]);

      const userOp = {
        ...buildUserOp(alice.address, programAddress, await cgPaymaster.getAddress(), orgAddress),
        callData: encodeExecuteERC7579(programAddress, 0n, adminData),
      };

      await expect(
        cgPaymaster.connect(entryPointSigner).validatePaymasterUserOp(userOp, USER_OP_HASH, MAX_COST),
      ).to.be.revertedWithCustomError(cgPaymaster, "InvalidCallData");
    });

    it("rejects ERC-7579 with non-canonical data offset", async () => {
      const { cgPaymaster, orgAddress, programAddress, mockEntryPoint, alice } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      // Build a valid Kernel calldata then mutate bytes [36:68] (the bytes offset)
      // from 0x40 to 0x80.
      const valid = encodeExecuteERC7579(programAddress);
      const head = valid.slice(0, 2 + 2 * 36); // 0x + selector(4) + mode(32) = 36 bytes
      const tail = valid.slice(2 + 2 * 68); // skip the offset word
      const badOffset = ethers.zeroPadValue(ethers.toBeHex(0x80n), 32).slice(2);
      const mutated = head + badOffset + tail;

      const userOp = {
        ...buildUserOp(alice.address, programAddress, await cgPaymaster.getAddress(), orgAddress),
        callData: mutated,
      };

      await expect(
        cgPaymaster.connect(entryPointSigner).validatePaymasterUserOp(userOp, USER_OP_HASH, MAX_COST),
      ).to.be.revertedWithCustomError(cgPaymaster, "InvalidCallData");
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

      const context = ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [orgAddress, MAX_COST]);

      const actualCost = MAX_COST / 2n;
      const expectedRemaining = DEPOSIT - actualCost;

      await expect(cgPaymaster.connect(entryPointSigner).postOp(POST_OP_MODE_SUCCEEDED, context, actualCost, 0n))
        .to.emit(cgPaymaster, "GasCharged")
        .withArgs(orgAddress, actualCost, expectedRemaining);

      expect(await cgPaymaster.orgBalance(orgAddress)).to.equal(expectedRemaining);
    });

    it("emits LowBalance when remaining balance falls below the threshold", async () => {
      const { cgPaymaster, orgAddress, programAddress, mockEntryPoint, alice } = await deployFixture();

      // Deposit so that after the full charge, remaining = LOW_THRESHOLD - 1
      const tinyDeposit = LOW_THRESHOLD + MAX_COST - 1n;
      await cgPaymaster.depositFor(orgAddress, { value: tinyDeposit });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      const userOp = buildUserOp(alice.address, programAddress, await cgPaymaster.getAddress(), orgAddress);
      await cgPaymaster.connect(entryPointSigner).validatePaymasterUserOp(userOp, USER_OP_HASH, MAX_COST);

      const context = ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [orgAddress, MAX_COST]);
      await expect(cgPaymaster.connect(entryPointSigner).postOp(POST_OP_MODE_SUCCEEDED, context, MAX_COST, 0n))
        .to.emit(cgPaymaster, "LowBalance")
        .withArgs(orgAddress, LOW_THRESHOLD - 1n);
    });

    it("refunds correctly under postOp mode opReverted (UserOp execution reverted)", async () => {
      const { cgPaymaster, orgAddress, programAddress, mockEntryPoint, alice } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      const userOp = buildUserOp(alice.address, programAddress, await cgPaymaster.getAddress(), orgAddress);
      await cgPaymaster.connect(entryPointSigner).validatePaymasterUserOp(userOp, USER_OP_HASH, MAX_COST);

      const context = ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [orgAddress, MAX_COST]);
      const actualCost = MAX_COST / 3n;

      await expect(cgPaymaster.connect(entryPointSigner).postOp(POST_OP_MODE_REVERTED, context, actualCost, 0n))
        .to.emit(cgPaymaster, "GasCharged")
        .withArgs(orgAddress, actualCost, DEPOSIT - actualCost);

      expect(await cgPaymaster.orgBalance(orgAddress)).to.equal(DEPOSIT - actualCost);
    });

    it("does NOT credit the refund when called with mode=postOpReverted (no double-credit)", async () => {
      const { cgPaymaster, orgAddress, programAddress, mockEntryPoint, alice } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      const userOp = buildUserOp(alice.address, programAddress, await cgPaymaster.getAddress(), orgAddress);
      await cgPaymaster.connect(entryPointSigner).validatePaymasterUserOp(userOp, USER_OP_HASH, MAX_COST);

      const reservedBalance = await cgPaymaster.orgBalance(orgAddress);
      expect(reservedBalance).to.equal(DEPOSIT - MAX_COST);

      // Simulate the EntryPoint retrying after the first postOp call reverted.
      // The paymaster must forfeit the reserve rather than credit it back.
      const context = ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [orgAddress, MAX_COST]);
      const tx = cgPaymaster.connect(entryPointSigner).postOp(POST_OP_MODE_POST_OP_REVERTED, context, MAX_COST, 0n);
      await expect(tx).to.not.emit(cgPaymaster, "GasCharged");
      await expect(tx).to.not.emit(cgPaymaster, "LowBalance");

      // Balance unchanged — reserve forfeited, not refunded
      expect(await cgPaymaster.orgBalance(orgAddress)).to.equal(reservedBalance);
    });

    it("caps refund when actualGasCost exceeds reserved (defensive)", async () => {
      const { cgPaymaster, orgAddress, programAddress, mockEntryPoint, alice } = await deployFixture();

      await cgPaymaster.depositFor(orgAddress, { value: DEPOSIT });
      const entryPointSigner = await impersonate(await mockEntryPoint.getAddress());

      const userOp = buildUserOp(alice.address, programAddress, await cgPaymaster.getAddress(), orgAddress);
      await cgPaymaster.connect(entryPointSigner).validatePaymasterUserOp(userOp, USER_OP_HASH, MAX_COST);

      const reservedAfter = DEPOSIT - MAX_COST;
      const context = ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [orgAddress, MAX_COST]);

      // actualGasCost > reserved is bounded; charge = reserved; remaining = reservedAfter + 0
      await expect(cgPaymaster.connect(entryPointSigner).postOp(POST_OP_MODE_SUCCEEDED, context, MAX_COST + 1n, 0n))
        .to.emit(cgPaymaster, "GasCharged")
        .withArgs(orgAddress, MAX_COST, reservedAfter);

      expect(await cgPaymaster.orgBalance(orgAddress)).to.equal(reservedAfter);
    });

    it("reverts when called by anyone other than the EntryPoint", async () => {
      const { cgPaymaster, alice } = await deployFixture();
      await expect(cgPaymaster.connect(alice).postOp(0, "0x", 0n, 0n)).to.be.revertedWithCustomError(
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

      await expect(
        cgPaymaster.connect(deployer).withdraw(orgAddress, alice.address, DEPOSIT),
      ).to.be.revertedWithCustomError(cgPaymaster, "NotOrgManager");

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
