# DAO Governance Contract — Security Audit

Scope: [`contracts/dao-governance-contract/src/lib.rs`](src/lib.rs) (Soroban SDK 21.7.7).
This document records the audit methodology, findings, severity, fix status,
and the regression tests that lock each fix in place.

Convention mirrors [`contracts/greenpay-contract/SECURITY.md`](../greenpay-contract/SECURITY.md)
and [`contracts/escrow-contract/SECURITY.md`](../escrow-contract/SECURITY.md),
audited in the same pass.

## Methodology

The audit walked the contract surface against the standard Soroban / Stellar
threat model and the additional risks specific to on-chain governance:

1. **Snapshot integrity** — every path that could influence `get_voting_power`
   was traced to verify that the ledger recorded in `snapshot_ledger` acts as a
   true point-in-time fence: no mutation after the snapshot must be able to
   retroactively increase the power counted for an in-progress vote.
2. **Flash-loan / same-ledger attacks** — the `created_ledger` guard in
   `get_voting_power` was verified to block locks created at or after the
   snapshot ledger from voting on that proposal.
3. **Reentrancy** — every external call (`token::Client::transfer`) was
   checked against Checks-Effects-Interactions (CEI) ordering.
4. **Access control** — every `pub fn` was verified for a matching
   `require_auth` and, where applicable, an admin equality check.
5. **Integer arithmetic** — `i128` / `u32` operations were inspected for
   overflow; all checked paths use `checked_add` / `checked_sub`.
6. **Allowlist re-check at execution** — confirmed that `execute_proposal`
   re-validates `DataKey::AllowedTarget` rather than trusting the check
   performed at proposal creation.
7. **Storage lifecycle** — `instance` vs `persistent` storage TTL implications
   noted as operational considerations.

Each finding is paired with a regression test in [`src/lib.rs`](src/lib.rs)
so that a revert is caught by `cargo test`.

## Severity scale

| Severity | Definition |
| --- | --- |
| **Critical** | Governance or funds at risk now, no preconditions. |
| **High**     | Governance integrity or fund security at risk under realistic conditions. |
| **Medium**   | State corruption or DoS under unusual but plausible inputs. |
| **Low**      | Cosmetic, inaccurate metrics, or requires implausible inputs. |
| **Info**     | Documentation / hygiene; no exploit. |

---

## Findings

### H-01 — `get_voting_power` derived historical power from a mutable present-day record — retroactive inflation via `extend_lock` after snapshot  *(Fixed)*

**Severity:** High.
**Identifier:** CVE-DAO-GOV-2026-001.
**Location (pre-fix):** `get_voting_power` (~line 255), `extend_lock` (~line 199).

#### Root cause

`get_voting_power(env, voter, at_ledger)` did not read a point-in-time
checkpoint. It fetched the voter's single, **current** `Lock` record
(`DataKey::Lock(voter)`) and computed:

```rust
let remaining = lock.unlock_ledger - at_ledger;
(lock.amount * remaining as i128) / MAX_LOCK_LEDGERS as i128
```

`extend_lock()` mutated `lock.unlock_ledger` in place without recording the
pre-extension state anywhere. Because `get_voting_power` always read the live
record, any increase to `unlock_ledger` retroactively inflated the power
computed for any historical `at_ledger` — including a proposal's
`snapshot_ledger` that was set in the past.

#### Attack sequence

1. Voter calls `lock_tokens` with a short duration → low voting power at the
   upcoming snapshot.
2. Proposer calls `advance_to_snapshot` → `snapshot_ledger = L` is recorded
   on the proposal.
3. Before casting their vote, the attacker calls `extend_lock` to push
   `unlock_ledger` far into the future (up to 4 years).
4. Attacker calls `cast_vote`. `cast_vote` calls
   `get_voting_power(voter, proposal.snapshot_ledger)` — which now uses the
   extended `unlock_ledger`, yielding far more power than the attacker held
   at ledger `L`.

The existing `at_ledger < lock.created_ledger` guard correctly blocked a
brand-new lock created **after** the snapshot, but it provided no protection
for the extend-lock path because `created_ledger` is never mutated by
`extend_lock`.

This defeats the entire purpose of snapshotting: it simply moves the attack
vector from flash-loaning tokens (blocked by `created_ledger`) to
flash-extending a lock.

#### Fix

**Per-voter lock checkpoints.** A new `LockCheckpoint` struct is written to
persistent storage on every `lock_tokens` and `extend_lock` call:

```rust
pub struct LockCheckpoint {
    pub effective_from_ledger: u32,  // when this state becomes canonical
    pub amount: i128,
    pub unlock_ledger: u32,
    pub created_ledger: u32,
}
```

Checkpoints are indexed under `DataKey::LockCheckpoint(voter, index)` with a
per-voter counter stored in `DataKey::LockCheckpointCount(voter)`.

**`effective_from_ledger` semantics** — the key correctness invariant:

| Caller | `effective_from_ledger` | Rationale |
| --- | --- | --- |
| `lock_tokens` | `current_ledger` | A new lock is valid starting at its creation ledger; a snapshot taken in the same ledger must see the initial power. |
| `extend_lock` | `current_ledger + 1` | An extension called within the same ledger as a snapshot must NOT retroactively inflate the power counted for that snapshot. The extended `unlock_ledger` only takes effect from the following ledger onward. |

**Updated `get_voting_power`** scans checkpoints from newest to oldest and
uses the first one with `effective_from_ledger <= at_ledger` — the state that
was genuinely current at the query ledger. The live `Lock` record is
consulted only as a fallback when no checkpoints exist (unreachable in normal
operation after the first lock).

#### Regression tests

| Test | What it asserts |
| --- | --- |
| `test_snapshot_immutable_after_extend` | `expected_power` is captured before `extend_lock`. After extending and voting, `get_snapshot_power` equals the pre-extension value, and is strictly less than the value the raw formula would produce with the extended `unlock_ledger`. |
| `test_extend_lock_after_snapshot_does_not_inflate_vote` | Attacker (MIN duration) and honest voter (MAX duration) are both snapshotted. Attacker extends to MAX after the snapshot. Attacker's counted vote equals their pre-extension power; honest voter's power is unchanged; attacker still has less counted power than the honest voter. |

---

### H-02 — Quorum was an absolute vote count, not a proportion of locked supply  *(Fixed)*

**Severity:** High.
**Location (pre-fix):** `Config.quorum`, `finalise_vote` (~line 535).

#### Root cause

`finalise_vote` compared `votes_for + votes_against` against
`config.quorum`, a fixed absolute `i128` chosen at `initialize`. Voting power
is time-decayed lock weight (`get_voting_power`), and the locked supply moves
constantly as voters lock, extend and withdraw, so the threshold an absolute
number should be measured against drifts with it: a quorum sized for a small
ecosystem becomes trivial once more tokens are locked, and one sized for
maturity becomes unreachable during early participation. Because `Config` is
immutable, nothing on-chain could recalibrate it.

#### Fix

Quorum is now a **proportion**, expressed in basis points
(`Config.quorum_bps`, 1/10000 of the total locked GP supply), and is
snapshotted onto each proposal when it advances to vote:

```rust
proposal.quorum_requirement = (total_locked * config.quorum_bps) / 10000;
```

The denominator — `DataKey::TotalLocked` — is maintained **incrementally** on
every `lock_tokens` (adding the new amount and dropping any replaced expired
lock) and `withdraw` (removing the withdrawn amount), so it is never
recomputed by iterating lockers. `finalise_vote` uses the frozen
`proposal.quorum_requirement`, so tokens locked or withdrawn **during** a vote
cannot move the goalposts.

#### Migration note (absolute → proportional quorum)

No deployment is currently live (all contract IDs are `TODO` in
`contracts/deployment-config.json`), so there is no on-chain state to
migrate. For any future deployment that ran the pre-fix code:

1. The `initialize` signature is unchanged in shape — the third argument is
   still an `i128` — but its meaning changes from an **absolute vote count**
   to **basis points of total locked supply**. A deployment that initialized
   with `quorum = 1000` must re-initialize with `quorum_bps = 1000` (10%)
   and will now require 10% of whatever is locked, rather than 1000 votes.
2. In-flight proposals created before the upgrade keep their old
   `quorum_requirement` field default of `0` and should be finalised before
   the upgrade, or withdrawn, to avoid the `0` threshold being treated as
   quorum met. After the upgrade all new proposals carry a real threshold.
3. Because the semantics change, the cleanest cutover is a fresh deploy of
   the upgraded WASM rather than an in-place upgrade of a live contract; the
   two are incompatible on the meaning of the stored config value.

#### Regression tests

| Test | What it asserts |
| --- | --- |
| `test_quorum_scales_with_locked_supply` | Doubling the locked supply doubles `quorum_requirement` for a new proposal (50_000 → 100_000 at 10%). |
| `test_quorum_shrinks_when_supply_withdrawn` | After all supply is withdrawn and a smaller pool is locked, a new proposal's threshold shrinks (1_000 → 500). |
| `test_quorum_frozen_at_snapshot` | A whale locking mid-vote does not move the goalposts: the proposal keeps its snapshotted threshold and passes on the pre-whale votes. |
| `test_total_locked_tracks_locks_and_withdrawals` | `get_total_locked` reflects locks, expired-lock replacement, and withdrawals (0 → 5000 → 8000 → 7000 → 3000). |
| `test_finalise_defeated_no_quorum` | Most of the supply held by a non-voter defeats a proposal whose votes fall below the proportional threshold. |

---

## Access control audit

| Function | Auth required | Role check | Notes |
| --- | --- | --- | --- |
| `initialize` | none | one-shot guard via `has(Config)` | OK |
| `lock_tokens` | `voter.require_auth` | n/a | OK |
| `extend_lock` | `voter.require_auth` | lock existence check | OK |
| `withdraw` | `voter.require_auth` | lock existence, expiry guard | OK |
| `create_proposal` | implicit via VP check | `get_voting_power > 0` at current ledger | OK |
| `advance_to_snapshot` | `caller.require_auth` | dao_admin bypass or VP > 0 | OK |
| `cast_vote` | `voter.require_auth` | snapshot VP > 0, no double-vote | OK |
| `finalise_vote` | none (permissionless) | stage + timing guards | OK |
| `execute_proposal` | none (permissionless) | stage, timelock, allowlist re-check | OK |
| `add_allowed_target` | `caller.require_auth` | `caller == dao_admin` | OK |
| `remove_allowed_target` | `caller.require_auth` | `caller == dao_admin` | OK |
| `upgrade` | `caller.require_auth` | `caller == dao_admin` | OK |
| `get_*` | none | read-only | OK |

---

## Test results

```
cargo test --lib
```

All 63 pre-existing tests pass unchanged (H-01 fix included). The H-02
proportional-quorum fix adds 5 regression tests
(`test_quorum_scales_with_locked_supply`, `test_quorum_shrinks_when_supply_withdrawn`,
`test_quorum_frozen_at_snapshot`, `test_total_locked_tracks_locks_and_withdrawals`,
and the reworked `test_finalise_defeated_no_quorum`).
Total: **67 tests, 0 failures**.
