# GreenPay Soroban Contract

This Soroban smart contract provides **on-chain transparency** for every climate donation on Stellar GreenPay.

## What it does

Every donation is recorded permanently on the Stellar blockchain. Anyone can query project totals, donor statistics, CO₂ offsets, and badge tiers — with no central authority controlling the data.

## Functions

| Function | Who calls it | Description |
|----------|-------------|-------------|
| `initialize(admin)` | Deployer | One-time setup |
| `register_project(admin, id, name, wallet, co2_per_xlm)` | Admin | Register a verified project |
| `deactivate_project(admin, id)` | Admin | Stop new donations to a project |
| `donate(token, donor, project_id, amount, msg_hash)` | Donor | Send XLM + record donation |
| `get_project(id)` | Anyone | Read project stats |
| `get_donor_stats(donor)` | Anyone | Read donor stats + badge |
| `get_badge(donor)` | Anyone | Get current badge tier |
| `get_global_total()` | Anyone | Total XLM raised platform-wide |
| `get_global_co2()` | Anyone | Total CO₂ offset in grams |
| `get_donation_count()` | Anyone | Total donations recorded |

## Badge Tiers

| Badge | Emoji | Threshold |
|-------|-------|-----------|
| Seedling | 🌱 | ≥ 10 XLM |
| Tree | 🌳 | ≥ 100 XLM |
| Forest | 🌲 | ≥ 500 XLM |
| Earth Guardian | 🌍 | ≥ 2,000 XLM |

## Build & Test

```bash
cargo build --target wasm32-unknown-unknown --release
cargo test
```

## Deploy

```bash
chmod +x ../../scripts/deploy-contract.sh
../../scripts/deploy-contract.sh testnet alice
```

## Register a Project

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source alice \
  --network testnet \
  -- register_project \
  --admin <ADMIN_ADDRESS> \
  --project_id "amazon-001" \
  --name "Amazon Reforestation" \
  --wallet <PROJECT_WALLET> \
  --co2_per_xlm 8500
```

`co2_per_xlm` = estimated grams of CO₂ offset per XLM donated (8,500 ≈ 8.5 kg per XLM).
Must be ≤ `MAX_CO2_PER_XLM` (10_000_000 g/XLM); values above that are rejected at registration.
See [`SECURITY.md`](SECURITY.md#accumulator-bounds-at-max_co2_per_xlm) for formal overflow horizons.

## Storage choice for future contributors

GreenPay uses two Soroban storage types. When adding a new `DataKey` variant,
pick the correct one:

| Storage type | Use for | Examples |
| --- | --- | --- |
| **Instance** | Small, contract-wide configuration with a single shared TTL/footprint. Loaded on every invocation. | `Admin`, `ProjectCount`, `DonationCount`, `GlobalTotalRaised`, `GlobalCO2OffsetGrams`, `AllowedToken(Address)` |
| **Persistent** | Per-entity records that grow unbounded (per project/donor/proposal). Each key has its own TTL. | `Project(String)`, `DonorStats(Address)`, `ImpactNFT(Address, BadgeTier)`, `HasDonated(String, Address)`, `Proposal(String)`, `HasVoted(String, Address)` |

**Rule of thumb:** if the key contains a `String` project id or an `Address`
donor/voter, it is per-entity and belongs in **persistent** storage. If it is a
single global scalar (admin, counter, allowlist), it belongs in **instance**
storage.

Per-entity persistent entries must be accessed through the helpers in
[`src/lib.rs`](src/lib.rs):

- `read_persistent(env, key)` — reads, lazily migrates a legacy v1 instance
  entry, and extends the key's TTL.
- `write_persistent(env, key, val)` — writes and extends the key's TTL.
- `has_persistent(env, key)` — checks existence (also sees legacy instance
  entries) and extends the key's TTL.

Never call `env.storage().instance()` for a per-entity key: it inflates the
shared instance footprint on every invocation and eventually hits the hard
ledger-entry size ceiling. TTL extension is automatic on every read/write via
`extend_persistent_ttl` (`PERSISTENT_TTL_THRESHOLD` / `PERSISTENT_TTL_EXTEND`).

## Roadmap

- **v1.3** — Impact NFT minting on badge achievement
- **v2.1** — DAO governance voting for project verification
