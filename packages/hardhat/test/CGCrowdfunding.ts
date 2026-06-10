import { expect } from "chai";
import { ethers } from "hardhat";
import { CGCrowdfunding, MockUSDC, MockEURC } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

type ERC20Permit = MockUSDC | MockEURC;

const TARGET = 10_000_000n; // 10 USDC/EURC (6 decimals)
const ONE = 1_000_000n;
const SEED = 1_000_000_000n; // 1,000 units

async function signPermit(
  signer: HardhatEthersSigner,
  token: ERC20Permit,
  spender: string,
  value: bigint,
  deadline: number,
) {
  const tokenAddress = await token.getAddress();
  const tokenName = await token.name();
  const nonce = await token.nonces(signer.address);
  const network = await ethers.provider.getNetwork();

  const domain = {
    name: tokenName,
    version: "1",
    chainId: network.chainId,
    verifyingContract: tokenAddress,
  };
  const types = {
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const message = {
    owner: signer.address,
    spender,
    value,
    nonce,
    deadline,
  };
  const sig = await signer.signTypedData(domain, types, message);
  return ethers.Signature.from(sig);
}

const TOKENS = ["MockUSDC", "MockEURC"] as const;

for (const tokenContract of TOKENS) {
  describe(`CGCrowdfunding (${tokenContract})`, function () {
    let crowdfunding: CGCrowdfunding;
    let token: ERC20Permit;
    let owner: HardhatEthersSigner;
    let donor1: HardhatEthersSigner;
    let donor2: HardhatEthersSigner;
    let recipient: HardhatEthersSigner;
    let deadline: number;

    beforeEach(async () => {
      [owner, donor1, donor2, recipient] = await ethers.getSigners();

      const tokenFactory = await ethers.getContractFactory(tokenContract);
      token = (await tokenFactory.deploy()) as ERC20Permit;
      await token.mint(donor1.address, SEED);
      await token.mint(donor2.address, SEED);
      await token.mint(owner.address, SEED);

      const now = await time.latest();
      deadline = now + 7 * 24 * 60 * 60;

      const factory = await ethers.getContractFactory("CGCrowdfunding");
      crowdfunding = await factory.deploy(owner.address, await token.getAddress(), TARGET, deadline);
    });

    describe("Deployment", function () {
      it("sets token, target, deadline, owner", async () => {
        expect(await crowdfunding.token()).to.equal(await token.getAddress());
        expect(await crowdfunding.fundingTarget()).to.equal(TARGET);
        expect(await crowdfunding.deadline()).to.equal(deadline);
        expect(await crowdfunding.owner()).to.equal(owner.address);
      });

      it("starts in ACTIVE state", async () => {
        expect(await crowdfunding.state()).to.equal(0);
        expect(await crowdfunding.isFunded()).to.equal(false);
      });

      it("reverts with zero token address", async () => {
        const factory = await ethers.getContractFactory("CGCrowdfunding");
        await expect(factory.deploy(owner.address, ethers.ZeroAddress, TARGET, deadline)).to.be.revertedWithCustomError(
          crowdfunding,
          "ZeroAddress",
        );
      });

      it("reverts with zero target", async () => {
        const factory = await ethers.getContractFactory("CGCrowdfunding");
        await expect(
          factory.deploy(owner.address, await token.getAddress(), 0, deadline),
        ).to.be.revertedWithCustomError(crowdfunding, "ZeroTarget");
      });

      it("reverts with deadline in the past", async () => {
        const factory = await ethers.getContractFactory("CGCrowdfunding");
        const past = (await time.latest()) - 1;
        await expect(
          factory.deploy(owner.address, await token.getAddress(), TARGET, past),
        ).to.be.revertedWithCustomError(crowdfunding, "DeadlineInPast");
      });
    });

    describe("Tracked donate", function () {
      it("accepts donations and credits the donor", async () => {
        await token.connect(donor1).approve(await crowdfunding.getAddress(), ONE);
        await expect(crowdfunding.connect(donor1).donate(ONE))
          .to.emit(crowdfunding, "ContributionReceived")
          .withArgs(donor1.address, ONE);

        expect(await crowdfunding.contributions(donor1.address)).to.equal(ONE);
        expect(await crowdfunding.totalTracked()).to.equal(ONE);
        expect(await crowdfunding.totalRaised()).to.equal(ONE);
      });

      it("accumulates multiple donations from same donor", async () => {
        await token.connect(donor1).approve(await crowdfunding.getAddress(), ONE * 5n);
        await crowdfunding.connect(donor1).donate(ONE * 2n);
        await crowdfunding.connect(donor1).donate(ONE * 3n);
        expect(await crowdfunding.contributions(donor1.address)).to.equal(ONE * 5n);
      });

      it("isFunded() flips true once balance >= target without state change", async () => {
        await token.connect(donor1).approve(await crowdfunding.getAddress(), TARGET);
        await crowdfunding.connect(donor1).donate(TARGET);
        expect(await crowdfunding.isFunded()).to.equal(true);
        expect(await crowdfunding.state()).to.equal(0); // ACTIVE — no state transition
      });

      it("accepts further donations after the target is met (still ACTIVE)", async () => {
        await token.connect(donor1).approve(await crowdfunding.getAddress(), TARGET + ONE);
        await crowdfunding.connect(donor1).donate(TARGET);
        await expect(crowdfunding.connect(donor1).donate(ONE)).to.not.be.reverted;
      });

      it("reverts on zero amount", async () => {
        await expect(crowdfunding.connect(donor1).donate(0)).to.be.revertedWithCustomError(
          crowdfunding,
          "NoContribution",
        );
      });

      it("reverts on dust amount below minDonation (10^decimals)", async () => {
        await token.connect(donor1).approve(await crowdfunding.getAddress(), ONE);
        // ONE - 1 = 0.999999 USDC, just below the 1 USDC floor
        await expect(crowdfunding.connect(donor1).donate(ONE - 1n))
          .to.be.revertedWithCustomError(crowdfunding, "BelowMinDonation")
          .withArgs(ONE, ONE - 1n);
      });

      it("accepts exactly minDonation (1 full token unit)", async () => {
        await token.connect(donor1).approve(await crowdfunding.getAddress(), ONE);
        await expect(crowdfunding.connect(donor1).donate(ONE)).to.not.be.reverted;
        expect(await crowdfunding.minDonation()).to.equal(ONE);
      });

      it("reverts after deadline", async () => {
        await token.connect(donor1).approve(await crowdfunding.getAddress(), ONE);
        await time.increaseTo(deadline + 1);
        await expect(crowdfunding.connect(donor1).donate(ONE)).to.be.revertedWithCustomError(
          crowdfunding,
          "DeadlinePassed",
        );
      });

      it("reverts when CANCELLED", async () => {
        await crowdfunding.cancel();
        await expect(crowdfunding.connect(donor1).donate(ONE)).to.be.revertedWithCustomError(
          crowdfunding,
          "NotInState",
        );
      });
    });

    describe("donateFor (only owner)", function () {
      it("owner attributes donations to a third-party donor", async () => {
        await token.connect(owner).approve(await crowdfunding.getAddress(), ONE);
        await expect(crowdfunding.donateFor(donor2.address, ONE))
          .to.emit(crowdfunding, "ContributionReceived")
          .withArgs(donor2.address, ONE);
        expect(await crowdfunding.contributions(donor2.address)).to.equal(ONE);
      });

      it("rejects zero donor", async () => {
        await expect(crowdfunding.donateFor(ethers.ZeroAddress, ONE)).to.be.revertedWithCustomError(
          crowdfunding,
          "ZeroAddress",
        );
      });

      it("rejects non-owner caller", async () => {
        await expect(crowdfunding.connect(donor1).donateFor(donor1.address, ONE)).to.be.revertedWithCustomError(
          crowdfunding,
          "OwnableUnauthorizedAccount",
        );
      });
    });

    describe("donateWithPermit", function () {
      it("permits and donates atomically", async () => {
        const sig = await signPermit(donor1, token, await crowdfunding.getAddress(), ONE, deadline);
        await expect(crowdfunding.connect(donor1).donateWithPermit(ONE, deadline, sig.v, sig.r, sig.s))
          .to.emit(crowdfunding, "ContributionReceived")
          .withArgs(donor1.address, ONE);
        expect(await crowdfunding.contributions(donor1.address)).to.equal(ONE);
      });

      it("succeeds when permit is front-run if allowance is in place", async () => {
        const sig = await signPermit(donor1, token, await crowdfunding.getAddress(), ONE, deadline);
        // Attacker submits the same permit first
        await token.permit(donor1.address, await crowdfunding.getAddress(), ONE, deadline, sig.v, sig.r, sig.s);
        // Donor's call should still succeed thanks to try/catch + existing allowance
        await expect(crowdfunding.connect(donor1).donateWithPermit(ONE, deadline, sig.v, sig.r, sig.s))
          .to.emit(crowdfunding, "ContributionReceived")
          .withArgs(donor1.address, ONE);
      });

      it("reverts gracefully when permit is invalid AND no allowance", async () => {
        // Random bogus sig
        const sig = await signPermit(donor1, token, await crowdfunding.getAddress(), ONE, deadline);
        // Use the wrong value: signed for ONE, try to spend 2*ONE → permit fails, allowance insufficient
        await expect(crowdfunding.connect(donor1).donateWithPermit(2n * ONE, deadline, sig.v, sig.r, sig.s)).to.be
          .reverted;
      });
    });

    describe("Direct transfers (counted toward isFunded)", function () {
      it("withdraw succeeds when target met by direct transfers alone", async () => {
        await token.connect(donor1).transfer(await crowdfunding.getAddress(), TARGET);
        expect(await crowdfunding.isFunded()).to.equal(true);

        await expect(crowdfunding.withdraw(recipient.address))
          .to.emit(crowdfunding, "FundsWithdrawn")
          .withArgs(recipient.address, TARGET);

        expect(await crowdfunding.state()).to.equal(1); // WITHDRAWN
      });

      it("withdraw succeeds with mixed tracked + direct transfers crossing target", async () => {
        await token.connect(donor1).approve(await crowdfunding.getAddress(), TARGET / 2n);
        await crowdfunding.connect(donor1).donate(TARGET / 2n);

        await token.connect(donor2).transfer(await crowdfunding.getAddress(), TARGET / 2n);
        expect(await crowdfunding.isFunded()).to.equal(true);

        await expect(crowdfunding.withdraw(recipient.address)).to.emit(crowdfunding, "FundsWithdrawn");
        expect(await crowdfunding.state()).to.equal(1); // WITHDRAWN
      });

      it("withdraw reverts with TargetNotMet when balance < target", async () => {
        await token.connect(donor1).transfer(await crowdfunding.getAddress(), TARGET / 2n);
        await expect(crowdfunding.withdraw(recipient.address)).to.be.revertedWithCustomError(
          crowdfunding,
          "TargetNotMet",
        );
      });
    });

    describe("returnUntracked", function () {
      it("returns stray balance to off-chain identified sender", async () => {
        await token.connect(donor1).approve(await crowdfunding.getAddress(), TARGET);
        await crowdfunding.connect(donor1).donate(TARGET); // FUNDED

        // Stray transfer post-funding
        await token.connect(donor2).transfer(await crowdfunding.getAddress(), ONE);

        const before = await token.balanceOf(donor2.address);
        await expect(crowdfunding.returnUntracked(donor2.address, ONE))
          .to.emit(crowdfunding, "UntrackedReturned")
          .withArgs(donor2.address, ONE);
        const after = await token.balanceOf(donor2.address);
        expect(after - before).to.equal(ONE);
      });

      it("cannot exceed unsynced balance", async () => {
        await token.connect(donor1).transfer(await crowdfunding.getAddress(), ONE);

        await expect(crowdfunding.returnUntracked(donor1.address, ONE * 2n)).to.be.revertedWithCustomError(
          crowdfunding,
          "NothingToReturn",
        );
      });

      it("cannot touch totalTracked", async () => {
        await token.connect(donor1).approve(await crowdfunding.getAddress(), ONE);
        await crowdfunding.connect(donor1).donate(ONE); // tracked

        // No stray balance — calling returnUntracked must revert
        await expect(crowdfunding.returnUntracked(donor1.address, ONE)).to.be.revertedWithCustomError(
          crowdfunding,
          "NothingToReturn",
        );
      });

      it("rejects zero recipient and zero amount", async () => {
        await token.connect(donor1).transfer(await crowdfunding.getAddress(), ONE);
        await expect(crowdfunding.returnUntracked(ethers.ZeroAddress, ONE)).to.be.revertedWithCustomError(
          crowdfunding,
          "ZeroAddress",
        );
        await expect(crowdfunding.returnUntracked(donor1.address, 0)).to.be.revertedWithCustomError(
          crowdfunding,
          "NothingToReturn",
        );
      });

      it("rejects non-owner", async () => {
        await expect(crowdfunding.connect(donor1).returnUntracked(donor1.address, ONE)).to.be.revertedWithCustomError(
          crowdfunding,
          "OwnableUnauthorizedAccount",
        );
      });
    });

    describe("Cancel contribution", function () {
      it("donor pulls their tracked contribution while ACTIVE", async () => {
        await token.connect(donor1).approve(await crowdfunding.getAddress(), ONE * 3n);
        await crowdfunding.connect(donor1).donate(ONE * 3n);

        const before = await token.balanceOf(donor1.address);
        await expect(crowdfunding.connect(donor1).cancelContribution())
          .to.emit(crowdfunding, "ContributionCancelled")
          .withArgs(donor1.address, ONE * 3n);
        const after = await token.balanceOf(donor1.address);

        expect(after - before).to.equal(ONE * 3n);
        expect(await crowdfunding.contributions(donor1.address)).to.equal(0);
        expect(await crowdfunding.totalTracked()).to.equal(0);
      });

      it("reverts after the campaign was cancelled", async () => {
        await token.connect(donor1).approve(await crowdfunding.getAddress(), ONE);
        await crowdfunding.connect(donor1).donate(ONE);
        await crowdfunding.cancel();
        await expect(crowdfunding.connect(donor1).cancelContribution()).to.be.revertedWithCustomError(
          crowdfunding,
          "NotInState",
        );
      });
    });

    describe("Withdraw", function () {
      it("owner withdraws full balance, including any stray transfers", async () => {
        await token.connect(donor1).approve(await crowdfunding.getAddress(), TARGET);
        await crowdfunding.connect(donor1).donate(TARGET);

        // Stray on top of target
        await token.connect(donor2).transfer(await crowdfunding.getAddress(), ONE);

        const before = await token.balanceOf(recipient.address);
        await expect(crowdfunding.withdraw(recipient.address))
          .to.emit(crowdfunding, "FundsWithdrawn")
          .withArgs(recipient.address, TARGET + ONE);
        const after = await token.balanceOf(recipient.address);

        expect(after - before).to.equal(TARGET + ONE);
        expect(await crowdfunding.state()).to.equal(1); // WITHDRAWN
        expect(await crowdfunding.totalRaised()).to.equal(TARGET + ONE); // frozen
      });

      it("reverts with TargetNotMet if balance < target", async () => {
        await expect(crowdfunding.withdraw(recipient.address)).to.be.revertedWithCustomError(
          crowdfunding,
          "TargetNotMet",
        );
      });

      it("reverts on zero recipient", async () => {
        await token.connect(donor1).approve(await crowdfunding.getAddress(), TARGET);
        await crowdfunding.connect(donor1).donate(TARGET);
        await expect(crowdfunding.withdraw(ethers.ZeroAddress)).to.be.revertedWithCustomError(
          crowdfunding,
          "ZeroAddress",
        );
      });
    });

    describe("Refund + sweep after CANCELLED", function () {
      it("tracked donors refund; owner sweeps untracked", async () => {
        await token.connect(donor1).approve(await crowdfunding.getAddress(), ONE * 3n);
        await crowdfunding.connect(donor1).donate(ONE * 3n);

        await token.connect(donor2).transfer(await crowdfunding.getAddress(), ONE * 2n);

        await crowdfunding.cancel();

        const r1Before = await token.balanceOf(donor1.address);
        await expect(crowdfunding.connect(donor1).refund())
          .to.emit(crowdfunding, "RefundClaimed")
          .withArgs(donor1.address, ONE * 3n);
        const r1After = await token.balanceOf(donor1.address);
        expect(r1After - r1Before).to.equal(ONE * 3n);

        const sBefore = await token.balanceOf(recipient.address);
        await expect(crowdfunding.sweepUntracked(recipient.address))
          .to.emit(crowdfunding, "UntrackedSwept")
          .withArgs(recipient.address, ONE * 2n);
        const sAfter = await token.balanceOf(recipient.address);
        expect(sAfter - sBefore).to.equal(ONE * 2n);
      });

      it("sweep reserves totalTracked even before all refunds claimed", async () => {
        await token.connect(donor1).approve(await crowdfunding.getAddress(), ONE * 3n);
        await crowdfunding.connect(donor1).donate(ONE * 3n);
        await token.connect(donor2).transfer(await crowdfunding.getAddress(), ONE * 2n);
        await crowdfunding.cancel();

        // Sweep before donor1 refunds
        await crowdfunding.sweepUntracked(recipient.address);

        // Donor1 can still refund
        await expect(crowdfunding.connect(donor1).refund()).to.not.be.reverted;
      });

      it("sweep reverts when only tracked balance present", async () => {
        await token.connect(donor1).approve(await crowdfunding.getAddress(), ONE);
        await crowdfunding.connect(donor1).donate(ONE);
        await crowdfunding.cancel();
        await expect(crowdfunding.sweepUntracked(recipient.address)).to.be.revertedWithCustomError(
          crowdfunding,
          "NothingToSweep",
        );
      });

      it("refund reverts if not CANCELLED", async () => {
        await token.connect(donor1).approve(await crowdfunding.getAddress(), ONE);
        await crowdfunding.connect(donor1).donate(ONE);
        await expect(crowdfunding.connect(donor1).refund()).to.be.revertedWithCustomError(crowdfunding, "NotInState");
      });

      it("cannot double-refund", async () => {
        await token.connect(donor1).approve(await crowdfunding.getAddress(), ONE);
        await crowdfunding.connect(donor1).donate(ONE);
        await crowdfunding.cancel();
        await crowdfunding.connect(donor1).refund();
        await expect(crowdfunding.connect(donor1).refund()).to.be.revertedWithCustomError(
          crowdfunding,
          "NoContribution",
        );
      });

      it("cancel after the target is met is still allowed; donors refund", async () => {
        await token.connect(donor1).approve(await crowdfunding.getAddress(), TARGET);
        await crowdfunding.connect(donor1).donate(TARGET);
        expect(await crowdfunding.isFunded()).to.equal(true);
        await crowdfunding.cancel();
        await expect(crowdfunding.connect(donor1).refund()).to.not.be.reverted;
      });
    });
  });
}
