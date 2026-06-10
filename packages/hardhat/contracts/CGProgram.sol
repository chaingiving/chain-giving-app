// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC1155 } from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { CGToken } from "./CGToken.sol";
import { CGCrowdfunding } from "./CGCrowdfunding.sol";
import { CGDistribution } from "./CGDistribution.sol";
import { CGComponentFactory } from "./CGComponentFactory.sol";

/// @notice Minimal subset of Uniswap Permit2 used for SignatureTransfer flows.
///         Permit2 is deterministically deployed at the same address on every
///         supported chain; see https://github.com/Uniswap/permit2.
interface IPermit2 {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }
    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }
    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }
    function permitTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;
}

/// @title CGProgram — Orchestrates crowdfunding and ERC-1155 token distributions
/// @notice Top-level contract tying one crowdfunding to one-or-more distributions.
///         Each distribution uses a specific token type from the shared CGToken contract.
///         Child contracts are deployed via external factories to keep bytecode under the
///         24 KB Spurious Dragon limit.
contract CGProgram is Ownable {
    using SafeERC20 for IERC20;

    enum State {
        ACTIVE,
        EXECUTING,
        COMPLETED,
        CANCELLED
    }

    struct TokenTypeInfo {
        uint256 tokenId;
        string name;
        string symbol;
        uint256 maxSupply;
        uint256 totalMinted;
        string uri;
        bool transferable;
        bool burnable;
    }

    struct CrowdfundingInfo {
        address addr;
        address currency;
        uint256 fundingTarget;
        uint256 deadline;
        CGCrowdfunding.State state;
        uint256 totalRaised;
        uint256 totalTracked;
        bool isFunded;
    }

    struct DistributionInfo {
        address addr;
        uint256 tokenId;
        CGDistribution.State state;
        uint256 beneficiaryCount;
        uint256 totalRequired;
        address[] beneficiaries;
        uint256[] amounts;
    }

    string public name;
    bool public immutable lockDistributions;
    CGComponentFactory public immutable componentFactory;

    /// @notice Canonical Permit2 address — same on every chain via CREATE2 deploy.
    ///         Used by donateWithPermit2 to bypass per-program approvals.
    IPermit2 public constant PERMIT2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    CGToken public token;
    CGCrowdfunding public crowdfunding;
    CGDistribution[] public distributions;
    State public state;

    event ProgramCreated(string name, address token, bool lockDistributions);
    event TokenTypeDefined(
        uint256 indexed tokenId,
        string name,
        string symbol,
        uint256 maxSupply,
        bool transferable,
        bool burnable
    );
    event CrowdfundingSet(address crowdfunding, address currency);
    event DistributionCreated(uint256 index, address distribution, uint256 tokenId);
    event DistributionDeleted(uint256 index, address distribution);
    event ProgramExecuted();
    event ProgramCancelled();

    error ProgramNotActive();
    error CrowdfundingAlreadySet();
    error NoCrowdfunding();
    error NoDistributions();
    error DistributionNotReady(uint256 index);
    error DistributionsLocked();
    error ExceedsTotalSupply(uint256 tokenId, uint256 totalRequired, uint256 maxSupply);
    error DistributionAlreadyDistributed(uint256 index);
    error ContributionsExist();

    constructor(
        address owner_,
        string memory name_,
        bool lockDistributions_,
        CGComponentFactory componentFactory_
    ) Ownable(owner_) {
        name = name_;
        lockDistributions = lockDistributions_;
        componentFactory = componentFactory_;

        token = CGToken(componentFactory_.createToken(address(this)));
        state = State.ACTIVE;

        emit ProgramCreated(name_, address(token), lockDistributions_);
    }

    /// @notice Define a new ERC-1155 token type on the program's token contract.
    function defineTokenType(
        string calldata name_,
        string calldata symbol_,
        uint256 maxSupply_,
        string calldata uri_,
        bool transferable_,
        bool burnable_
    ) external onlyOwner returns (uint256 tokenId) {
        if (state != State.ACTIVE) revert ProgramNotActive();
        tokenId = token.defineTokenType(name_, symbol_, maxSupply_, uri_, transferable_, burnable_);
        emit TokenTypeDefined(tokenId, name_, symbol_, maxSupply_, transferable_, burnable_);
    }

    /// @notice Deploy and attach a CGCrowdfunding for the given ERC-20 currency.
    function setCrowdfunding(address currency_, uint256 target_, uint256 deadline_) external onlyOwner {
        if (state != State.ACTIVE) revert ProgramNotActive();
        if (address(crowdfunding) != address(0)) revert CrowdfundingAlreadySet();

        crowdfunding = CGCrowdfunding(
            componentFactory.createCrowdfunding(address(this), currency_, target_, deadline_)
        );
        emit CrowdfundingSet(address(crowdfunding), currency_);
    }

    /// @notice Deploy a new CGDistribution for a specific token type.
    function createDistribution(uint256 tokenId_) external onlyOwner returns (address) {
        if (state != State.ACTIVE) revert ProgramNotActive();
        if (lockDistributions && _crowdfundingHasContributions()) revert DistributionsLocked();

        // Validate the token type exists
        token.getTokenType(tokenId_);

        CGDistribution dist = CGDistribution(
            componentFactory.createDistribution(address(this), IERC1155(address(token)), tokenId_)
        );
        distributions.push(dist);

        // Allow the distribution contract to transfer soulbound tokens on behalf of the program.
        token.setAuthorizedTransferrer(address(dist), true);

        uint256 index = distributions.length - 1;
        emit DistributionCreated(index, address(dist), tokenId_);
        return address(dist);
    }

    function setBeneficiaries(
        uint256 distributionIndex,
        address[] calldata beneficiaries_,
        uint256[] calldata amounts_
    ) external onlyOwner {
        if (state != State.ACTIVE) revert ProgramNotActive();
        if (lockDistributions && _crowdfundingHasContributions()) revert DistributionsLocked();

        CGDistribution dist = distributions[distributionIndex];
        dist.setBeneficiaries(beneficiaries_, amounts_);
        _validateSupplyCap(dist.tokenId());
    }

    function addBeneficiaries(
        uint256 distributionIndex,
        address[] calldata beneficiaries_,
        uint256[] calldata amounts_
    ) external onlyOwner {
        if (state != State.ACTIVE) revert ProgramNotActive();
        if (lockDistributions && _crowdfundingHasContributions()) revert DistributionsLocked();

        CGDistribution dist = distributions[distributionIndex];
        dist.addBeneficiaries(beneficiaries_, amounts_);
        _validateSupplyCap(dist.tokenId());
    }

    function removeBeneficiaries(uint256 distributionIndex, address[] calldata toRemove_) external onlyOwner {
        if (state != State.ACTIVE) revert ProgramNotActive();
        if (lockDistributions && _crowdfundingHasContributions()) revert DistributionsLocked();

        distributions[distributionIndex].removeBeneficiaries(toRemove_);
    }

    function deleteDistribution(uint256 distributionIndex) external onlyOwner {
        if (state != State.ACTIVE) revert ProgramNotActive();
        CGDistribution.State distState = distributions[distributionIndex].state();
        if (distState == CGDistribution.State.DISTRIBUTED) revert DistributionAlreadyDistributed(distributionIndex);
        if (distState == CGDistribution.State.READY && _crowdfundingHasContributions()) revert ContributionsExist();

        address deleted = address(distributions[distributionIndex]);

        token.setAuthorizedTransferrer(deleted, false);

        uint256 last = distributions.length - 1;
        if (distributionIndex != last) {
            distributions[distributionIndex] = distributions[last];
        }
        distributions.pop();

        emit DistributionDeleted(distributionIndex, deleted);
    }

    function markDistributionReady(uint256 distributionIndex) external onlyOwner {
        if (state != State.ACTIVE) revert ProgramNotActive();

        CGDistribution dist = distributions[distributionIndex];
        uint256 required = dist.totalRequired();
        uint256 distTokenId = dist.tokenId();

        token.mint(address(dist), distTokenId, required);
        dist.markReady();
    }

    /// @notice Donate ERC-20 tokens through the program. Caller must approve the program for `amount`.
    ///         Enforces lock-distributions gating.
    function donate(uint256 amount) external {
        _preDonateChecks();
        IERC20 currency = crowdfunding.token();
        currency.safeTransferFrom(msg.sender, address(this), amount);
        currency.forceApprove(address(crowdfunding), amount);
        crowdfunding.donateFor(msg.sender, amount);
    }

    /// @notice EIP-2612 permit + donate in one transaction. Donor signs a permit authorizing
    ///         the PROGRAM (not the crowdfunding) to spend `amount`. Permit is wrapped in
    ///         try/catch to defend against permit-front-running griefing.
    function donateWithPermit(
        uint256 amount,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _preDonateChecks();
        IERC20 currency = crowdfunding.token();
        try IERC20Permit(address(currency)).permit(msg.sender, address(this), amount, permitDeadline, v, r, s) {} catch {}
        currency.safeTransferFrom(msg.sender, address(this), amount);
        currency.forceApprove(address(crowdfunding), amount);
        crowdfunding.donateFor(msg.sender, amount);
    }

    /// @notice Permit2-based donate. Donor signs a Permit2 PermitTransferFrom authorizing
    ///         this program to pull `amount` of the crowdfunding currency. Requires a
    ///         one-time `approve(PERMIT2, …)` on the token; subsequent donations need
    ///         only a signature. Wallets recognize Permit2 signatures and render a
    ///         non-scary UI (the spender is the well-known Permit2 contract, not this
    ///         unverified program).
    function donateWithPermit2(uint256 amount, uint256 nonce, uint256 deadline, bytes calldata signature) external {
        _preDonateChecks();
        IERC20 currency = crowdfunding.token();
        PERMIT2.permitTransferFrom(
            IPermit2.PermitTransferFrom({
                permitted: IPermit2.TokenPermissions({ token: address(currency), amount: amount }),
                nonce: nonce,
                deadline: deadline
            }),
            IPermit2.SignatureTransferDetails({ to: address(this), requestedAmount: amount }),
            msg.sender,
            signature
        );
        currency.forceApprove(address(crowdfunding), amount);
        crowdfunding.donateFor(msg.sender, amount);
    }

    function _preDonateChecks() internal view {
        if (state != State.ACTIVE) revert ProgramNotActive();
        if (address(crowdfunding) == address(0)) revert NoCrowdfunding();

        if (lockDistributions) {
            if (distributions.length == 0) revert NoDistributions();
            for (uint256 i = 0; i < distributions.length; i++) {
                if (distributions[i].state() != CGDistribution.State.READY) revert DistributionNotReady(i);
            }
        }
    }

    /// @notice Withdraw funds and distribute tokens — all in one transaction.
    /// @dev    crowdfunding.withdraw() auto-syncs direct transfers and reverts with
    ///         NotInState if the campaign is still under target after sync.
    function execute() external onlyOwner {
        if (state != State.ACTIVE) revert ProgramNotActive();
        if (address(crowdfunding) == address(0)) revert NoCrowdfunding();
        if (distributions.length == 0) revert NoDistributions();

        for (uint256 i = 0; i < distributions.length; i++) {
            if (distributions[i].state() != CGDistribution.State.READY) revert DistributionNotReady(i);
        }

        // Act as a reentrancy guard: external calls below (withdraw, distribute)
        // will revert if they re-enter any function guarded by `ProgramNotActive`.
        state = State.EXECUTING;

        crowdfunding.withdraw(owner());

        for (uint256 i = 0; i < distributions.length; i++) {
            distributions[i].distribute();
        }

        state = State.COMPLETED;
        emit ProgramExecuted();
    }

    /// @notice Owner-only wrapper around crowdfunding.returnUntracked(to, amount).
    ///         Lets the program owner refund stray direct transfers identified off-chain.
    function returnUntracked(address to, uint256 amount) external onlyOwner {
        if (address(crowdfunding) == address(0)) revert NoCrowdfunding();
        crowdfunding.returnUntracked(to, amount);
    }

    /// @notice Owner-only wrapper around crowdfunding.sweepUntracked(to). Only callable
    ///         after the crowdfunding has been cancelled (enforced by the crowdfunding).
    function sweepUntracked(address to) external onlyOwner {
        if (address(crowdfunding) == address(0)) revert NoCrowdfunding();
        crowdfunding.sweepUntracked(to);
    }

    function cancel() external onlyOwner {
        if (state != State.ACTIVE) revert ProgramNotActive();

        state = State.CANCELLED;

        if (address(crowdfunding) != address(0) && crowdfunding.state() == CGCrowdfunding.State.ACTIVE) {
            crowdfunding.cancel();
        }

        emit ProgramCancelled();
    }

    function distributionCount() external view returns (uint256) {
        return distributions.length;
    }

    function getTokenTypes() external view returns (TokenTypeInfo[] memory infos) {
        uint256 count = token.nextTokenId();
        infos = new TokenTypeInfo[](count);
        for (uint256 i = 0; i < count; i++) {
            CGToken.TokenType memory tt = token.getTokenType(i);
            infos[i] = TokenTypeInfo({
                tokenId: i,
                name: tt.name,
                symbol: tt.symbol,
                maxSupply: tt.maxSupply,
                totalMinted: tt.totalMinted,
                uri: token.uri(i),
                transferable: tt.transferable,
                burnable: tt.burnable
            });
        }
    }

    function getCrowdfundingInfo() external view returns (CrowdfundingInfo memory info) {
        if (address(crowdfunding) == address(0)) return info;

        info = CrowdfundingInfo({
            addr: address(crowdfunding),
            currency: address(crowdfunding.token()),
            fundingTarget: crowdfunding.fundingTarget(),
            deadline: crowdfunding.deadline(),
            state: crowdfunding.state(),
            totalRaised: crowdfunding.totalRaised(),
            totalTracked: crowdfunding.totalTracked(),
            isFunded: crowdfunding.isFunded()
        });
    }

    function getDistributionInfo(uint256 index) public view returns (DistributionInfo memory) {
        CGDistribution dist = distributions[index];
        return
            DistributionInfo({
                addr: address(dist),
                tokenId: dist.tokenId(),
                state: dist.state(),
                beneficiaryCount: dist.beneficiaryCount(),
                totalRequired: dist.totalRequired(),
                beneficiaries: dist.getBeneficiaries(),
                amounts: dist.getAmounts()
            });
    }

    function getAllDistributionsInfo() external view returns (DistributionInfo[] memory infos) {
        infos = new DistributionInfo[](distributions.length);
        for (uint256 i = 0; i < distributions.length; i++) {
            infos[i] = getDistributionInfo(i);
        }
    }

    function _validateSupplyCap(uint256 distTokenId_) internal view {
        CGToken.TokenType memory tt = token.getTokenType(distTokenId_);
        if (tt.maxSupply > 0) {
            uint256 aggregateRequired = _totalRequiredForToken(distTokenId_);
            if (aggregateRequired > tt.maxSupply)
                revert ExceedsTotalSupply(distTokenId_, aggregateRequired, tt.maxSupply);
        }
    }

    function _crowdfundingHasContributions() internal view returns (bool) {
        return address(crowdfunding) != address(0) && crowdfunding.totalRaised() > 0;
    }

    function _totalRequiredForToken(uint256 tokenId_) internal view returns (uint256 total) {
        for (uint256 i = 0; i < distributions.length; i++) {
            CGDistribution dist = distributions[i];
            if (dist.tokenId() == tokenId_) {
                total += dist.totalRequired();
            }
        }
    }
}
