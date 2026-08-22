# GreenPay Contract Upgrade Notes

## Storage Compatibility

GreenPay splits its storage between **instance** and **persistent** storage:

- **Instance storage** (small, contract-wide config with a single shared TTL):
  - `DataKey::Admin`
  - `DataKey::ProjectCount`
  - `DataKey::DonationCount`
  - `DataKey::GlobalTotalRaised`
  - `DataKey::GlobalCO2OffsetGrams`
  - `DataKey::AllowedToken(Address)`

- **Persistent storage** (per-entity records, each with its own per-key TTL):
  - `DataKey::Project(String)`
  - `DataKey::DonorStats(Address)`
  - `DataKey::ImpactNFT(Address, BadgeTier)`
  - `DataKey::HasDonated(String, Address)`
  - `DataKey::Proposal(String)`
  - `DataKey::HasVoted(String, Address)`

Per-entity records are stored in persistent storage because they grow unbounded
as the platform gains projects and donors. Soroban's instance storage is
intended for small, contract-wide configuration data with a single combined
TTL/footprint that is loaded on every invocation; storing per-entity data there
inflates the instance footprint and eventually hits the hard ledger-entry size
ceiling. Persistent storage with per-key TTLs (extended on every read/write)
is the documented, correct choice for unbounded per-entity data.

TTL parameters live in [`src/lib.rs`](src/lib.rs):

- `PERSISTENT_TTL_THRESHOLD` — 7 days of ledgers; below this remaining TTL the
  entry is extended.
- `PERSISTENT_TTL_EXTEND` — 4 years of ledgers; the target TTL after extension.

Every read and write of a per-entity persistent entry automatically extends its
TTL via `extend_persistent_ttl`, so actively used records never expire and
no manual TTL maintenance is required.

## v1 → v2 Migration

Upgrade code must keep existing storage keys and stored value layouts
backward-compatible because old ledger entries are decoded by the new contract
executable after upgrade.

The v1 deployment stored **all** keys in instance storage. The v2 layout moves
per-entity records to persistent storage. This is handled by a **lazy,
transaction-safe migration** in the contract itself:

1. On first access to a per-entity key (`Project`, `DonorStats`, `ImpactNFT`,
   `HasDonated`, `Proposal`, `HasVoted`), the `read_persistent` helper checks
   whether the value exists in legacy instance storage.
2. If it does, the value is atomically copied to persistent storage and removed
   from instance storage (a no-op migration when the key is absent).
3. Soroban rolls back the entire invocation if it panics, so the copy+remove
   cannot lose the original data.

There is no explicit offline migration step required — upgrading the contract
executable and letting the first invocation per key trigger migration is
sufficient. New keys written after the upgrade go directly to persistent storage.

Do not rename or remove these variants, change their argument order, or
reorder/remove fields from stored structs such as `Project`, `DonorStats`,
`ImpactNFT`, or `VoteProposal` without adding an explicit migration path. New
fields should be handled through a new storage version or a new key namespace so
existing v1 values remain decodable. Consult the
[Acceptance Criteria storage-type guidance](README.md#storage-choice-for-future-contributors)
before adding new `DataKey` variants.

## Regression Coverage

- `test_upgrade_preserves_donation_state_and_storage_keys` covers the v1 to v2
  same-code path: deploys GreenPay, records a donation, replaces the executable
  at the same contract ID, and asserts donation-derived project totals, donor
  stats, badge/NFT state, global counters, and `HasDonated` markers remain
  readable — with per-entity keys confirmed to live in persistent storage.
- `test_lazy_migration_from_instance_to_persistent_storage` simulates a v1
  deployment by writing all per-entity records to instance storage, then proves
  a single access migrates each key to persistent storage (removing the legacy
  instance entry) without data loss.
- `test_scale_hundreds_of_projects_and_donors` registers 300 projects and 300
  donors and asserts every per-entity record stays in persistent storage while
  contract calls remain performant.
- `test_persistent_ttl_extended_on_read_and_write` jumps the ledger far beyond
  the default instance TTL and confirms per-entity persistent entries remain
  readable because TTL is extended on every read/write.
- `test_donate_total_raised_overflow_*` injects a near-`i128::MAX` `total_raised`
  into persistent project storage and asserts the next donation panics with
  `"Project total_raised overflow"` rather than wrapping, and that state + token
  balances roll back.

## Validation

Run the focused v1→v2 compatibility regression:

```bash
cargo test -p greenpay-contract --lib test_upgrade_preserves_donation_state_and_storage_keys
```

Run the migration and scale tests:

```bash
cargo test -p greenpay-contract --lib test_lazy_migration_from_instance_to_persistent_storage
cargo test -p greenpay-contract --lib test_scale_hundreds_of_projects_and_donors
cargo test -p greenpay-contract --lib test_persistent_ttl_extended_on_read_and_write
```

Run the full contract suite:

```bash
cargo test