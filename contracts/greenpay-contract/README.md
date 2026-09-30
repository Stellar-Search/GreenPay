# GreenPay Soroban Contract

This Soroban smart contract provides **on-chain transparency** for every climate donation on Stellar GreenPay.

## What it does

Every donation is recorded permanently on Stellar. Anyone can query project totals, donor statistics, and donation badge tiers. Environmental outcomes are separate evidence-backed project claims; approved verifiers anchor their canonical SHA-256 values and revocations in this contract.

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
| `get_global_co2()` | Anyone | Deprecated compatibility accumulator (new donations do not update it) |
| `get_donation_count()` | Anyone | Total donations recorded |
| `set_impact_verifier(admin, verifier, approved)` | Admin | Manage independent impact verifiers |
| `anchor_impact_attestation(verifier, claim_id, hash, expires_at)` | Approved verifier | Anchor a canonical claim SHA-256 |
| `verify_impact_attestation(claim_id, expected_hash)` | Anyone | Check hash, expiry and revocation state |
| `revoke_impact_attestation(caller, claim_id, reason_hash)` | Verifier/admin | Permanently mark an attestation withdrawn |
| `get_impact_attestation(claim_id)` | Anyone | Read the historical anchor and current status |
| `set_dao_contract(admin, dao)` | Admin | Register the DAO contract for project verification (Issue #112) |
| `get_dao_contract()` | Anyone | Get the registered DAO contract address |
| `verify_project(caller, project_id)` | DAO contract only | Mark a project as DAO-verified; must be called via `dao-governance-contract.execute_proposal` |

## Impact Badge NFTs

Every earned badge is minted as a **real non-fungible token** on the Stellar
blockchain, not just an internal flag. Each badge is a distinct token with a
stable `u32` token id, an owner, and full on-chain metadata (tier, total
donated at mint, and the ledger it was minted on), so wallets, explorers, and
marketplaces can discover, display, and let donors transfer their badges.

The contract implements a minimal NFT interface in the spirit of SEP-41 (the
Soroban Token Interface), with NFT-style operations because each badge is
non-fungible:

| Function | Description |
|----------|-------------|
| `name()` | Collection name (`GreenPay Impact Badge`) |
| `symbol()` | Collection symbol (`GPB`) |
| `decimals()` | Always `0` (badges are indivisible) |
| `total_supply()` | Total badge tokens minted |
| `balance_of(owner)` | Number of badge tokens `owner` holds |
| `owner_of(token_id)` | Address currently owning `token_id` |
| `tokens_of(owner)` | Token ids held by `owner` |
| `token_metadata(token_id)` | Full on-chain metadata (`ImpactNFT`) |
| `token_tier(token_id)` | Badge tier of `token_id` |
| `get_token_id(donor, tier)` | Token id for a donor's badge, if minted |
| `transfer(from, to, token_id)` | Transfer a badge to a new owner (owner-only) |
| `mint_impact_nft(donor, tier)` | Mint the donor's badge on demand (auto-mint in `donate()` normally covers this) |
| `has_nft(donor, tier)` | Whether `donor` holds a badge for `tier` |

Tokens are minted automatically in `donate()` when a donor reaches a new tier.
Badges minted before the interface existed (legacy `ImpactNFT` markers) are
backfilled into the token registry on first query, so they stay discoverable
and transferable. Transferring a badge does **not** change the donor's badge
tier — `get_badge`/`get_donor_stats` reflect giving history, while the badge
token is a portable collectible.

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
  --co2_per_xlm 0
```

`co2_per_xlm` is a deprecated ABI parameter and should be `0`. It remains in
`register_project` so deployed clients can upgrade without an incompatible
signature change. `donate` does not read it and the compatibility
`get_global_co2` accumulator is not updated by new donations. Publish outcome
claims through the evidence API and anchor their canonical hashes instead.

## Storage choice for future contributors

GreenPay uses two Soroban storage types. When adding a new `DataKey` variant,
pick the correct one:

| Storage type | Use for | Examples |
| --- | --- | --- |
| **Instance** | Small, contract-wide configuration with a single shared TTL/footprint. Loaded on every invocation. | `Admin`, `ProjectCount`, `DonationCount`, `GlobalTotalRaised`, deprecated `GlobalCO2OffsetGrams`, `AllowedToken(Address)`, `NftCount` |
| **Persistent** | Per-entity records that grow unbounded (per project/donor/proposal/token/claim). Each key has its own TTL. | `Project(String)`, `DonorStats(Address)`, `ImpactNFT(Address, BadgeTier)`, `HasDonated(String, Address)`, `Proposal(String)`, `HasVoted(String, Address)`, `NftMeta(u32)`, `NftOwnerTokens(Address)`, `ImpactVerifier(Address)`, `ImpactAttestation(String)` |

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

- **v1.3** — Impact NFT minting on badge achievement ✅ (implemented — badges are real, transferable NFT tokens via the SEP-41-inspired interface; see [Impact Badge NFTs](#impact-badge-nfts))
- **v2.1** — DAO governance voting for project verification ✅ (implemented — see [ARCHITECTURE.md](../ARCHITECTURE.md))
