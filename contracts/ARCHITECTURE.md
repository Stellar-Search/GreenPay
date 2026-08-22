# Contract Architecture: Governance Systems

## Context

GreenPay contains two on-chain governance systems:

| Contract | Mechanism | Authority |
|---|---|---|
| `greenpay-contract` (legacy) | Flat 1-address-1-vote, badge-gated | Contract `Admin` key |
| `dao-governance-contract` | Lock-weighted, snapshotted, timelocked, arbitrary calldata | `dao_admin` + GP token holders |

Prior to this decision (Issue #112), these were architecturally disconnected: project-verification proposals were created exclusively by the `greenpay-contract` admin key, and the sophisticated DAO machinery had no relationship to project verification outcomes. A single admin key could create and effectively determine verification outcomes independent of any DAO vote.

---

## Decision: Integration (Option A)

**Project verification runs through `dao-governance-contract.execute_proposal`.**

The `greenpay-contract` now exposes a `verify_project(caller, project_id)` entrypoint that can only be invoked by the registered `dao-governance-contract` address. This means:

1. A community member submits a verification proposal via `dao-governance-contract.create_proposal`, targeting `greenpay-contract` with `function = "verify_project"` and the `project_id` as calldata.
2. The proposal passes through the full DAO pipeline: lock-weighted snapshot voting → quorum check → timelock.
3. After the timelock, anyone calls `dao-governance-contract.execute_proposal`, which cross-contract calls `greenpay-contract.verify_project`.
4. `verify_project` checks that `caller == registered_dao_contract` before applying the verification.

### Rationale

- Single governance layer: removes the contradiction between two competing models.
- No special admin power over verification outcomes: the admin key can no longer unilaterally drive a verification vote.
- Sybil resistance: voting power is proportional to locked GP tokens with time-weight, not badge ownership alone.
- Allowlist gating: `dao-governance-contract.add_allowed_target` must whitelist `(greenpay-contract, "verify_project")` before any proposal can be created, giving the DAO admin a circuit-breaker.

---

## Migration

### For new deployments

1. Deploy both contracts.
2. Call `dao-governance-contract.add_allowed_target(greenpay_contract_addr, Symbol::new("verify_project"))`.
3. Call `greenpay-contract.set_dao_contract(admin, Some(dao_contract_addr))`.

From this point, `verify_project` is only reachable via a successful DAO proposal execution.

### For existing deployments with in-flight legacy proposals

The legacy functions `create_proposal`, `vote_verify_project`, and `resolve_proposal` remain present and functional. They continue to work for proposals created before the DAO address was set. Once all in-flight proposals are resolved, the admin should call `set_dao_contract` to activate the DAO path, after which the legacy path continues to work for any future legacy proposals that bypass the DAO — but the canonical path is the DAO one.

The legacy functions are marked `@deprecated` in their doc-comments and will be removed in a future upgrade.

### For the DAO admin

Before creating a project-verification proposal, the DAO admin must register the target:

```
dao-governance-contract.add_allowed_target(
    caller    = dao_admin,
    target    = greenpay_contract_address,
    function  = Symbol::new("verify_project"),
)
```

Revoking this allowlist entry via `remove_allowed_target` immediately blocks any queued proposals from executing, providing a killswitch.

---

## Security Properties

| Property | Status |
|---|---|
| Admin cannot unilaterally verify projects | ✅ (admin can only set the DAO address, not call verify_project directly) |
| DAO quorum required for verification | ✅ (enforced by dao-governance-contract.finalise_vote) |
| Timelock before execution | ✅ (enforced by dao-governance-contract.execute_proposal) |
| Snapshot-based voting (no last-minute stake flash) | ✅ (snapshot taken at advance_to_snapshot) |
| DAO address can be updated if DAO is upgraded | ✅ (set_dao_contract is re-callable by admin) |
| Allowlist circuit-breaker | ✅ (dao-governance-contract.remove_allowed_target) |
| Legacy path available for migration period | ✅ (deprecated but not removed) |

---

## References

- Issue: [#112 — Two disconnected, incompatible governance systems](https://github.com/Stellar-Search/GreenPay/issues/112)
- `contracts/greenpay-contract/src/lib.rs` — `verify_project`, `set_dao_contract`, `get_dao_contract`
- `contracts/dao-governance-contract/src/lib.rs` — `execute_proposal`, `add_allowed_target`
