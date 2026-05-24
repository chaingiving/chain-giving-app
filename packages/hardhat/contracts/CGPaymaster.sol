// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { CGRegistry } from "./CGRegistry.sol";
import { CGOrganization } from "./CGOrganization.sol";

// ── Minimal ERC-4337 EntryPoint v0.7 interface ───────────────────────────────

interface IEntryPoint {
    function depositTo(address account) external payable;
    function withdrawTo(address payable withdrawAddress, uint256 withdrawAmount) external;
    function balanceOf(address account) external view returns (uint256);
}

// ── ERC-4337 PackedUserOperation struct (EntryPoint v0.7) ────────────────────

struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits; //  [verificationGasLimit (16) | callGasLimit (16)]
    uint256 preVerificationGas;
    bytes32 gasFees; //          [maxPriorityFeePerGas (16) | maxFeePerGas (16)]
    bytes paymasterAndData;
    bytes signature;
}

enum PostOpMode {
    opSucceeded,
    opReverted,
    postOpReverted
}

// ─────────────────────────────────────────────────────────────────────────────

/// @title CGPaymaster — ERC-4337 v0.7 Paymaster for Chain.Giving gas sponsorship
///
/// @notice Sponsors gas for beneficiary and organization owner UserOperations.
///         Each organization has an independent ETH budget tracked on-chain.
///         The total ETH is held at the EntryPoint under this paymaster's deposit;
///         per-org accounting is maintained in the `orgBalance` mapping.
///         Validation is fully on-chain — no off-chain relayer or signing service needed.
///
/// @dev    paymasterAndData layout (EntryPoint v0.7):
///           [0  :20] paymaster address                       (set by wallet/bundler)
///           [20:36] paymasterVerificationGasLimit (uint128)  (set by wallet/bundler)
///           [36:52] paymasterPostOpGasLimit       (uint128)  (set by wallet/bundler)
///           [52:72] sponsoring org address (20 bytes)        ← our paymasterData
///
///         Sponsored calls must use one of two outer selectors:
///           • execute(address,uint256,bytes)  — SimpleAccount / Coinbase Smart Wallet  (0xb61d27f6)
///           • execute(bytes32,bytes)          — ERC-7579 single execution / Kernel v3 (0xe9ae5c53)
///
///         The resolved call target must belong to the sponsoring org — checked by walking
///         the on-chain ownership chain: org → program → token/distribution/crowdfunding.
///
/// @dev    Management model:
///           • By default the CGPaymaster owner (= CGRegistry deployer) manages every org's stash.
///           • An org can opt into self-management via `transferManagement`.
///           • Only the current manager may `withdraw` or re-`transferManagement` an org's budget.
contract CGPaymaster is Ownable {
    // ── Outer-selector constants ──────────────────────────────────────────────

    /// @dev keccak256("execute(address,uint256,bytes)")[0:4]
    bytes4 private constant EXECUTE_SIMPLE = 0xb61d27f6;
    /// @dev keccak256("execute(bytes32,bytes)")[0:4] — ERC-7579 modular accounts
    bytes4 private constant EXECUTE_ERC7579 = 0xe9ae5c53;

    // ── paymasterAndData layout (v0.7) ───────────────────────────────────────

    uint256 private constant ORG_DATA_OFFSET = 52;
    uint256 private constant ORG_DATA_END = 72;

    // ── SimpleAccount execute(address,uint256,bytes) layout ──────────────────
    //
    //   [0  :  4] outer selector
    //   [4  : 36] target          (address, right-aligned in 32 bytes)
    //   [36 : 68] value           (uint256)
    //   [68 :100] data offset     (canonical = 0x60)
    //   [100:132] data length     (≥ 4)
    //   [132:136] inner selector
    uint256 private constant SIMPLE_DATA_OFFSET = 0x60;
    uint256 private constant SIMPLE_INNER_SELECTOR_AT = 132;
    uint256 private constant SIMPLE_MIN_LENGTH = 136;

    // ── ERC-7579 execute(bytes32,bytes) layout ───────────────────────────────
    //
    //   [0  :  4] outer selector
    //   [4  : 36] mode (bytes32) — byte 0 = callType, byte 1 = execType, rest unused
    //   [36 : 68] data offset    (canonical = 0x40)
    //   [68 :100] data length    (≥ 56 = target(20) + value(32) + selector(4))
    //   executionData is abi.encodePacked(target, value, callData):
    //     [100:120] target
    //     [120:152] value
    //     [152:156] inner selector
    uint256 private constant ERC7579_DATA_OFFSET = 0x40;
    uint256 private constant ERC7579_TARGET_AT = 100;
    uint256 private constant ERC7579_INNER_SELECTOR_AT = 152;
    uint256 private constant ERC7579_MIN_EXEC_DATA_LEN = 56;
    uint256 private constant ERC7579_MIN_LENGTH = 156;
    bytes1 private constant ERC7579_CALLTYPE_SINGLE = 0x00;

    // ── Sponsored inner-selector allowlist ───────────────────────────────────
    // Only non-owner, user-facing selectors are sponsorable. Owner-only admin ops
    // are excluded so an attacker cannot drain an org's gas budget via reverting calls.
    //
    // Donate / cancelContribution / refund are intentionally NOT sponsored:
    // the frontend runs them as direct EOA calls because the ERC-20 token holder
    // (msg.sender) must match the donor identity, which can't happen via a smart
    // account when permit is ECDSA-only (USDC FiatToken).

    // CGToken user ops (ERC-1155 + ERC-1155Burnable)
    bytes4 private constant SEL_SAFE_TRANSFER_FROM =
        bytes4(keccak256("safeTransferFrom(address,address,uint256,uint256,bytes)"));
    bytes4 private constant SEL_SAFE_BATCH_TRANSFER_FROM =
        bytes4(keccak256("safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)"));
    bytes4 private constant SEL_SET_APPROVAL_FOR_ALL = bytes4(keccak256("setApprovalForAll(address,bool)"));
    bytes4 private constant SEL_BURN = bytes4(keccak256("burn(address,uint256,uint256)"));
    bytes4 private constant SEL_BURN_BATCH = bytes4(keccak256("burnBatch(address,uint256[],uint256[])"));

    // ── State ─────────────────────────────────────────────────────────────────

    /// @notice The ERC-4337 EntryPoint singleton this paymaster is registered with.
    IEntryPoint public immutable entryPoint;

    /// @notice The Chain.Giving registry used to verify org and program addresses.
    CGRegistry public immutable registry;

    /// @notice Per-org internal gas budget (accounting only; actual ETH lives at EntryPoint).
    mapping(address org => uint256) public orgBalance;

    /// @notice Who may withdraw or reassign an org's budget.
    ///         address(0) means the CGPaymaster owner manages the org (default).
    mapping(address org => address) public orgManager;

    /// @notice Emit LowBalance when an org's remaining budget falls below this value (in wei).
    uint256 public lowBalanceThreshold;

    // ── Events ────────────────────────────────────────────────────────────────

    event Deposited(address indexed org, uint256 amount, address indexed depositor);
    event GasCharged(address indexed org, uint256 actualCost, uint256 remainingBalance);
    event LowBalance(address indexed org, uint256 balance);
    event Withdrawn(address indexed org, uint256 amount, address indexed to);
    event ManagementTransferred(address indexed org, address indexed newManager);
    event LowBalanceThresholdSet(uint256 threshold);

    // ── Errors ────────────────────────────────────────────────────────────────

    error OnlyEntryPoint();
    error NotOrgManager();
    error NotRegisteredOrg();
    error InsufficientOrgBalance(uint256 available, uint256 required);
    error InvalidCallTarget();
    error InvalidCallData();
    error InvalidPaymasterData();

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(IEntryPoint entryPoint_, CGRegistry registry_, uint256 lowBalanceThreshold_) Ownable(msg.sender) {
        entryPoint = entryPoint_;
        registry = registry_;
        lowBalanceThreshold = lowBalanceThreshold_;
    }

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyEntryPoint() {
        if (msg.sender != address(entryPoint)) revert OnlyEntryPoint();
        _;
    }

    // ── Funding ───────────────────────────────────────────────────────────────

    /// @notice Top up an org's gas budget. Sends ETH to the EntryPoint under this paymaster's deposit.
    ///         Callable by anyone — the registry owner tops up orgs as a managed service.
    /// @param org The CGOrganization address to credit.
    function depositFor(address org) external payable {
        if (!registry.isOrganization(org)) revert NotRegisteredOrg();
        orgBalance[org] += msg.value;
        entryPoint.depositTo{ value: msg.value }(address(this));
        emit Deposited(org, msg.value, msg.sender);
    }

    // ── Withdrawal ────────────────────────────────────────────────────────────

    /// @notice Withdraw unused ETH from an org's budget. Only callable by the org's manager.
    function withdraw(address org, address payable to, uint256 amount) external {
        if (msg.sender != _managerOf(org)) revert NotOrgManager();
        if (orgBalance[org] < amount) revert InsufficientOrgBalance(orgBalance[org], amount);

        orgBalance[org] -= amount;
        entryPoint.withdrawTo(to, amount);
        emit Withdrawn(org, amount, to);
    }

    // ── Management ────────────────────────────────────────────────────────────

    /// @notice Hand over management of an org's gas budget to a new address.
    function transferManagement(address org, address newManager) external {
        if (msg.sender != _managerOf(org)) revert NotOrgManager();
        orgManager[org] = newManager;
        emit ManagementTransferred(org, newManager);
    }

    /// @notice Update the low-balance warning threshold.
    function setLowBalanceThreshold(uint256 threshold) external onlyOwner {
        lowBalanceThreshold = threshold;
        emit LowBalanceThresholdSet(threshold);
    }

    // ── ERC-4337 Paymaster interface (v0.7) ───────────────────────────────────

    /// @notice Called by the EntryPoint before UserOperation execution.
    ///         Validates the sponsoring org has sufficient budget and that the call targets
    ///         a contract owned by that org. Reserves the maximum possible gas cost.
    function validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32,
        uint256 maxCost
    ) external onlyEntryPoint returns (bytes memory context, uint256 validationData) {
        if (userOp.paymasterAndData.length < ORG_DATA_END) revert InvalidPaymasterData();
        address org = address(bytes20(userOp.paymasterAndData[ORG_DATA_OFFSET:ORG_DATA_END]));

        if (!registry.isOrganization(org)) revert NotRegisteredOrg();
        if (orgBalance[org] < maxCost) revert InsufficientOrgBalance(orgBalance[org], maxCost);
        if (!_isValidCall(userOp.callData, CGOrganization(org))) revert InvalidCallTarget();

        // Reserve the worst-case cost; postOp refunds the unused portion.
        orgBalance[org] -= maxCost;

        return (abi.encode(org, maxCost), 0);
    }

    /// @notice Called by the EntryPoint after UserOperation execution.
    /// @dev    v0.7 signature includes `actualUserOpFeePerGas` (informational; we don't use it).
    ///         When `mode == postOpReverted`, the EntryPoint is retrying after the FIRST postOp
    ///         call reverted; crediting again would double-refund. We forfeit the reserve.
    function postOp(
        PostOpMode mode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 /* actualUserOpFeePerGas */
    ) external onlyEntryPoint {
        if (mode == PostOpMode.postOpReverted) return;

        (address org, uint256 reserved) = abi.decode(context, (address, uint256));

        // Defensive: the EntryPoint should never charge more than was reserved, but guard
        // against under-flow so a buggy entrypoint cannot zero out the org balance.
        uint256 charge = actualGasCost > reserved ? reserved : actualGasCost;

        unchecked {
            orgBalance[org] += reserved - charge;
        }

        uint256 remaining = orgBalance[org];
        emit GasCharged(org, charge, remaining);

        if (remaining < lowBalanceThreshold) {
            emit LowBalance(org, remaining);
        }
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    /// @notice Total ETH deposited at the EntryPoint under this paymaster's account.
    function totalDeposit() external view returns (uint256) {
        return entryPoint.balanceOf(address(this));
    }

    /// @notice Returns the effective manager for an org's budget.
    function managerOf(address org) external view returns (address) {
        return _managerOf(org);
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _managerOf(address org) internal view returns (address) {
        address m = orgManager[org];
        return m == address(0) ? owner() : m;
    }

    /// @dev Validates callData encodes one of the supported execute selectors, decodes the
    ///      inner call, and checks it targets an org-owned contract with an allowlisted
    ///      inner selector. Rejects non-canonical ABI encodings to keep offsets fixed.
    function _isValidCall(bytes calldata callData, CGOrganization org) internal view returns (bool) {
        if (callData.length < 4) revert InvalidCallData();
        bytes4 outerSel = bytes4(callData[0:4]);

        address target;
        bytes4 innerSelector;

        if (outerSel == EXECUTE_SIMPLE) {
            if (callData.length < SIMPLE_MIN_LENGTH) revert InvalidCallData();

            uint256 dataOffset = uint256(bytes32(callData[68:100]));
            if (dataOffset != SIMPLE_DATA_OFFSET) revert InvalidCallData();
            uint256 dataLength = uint256(bytes32(callData[100:132]));
            if (dataLength < 4) revert InvalidCallData();

            target = address(uint160(uint256(bytes32(callData[4:36]))));
            innerSelector = bytes4(callData[SIMPLE_INNER_SELECTOR_AT:SIMPLE_INNER_SELECTOR_AT + 4]);
        } else if (outerSel == EXECUTE_ERC7579) {
            if (callData.length < ERC7579_MIN_LENGTH) revert InvalidCallData();

            // Reject batch (0x01) and delegatecall (0xff) in v1
            if (callData[4] != ERC7579_CALLTYPE_SINGLE) revert InvalidCallData();

            uint256 dataOffset = uint256(bytes32(callData[36:68]));
            if (dataOffset != ERC7579_DATA_OFFSET) revert InvalidCallData();
            uint256 dataLength = uint256(bytes32(callData[68:100]));
            if (dataLength < ERC7579_MIN_EXEC_DATA_LEN) revert InvalidCallData();
            if (callData.length < 100 + dataLength) revert InvalidCallData();

            target = address(bytes20(callData[ERC7579_TARGET_AT:ERC7579_TARGET_AT + 20]));
            innerSelector = bytes4(callData[ERC7579_INNER_SELECTOR_AT:ERC7579_INNER_SELECTOR_AT + 4]);
        } else {
            revert InvalidCallData();
        }

        if (!_isSponsoredSelector(innerSelector)) revert InvalidCallData();
        return _isOrgContract(org, target);
    }

    /// @dev Allowlist of inner selectors the paymaster will sponsor. Limited to user-facing
    ///      flows so owner-only admin reverts cannot drain an org's budget.
    function _isSponsoredSelector(bytes4 sel) internal pure returns (bool) {
        return
            sel == SEL_SAFE_TRANSFER_FROM ||
            sel == SEL_SAFE_BATCH_TRANSFER_FROM ||
            sel == SEL_SET_APPROVAL_FOR_ALL ||
            sel == SEL_BURN ||
            sel == SEL_BURN_BATCH;
    }

    /// @dev Returns true if `target` is a contract that belongs to `org`:
    ///        - the org contract itself
    ///        - a CGProgram created by the org
    ///        - a CGToken, CGDistribution, or CGCrowdfunding owned by one of the org's programs
    ///          (all are Ownable with their parent CGProgram as owner)
    function _isOrgContract(CGOrganization org, address target) internal view returns (bool) {
        if (target == address(org)) return true;
        if (org.isProgram(target)) return true;
        if (target.code.length == 0) return false;
        try Ownable(target).owner() returns (address parent) {
            return org.isProgram(parent);
        } catch {
            return false;
        }
    }
}
