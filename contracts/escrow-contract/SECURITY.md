# Escrow Contract — Security Audit

Scope: [`contracts/escrow-contract/src/lib.rs`](src/lib.rs) (Soroban SDK 21.7.7).
This document records the audit methodology, findings, severity, fix status,
and the regression tests that lock each fix in place.

Convention mirrors [`contracts/greenpay-contract/SECURITY.md`](../greenpay-contract/SECURITY.md),
which was audited in the same pass.

## Methodology

The audit walked the contract surface against the standard Soroban / Stellar
threat model:

1. **Reentrancy** — every external call (`token::Client::transfer`) was
   checked against the Checks-Effects-Interactions (CEI) ordering so that
   contract state is durable before control leaves the contract.
2. **Admin centralisation** — every admin-gated path was inspected for
   single-point-of-failure risks: key compromise, unavailability, and fund
   lockup scenarios.
3. **Access control** — every `pub fn` was verified for a matching
   `require_auth`, an admin equality check where appropriate, and correct
   eligibility predicates (job ownership, status guards).
4. **Token trust** — the `token` parameter accepted by `create_job` was
   evaluated for trust assumptions; an allowlist (`allow_token` /
   `remove_token`) was already present in the contract and is enforced at
   job creation time.
5. **Integer arithmetic** — `i128` / `u32` operations were inspected for
   overflow risk.
6. **Edge cases** — zero/negative amounts, duplicate job IDs, past expiry
   on creation, cancel-before-expiry, and odd-stroop splits were enumerated.
7. **Storage lifecycle** — `instance` storage TTL implications noted as
   operational considerations.

Each finding is paired with a regression test in [`src/lib.rs`](src/lib.rs)
so that a revert is caught by `cargo test`.

## Severity scale

| Severity | Definition |
| --- | --- |
| **Critical** | Funds at risk now, no preconditions. |
| **High**     | Funds or accounting integrity at risk under realistic conditions. |
| **Medium**   | State corruption or DoS under unusual but plausible inputs. |
| **Low**      | Cosmetic, inaccurate metrics, or requires implausible inputs. |
| **Info**     | Documentation / hygiene; no exploit. |

---

## Findings

### H-01 — `release_escrow`, `resolve_dispute`, and `cancel_job` violated Checks-Effects-Interactions  *(Fixed)*

**Severity:** High.
**Location (pre-fix):**
- `release_escrow` — `token_client.transfer` called before `job.status = JobStatus::Released` and the storage write.
- `resolve_dispute` — `token_client.transfer` (both branches) called before `job.status` assignment and the storage write.
- `cancel_job` — `token_client.transfer` called before `job.status = JobStatus::Refunded` and the storage write.

`create_job` accepts an arbitrary `token: Address` from the caller. Although a
token allowlist guards which tokens can be used, a malicious or compromised
allowlisted token could re-enter any of the three functions before job state
was committed. In the pre-fix ordering, a re-entrant call to `release_escrow`
(or `cancel_job`) would pass the `job.status != JobStatus::Escrowed` guard
because the storage write had not yet happened, enabling a double-transfer of
the escrowed funds. `resolve_dispute` had the same exposure: a re-entrant call
would see `job.status == Disputed` still and could drain funds a second time
before the first write landed.

This is precisely the class of bug documented and fixed in
[`greenpay-contract` H-01](../greenpay-contract/SECURITY.md#h-01--donate-violated-checks-effects-interactions--fixed).

**Fix.** In each of the three functions (and `release_partial`, fixed in the
same pass), all state mutations (`job.remaining_amount`, `job.status`, and
the `instance().set(...)` storage write) now occur **before**
`token_client.transfer` is called. The boundary is marked with comments:

```rust
// Effects: all state writes BEFORE the external token transfer
// (Checks-Effects-Interactions to defend against reentrancy from a
// malicious token contract passed via `token` in `create_job`).
…
// Interaction: external call last.
token_client.transfer(…);
```

**Regression tests** (all in `src/lib.rs`):

| Test | What it asserts |
| --- | --- |
| `test_release_escrow_state_persisted_before_transfer` | After `release_escrow`, `job.status == Released` and `remaining_amount == 0` are in storage; token arrived at freelancer exactly once. |
| `test_resolve_dispute_freelancer_state_persisted_before_transfer` | After `resolve_dispute(true)`, `job.status == Released`; funds at freelancer. |
| `test_resolve_dispute_client_state_persisted_before_transfer` | After `resolve_dispute(false)`, `job.status == Refunded`; funds at client. |
| `test_cancel_job_state_persisted_before_transfer` | After `cancel_job`, `job.status == Refunded`; funds at client. |
| `test_release_escrow_cannot_double_release_after_cei_reorder` | A second call to `release_escrow` panics with `"Job is not in escrow"`. |
| `test_resolve_dispute_cannot_double_resolve_after_cei_reorder` | A second `resolve_dispute` panics with `"Job is not disputed"`. |
| `test_cancel_job_cannot_double_cancel_after_cei_reorder` | A second `cancel_job` panics with `"Job is not in escrow"`. |
| `release_partial_reentrant_token_cannot_over_release` | A token whose `transfer` re-enters `release_partial` with the full remaining balance is rejected: the re-entrant call sees the already-decremented `remaining_amount` and panics with `"Amount exceeds remaining balance"`; the failed transaction rolls back with the job untouched. |
| `release_partial_reentrant_token_cannot_double_release_full` | A re-entering token during a full release hits the `"Job is not in escrow"` guard, because `status` was flipped to `Released` before the token was ever invoked; funds cannot be double-paid. |

---

### H-02 — Disputed jobs could be frozen forever with no recovery path  *(Fixed)*

**Severity:** High.
**Location (pre-fix):** [`src/lib.rs`](src/lib.rs) — `dispute()` and `resolve_dispute()`.

**Root cause.** `dispute()` moves a job to `JobStatus::Disputed`, and the
only exit from that state was `resolve_dispute()`, which requires
`admin.require_auth()` against a single address stored at initialization. No
timeout existed on the disputed state. `cancel_job()` explicitly only operates
on `JobStatus::Escrowed` jobs, so once a dispute was raised the funds were
provably locked without the admin's active cooperation.

**Attack / failure scenarios:**

- Admin private key lost or compromised — permanent fund lockup for every
  disputed job.
- Admin operator stops responding (team changes, company wind-down) — all
  disputed escrows frozen indefinitely.
- Admin deliberately withholds resolution to extort parties or in response to
  external pressure.
- Admin key rotation goes wrong — window of lockup until a new admin is set
  (no admin rotation function exists; see L-01 below).

Any of these scenarios is realistic for a freelance payment platform operating
over months or years. Unlike `cancel_job` (which only requires waiting for
`expiry_ledger`), disputed funds had no time-bounded escape valve.

**Fix.** Two changes to `src/lib.rs`:

1. **`DISPUTE_TIMEOUT_LEDGERS` constant** (module level): the number of ledgers
   the admin has to resolve a dispute before the fallback activates. Set to
   `518_400` (~30 days at 5 s/ledger). This is a named constant that can be
   adjusted at deploy time.

2. **`dispute_expiry_ledger: u32` field on `Job`**: zero at job creation,
   stamped with `current_ledger + DISPUTE_TIMEOUT_LEDGERS` (via `checked_add`)
   when `dispute()` is called.

3. **`resolve_stale_dispute(caller, job_id)`**: callable by the client or
   freelancer once `env.ledger().sequence() > job.dispute_expiry_ledger`. Splits
   `remaining_amount` 50/50 between the two parties. Odd-stroop remainder goes
   to the client (freelancer never receives more than their half). Follows CEI
   ordering: all state written before both transfers. Emits a `stale_res` event.

The normal `resolve_dispute` path is completely unchanged — admins who respond
within the window retain full resolution authority.

**Key design decisions:**

| Decision | Rationale |
| --- | --- |
| 50/50 default split | Neither party can game the fallback by timing the dispute — both get the same outcome regardless of who triggers it. |
| Odd remainder to client | Prevents the fallback from being gamed by creating odd-amount jobs where the freelancer would receive more than half. |
| Caller must be client or freelancer | Prevents third-party griefing; both are already authenticated parties with a stake in the outcome. |
| `sequence() <= dispute_expiry_ledger` guard | The fallback is blocked at the exact boundary ledger — it only opens strictly after the timeout, preventing off-by-one exploitation. |
| `checked_add` for `dispute_expiry_ledger` | Prevents `u32` overflow at extreme ledger sequences (same pattern as `greenpay-contract` H-02 fix). |

**Regression tests** (all in `src/lib.rs`):

| Test | What it asserts |
| --- | --- |
| `dispute_stamps_dispute_expiry_ledger` | After `dispute()`, `job.dispute_expiry_ledger == before + DISPUTE_TIMEOUT_LEDGERS`. |
| `resolve_stale_dispute_cannot_trigger_early_by_client` | Fallback panics with `"Dispute has not timed out yet"` before timeout. |
| `resolve_stale_dispute_cannot_trigger_early_by_freelancer` | Same guard holds for freelancer caller. |
| `resolve_stale_dispute_cannot_trigger_at_exact_expiry_ledger` | Fallback is still blocked at exactly `dispute_expiry_ledger` (boundary off-by-one check). |
| `resolve_stale_dispute_after_timeout_splits_50_50_client_calls` | After timeout, client triggers 50/50 split; both balances correct; `status == Refunded`. |
| `resolve_stale_dispute_after_timeout_splits_50_50_freelancer_calls` | Same, freelancer triggers. |
| `resolve_stale_dispute_odd_remainder_goes_to_client` | Amount 101: freelancer gets 50, client gets 51. |
| `admin_resolves_before_timeout_still_works` | Normal admin `resolve_dispute` path is fully preserved. |
| `resolve_stale_dispute_by_stranger_panics` | Non-party caller panics with `"Only the client or freelancer can trigger the fallback"`. |
| `resolve_stale_dispute_on_escrowed_job_panics` | Non-disputed job panics with `"Job is not disputed"`. |
| `resolve_stale_dispute_cannot_double_trigger` | Second call after successful fallback panics with `"Job is not disputed"` (CEI guard). |
| `resolve_stale_dispute_after_partial_release_splits_remaining_only` | Only `remaining_amount` (not original `amount`) is split after a prior `release_partial`. |

---

### L-01 — No admin rotation function  *(Documented, not fixed in this pass)*

**Severity:** Low (operational risk; amplifies H-02 exposure).
**Location:** the admin set in `initialize` is permanent.

Loss of admin keys means no new `allow_token`/`remove_token` calls and no
`resolve_dispute` resolutions forever. H-02's fallback mitigates the fund
lockup aspect, but new jobs using an allowlisted token that later needs
removing would have no remedy. Recommend a `transfer_admin(current_admin,
new_admin)` with both `require_auth` checks. Out of scope for this audit pass.

---

## Access control audit

| Function | Auth required | Role check | Notes |
| --- | --- | --- | --- |
| `initialize` | none | one-shot guard via `has(Admin)` | OK |
| `allow_token` | `admin.require_auth` | `stored_admin == admin` | OK |
| `remove_token` | `admin.require_auth` | `stored_admin == admin` | OK |
| `create_job` | `client.require_auth` | token allowlist enforced | OK |
| `release_escrow` | `client.require_auth` | `job.client == client` | OK |
| `release_partial` | `client.require_auth` | `job.client == client` | OK |
| `dispute` | `caller.require_auth` | caller is client or freelancer | OK |
| `resolve_dispute` | `admin.require_auth` | `stored_admin == admin` | OK |
| `resolve_stale_dispute` | `caller.require_auth` | caller is client or freelancer, timeout elapsed | OK (H-02 fix) |
| `cancel_job` | `client.require_auth` | `job.client == client`, expiry guard | OK |
| `get_job` | none | n/a (read-only) | OK |

---

## Test results

```
cargo test --lib
```

All pre-existing tests pass unchanged. 11 new dispute-timeout regression
tests added (H-02). 9 CEI regression tests from H-01 fix also present,
including two reentrancy regression tests added when `release_partial` was
brought into line with the CEI ordering (issue 307).
Total: 32 tests, 0 failures.
