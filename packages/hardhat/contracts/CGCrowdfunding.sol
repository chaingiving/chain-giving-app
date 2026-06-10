// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { IERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title CGCrowdfunding — ERC-20 fundraising with escrow, refunds, and direct-transfer recovery
/// @notice Collects ERC-20 donations toward a target. Tracked donations are donor-attributed
///         and refundable on cancellation; direct ERC-20 transfers add to the balance and are
///         non-refundable. There is no FUNDED state — direct transfers cannot be observed in
///         real time, so the campaign stays ACTIVE and `isFunded()` is computed from balance.
contract CGCrowdfunding is Ownable {
    using SafeERC20 for IERC20;

    enum State {
        ACTIVE,
        WITHDRAWN,
        CANCELLED
    }

    IERC20 public immutable token;
    uint256 public immutable fundingTarget;
    uint256 public immutable deadline;
    /// @notice Minimum donation amount in token base units. Equals 10**decimals (i.e. one full
    ///         token) so each accepted donation dwarfs sponsored gas — making dust-flood
    ///         griefing against a CGPaymaster budget economically irrational.
    uint256 public immutable minDonation;
    State public state;

    mapping(address => uint256) public contributions;
    uint256 public totalTracked;
    /// @notice Frozen at withdraw() so totalRaised() keeps a meaningful historical value.
    uint256 public totalWithdrawn;

    event ContributionReceived(address indexed donor, uint256 amount);
    event ContributionCancelled(address indexed donor, uint256 amount);
    event UntrackedReturned(address indexed to, uint256 amount);
    event UntrackedSwept(address indexed to, uint256 amount);
    event CrowdfundingCancelled();
    event FundsWithdrawn(address indexed to, uint256 amount);
    event RefundClaimed(address indexed donor, uint256 amount);

    error NotInState(State expected, State actual);
    error TargetNotMet();
    error DeadlinePassed();
    error NoContribution();
    error NothingToReturn();
    error NothingToSweep();
    error ZeroTarget();
    error DeadlineInPast();
    error ZeroAddress();
    error UnexpectedTransferAmount();
    error BelowMinDonation(uint256 minRequired, uint256 provided);

    constructor(address owner_, address token_, uint256 target_, uint256 deadline_) Ownable(owner_) {
        if (token_ == address(0)) revert ZeroAddress();
        if (target_ == 0) revert ZeroTarget();
        if (deadline_ <= block.timestamp) revert DeadlineInPast();
        token = IERC20(token_);
        fundingTarget = target_;
        deadline = deadline_;
        state = State.ACTIVE;

        // Resolve token decimals defensively — IERC20 does not require decimals(),
        // and tokens with no code or non-standard implementations should not block deployment.
        uint8 decimals;
        try IERC20Metadata(token_).decimals() returns (uint8 d) {
            decimals = d;
        } catch {
            decimals = 18;
        }
        minDonation = 10 ** uint256(decimals);
    }

    /// @notice Tracked donations + direct transfers. Returns frozen total once WITHDRAWN.
    function totalRaised() public view returns (uint256) {
        return state == State.WITHDRAWN ? totalWithdrawn : token.balanceOf(address(this));
    }

    /// @notice Returns true once total raised >= target. Computed from balance, so it picks
    ///         up direct transfers without any keeper call.
    function isFunded() public view returns (bool) {
        return totalRaised() >= fundingTarget;
    }

    /// @notice Donate ERC-20 tokens. Caller must approve this contract for `amount`.
    function donate(uint256 amount) external {
        _donate(msg.sender, amount);
    }

    /// @notice Donate on behalf of `donor`. Only the owning program (CGProgram) may call.
    ///         Caller (the program) must hold tokens and have approved this contract.
    function donateFor(address donor, uint256 amount) external onlyOwner {
        if (donor == address(0)) revert ZeroAddress();
        _donate(donor, amount);
    }

    /// @notice EIP-2612 permit + donate in one transaction. The permit step is wrapped in
    ///         try/catch to defend against permit-front-running griefing.
    function donateWithPermit(
        uint256 amount,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        try IERC20Permit(address(token)).permit(msg.sender, address(this), amount, permitDeadline, v, r, s) {} catch {}
        _donate(msg.sender, amount);
    }

    function _donate(address donor, uint256 amount) internal {
        if (state != State.ACTIVE) revert NotInState(State.ACTIVE, state);
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (amount == 0) revert NoContribution();
        if (amount < minDonation) revert BelowMinDonation(minDonation, amount);

        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - balanceBefore;
        if (received == 0) revert UnexpectedTransferAmount();

        contributions[donor] += received;
        totalTracked += received;
        emit ContributionReceived(donor, received);
    }

    /// @notice Return non-tracked balance to an off-chain-identified sender.
    ///         Bounded by `balance - totalTracked` so refund claimants are always reserved.
    function returnUntracked(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert NothingToReturn();

        uint256 balance = token.balanceOf(address(this));
        uint256 untracked = balance > totalTracked ? balance - totalTracked : 0;
        if (amount > untracked) revert NothingToReturn();

        token.safeTransfer(to, amount);
        emit UntrackedReturned(to, amount);
    }

    /// @notice Donor may withdraw their own tracked contribution while ACTIVE.
    function cancelContribution() external {
        if (state != State.ACTIVE) revert NotInState(State.ACTIVE, state);
        uint256 amount = contributions[msg.sender];
        if (amount == 0) revert NoContribution();
        contributions[msg.sender] = 0;
        totalTracked -= amount;
        token.safeTransfer(msg.sender, amount);
        emit ContributionCancelled(msg.sender, amount);
    }

    /// @notice Cancel the campaign. Allowed only while ACTIVE.
    function cancel() external onlyOwner {
        if (state != State.ACTIVE) revert NotInState(State.ACTIVE, state);
        state = State.CANCELLED;
        emit CrowdfundingCancelled();
    }

    /// @notice Tracked donor claims refund after CANCELLED.
    function refund() external {
        if (state != State.CANCELLED) revert NotInState(State.CANCELLED, state);
        uint256 amount = contributions[msg.sender];
        if (amount == 0) revert NoContribution();
        contributions[msg.sender] = 0;
        totalTracked -= amount;
        token.safeTransfer(msg.sender, amount);
        emit RefundClaimed(msg.sender, amount);
    }

    /// @notice Withdraw the full balance to `to`. Requires ACTIVE state and target met.
    function withdraw(address to) external onlyOwner {
        if (state != State.ACTIVE) revert NotInState(State.ACTIVE, state);
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = token.balanceOf(address(this));
        if (balance < fundingTarget) revert TargetNotMet();
        state = State.WITHDRAWN;
        totalWithdrawn = balance;
        token.safeTransfer(to, balance);
        emit FundsWithdrawn(to, balance);
    }

    /// @notice Sweep balance above totalTracked after CANCELLED. Tracked balance stays
    ///         reserved so donors can still claim refunds.
    function sweepUntracked(address to) external onlyOwner {
        if (state != State.CANCELLED) revert NotInState(State.CANCELLED, state);
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = token.balanceOf(address(this));
        if (balance <= totalTracked) revert NothingToSweep();
        uint256 sweepable;
        unchecked {
            sweepable = balance - totalTracked;
        }
        token.safeTransfer(to, sweepable);
        emit UntrackedSwept(to, sweepable);
    }
}
