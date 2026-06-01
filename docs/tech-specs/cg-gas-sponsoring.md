# Chain.Giving Gas Sponsoring

This document describes how the live `CGPaymaster` + smart-account stack
implements the gas-sponsorship goals listed in section 1, and which calls are
actually sponsored vs paid by the user. The role-based framing from the
original spec is preserved as the product target; the implementation chapters
explain where reality matches and where pragmatic divergence was necessary.

## 1. Roles and Sponsorship Targets

### Beneficiary gas sponsorship

All beneficiary wallet transactions that move or burn **CG tokens** are
sponsored by the issuing organization. A beneficiary receiving a CGToken
voucher, transferring it to a redeeming party, or burning it on redemption
never needs to hold the chain's native gas token. The first sponsored token
op from a given owner bundles a signed operator approval with the actual call
so no separate "prep" transaction is required (see §6).

The fundraising side (donations, refunds, cancellations) is **not** sponsored
in the current implementation — see §5 for why and what replaced it.

### Organization owner gas sponsorship

Organization admin work — defining token types, creating distributions,
setting beneficiaries, executing programs, withdrawing crowdfund proceeds —
is **not** sponsored. The original spec called for org owners to "set up
programs without having to obtain any gas tokens"; in practice, owner-only
calls are kept off the sponsorship allowlist because an attacker controlling
an admin key could otherwise drain the org's gas budget through reverting
admin calls (see `CGPaymaster.sol:107-108`). Owner ops run as direct
transactions from the org owner's wallet.

The "stash of funds" the original spec described is implemented as the org's
balance inside `CGPaymaster`, used to sponsor beneficiary CGToken ops on the
org's behalf.

### Chain.Giving registry owner & global administrators

Registry-level work (deploying CGRegistry, transferring its ownership,
upgrading the paymaster) pays its own gas. The deployer is the default
paymaster owner and can withdraw unused balance from any unmanaged org's
stash, transfer management of an org's stash to its owner, and adjust the
low-balance threshold — see §7. The deployer is responsible for monitoring
org balances and topping them up (potentially invoiced off-chain) until an
org self-manages.

## 2. Implementation Overview

The stack is ERC-4337 v0.7 with `CGPaymaster` as the sponsorship contract,
two smart-account paths on the wallet side, and a bundler proxy in between:

```
┌─────────────────────────┐         ┌──────────────────────┐
│  User wallet            │         │  Browser frontend    │
│  - MetaMask (EOA)       │ signs   │  useSponsoredWrite   │
│  - Coinbase Smart       │────────▶│  + useCGTokenWrite   │
│  - Email/social (Reown) │  UserOp │  + useSponsoredUserOp│
└─────────────────────────┘         └──────────┬───────────┘
                                               │
                ┌──────────────────────────────┴────────────────────────┐
                │                                                       │
                ▼ Kernel-via-Pimlico (EOA wallets)                       ▼ EIP-5792 (smart wallets)
        ┌───────────────────────┐                            ┌───────────────────────────┐
        │ permissionless        │                            │ wagmi useSendCalls        │
        │ toKernelSmartAccount  │                            │ + paymasterService cap    │
        │ getKernelClient       │                            │ context.orgAddress        │
        └──────────┬────────────┘                            └─────────────┬─────────────┘
                   │                                                       │
                   ▼                                                       ▼
       /api/bundler/[chainId] ───────┐               ┌──── /api/paymaster ◀┘
       (Pimlico proxy)               │               │     (ERC-7677 service)
                                     ▼               ▼
                       ┌──────────────────────────────────────┐
                       │   Bundler → EntryPoint v0.7          │
                       │   0x0000000071727De22E5E9d8BAf0…032  │
                       │                                      │
                       │   - calls CGPaymaster.validate…      │
                       │   - executes calldata at sender      │
                       │   - calls CGPaymaster.postOp         │
                       └──────────────────────────────────────┘
```

### Smart-account paths

Two paths cover all wallet kinds; selection is automatic and lives in
`useOrgGasSponsorship.ts`:

- **`kernel`** — the connected wallet exposes an EOA signer (MetaMask,
  WalletConnect EOAs, Reown email/social via its embedded wallet). The EOA
  is wrapped in a counterfactual **Kernel v3.1** smart account via Pimlico's
  `toKernelSmartAccount`. Sponsored ops are submitted as UserOps signed by
  the EOA but executed at the Kernel address.
- **`eip5792`** — the connected wallet is itself a smart account (Coinbase
  Smart Wallet, MetaMask Smart Account, Safe) that advertises the EIP-5792
  `paymasterService` capability. Sponsored ops go through wagmi's
  `useSendCalls` with the paymaster URL passed as a capability.

The Kernel path uses `useMetaFactory: false` so `initCode` calls
`KernelFactory.createAccount` directly. This bypasses Kernel's MetaFactory
whitelist gate, which is missing on Arc Testnet (the MetaFactory there
reverts with `0xc88357cc` / "NotApprovedFactory"). It works identically on
chains where the gate is properly set (Base Sepolia, mainnets) — the inner
`KernelFactory` does the actual `CREATE2`, so the resulting account address
is identical either way.

### `CGPaymaster` — what the paymaster checks

Lives at `packages/hardhat/contracts/CGPaymaster.sol`. On every sponsored
UserOp it validates:

1. **Caller is the EntryPoint.** Hard-gated by the `onlyEntryPoint` modifier.
2. **Org identity.** The `paymasterAndData` field carries the sponsoring org
   address in bytes [52:72]. The paymaster checks that this is a registered
   org in `CGRegistry`.
3. **Org has budget.** `orgBalance[org] ≥ maxCost` where `maxCost` is the
   bundler-computed cap for this UserOp. The full `maxCost` is reserved
   (subtracted from `orgBalance`) at validation time and partially refunded
   in `postOp` based on actual gas used.
4. **Call data parses correctly and targets the org's surface.** The
   paymaster decodes one of two outer selectors:
   - `execute(address,uint256,bytes)` — SimpleAccount / Coinbase Smart Wallet
     (selector `0xb61d27f6`).
   - `execute(bytes32,bytes)` — ERC-7579 single execution (callType `0x00`)
     **or batch execution (callType `0x01`)**. Delegatecall (`0xff`) is
     always rejected.
5. **Inner selector is on the sponsored allowlist** — see §3.
6. **Inner target belongs to the sponsoring org** — the org itself, a
   `CGProgram` created by it, or a CGToken/CGCrowdfunding/CGDistribution
   whose Ownable parent is one of the org's programs.

The paymaster rejects non-canonical ABI encodings (e.g. unexpected bytes
offsets) so the byte-offset based parsing remains a safe one-pass scan.

### Bundler — `/api/bundler/[chainId]`

The frontend never talks to a public bundler directly. The browser POSTs
JSON-RPC to `/api/bundler/{chainId}`, which forwards to **Pimlico**
(`api.pimlico.io`) with a server-side `PIMLICO_API_KEY` attached. A small
method allowlist limits what callers can submit:

- `eth_sendUserOperation`, `eth_estimateUserOperationGas`,
  `eth_getUserOperationByHash`, `eth_getUserOperationReceipt`,
  `eth_supportedEntryPoints`, `eth_chainId`
- Pimlico extensions: `pimlico_getUserOperationGasPrice`,
  `pimlico_getUserOperationStatus`

`pm_*` paymaster methods are **not** proxied through the bundler — they go
to a separate route, `/api/paymaster`, which runs our own ERC-7677 service.

### Paymaster service — `/api/paymaster`

ERC-7677 returns the v0.7 separate-fields blob:

- `paymaster` — the deployed `CGPaymaster` address for the active chain (read
  from `deployedContracts.ts`).
- `paymasterData` — the sponsoring org's address as 20 raw bytes (passed in
  via `context.orgAddress` from the wallet's EIP-5792 capability, or from
  the Kernel client's `getPaymasterData` callback).
- `paymasterVerificationGasLimit` — `0x10000` (65 536), comfortably covers
  the paymaster's validation cost with margin for cold storage reads on the
  first sponsored UserOp per org.
- `paymasterPostOpGasLimit` — `0x8000` (32 768).

Stub and final data are identical — `CGPaymaster` validation is fully
on-chain and there is no signing service.

## 3. Sponsored Selectors (Allowlist)

Defined in `CGPaymaster.sol:115-126`. The paymaster sponsors **only**
non-owner, user-facing CGToken operations:

| Selector | Function | Why sponsored |
|---|---|---|
| `0xf242432a` | `safeTransferFrom(address,address,uint256,uint256,bytes)` | Beneficiary moves a voucher/badge |
| `0x2eb2c2d6` | `safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)` | Bulk transfer |
| `0xa22cb465` | `setApprovalForAll(address,bool)` | Operator approval (rare on the user path; mostly the signed variant below is used) |
| `0xe9f4197a` | `setApprovalForAllWithSignature(address,address,bool,uint256,bytes)` | Signed approval bootstrap — see §6 |
| `0xf5298aca` | `burn(address,uint256,uint256)` | Holder destroys their voucher (redemption pattern) |
| `0x6b20c454` | `burnBatch(address,uint256[],uint256[])` | Bulk burn |

The allowlist is **inner-selector based**: the outer `execute(...)` selector
of the smart account is parsed first, then the inner call's selector is
compared against this list.

## 4. What Is NOT Sponsored

Owner-only admin ops on `CGProgram`, `CGOrganization`, `CGCrowdfunding`,
`CGDistribution`, and `CGToken` are deliberately excluded. The threat model:
an attacker who briefly controls an admin key (or any path that triggers an
owner-gated revert) could otherwise spam reverting admin UserOps and drain
the org's gas budget. Org admins pay their own gas for setup work.

This includes (non-exhaustive):

- `CGRegistry.createOrganization`
- `CGOrganization.createProgram`
- `CGProgram.setCrowdfunding`, `setBeneficiaries`, `markDistributionReady`,
  `cancel`, `execute`, `returnUntracked`, `sweepUntracked`,
  `defineTokenType`, `createDistribution`, `deleteDistribution`,
  `setLockDistributions`, `setProgramName`
- `CGToken.mint`, `mintBatch`, `defineTokenType`, `setAuthorizedTransferrer`
- `CGCrowdfunding.cancel`, `withdraw`, `donateFor`
- `CGDistribution.markReady`, `airdrop`, owner-only setters

### Donate / cancel / refund — pruned from the allowlist

In an earlier iteration these *were* sponsored. They were removed in commit
`0921130` because of a fundamental identity-split: USDC's `permit` only
verifies ECDSA signatures (no ERC-1271), so a sponsored UserOp with the
smart account as `msg.sender` cannot permit-spend tokens held at the EOA
nor can the EOA's tokens be pulled by a smart-account-signed transfer.
The current flows run as direct EOA writes:

- **Donations** — direct write of `donateWithPermit2` (when Permit2 is
  deployed on the chain) or `donate` after a one-time `approve`. Permit2
  is the preferred path because wallets render its signatures with a
  friendlier UI than raw ERC-2612 permits.
- **`cancelContribution` / `refund`** — direct write from the donor's EOA,
  because the contributions ledger is keyed by `msg.sender` of the original
  donation, which is the EOA.

These flows are documented further in `cg-frontend.md` and in `donate`
handlers under `app/program/[address]/_components/CGProgramView.tsx`.

## 5. The Signed-Approval Bootstrap for CGToken Transfers

Sponsored CGToken transfers run from the smart account, so `msg.sender`
of `safeTransferFrom(owner, …)` is the Kernel (or EIP-5792 smart wallet),
not the owner. ERC-1155 requires the operator to have been approved by the
owner — which would normally require the owner to send a `setApprovalForAll`
tx first, consuming native gas. That breaks the "no gas tokens ever needed"
goal.

The fix is `CGToken.setApprovalForAllWithSignature(owner, operator,
approved, deadline, signature)`. Modeled after ERC-2612 permit but for
ERC-1155 operator approval:

1. The user signs an EIP-712 `ApprovalForAll(owner, operator, approved,
   nonce, deadline)` typed-data message off-chain (free).
2. The frontend (`useCGTokenWrite`) detects on first use that
   `isApprovedForAll(owner, smartAccount) == false`.
3. It bundles two calls into a single sponsored UserOp:
   1. `setApprovalForAllWithSignature(owner, smartAccount, true, deadline, sig)`
   2. The actual `safeTransferFrom` / `burn` / etc.
4. The paymaster sees an ERC-7579 batch (callType `0x01`) and validates
   each inner call against the same allowlist and ownership rules. Both
   selectors are sponsored, so the paymaster pays for the whole UserOp.
5. After this, the operator approval persists on-chain. Subsequent
   transfers from the same owner skip the bootstrap and run as a single
   sponsored UserOp.

`CGToken.setApprovalForAllWithSignature` uses OpenZeppelin's
`SignatureChecker.isValidSignatureNow`, which transparently handles both
ECDSA signatures (EOAs) and ERC-1271 contract signatures (smart wallets).
Nonces are per-owner sequential to prevent replay.

## 6. Org Gas-Budget Lifecycle

### Deposit

The paymaster needs ETH (or the chain's native gas token) at the
EntryPoint to cover sponsored ops. Two layered concepts:

- `CGPaymaster.deposit() payable` — adds to the paymaster's general
  EntryPoint deposit. Not credited to any org. Pure top-up buffer.
- `CGPaymaster.depositFor(org) payable` — adds to the paymaster's
  EntryPoint deposit *and* credits `orgBalance[org]` by the same amount.
  Both layers are funded in one call.

The deposit UI on the organization page (`CGOrganizationView`) calls
`depositFor`, so users typically don't think about the two layers.

### Spend

On each sponsored UserOp:

1. `validatePaymasterUserOp` reserves `maxCost` from `orgBalance[org]`.
   If `orgBalance` is insufficient, validation reverts and the UserOp
   never executes.
2. `postOp` is called by the EntryPoint after execution. It refunds the
   unused portion (`maxCost - actualCost`) back to `orgBalance[org]`. If
   `actualCost` exceeds the reserve (defensive edge case), the reserve is
   forfeited but not negative.

A `GasCharged` event is emitted with the actual cost and remaining balance.

### Low-balance signal

A configurable `lowBalanceThreshold` (default `0.01 ETH`) triggers a
`LowBalance(org, balance)` event in `postOp` when `orgBalance[org]` falls
below it. Off-chain monitors (an alert bot, a Tenderly stream) can watch
for this and notify the org or registry owner.

### Withdraw

`CGPaymaster.withdraw(org, amount, to)` pulls from `orgBalance[org]` to
`to`. Only the org's **manager** can call it. The default manager is the
paymaster owner (the registry deployer). Management can be handed off via
`transferManagement(org, newManager)` so the org self-manages once
established.

### Threshold and ownership

- `setLowBalanceThreshold(threshold)` — owner-only.
- `transferManagement(org, newManager)` — current manager only.
- `managerOf(org)` — view returning the current effective manager.

## 7. Frontend Wiring

| File | Role |
|---|---|
| `useSponsoredWrite.ts` | Dispatcher. Picks `eip5792` / `kernel` / `none` based on wallet caps + org budget. Exposes `write(call)` and `writeBatch(calls[])`. |
| `useSponsoredUserOp.ts` | Kernel path. Builds the smart-account client via `getKernelClient`, sends UserOps. `sendCalls(calls[])` for multi-call. |
| `useCGTokenWrite.ts` | CGToken-specific dispatcher. Probes `isApprovedForAll` before sponsored transfers/burns and bundles the signed-approval bootstrap when needed. |
| `useOrgGasSponsorship.ts` | Reads `orgBalance` from the paymaster and decides which sponsorship mode is viable for the connected wallet + chain. |
| `useEffectiveAddress.ts` | Returns the address the user is "known by" on-chain — the Kernel for EOA wallets, the smart-wallet address for EIP-5792 wallets. Used for balance/contribution lookups. |
| `services/web3/smartAccount.ts` | Kernel-via-Pimlico smart-account factory. Builds the wagmi/permissionless client, the bundler transport, and the paymaster middleware. |
| `app/api/paymaster/route.ts` | ERC-7677 paymaster service. Returns the v0.7 sponsorship blob. |
| `app/api/bundler/[chainId]/route.ts` | Bundler proxy. Adds the Pimlico API key server-side. |

## 8. Operational Concerns

- **Per-chain deploys.** `CGPaymaster` is deployed per chain. Topping up
  one chain's balance does not credit any other.
- **Native-gas-token chains.** On Arc Testnet, the native gas token is USDC
  (18-decimal as native, 6-decimal as the ERC-20 interface). The paymaster
  is currency-agnostic — `orgBalance` is denominated in the native gas
  token, whatever it is. UI surfaces use `targetNetwork.nativeCurrency.symbol`
  rather than a hard-coded "ETH".
- **EntryPoint v0.7 only.** The paymaster is hard-wired to the canonical
  EntryPoint v0.7 at `0x0000000071727De22E5E9d8BAf0edAc6f37da032`. UserOps
  targeting a different EntryPoint are rejected by `/api/paymaster`.
- **Kernel v3.1 with `useMetaFactory: false`.** Works on every chain where
  `KernelFactory` is deployed at its canonical address; the MetaFactory
  whitelist bug on Arc Testnet is sidestepped automatically.
- **Reown embedded-wallet limitation.** Reown's social/email login frame
  has its own CSP that allowlists only Reown's blockchain-api proxy. Chains
  the proxy doesn't route (Arc Testnet at time of writing) cannot use the
  embedded wallet for sponsored ops — users on those chains must connect
  with an external wallet (MetaMask etc.). See the support ticket draft
  in conversation history.
- **EIP-7702 future path.** The cleanest answer to "EOA holds tokens, smart
  account signs UserOp" would be EIP-7702 (Pectra): the EOA delegates its
  code to Kernel via a signed authorization, becoming a smart account
  in-place. Currently blocked by viem's `signAuthorization` rejecting
  JSON-RPC accounts; tracked as a future migration when the wallet ↔ wagmi
  ↔ viem ↔ permissionless chain catches up.

## 9. Test Coverage

`packages/hardhat/test/CGPaymaster.ts` covers:

- Deployment defaults and ownership
- `depositFor` accounting and registry membership check
- `validatePaymasterUserOp` for SimpleAccount and ERC-7579 single execution
- ERC-7579 batch acceptance (all calls sponsorable) + rejection paths
  (bad inner selector, bad inner target, empty batch, delegatecall)
- Rejection of non-canonical ABI encodings
- `postOp` accounting under success, opReverted, postOpReverted modes
- `withdraw`, `transferManagement`, `setLowBalanceThreshold`

Full suite: 240 tests passing.
