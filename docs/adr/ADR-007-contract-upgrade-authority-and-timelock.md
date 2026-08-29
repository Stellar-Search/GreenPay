# ADR-007: Contract Upgrade Authority and Timelock

## Status

Proposed — the timelock is implemented; the authority decision below needs
maintainer confirmation before it is marked Accepted.

## Context and Problem Statement

`greenpay-contract`, `escrow-contract` and `dao-governance-contract` each
exposed an `upgrade(env, admin, new_wasm_hash)` entrypoint that called
`env.deployer().update_current_contract_wasm(...)` immediately, gated only on
`require_auth` plus an equality check against the stored admin address.

One signature therefore replaced the code holding escrowed job funds and donor
records, in one ledger, with no announcement. A client whose funds sat in
`escrow-contract` had no way to observe a pending change and settle or reclaim
before it landed; a donor had no way to see that the donation contract was
about to become different code. The mechanism was right — Soroban contracts do
need an upgrade path — but its governance was never specified.

`dao-governance-contract`'s own doc comment suggested routing upgrades through
`execute_proposal`, so they would inherit the DAO's quorum, snapshot and
timelock. Nothing enforced that, and as documented below, that route does not
currently work.

Two questions had to be separated:

1. **How long** must an announced upgrade wait before it can be applied?
2. **Who** is the authority that announces and applies it?

Question 1 is an engineering decision and is settled here. Question 2 is a
product and operational decision; this ADR records the recommendation and the
alternatives rather than silently adopting one.

## Decision Drivers

- Someone with funds at stake must be able to see a code change coming and exit
  before it takes effect.
- The delay must be enforced on-chain, not by process or convention.
- The delay must not be adjustable by the same key it constrains.
- Withdrawing an announced upgrade must be visible, not silent.
- Authority must be changeable later without another breaking rewrite.
- A security fix must still be shippable on a defined schedule.

## Decision Outcome

### Upgrades are two-phase, with a 120_960-ledger timelock

All three contracts replace `upgrade` with `propose_upgrade`, `apply_upgrade`,
`cancel_upgrade` and a `get_pending_upgrade` getter. `propose_upgrade` records
a `PendingUpgrade { wasm_hash, proposed_at_ledger, executable_from_ledger }`
and emits `upg_prop` carrying the hash and the ledger it becomes installable
at. `apply_upgrade` refuses while `sequence() < executable_from_ledger`.

`UPGRADE_TIMELOCK_LEDGERS = 120_960` — roughly **7 days at ~5 s per ledger**.

The value is reused rather than invented: 120_960 is already
`VOTING_WINDOW_LEDGERS` in greenpay-contract, and `MIN_LOCK_LEDGERS` and
`MIN_VOTING_WINDOW` in dao-governance-contract, and `PERSISTENT_TTL_THRESHOLD`.
The codebase therefore keeps one notion of "a window in which a stakeholder can
notice and act" instead of adding a fifth unrelated constant.

Because the gate counts **ledgers**, not wall-clock seconds, 7 days is a
**floor** rather than an estimate. The 5 s figure is Stellar's target close
time; observed closes run at or slightly above it. If ledgers close slower, the
real delay is longer. It can never come in shorter than the ledger count
implies.

**The specific number is a judgment call, and is open to adjustment.** The
mechanism is what is being defended here, not the constant. Seven days spans a
weekend plus a working day, which is what an escrow counterparty realistically
needs to notice a proposal and act on it. The cost is that it is also the floor
on shipping a fix for a known-exploitable bug. If that trade reads wrong for
this project, 17_280 (24 h) or 60_480 (3.5 days) are defensible; the code
change is one constant.

The standard mitigation for the patch-agility cost is a circuit breaker that is
*not* timelocked — pause the affected paths immediately, then fix on the
timelock's schedule. Emergency pause is being added separately (issue #315). If
it lands, the case for keeping the timelock at 7 days gets stronger rather than
weaker.

### The delay is a constant, not configuration

An admin-settable delay is not a weaker timelock, it is no timelock: the holder
of the key the delay constrains could set it to zero and upgrade in the same
block. Making the setter itself timelocked is circular.

As a constant, changing the delay requires an upgrade, and that upgrade is
subject to the current delay. The timelock governs its own parameter.

`dao-governance-contract` has a configurable `Config.timelock_ledgers`, and it
is deliberately **not** reused for the upgrade path. That value is validated
only as non-zero at `initialize`, where `dao_admin` chooses it, so sourcing the
upgrade delay from it would let the constrained key set it to 1. Its
configurability is only safe because `set_config` requires
`env.current_contract_address().require_auth()` — reachable solely through a
proposal that has already cleared quorum and timelock. The precedent is
"configurable **if and only if** the setter is itself governed," and an
admin-gated path does not meet that bar.

### Only one upgrade may be pending, and replacing one is explicit

`propose_upgrade` panics if a proposal is already pending. Replacing an
announced hash is `cancel_upgrade` followed by a fresh `propose_upgrade`, which
serves a full new timelock.

Overwrite-with-reset would have been equally safe against the obvious bypass,
but it makes withdrawal invisible: swapping the announced hash would be a
single transaction emitting a single event, and a watcher tracking "the current
pending hash" could miss that the hash it had been evaluating was retracted.
Requiring cancel-then-propose puts the retraction on the event stream as its
own `upg_cncl`.

It also removes a class of bug rather than testing for it. Because no code path
writes a `PendingUpgrade` over an existing one, a replacement *cannot* inherit
the earlier `executable_from_ledger`. The timelock-shortening bypass is
unrepresentable, not merely absent.

### Cancelling removes state; it does not flag it

`cancel_upgrade` removes the storage key outright. A retained
cancelled-but-readable record is state that a later code path, or a future
version whose struct has drifted, could misread as applicable. Removal makes
`get_pending_upgrade() == None` and `apply_upgrade` failing with "no pending
upgrade" true by construction rather than by a correctly-checked flag. The
`upg_cncl` event and ledger history are the audit trail; that is what events
are for.

`apply_upgrade` removes the record before calling the deployer, for the same
reason.

### `propose_upgrade` extends the contract instance TTL

Instance storage entries have a TTL like any other ledger entry, and the
default is far shorter than a 7-day timelock. Neither greenpay-contract nor
escrow-contract extended their instance TTL anywhere before this change. A
proposal made on an otherwise-idle contract would therefore have had its
pending record — and the `Admin` entry beside it — archived before it became
applicable, requiring a restore before the upgrade could proceed at all.

`propose_upgrade` extends the instance TTL to `UPGRADE_INSTANCE_TTL_EXTEND`
(2_102_400 ledgers) so a pending record always outlives its own timelock.

### Authority: multisig now, DAO as the intended end state

**Decision: a multisig admin account, today.** The contracts stay admin-gated.
The admin is a Stellar account configured with multiple signers and a raised
threshold, so `admin.require_auth()` enforces M-of-N with no contract change
at all.

**Intended end state: DAO routing via `execute_proposal`** — blocked on the
calldata ABI mismatch documented below.

This split is chosen because the timelock is the load-bearing control and lands
regardless of who the authority is; authority is a separable second decision;
and multisig is deployable the day this merges at zero contract cost, whereas
DAO routing is a larger change that is not currently available.

#### Why DAO routing is not available today

`execute_proposal` invokes its target as:

```rust
let args = vec![&env, proposal.calldata.into_val(&env)];
env.invoke_contract::<()>(&proposal.target_contract, &proposal.function, args);
```

Exactly one argument, of type `Bytes`. The callable ABI is therefore fixed at
`fn f(env: Env, data: Bytes) -> ()`; the contract's own test target,
`Noop::noop(_env: Env, _data: Bytes)`, confirms it.

Two consequences follow:

1. `apply_upgrade(env, admin: Address)` is **not** callable by
   `execute_proposal`. A DAO-routed path needs a second entrypoint shaped
   `apply_upgrade(env: Env, _data: Bytes)` that derives authority from
   `dao_addr.require_auth()` rather than from a caller argument — a different
   function, not a parameterisation of this one.

2. **The existing precedent for this pattern is itself broken.**
   `greenpay-contract`'s `verify_project(env, caller: Address, project_id:
   String)` takes two arguments, while its own doc comment describes it as the
   calldata payload target for `execute_proposal`. Invoked through
   `execute_proposal` it would receive one `Bytes` argument and fail on arity.
   The existing test calls it directly with a mocked DAO address, so the real
   path has never been exercised. Adopting DAO routing means building the first
   working instance of this integration, not reusing a proven one.

#### Multisig: what it gives and what it does not

- It is the only option deployable today, and it needs no contract change:
  raising the admin account's signer threshold on the network converts "one
  key" into M-of-N immediately.
- No cross-contract dependency, no deployment ordering constraint, and no
  bricking class.
- But authority lives in account configuration rather than contract state, so
  it is not inspectable from the contract and not enforceable by it. Changes to
  the signer set are not announced on-chain. It carries no token-holder
  legitimacy.

#### DAO routing: what it would take

- Fix `execute_proposal`'s calldata ABI, or add `Bytes`-shaped variants of every
  DAO-callable entrypoint (and fix `verify_project` while doing so).
- Add a `DaoContract` registration to `escrow-contract`, which has none.
- Keep an admin path for bootstrap: the DAO must exist and be initialised before
  it can govern anything, so admin-gating never fully disappears — it becomes a
  fallback whose own governance still needs specifying.
- Accept a bricking risk: neither greenpay-contract nor escrow-contract has an
  admin-transfer function, so a DAO address that is wrong or dead, once
  admin-gating is removed, leaves the contract permanently unupgradeable.
- Accept that `dao-governance-contract` cannot govern its own upgrade this way.
  `execute_proposal` cannot be the authority over the upgrade of the contract
  that implements `execute_proposal`.

### `upgrade` is removed, not deprecated

The single-phase `upgrade` entrypoint is gone from all three contracts. This is
a **breaking ABI change** for any caller invoking it.

Keeping it as a shim was rejected on both readings: a shim that routes through
the timelock is not a shim, and a shim that does not is precisely the
vulnerability this ADR exists to close.

The `upgraded` event is unchanged — same topic, same payload — so existing
indexers keep working. `apply_upgrade` emits it at the moment the code actually
changes.

The deployment scripts are unaffected: `scripts/deploy-contracts-automated.sh`
upgrades by running `stellar contract deploy` against the same contract ID, and
never invoked the contract entrypoint.

## Consequences

### Positive

- An upgrade cannot take effect for at least 120_960 ledgers after it is
  announced, enforced on-chain in all three contracts.
- A pending upgrade is observable two ways: the `upg_prop` event and the
  `get_pending_upgrade` getter.
- A withdrawn proposal is visible as its own event rather than being silently
  overwritten.
- The timelock-shortening bypass is unrepresentable rather than merely tested
  against.
- A pending record can no longer be archived out from under its own timelock.
- Moving to DAO authority later does not require revisiting the timelock.

### Negative

- Shipping a fix for a known-exploitable bug now has a 7-day floor, unless a
  separate untimelocked circuit breaker exists.
- A compromised admin key can still schedule an upgrade; the timelock buys
  notice and a window to respond, it does not prevent the proposal.
- Multisig authority is not visible on-chain, so "who can upgrade this" cannot
  be answered from contract state alone.
- The breaking removal of `upgrade` requires every caller to migrate.
- Replacing a pending hash costs an extra transaction.

## More Information

- Issue #310 — the audit finding this ADR resolves.
- Issue #315 / the emergency-pause work — the untimelocked circuit breaker that
  offsets the patch-agility cost.
- [greenpay-contract upgrade entrypoints](../../contracts/greenpay-contract/src/lib.rs)
- [escrow-contract upgrade entrypoints](../../contracts/escrow-contract/src/lib.rs)
- [dao-governance-contract upgrade entrypoints](../../contracts/dao-governance-contract/src/lib.rs)
