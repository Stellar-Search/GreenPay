# Contract Security Audit Process

A single, repeatable process for auditing the Soroban contracts in `contracts/`,
so that a material change to any contract is re-checked against the same
methodology that produced the existing audit records.

## Scope

| Contract | Audit record |
| --- | --- |
| `greenpay-contract` | [`greenpay-contract/SECURITY.md`](greenpay-contract/SECURITY.md) |
| `escrow-contract` | [`escrow-contract/SECURITY.md`](escrow-contract/SECURITY.md) |
| `dao-governance-contract` | [`dao-governance-contract/SECURITY.md`](dao-governance-contract/SECURITY.md) |

## When to re-run (triggers)

Re-audit a contract when a change touches any of the following:

- a public entrypoint (`pub fn` on the contract impl) — added, removed, or signature changed;
- an external call (`token::Client::transfer`, cross-contract invocation);
- arithmetic on value or accounting fields;
- access control (`require_auth`, admin/role checks, eligibility predicates);
- storage keys, storage tier (`instance` / `persistent`), or TTL handling;
- the `soroban-sdk` / toolchain version;
- an upgrade path or migration;
- the fix for a previously recorded finding.

Non-material changes (comments, formatting, documentation, tests-only) do **not**
require a re-run.

## Methodology (checklist)

For every entrypoint and every reachable state transition:

1. **Reentrancy** — verify Checks-Effects-Interactions: all state writes are durable before any external call.
2. **Integer arithmetic** — use `checked_add` / `checked_sub` / `checked_mul` with named panic messages; do not rely on the `overflow-checks` profile setting.
3. **Access control** — every mutating `pub fn` has `require_auth` plus the correct ownership / admin / eligibility check.
4. **Front-running / MEV** — inspect ordering-sensitive flows (snapshots, thresholds, allowlists).
5. **Event safety** — no spoofable topics, no sensitive data, indexed fields sufficient for off-chain consumers.
6. **Edge cases** — zero/negative amounts, boundary ledgers, duplicate IDs, empty inputs, past deadlines.
7. **Storage lifecycle** — confirm the storage tier is appropriate and the TTL is extended where required.

## Procedure

1. Inventory the surface: list every entrypoint and every storage key it touches.
2. Apply the checklist above to each.
3. Classify each finding with the severity scale below.
4. Fix it, or document why it is out of scope (with rationale and a follow-up reference).
5. Add a regression test for every substantive finding in the contract's `src/` tests, naming the finding in the test.
6. Record the finding in the contract's `SECURITY.md`: id, severity, pre-fix location, root cause, attack/failure scenario, fix, and the regression test name(s).
7. Run `make test` (or `cd contracts && cargo test --workspace`) and `make lint`; update the **Test results** section with the count.
8. Add the re-run date and the commit/PR reference to the contract's `SECURITY.md`.

## Severity scale

| Severity | Definition |
| --- | --- |
| **Critical** | Funds or governance at risk now, with no preconditions. |
| **High** | Funds, accounting integrity, or governance integrity at risk under realistic conditions. |
| **Medium** | State corruption or DoS under unusual but plausible inputs. |
| **Low** | Cosmetic, inaccurate metrics, or requires implausible inputs. |
| **Info** | Documentation / hygiene; no exploit. |

## Finding record template

```markdown
### <ID> — <one-line summary>  *(Fixed | Documented, not fixed)*

**Severity:** <Critical|High|Medium|Low|Info>.
**Location (pre-fix):** `src/lib.rs:<lines>`.
**Root cause:** …
**Attack / failure scenario:** …
**Fix:** … (or "Out of scope for this pass because …")
**Regression tests:** `test_…` — what it asserts.
```

## Complementary checks

- Dependency vulnerabilities: `make audit` (`cargo audit`).
- Formatting and lints: `make lint`.
- Property / fuzz tests: [`PROPERTY_TEST_CATALOG.md`](PROPERTY_TEST_CATALOG.md) and [`TESTING_STRATEGY.md`](TESTING_STRATEGY.md).

## Ownership and sign-off

The change author runs the process for the affected contract. A reviewer confirms
that the checklist was applied and that every substantive finding has a
regression test before the change is merged.
