// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { CGRegistry } from "./CGRegistry.sol";
import { CGOrganization } from "./CGOrganization.sol";

// ── Minimal ERC-4337 EntryPoint v0.6 interface ───────────────────────────────

interface IEntryPoint {
    struct DepositInfo {
        uint112 deposit;
        bool staked;
        uint112 stake;
        uint32 unstakeDelaySec;
        uint48 withdrawTime;
    }

    function depositTo(address account) external payable;
    function withdrawTo(address payable withdrawAddress, uint256 withdrawAmount) external;
    function getDepositInfo(address account) external view returns (DepositInfo memory);
    function balanceOf(address account) external view returns (uint256);
}

// ── ERC-4337 UserOperation struct (EntryPoint v0.6) ──────────────────────────

struct UserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    uint256 callGasLimit;
    uint256 verificationGasLimit;
    uint256 preVerificationGas;
    uint256 maxFeePerGas;
    uint256 maxPriorityFeePerGas;
    bytes paymasterAndData;
    bytes signature;
}

enum PostOpMode {
    opSucceeded,
    opReverted,
    postOpReverted
}

// ─────────────────────────────────────────────────────────────────────────────

/// @title CGPaymaster — ERC-4337 Paymaster for Chain.Giving gas sponsorship
///
/// @notice Sponsors gas for beneficiary and organization owner UserOperations.
///         Each organization has an independent ETH budget tracked on-chain.
///         The total ETH is held at the EntryPoint under this paymaster's deposit;
///         per-org accounting is maintained in the `orgBalance` mapping.
///         Validation is fully on-chain — no off-chain relayer or signing service needed.
///
/// @dev    paymasterAndData layout:
///           [0  :20] — this paymaster address (set by wallet / bundler tooling)
///           [20 :40] — sponsoring org address (caller-supplied, 20 bytes)
///
///         Sponsored calls must use the standard execute(address,uint256,bytes) selector
///         (Coinbase Smart Wallet, ERC-4337 SimpleAccount, and most compatible wallets).
///         The resolved call target must belong to the sponsoring org — checked by walking
///         the on-chain ownership chain: org → program → token/distribution/crowdfunding.
///
/// @dev    Management model:
///           • By default the CGPaymaster owner (= CGRegistry deployer) manages every org's stash.
///           • An org can opt into self-management via `transferManagement`.
///           • Only the current manager may `withdraw` or re-`transferManagement` an org's budget.
contract CGPaymaster is Ownable {
    // ── Constants ─────────────────────────────────────────────────────────────

    /// @dev keccak256("execute(address,uint256,bytes)")[0:4]
    ///      Used by Coinbase Smart Wallet, ERC-4337 SimpleAccount, and most compatible wallets.
    bytes4 private constant EXECUTE_SELECTOR = bytes4(keccak256("execute(address,uint256,bytes)"));

    /// @dev Byte offset where the org address starts inside paymasterAndData.
    uint256 private constant ORG_DATA_OFFSET = 20;

    // ── Sponsored inner-selector allowlist ───────────────────────────────────
    // Only non-owner, user-facing selectors are sponsorable. Owner-only admin
    // ops (createProgram, setBeneficiaries, execute, mint, …) are excluded so
    // an attacker cannot drain an org's gas budget via reverting calls.

    // CGProgram + CGCrowdfunding (same signatures on both)
    bytes4 private constant SEL_DONATE = bytes4(keccak256("donate(uint256)"));
    bytes4 private constant SEL_DONATE_PERMIT =
        bytes4(keccak256("donateWithPermit(uint256,uint256,uint8,bytes32,bytes32)"));
    // CGCrowdfunding donor refunds
    bytes4 private constant SEL_CANCEL_CONTRIBUTION = bytes4(keccak256("cancelContribution()"));
    bytes4 private constant SEL_REFUND = bytes4(keccak256("refund()"));
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
    /// @param org    The CGOrganization whose budget to reduce.
    /// @param to     Recipient of the withdrawn ETH.
    /// @param amount Amount to withdraw in wei.
    function withdraw(address org, address payable to, uint256 amount) external {
        if (msg.sender != _managerOf(org)) revert NotOrgManager();
        if (orgBalance[org] < amount) revert InsufficientOrgBalance(orgBalance[org], amount);

        orgBalance[org] -= amount;
        entryPoint.withdrawTo(to, amount);
        emit Withdrawn(org, amount, to);
    }

    // ── Management ────────────────────────────────────────────────────────────

    /// @notice Hand over management of an org's gas budget to a new address.
    ///         Allows an org owner to self-manage their stash instead of relying on the registry owner.
    ///         Only the current manager may call this.
    /// @param org        The CGOrganization to reassign.
    /// @param newManager The new manager address. Use address(0) to revert to CGPaymaster owner.
    function transferManagement(address org, address newManager) external {
        if (msg.sender != _managerOf(org)) revert NotOrgManager();
        orgManager[org] = newManager;
        emit ManagementTransferred(org, newManager);
    }

    /// @notice Update the low-balance warning threshold. Only callable by the CGPaymaster owner.
    function setLowBalanceThreshold(uint256 threshold) external onlyOwner {
        lowBalanceThreshold = threshold;
        emit LowBalanceThresholdSet(threshold);
    }

    // ── ERC-4337 Paymaster interface ──────────────────────────────────────────

    /// @notice Called by the EntryPoint before UserOperation execution.
    ///         Validates the sponsoring org has sufficient budget and that the call targets
    ///         a contract owned by that org. Reserves the maximum possible gas cost.
    ///
    /// @param userOp     The UserOperation to validate.
    /// @param maxCost    Maximum ETH the EntryPoint may charge for this operation.
    /// @return context       Encoded (org, reserved) passed to postOp for settlement.
    /// @return validationData 0 = valid; SIG_VALIDATION_FAILED constant if invalid (not used here).
    function validatePaymasterUserOp(
        UserOperation calldata userOp,
        bytes32,
        uint256 maxCost
    ) external onlyEntryPoint returns (bytes memory context, uint256 validationData) {
        address org = address(bytes20(userOp.paymasterAndData[ORG_DATA_OFFSET:ORG_DATA_OFFSET + 20]));

        if (!registry.isOrganization(org)) revert NotRegisteredOrg();
        if (orgBalance[org] < maxCost) revert InsufficientOrgBalance(orgBalance[org], maxCost);
        if (!_isValidCall(userOp.callData, CGOrganization(org))) revert InvalidCallTarget();

        // Reserve the worst-case cost; postOp refunds the unused portion.
        orgBalance[org] -= maxCost;

        return (abi.encode(org, maxCost), 0);
    }

    /// @notice Called by the EntryPoint after UserOperation execution.
    ///         Refunds unused gas to the org's budget and emits monitoring events.
    ///
    /// @param context       Encoded (org, reserved) from validatePaymasterUserOp.
    /// @param actualGasCost Actual ETH charged by the EntryPoint for this operation.
    function postOp(PostOpMode, bytes calldata context, uint256 actualGasCost) external onlyEntryPoint {
        (address org, uint256 reserved) = abi.decode(context, (address, uint256));

        orgBalance[org] += reserved - actualGasCost;

        uint256 remaining = orgBalance[org];
        emit GasCharged(org, actualGasCost, remaining);

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
    ///         Falls back to the CGPaymaster owner when no explicit manager is set.
    function managerOf(address org) external view returns (address) {
        return _managerOf(org);
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _managerOf(address org) internal view returns (address) {
        address m = orgManager[org];
        return m == address(0) ? owner() : m;
    }

    /// @dev Validates callData encodes a standard execute(address,uint256,bytes) call whose
    ///      target belongs to the given org AND whose inner selector is on the sponsorship
    ///      allowlist (non-owner ops + CGToken user ops).
    ///
    ///      execute(address,uint256,bytes) canonical ABI layout:
    ///        [0  :  4] outer selector
    ///        [4  : 36] target          (address, right-aligned in 32 bytes)
    ///        [36 : 68] value           (uint256)
    ///        [68 :100] data offset     (= 0x60 for canonical encoding)
    ///        [100:132] data length     (uint256, must be >= 4 for a real call)
    ///        [132:136] inner selector  (first 4 bytes of the inner call's calldata)
    function _isValidCall(bytes calldata callData, CGOrganization org) internal view returns (bool) {
        // Minimum length: outer header (132) + inner selector (4) = 136 bytes
        if (callData.length < 136) revert InvalidCallData();
        if (bytes4(callData[0:4]) != EXECUTE_SELECTOR) revert InvalidCallData();

        // Reject non-canonical encodings to keep the inner-selector offset fixed at 132.
        uint256 dataOffset = uint256(bytes32(callData[68:100]));
        if (dataOffset != 0x60) revert InvalidCallData();
        uint256 dataLength = uint256(bytes32(callData[100:132]));
        if (dataLength < 4) revert InvalidCallData();

        bytes4 innerSelector = bytes4(callData[132:136]);
        if (!_isSponsoredSelector(innerSelector)) revert InvalidCallData();

        address target = address(uint160(uint256(bytes32(callData[4:36]))));
        return _isOrgContract(org, target);
    }

    /// @dev Allowlist of inner selectors the paymaster will sponsor. Limited to user-facing
    ///      flows so owner-only admin reverts cannot drain an org's budget.
    function _isSponsoredSelector(bytes4 sel) internal pure returns (bool) {
        return
            sel == SEL_DONATE ||
            sel == SEL_DONATE_PERMIT ||
            sel == SEL_CANCEL_CONTRIBUTION ||
            sel == SEL_REFUND ||
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
    ///
    ///      The code-length guard is required before the try/catch: calling owner() on an EOA
    ///      succeeds at the EVM level (no code → empty return data), but Solidity's ABI decoder
    ///      then fails to decode zero bytes as address, and that decode error propagates outside
    ///      the catch block as an unhandled revert.
    function _isOrgContract(CGOrganization org, address target) internal view returns (bool) {
        if (target == address(org)) return true;
        if (org.isProgram(target)) return true;
        // Only attempt ownership lookup if target is a contract
        if (target.code.length == 0) return false;
        try Ownable(target).owner() returns (address parent) {
            return org.isProgram(parent);
        } catch {
            return false;
        }
    }
}
