#![no_std]
#[cfg(all(test, feature = "testutils"))]
mod badge_property_tests;
#[cfg(all(test, feature = "testutils"))]
mod fuzz_tests;
#[cfg(all(test, feature = "testutils"))]
mod overflow_property_tests;

/**
 * contracts/greenpay-contract/src/lib.rs
 *
 * Stellar GreenPay — Climate Donation Tracking Contract
 *
 * This contract provides on-chain transparency for every donation:
 *
 *   1. Admin registers verified climate projects on-chain
 *   2. Donors call donate() — XLM sent directly to project wallet
 *   3. Contract records every donation immutably
 *   4. Independent verifiers anchor hashes of evidence-backed impact claims
 *   5. Anyone can check an attestation hash and its revocation state
 *   6. Impact badges auto-calculated based on cumulative donor totals
 *   7. Community governance: badge holders vote to verify new projects
 *
 * Build:
 *   cargo build --target wasm32-unknown-unknown --release
 *
 * Deploy:
 *   stellar contract deploy \
 *     --wasm target/wasm32-unknown-unknown/release/greenpay_contract.wasm \
 *     --source alice --network testnet
 */
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, BytesN, Env, IntoVal,
    String, TryFromVal, Val, Vec,
};

// ─── Badge tiers (on-chain) ───────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum BadgeTier {
    None,
    Seedling,      // ≥ 10 XLM
    Tree,          // ≥ 100 XLM
    Forest,        // ≥ 500 XLM
    EarthGuardian, // ≥ 2000 XLM
}

// ─── Data structures ──────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub wallet: Address,
    /// Deprecated ABI field. Donations no longer derive outcomes from it.
    pub co2_per_xlm: u32,
    pub total_raised: i128,
    pub donor_count: u32,
    pub active: bool,
    pub registered_at: u32,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct DonationRecord {
    pub donor: Address,
    pub project: String,
    pub amount: i128,
    pub ledger: u32,
    pub message_hash: u32,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct DonorStats {
    pub total_donated: i128,
    pub donation_count: u32,
    pub badge: BadgeTier,
    pub co2_offset_grams: i128,
}

/// Hash-only on-chain record for an off-chain environmental impact claim.
///
/// The canonical claim payload (quantity range, unit, methodology, baseline,
/// measurement period, asserting party and evidence hashes) remains in the
/// public API. Storing its SHA-256 here lets a donor prove the payload has not
/// changed since an approved verifier attested it, without putting documents
/// or personally identifying metadata on-chain.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ImpactAttestation {
    pub claim_id: String,
    pub attestation_hash: BytesN<32>,
    pub verifier: Address,
    pub anchored_at: u64,
    pub expires_at: u64,
    pub revoked: bool,
    pub revoked_at: u64,
    /// All-zero until revoked; `revoked` disambiguates that sentinel.
    pub revocation_reason_hash: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct ImpactNFT {
    pub owner: Address,
    pub tier: BadgeTier,
    pub total_donated: i128,
    pub minted_at_ledger: u32,
}

/// A community voting proposal to verify a project.
///
/// Vote weights use `i128` to accumulate `total_donated` values (stored in
/// stroops) without overflow risk.  A voter contributing 2 000 XLM
/// (EarthGuardian) supplies 2 000 × 10_000_000 = 2×10¹⁰ weight units, still
/// orders of magnitude below i128::MAX even across thousands of voters.
#[contracttype]
#[derive(Clone, Debug)]
pub struct VoteProposal {
    pub project_id: String,
    /// Sum of `total_donated` (stroops) of all voters who approved.
    pub votes_for: i128,
    /// Sum of `total_donated` (stroops) of all voters who rejected.
    pub votes_against: i128,
    pub deadline_ledger: u32,
    pub resolved: bool,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct MigrationState {
    pub target_version: u32,
    pub cursor: u32,
    pub total_items: u32,
    pub completed: bool,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ProjectV1 {
    pub id: String,
    pub name: String,
    pub wallet: Address,
    pub co2_per_xlm: u32,
    pub total_raised: i128,
    pub donor_count: u32,
    pub active: bool,
    pub registered_at: u32,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Version,
    MigrationState,
    Project(String),
    ProjectCount,
    DonorStats(Address),
    ImpactNFT(Address, BadgeTier),
    DonationCount,
    GlobalTotalRaised,
    GlobalCO2OffsetGrams,
    // Tracks whether `donor` has ever donated to `project` — used so
    // `Project.donor_count` reflects unique donors instead of donations.
    HasDonated(String, Address),
    // Governance
    Proposal(String),
    HasVoted(String, Address),
    AllowedToken(Address),
    // DAO integration: the registered dao-governance-contract address.
    // Set once by admin via `set_dao_contract`; only that address may call
    // `verify_project` directly (bypassing the legacy badge-holder voting).
    DaoContract,
    // Impact NFT token registry (SEP-41-inspired minimal NFT interface — see
    // `name`/`symbol`/`decimals`/`balance_of`/`owner_of`/`transfer`).
    // `NftCount` is a single contract-wide counter (instance storage); the
    // per-token and per-owner records grow unbounded and, like every other
    // per-entity key, live in persistent storage.
    NftCount,
    NftMeta(u32),
    NftOwnerTokens(Address),
    // Evidence-first impact accounting. Verifier entries and attestations are
    // persistent per-entity records so the registry cannot inflate instance
    // storage as it grows.
    ImpactVerifier(Address),
    ImpactAttestation(String),
    // Emergency pause flag — when true, fund-moving functions are blocked.
    Paused,
}

// ─── Constants ────────────────────────────────────────────────────────────────

pub const CONTRACT_VERSION: u32 = 1;
pub const STROOP: i128 = 10_000_000;

/// Compatibility bound on the deprecated `co2_per_xlm` registration field.
/// Evidence-first builds do not read this value in `donate`; the cap remains
/// so an emergency rollback to an older ABI cannot encounter an unbounded
/// administrator-supplied multiplier.
/// | `GlobalTotalRaised` | i128 | `i128::MAX` stroops total (e.g. 1-stroop donations) | No (needs > u32::MAX txs) |
/// | `GlobalTotalRaised` @ u32::MAX | i128 | `u32::MAX` × (`i128::MAX` / `u32::MAX`) stroops/donation | Theoretical per-invocation bound |
/// | `DonationCount` | u32 | `u32::MAX + 1` successful donations | Yes |
/// | `Project.donor_count` | u32 | `u32::MAX + 1` unique donors to one project | Yes |
pub const MAX_CO2_PER_XLM: u32 = STROOP as u32;

/// Largest single donation exercised in property tests (1 billion XLM).
pub const MAX_REALISTIC_DONATION_STROOPS: i128 = 1_000_000_000 * STROOP;

// ─── Badge threshold constants (XLM) ──────────────────────────────────────────
// These constants define the minimum cumulative XLM required to earn each badge tier.
// Parity with the backend (`backend/src/services/store.js`'s `BADGE_THRESHOLDS`) is
// cross-checked by automated tests (`backend/src/services/badgeCrossValidation.test.js`).
pub const BADGE_THRESHOLD_SEEDLING_XLM: i128 = 10;
pub const BADGE_THRESHOLD_TREE_XLM: i128 = 100;
pub const BADGE_THRESHOLD_FOREST_XLM: i128 = 500;
pub const BADGE_THRESHOLD_EARTH_GUARDIAN_XLM: i128 = 2000;

/// Minimum `total_donated` (in stroops) required to participate in
/// project-verification voting.
///
/// # Sybil-resistance rationale
///
/// The legacy Seedling threshold (10 XLM) allowed an attacker to acquire
/// voting weight for ~$1–3 per address.  Raising the eligibility bar to
/// 100 XLM (Tree tier) increases the per-Sybil cost by 10× while keeping
/// genuine community donors eligible.  Combined with *weighting* every vote
/// by the voter's `total_donated` value, a single large donor now
/// economically outweighs many minimum-threshold Sybil accounts:
///
///   • 1 address with 2 000 XLM (EarthGuardian) contributes 2 000 × STROOP
///     weight units.
///   • 20 Sybil addresses each at exactly 100 XLM contribute only
///     20 × 100 × STROOP = 2 000 × STROOP — a tie rather than a win.
///
/// Cost-of-attack at the Tree threshold (100 XLM ≈ $10–30 at typical XLM
/// prices): to out-vote a single 2 000 XLM donor, an attacker must deploy more
/// than 20 funded addresses, costing more than 2 000 XLM — identical to simply
/// being a large donor, eliminating the asymmetric advantage of Sybil
/// identities.
pub const VOTE_ELIGIBILITY_STROOP: i128 = BADGE_THRESHOLD_TREE_XLM * STROOP; // 100 XLM (Tree tier)

// 7 days × 24 h × 3600 s ÷ 5 s per ledger ≈ 120_960 ledgers — used as the
// default when `create_proposal` is called without an explicit duration.
const VOTING_WINDOW_LEDGERS: u32 = 120_960;

// Bounds on caller-supplied voting durations. Floor (~1 hour) keeps the
// window long enough to be observed; ceiling (~30 days) bounds storage TTL
// pressure and prevents proposals from sitting open indefinitely.
const MIN_VOTING_WINDOW_LEDGERS: u32 = 720; // 1 hour @ 5s/ledger
const MAX_VOTING_WINDOW_LEDGERS: u32 = 518_400; // 30 days @ 5s/ledger

// ─── Persistent storage TTL ───────────────────────────────────────────────────

/// Minimum remaining TTL (ledgers) below which per-entity persistent entries
/// are extended. Mirrors dao-governance-contract's 7-day threshold so entries
/// that are actively used never risk expiring.
const PERSISTENT_TTL_THRESHOLD: u32 = VOTING_WINDOW_LEDGERS;

/// Target TTL (ledgers) per-entity persistent entries are extended to.
/// 4 years × 365 days × 24 h × 3600 s ÷ 5 s per ledger — matches
/// dao-governance-contract's `MAX_LOCK_LEDGERS`.
const PERSISTENT_TTL_EXTEND: u32 = 2_102_400;

fn calculate_badge(total_stroops: i128) -> BadgeTier {
    let xlm = total_stroops / STROOP;
    if xlm >= BADGE_THRESHOLD_EARTH_GUARDIAN_XLM {
        BadgeTier::EarthGuardian
    } else if xlm >= BADGE_THRESHOLD_FOREST_XLM {
        BadgeTier::Forest
    } else if xlm >= BADGE_THRESHOLD_TREE_XLM {
        BadgeTier::Tree
    } else if xlm >= BADGE_THRESHOLD_SEEDLING_XLM {
        BadgeTier::Seedling
    } else {
        BadgeTier::None
    }
}

/// Returns the vote weight for a donor whose `total_donated` (in stroops) is
/// `total_donated`.
///
/// Weight equals the donor's cumulative `total_donated` value (stroops), so a
/// voter who has donated twice as much always carries twice the vote weight.
/// Donors below the Tree tier (< 100 XLM / `VOTE_ELIGIBILITY_STROOP`) are
/// ineligible and receive weight 0; callers must reject them before counting.
///
/// # Overflow analysis
/// `total_donated` is bounded by the `DonationCount` u32 counter ×
/// `MAX_REALISTIC_DONATION_STROOPS` (1 billion XLM = 10¹⁶ stroops).  Even
/// at u32::MAX donations of 1 billion XLM each the product would exceed i128
/// capacity, but `DonationCount` is a u32 so the aggregate is safely within
/// i128 for any realistic scenario.  The `VoteProposal.votes_for/against`
/// accumulators use `checked_add` to surface any theoretical overflow.
fn vote_weight_for_donor(total_donated: i128) -> i128 {
    if total_donated < VOTE_ELIGIBILITY_STROOP {
        0
    } else {
        total_donated
    }
}
//
// Per-entity records (Project, DonorStats, ImpactNFT, HasDonated, Proposal,
// HasVoted) live in *persistent* storage, not instance storage. Instance storage
// shares a single TTL/footprint with the contract instance — it is documented
// by Soroban as suitable only for small, contract-wide configuration (Admin,
// counters, AllowedToken allowlist). Storing per-entity records there inflates
// the instance footprint on every invocation and eventually hits the hard
// ledger-entry size ceiling. Persistent storage gives each per-entity key its
// own TTL, so adding thousands of projects/donors never grows the shared
// footprint.
//
// The helpers below also implement a lazy migration from the legacy v1 layout
// (per-entity entries in instance storage). On first access to a per-entity key,
// if a value exists in instance storage it is atomically copied to persistent
// storage and removed from instance storage (Soroban rolls back all state
// changes if the invocation panics, so the migration cannot lose data).

/// Read a per-entity value from persistent storage, transparently migrating a
/// legacy v1 instance-storage entry on first access, and extend its TTL.
fn read_persistent<K, V>(env: &Env, key: &K) -> Option<V>
where
    K: IntoVal<Env, Val>,
    V: TryFromVal<Env, Val> + IntoVal<Env, Val>,
    V::Error: core::fmt::Debug,
{
    let storage = env.storage();

    // 1. Fresh persistent entry — read and extend TTL.
    if storage.persistent().has(key) {
        let val: V = storage
            .persistent()
            .get(key)
            .expect("persistent entry disappeared");
        extend_persistent_ttl(env, key);
        return Some(val);
    }

    // 2. Legacy v1 instance-storage entry — migrate to persistent storage.
    if storage.instance().has(key) {
        let val: V = storage
            .instance()
            .get(key)
            .expect("legacy instance entry disappeared");
        storage.persistent().set(key, &val);
        storage.instance().remove(key);
        extend_persistent_ttl(env, key);
        return Some(val);
    }

    None
}

/// Write a per-entity value to persistent storage and extend its TTL.
fn write_persistent<K, V>(env: &Env, key: &K, val: &V)
where
    K: IntoVal<Env, Val>,
    V: IntoVal<Env, Val>,
{
    env.storage().persistent().set(key, val);
    extend_persistent_ttl(env, key);
}

/// Check whether a per-entity key exists in persistent storage (or as a legacy
/// v1 instance-storage entry). Persistent entries have their TTL extended;
/// legacy entries are migrated by the next read.
fn has_persistent<K>(env: &Env, key: &K) -> bool
where
    K: IntoVal<Env, Val>,
{
    let storage = env.storage();
    if storage.persistent().has(key) {
        extend_persistent_ttl(env, key);
        return true;
    }
    storage.instance().has(key)
}

/// Extend the TTL of a persistent entry if it falls below the threshold.
fn extend_persistent_ttl<K>(env: &Env, key: &K)
where
    K: IntoVal<Env, Val>,
{
    env.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
}

// ─── Impact NFT registry ─────────────────────────────────────────────────────
//
// Every minted badge is a real, independently-addressable non-fungible token
// identified by a monotonically increasing `u32` token id. Three pieces of
// storage make the token discoverable through the standard NFT interface
// (`name`/`symbol`/`decimals`/`balance_of`/`owner_of`/`transfer`):
//
//   `DataKey::NftCount`                  — total minted; also the next id (1-based).
//   `DataKey::NftMeta(u32)`              — canonical per-token metadata (owner +
//                                          badge provenance: tier, total_donated
//                                          at mint, minted_at_ledger).
//   `DataKey::NftOwnerTokens(Address)`   — ownership index (ids owned by `Address`).
//
// The legacy `DataKey::ImpactNFT(Address, BadgeTier)` entry is still written on
// mint (it is the pre-interface layout that `has_nft` used to read) and is
// lazily backfilled into the registry on first query, so badges minted before
// this interface existed remain visible to `balance_of`, `owner_of`, and
// `transfer`.

/// Create a new badge token for `donor` at `tier` and return its token id.
///
/// Registers the metadata, updates the owner's token index, and keeps the
/// legacy `ImpactNFT(donor, tier)` marker in sync so pre-interface readers
/// (and `has_nft`) keep working.
fn mint_badge_token(
    env: &Env,
    donor: &Address,
    tier: &BadgeTier,
    total_donated: i128,
    minted_at_ledger: u32,
) -> u32 {
    let count: u32 = env
        .storage()
        .instance()
        .get(&DataKey::NftCount)
        .unwrap_or(0);
    let token_id = count.checked_add(1).expect("NFT token id overflow");
    env.storage().instance().set(&DataKey::NftCount, &token_id);

    let meta = ImpactNFT {
        owner: donor.clone(),
        tier: tier.clone(),
        total_donated,
        minted_at_ledger,
    };
    write_persistent(env, &DataKey::NftMeta(token_id), &meta);
    write_persistent(env, &DataKey::ImpactNFT(donor.clone(), tier.clone()), &meta);

    let mut owned: Vec<u32> = read_persistent(env, &DataKey::NftOwnerTokens(donor.clone()))
        .unwrap_or_else(|| Vec::new(env));
    owned.push_back(token_id);
    write_persistent(env, &DataKey::NftOwnerTokens(donor.clone()), &owned);

    token_id
}

/// Resolve the token id for a `(donor, tier)` badge, or `None`.
///
/// Checks the ownership index first so the answer stays correct after a
/// transfer. If the badge only exists as a legacy `ImpactNFT(donor, tier)`
/// marker (pre-interface layout), it is transparently backfilled into the
/// token registry and the new token id is returned.
fn find_token_id(env: &Env, donor: &Address, tier: &BadgeTier) -> Option<u32> {
    let owned_opt: Option<Vec<u32>> = read_persistent(env, &DataKey::NftOwnerTokens(donor.clone()));
    if let Some(owned) = owned_opt {
        for id in owned.iter() {
            let meta: ImpactNFT =
                read_persistent(env, &DataKey::NftMeta(id)).expect("owned token metadata missing");
            if &meta.tier == tier {
                return Some(id);
            }
        }
    }
    if has_persistent(env, &DataKey::ImpactNFT(donor.clone(), tier.clone())) {
        let meta: ImpactNFT =
            read_persistent(env, &DataKey::ImpactNFT(donor.clone(), tier.clone()))
                .expect("legacy NFT marker disappeared");
        return Some(mint_badge_token(
            env,
            donor,
            tier,
            meta.total_donated,
            meta.minted_at_ledger,
        ));
    }
    None
}

/// Read the ownership index for `owner` (empty when no entry exists).
fn owned_token_ids(env: &Env, owner: &Address) -> Vec<u32> {
    read_persistent(env, &DataKey::NftOwnerTokens(owner.clone())).unwrap_or_else(|| Vec::new(env))
}

/// Backfill any pre-interface badges owned by `owner` into the token registry
/// (at most one badge per tier — the four known tiers).
fn backfill_legacy_badges(env: &Env, owner: &Address) {
    for tier in [
        BadgeTier::Seedling,
        BadgeTier::Tree,
        BadgeTier::Forest,
        BadgeTier::EarthGuardian,
    ] {
        find_token_id(env, owner, &tier);
    }
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct GreenPayContract;

#[contractimpl]
impl GreenPayContract {
    // ─── Initialization ──────────────────────────────────────────────────────

    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Contract already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::Version, &CONTRACT_VERSION);
        env.storage().instance().set(&DataKey::ProjectCount, &0u32);
        env.storage().instance().set(&DataKey::DonationCount, &0u32);
        env.storage()
            .instance()
            .set(&DataKey::GlobalTotalRaised, &0i128);
        env.storage()
            .instance()
            .set(&DataKey::GlobalCO2OffsetGrams, &0i128);
        env.storage().instance().set(&DataKey::Paused, &false);
    }

    // ─── Emergency pause ────────────────────────────────────────────────────

    pub fn pause(env: Env, admin: Address) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        if stored_admin != admin {
            panic!("Only admin can pause");
        }
        env.storage().instance().set(&DataKey::Paused, &true);
    }

    pub fn unpause(env: Env, admin: Address) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        if stored_admin != admin {
            panic!("Only admin can unpause");
        }
        env.storage().instance().set(&DataKey::Paused, &false);
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    fn require_not_paused(env: &Env) {
        let paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false);
        if paused {
            panic!("Contract is paused");
        }
    }

    /// Exposes the contract's current schema version to off-chain consumers and scripts.
    pub fn get_version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Version)
            .unwrap_or(1u32)
    }

    /// Alias for get_version.
    pub fn version(env: Env) -> u32 {
        Self::get_version(env)
    }

    // ─── Token allowlist ──────────────────────────────────────────────────────

    pub fn allow_token(env: Env, admin: Address, token: Address) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        if stored_admin != admin {
            panic!("Only admin can manage tokens");
        }
        env.storage()
            .instance()
            .set(&DataKey::AllowedToken(token), &true);
    }

    pub fn remove_token(env: Env, admin: Address, token: Address) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        if stored_admin != admin {
            panic!("Only admin can manage tokens");
        }
        env.storage()
            .instance()
            .remove(&DataKey::AllowedToken(token));
    }

    // ─── Project management ───────────────────────────────────────────────────

    pub fn register_project(
        env: Env,
        admin: Address,
        project_id: String,
        name: String,
        wallet: Address,
        co2_per_xlm: u32,
    ) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        if stored_admin != admin {
            panic!("Only admin can register projects");
        }
        if has_persistent(&env, &DataKey::Project(project_id.clone())) {
            panic!("Project already registered");
        }
        if co2_per_xlm > MAX_CO2_PER_XLM {
            panic!("co2_per_xlm exceeds maximum allowed");
        }
        let project = Project {
            id: project_id.clone(),
            name,
            wallet,
            co2_per_xlm,
            total_raised: 0,
            donor_count: 0,
            active: true,
            registered_at: env.ledger().sequence(),
        };
        write_persistent(&env, &DataKey::Project(project_id.clone()), &project);
        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ProjectCount)
            .unwrap_or(0);
        let next_count = count.checked_add(1).expect("ProjectCount overflow");
        env.storage()
            .instance()
            .set(&DataKey::ProjectCount, &next_count);
        env.events()
            .publish((symbol_short!("proj_reg"), admin), project_id);
    }

    pub fn deactivate_project(env: Env, admin: Address, project_id: String) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        if stored_admin != admin {
            panic!("Only admin can deactivate projects");
        }
        let mut project: Project = read_persistent(&env, &DataKey::Project(project_id.clone()))
            .expect("Project not found");
        project.active = false;
        write_persistent(&env, &DataKey::Project(project_id), &project);
    }

    // ─── Donations ────────────────────────────────────────────────────────────

    pub fn donate(
        env: Env,
        token: Address,
        donor: Address,
        project_id: String,
        amount: i128,
        msg_hash: u32,
    ) {
        donor.require_auth();
        Self::require_not_paused(&env);
        if amount <= 0 {
            panic!("Donation amount must be positive");
        }

        if !env
            .storage()
            .instance()
            .has(&DataKey::AllowedToken(token.clone()))
        {
            panic!("Token is not supported");
        }

        let mut project: Project = read_persistent(&env, &DataKey::Project(project_id.clone()))
            .expect("Project not found");
        if !project.active {
            panic!("Project is not accepting donations");
        }

        let mut donor_stats: DonorStats =
            read_persistent(&env, &DataKey::DonorStats(donor.clone())).unwrap_or(DonorStats {
                total_donated: 0,
                donation_count: 0,
                badge: BadgeTier::None,
                co2_offset_grams: 0,
            });
        let prev_badge = donor_stats.badge.clone();

        // ── Effects: all state writes BEFORE the external token transfer
        //    (Checks-Effects-Interactions to defend against reentrancy from a
        //    malicious token contract passed via `token`).
        project.total_raised = project
            .total_raised
            .checked_add(amount)
            .expect("Project total_raised overflow");
        let donated_key = DataKey::HasDonated(project_id.clone(), donor.clone());
        if !has_persistent(&env, &donated_key) {
            write_persistent(&env, &donated_key, &true);
            project.donor_count = project
                .donor_count
                .checked_add(1)
                .expect("Project donor_count overflow");
        }
        write_persistent(&env, &DataKey::Project(project_id.clone()), &project);

        donor_stats.total_donated = donor_stats
            .total_donated
            .checked_add(amount)
            .expect("Donor total_donated overflow");
        donor_stats.donation_count = donor_stats
            .donation_count
            .checked_add(1)
            .expect("Donor donation_count overflow");
        // Environmental outcomes are project-level evidence claims, not a
        // deterministic side-effect of transferring XLM. The legacy field is
        // retained at zero for ABI compatibility; new impact is represented by
        // ImpactAttestation records below.
        donor_stats.co2_offset_grams = 0;
        donor_stats.badge = calculate_badge(donor_stats.total_donated);
        write_persistent(&env, &DataKey::DonorStats(donor.clone()), &donor_stats);

        // Auto-mint an Impact NFT when a donor reaches a new badge tier. The
        // mint registers the badge in the NFT token registry so it is
        // discoverable through the standard NFT interface (see
        // `balance_of`/`owner_of`/`transfer`), not just `has_nft`.
        if donor_stats.badge != BadgeTier::None
            && donor_stats.badge != prev_badge
            && find_token_id(&env, &donor, &donor_stats.badge).is_none()
        {
            mint_badge_token(
                &env,
                &donor,
                &donor_stats.badge,
                donor_stats.total_donated,
                env.ledger().sequence(),
            );
            env.events().publish(
                (symbol_short!("nft_mint"), donor.clone()),
                donor_stats.badge.clone(),
            );
        }

        let dc: u32 = env
            .storage()
            .instance()
            .get(&DataKey::DonationCount)
            .unwrap_or(0);
        let new_dc = dc.checked_add(1).expect("DonationCount overflow");
        env.storage()
            .instance()
            .set(&DataKey::DonationCount, &new_dc);

        let gr: i128 = env
            .storage()
            .instance()
            .get(&DataKey::GlobalTotalRaised)
            .unwrap_or(0);
        let new_gr = gr.checked_add(amount).expect("GlobalTotalRaised overflow");
        env.storage()
            .instance()
            .set(&DataKey::GlobalTotalRaised, &new_gr);

        // ── Interaction: external call happens after every effect is durable.
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&donor, &project.wallet, &amount);

        env.events().publish(
            (symbol_short!("donated"), donor, project_id),
            (amount, donor_stats.badge.clone(), msg_hash),
        );
    }

    // ─── Getters ─────────────────────────────────────────────────────────────

    pub fn get_project(env: Env, project_id: String) -> Project {
        read_persistent(&env, &DataKey::Project(project_id)).expect("Project not found")
    }

    pub fn get_donor_stats(env: Env, donor: Address) -> DonorStats {
        read_persistent(&env, &DataKey::DonorStats(donor)).unwrap_or(DonorStats {
            total_donated: 0,
            donation_count: 0,
            badge: BadgeTier::None,
            co2_offset_grams: 0,
        })
    }

    pub fn get_badge(env: Env, donor: Address) -> BadgeTier {
        let stats: DonorStats =
            read_persistent(&env, &DataKey::DonorStats(donor)).unwrap_or(DonorStats {
                total_donated: 0,
                donation_count: 0,
                badge: BadgeTier::None,
                co2_offset_grams: 0,
            });
        stats.badge
    }

    pub fn get_global_total(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::GlobalTotalRaised)
            .unwrap_or(0)
    }

    pub fn get_global_co2(env: Env) -> i128 {
        // Deprecated compatibility getter. Donation-derived environmental
        // accounting ended with the evidence-first claim model; this remains
        // frozen at its migration value (zero on new deployments).
        env.storage()
            .instance()
            .get(&DataKey::GlobalCO2OffsetGrams)
            .unwrap_or(0)
    }

    pub fn get_project_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::ProjectCount)
            .unwrap_or(0)
    }

    pub fn get_donation_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::DonationCount)
            .unwrap_or(0)
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized")
    }

    // ─── Environmental impact attestations ─────────────────────────────────

    /// Add or remove an independent verifier from the impact allowlist.
    pub fn set_impact_verifier(env: Env, admin: Address, verifier: Address, approved: bool) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        if stored_admin != admin {
            panic!("Only admin can manage impact verifiers");
        }
        let key = DataKey::ImpactVerifier(verifier.clone());
        if approved {
            write_persistent(&env, &key, &true);
        } else {
            env.storage().persistent().remove(&key);
            env.storage().instance().remove(&key);
        }
        env.events()
            .publish((symbol_short!("imp_ver"), verifier), approved);
    }

    pub fn is_impact_verifier(env: Env, verifier: Address) -> bool {
        read_persistent(&env, &DataKey::ImpactVerifier(verifier)).unwrap_or(false)
    }

    /// Anchor the SHA-256 of a canonical claim payload.
    ///
    /// A claim id is immutable: corrections create a new claim id and the old
    /// claim is revoked, so old certificates always resolve to their historical
    /// record instead of silently changing underneath the donor.
    pub fn anchor_impact_attestation(
        env: Env,
        verifier: Address,
        claim_id: String,
        attestation_hash: BytesN<32>,
        expires_at: u64,
    ) {
        verifier.require_auth();
        if !Self::is_impact_verifier(env.clone(), verifier.clone()) {
            panic!("Verifier is not approved");
        }
        if expires_at <= env.ledger().timestamp() {
            panic!("Attestation expiry must be in the future");
        }
        let key = DataKey::ImpactAttestation(claim_id.clone());
        if has_persistent(&env, &key) {
            panic!("Impact claim already anchored");
        }
        let record = ImpactAttestation {
            claim_id: claim_id.clone(),
            attestation_hash: attestation_hash.clone(),
            verifier: verifier.clone(),
            anchored_at: env.ledger().timestamp(),
            expires_at,
            revoked: false,
            revoked_at: 0,
            revocation_reason_hash: BytesN::from_array(&env, &[0u8; 32]),
        };
        write_persistent(&env, &key, &record);
        env.events().publish(
            (symbol_short!("imp_att"), verifier, claim_id),
            (attestation_hash, expires_at),
        );
    }

    /// Revoke a bad or withdrawn attestation without erasing its hash.
    /// The original verifier or the contract admin may perform the revocation.
    pub fn revoke_impact_attestation(
        env: Env,
        caller: Address,
        claim_id: String,
        reason_hash: BytesN<32>,
    ) {
        caller.require_auth();
        let key = DataKey::ImpactAttestation(claim_id.clone());
        let mut record: ImpactAttestation =
            read_persistent(&env, &key).expect("Impact attestation not found");
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        if caller != record.verifier && caller != admin {
            panic!("Only verifier or admin can revoke attestation");
        }
        if record.revoked {
            panic!("Impact attestation already revoked");
        }
        record.revoked = true;
        record.revoked_at = env.ledger().timestamp();
        record.revocation_reason_hash = reason_hash.clone();
        write_persistent(&env, &key, &record);
        env.events()
            .publish((symbol_short!("imp_rev"), caller, claim_id), reason_hash);
    }

    pub fn get_impact_attestation(env: Env, claim_id: String) -> ImpactAttestation {
        read_persistent(&env, &DataKey::ImpactAttestation(claim_id))
            .expect("Impact attestation not found")
    }

    /// True only while the stored hash is current, unrevoked and byte-for-byte
    /// equal to the hash independently calculated by the donor.
    pub fn verify_impact_attestation(
        env: Env,
        claim_id: String,
        expected_hash: BytesN<32>,
    ) -> bool {
        let record: Option<ImpactAttestation> =
            read_persistent(&env, &DataKey::ImpactAttestation(claim_id));
        match record {
            Some(value) => {
                !value.revoked
                    && value.expires_at > env.ledger().timestamp()
                    && value.attestation_hash == expected_hash
            }
            None => false,
        }
    }

    // ─── Impact NFT interface ─────────────────────────────────────────────────
    //
    // A minimal non-fungible-token interface in the spirit of SEP-41 (the
    // Soroban Token Interface). Unlike a fungible token, each minted badge is
    // a distinct, non-fungible token addressed by a `u32` token id, so the
    // interface exposes the NFT-style `owner_of` / `balance_of` / `transfer`
    // operations that wallets, explorers, and marketplaces expect. Metadata is
    // stored fully on-chain — see `token_metadata`. `mint_impact_nft` and
    // `has_nft` remain as the product-specific badge helpers; both delegate to
    // the same registry.

    /// Mint the donor's badge NFT for `tier` on demand (auto-mint in
    /// `donate` normally covers this). The minted badge is a real token in the
    /// NFT registry, so wallets and marketplaces can discover it.
    pub fn mint_impact_nft(env: Env, donor: Address, tier: BadgeTier) {
        donor.require_auth();
        if tier == BadgeTier::None {
            panic!("Cannot mint NFT for None tier");
        }

        let stats: DonorStats = read_persistent(&env, &DataKey::DonorStats(donor.clone()))
            .unwrap_or(DonorStats {
                total_donated: 0,
                donation_count: 0,
                badge: BadgeTier::None,
                co2_offset_grams: 0,
            });
        if stats.badge == BadgeTier::None {
            panic!("No badge tier reached yet");
        }
        if stats.badge != tier {
            panic!("Tier does not match donor's current badge");
        }
        if find_token_id(&env, &donor, &tier).is_some() {
            panic!("NFT already minted for this tier");
        }

        mint_badge_token(
            &env,
            &donor,
            &tier,
            stats.total_donated,
            env.ledger().sequence(),
        );
        env.events()
            .publish((symbol_short!("nft_mint"), donor), tier);
    }

    /// Whether `donor` holds a badge token for `tier`. Stays correct across
    /// transfers and sees pre-interface badges via the legacy backfill.
    pub fn has_nft(env: Env, donor: Address, tier: BadgeTier) -> bool {
        find_token_id(&env, &donor, &tier).is_some()
    }

    /// Collection name (SEP-41-style metadata).
    pub fn name(env: Env) -> String {
        String::from_str(&env, "GreenPay Impact Badge")
    }

    /// Collection symbol (SEP-41-style metadata).
    pub fn symbol(env: Env) -> String {
        String::from_str(&env, "GPB")
    }

    /// Decimals are 0: badge tokens are indivisible (SEP-41-style metadata).
    pub fn decimals(_env: Env) -> u32 {
        0
    }

    /// Number of badge tokens minted so far.
    pub fn total_supply(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::NftCount)
            .unwrap_or(0)
    }

    /// Number of badge tokens owned by `owner`. Pre-interface badges are
    /// counted too (lazy legacy backfill).
    pub fn balance_of(env: Env, owner: Address) -> u32 {
        backfill_legacy_badges(&env, &owner);
        owned_token_ids(&env, &owner).len()
    }

    /// Address currently owning `token_id`.
    pub fn owner_of(env: Env, token_id: u32) -> Address {
        let meta: ImpactNFT =
            read_persistent(&env, &DataKey::NftMeta(token_id)).expect("Token does not exist");
        meta.owner
    }

    /// Token ids owned by `owner`. Pre-interface badges are included via the
    /// lazy legacy backfill.
    pub fn tokens_of(env: Env, owner: Address) -> Vec<u32> {
        backfill_legacy_badges(&env, &owner);
        owned_token_ids(&env, &owner)
    }

    /// Full on-chain metadata for `token_id` (owner, tier, total_donated,
    /// minted_at_ledger).
    pub fn token_metadata(env: Env, token_id: u32) -> ImpactNFT {
        read_persistent(&env, &DataKey::NftMeta(token_id)).expect("Token does not exist")
    }

    /// Badge tier represented by `token_id` (convenience for display).
    pub fn token_tier(env: Env, token_id: u32) -> BadgeTier {
        let meta: ImpactNFT =
            read_persistent(&env, &DataKey::NftMeta(token_id)).expect("Token does not exist");
        meta.tier
    }

    /// Resolve the token id for a donor's `tier` badge, if minted. Works for
    /// pre-interface badges too (legacy backfill). Returns `None` when the
    /// badge has been transferred away or never minted.
    pub fn get_token_id(env: Env, donor: Address, tier: BadgeTier) -> Option<u32> {
        find_token_id(&env, &donor, &tier)
    }

    /// Transfer a badge token to a new owner. Only the current owner may
    /// transfer. Emits an `nft_xfr` event.
    pub fn transfer(env: Env, from: Address, to: Address, token_id: u32) {
        from.require_auth();
        if from == to {
            return;
        }
        let mut meta: ImpactNFT =
            read_persistent(&env, &DataKey::NftMeta(token_id)).expect("Token does not exist");
        if meta.owner != from {
            panic!("Only the token owner can transfer it");
        }
        // Materialize any pre-interface badges the recipient already owns so a
        // same-tier badge they earned themselves is never clobbered by the
        // legacy-marker move below.
        backfill_legacy_badges(&env, &to);
        let tier = meta.tier.clone();
        meta.owner = to.clone();
        write_persistent(&env, &DataKey::NftMeta(token_id), &meta);

        // Remove the token from the sender's ownership index.
        let mut from_tokens: Vec<u32> =
            read_persistent(&env, &DataKey::NftOwnerTokens(from.clone()))
                .expect("Sender does not own any tokens");
        let mut removed = false;
        for i in 0..from_tokens.len() {
            if from_tokens.get(i) == Some(token_id) {
                from_tokens.remove(i);
                removed = true;
                break;
            }
        }
        assert!(removed, "Sender does not own token");
        if from_tokens.is_empty() {
            env.storage()
                .persistent()
                .remove(&DataKey::NftOwnerTokens(from.clone()));
        } else {
            write_persistent(&env, &DataKey::NftOwnerTokens(from.clone()), &from_tokens);
        }

        // Add the token to the recipient's ownership index.
        let mut to_tokens: Vec<u32> = read_persistent(&env, &DataKey::NftOwnerTokens(to.clone()))
            .unwrap_or_else(|| Vec::new(&env));
        to_tokens.push_back(token_id);
        write_persistent(&env, &DataKey::NftOwnerTokens(to.clone()), &to_tokens);

        // Keep the legacy marker consistent so pre-interface readers of
        // `ImpactNFT(donor, tier)` (and `has_nft`) follow the new owner.
        env.storage()
            .persistent()
            .remove(&DataKey::ImpactNFT(from.clone(), tier.clone()));
        write_persistent(&env, &DataKey::ImpactNFT(to.clone(), tier.clone()), &meta);

        env.events()
            .publish((symbol_short!("nft_xfr"), from, to), token_id);
    }

    // ─── DAO Integration ──────────────────────────────────────────────────────

    /// Register the `dao-governance-contract` address so its `execute_proposal`
    /// can call `verify_project` on behalf of a passed DAO vote.
    ///
    /// May only be called by the contract admin. Can be called again later to
    /// point at an upgraded DAO contract (re-registering replaces the old
    /// address). Pass `None` to clear the registration and fall back to the
    /// legacy badge-holder voting path.
    pub fn set_dao_contract(env: Env, admin: Address, dao_contract: Option<Address>) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        if stored_admin != admin {
            panic!("Only admin can set DAO contract");
        }
        match dao_contract {
            Some(addr) => {
                env.storage().instance().set(&DataKey::DaoContract, &addr);
                env.events()
                    .publish((symbol_short!("dao_set"), admin), addr);
            }
            None => {
                env.storage().instance().remove(&DataKey::DaoContract);
                env.events().publish((symbol_short!("dao_clr"), admin), ());
            }
        }
    }

    /// Return the registered DAO contract address, or `None` if not set.
    pub fn get_dao_contract(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::DaoContract)
    }

    /// Mark a project as DAO-verified.
    ///
    /// **Authorization model (Issue #112 fix):**  
    /// This function may only be invoked by the registered
    /// `dao-governance-contract` (set via `set_dao_contract`). The DAO
    /// contract is expected to call this function as the *execution payload*
    /// of a `dao-governance-contract::execute_proposal` call — meaning the
    /// verification decision has already passed the DAO's full
    /// quorum/snapshot/timelock pipeline before reaching here.
    ///
    /// If no DAO contract is registered, this function panics. Use the legacy
    /// `create_proposal` / `vote_verify_project` / `resolve_proposal` path
    /// until the DAO contract address is set.
    ///
    /// # Calldata format expected by `dao-governance-contract::execute_proposal`
    ///
    /// The DAO's `Proposal` must target this contract with `function =
    /// Symbol::new("verify_project")` and `calldata` encoding the
    /// `project_id: String`. The DAO SDK encodes calldata as a single `Bytes`
    /// blob; on the DAO side a helper should encode the project ID before
    /// creating the proposal.
    pub fn verify_project(env: Env, caller: Address, project_id: String) {
        caller.require_auth();

        // Only the registered DAO contract may call this function.
        let dao_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::DaoContract)
            .expect("DAO contract not registered; call set_dao_contract first");
        if caller != dao_addr {
            panic!("Only the registered DAO contract can verify projects");
        }

        // Projects live in persistent storage (see read_persistent/
        // write_persistent); reading them through instance storage finds
        // nothing, so every call would fail with "Project not found".
        let mut project: Project = read_persistent(&env, &DataKey::Project(project_id.clone()))
            .expect("Project not found");
        if !project.active {
            panic!("Cannot verify an inactive project");
        }

        // Mark the project as DAO-verified by setting its active flag and
        // emitting a canonical event. Future callers of `get_project` can
        // inspect the `active` flag; a separate `verified` field can be added
        // in a storage-compatible upgrade if needed.
        project.active = true;
        write_persistent(&env, &DataKey::Project(project_id.clone()), &project);
        env.events()
            .publish((symbol_short!("dao_ver"), caller), project_id);
    }

    // ─── Legacy Governance (deprecated — superseded by DAO integration) ───────
    //
    // The functions below implement the original admin-controlled, badge-holder
    // 1-address-1-vote scheme for project verification. They are gated on the
    // absence of a registered DAO contract (set via `set_dao_contract`): as
    // soon as a DAO is registered the legacy path retires atomically —
    // `create_proposal` and `vote_verify_project` panic, so no new legacy
    // proposals or votes can be created. `resolve_proposal` deliberately stays
    // callable after cutover so that in-flight legacy proposals created before
    // registration can still be settled from the votes they already received;
    // it cannot be used to inject new votes.
    //
    // # Cutover / deprecation timeline
    //
    // 1. **Pre-DAO deployments**: legacy path is fully functional (as before).
    // 2. **Cutover**: admin calls `set_dao_contract(admin, Some(addr))`. From
    //    that ledger on, `create_proposal` and `vote_verify_project` refuse;
    //    in-flight legacy proposals are resolved via `resolve_proposal` from
    //    the votes already cast (their resolution path).
    // 3. **Retirement**: once all in-flight legacy proposals are resolved, the
    //    legacy functions (and their storage keys) are removed in the next
    //    upgrade. `resolve_proposal` is the last to go, after the last legacy
    //    proposal reaches a terminal state.
    //
    // Do NOT use these functions for new integrations — use `verify_project`
    // via a DAO `execute_proposal` call instead.

    /// **DEPRECATED** — use `verify_project` via DAO governance instead.
    ///
    /// Admin creates a voting proposal for a project to be community-verified.
    ///
    /// Refuses to run once a DAO contract is registered (see the section
    /// comment for the cutover rules).
    ///
    /// `duration_ledgers` is the length of the voting window in Stellar
    /// ledgers (≈5 s each). Pass `0` to use the default 7-day window;
    /// any other value must be within
    /// [`MIN_VOTING_WINDOW_LEDGERS`, `MAX_VOTING_WINDOW_LEDGERS`].
    pub fn create_proposal(env: Env, admin: Address, project_id: String, duration_ledgers: u32) {
        admin.require_auth();
        Self::require_not_paused(&env);
        if env.storage().instance().has(&DataKey::DaoContract) {
            panic!("DAO governance is active; legacy proposals are retired");
        }
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        if stored_admin != admin {
            panic!("Only admin can create proposals");
        }
        if !has_persistent(&env, &DataKey::Project(project_id.clone())) {
            panic!("Project not found");
        }
        if has_persistent(&env, &DataKey::Proposal(project_id.clone())) {
            panic!("Proposal already exists for this project");
        }

        let window = if duration_ledgers == 0 {
            VOTING_WINDOW_LEDGERS
        } else {
            if duration_ledgers < MIN_VOTING_WINDOW_LEDGERS {
                panic!("Voting duration too short");
            }
            if duration_ledgers > MAX_VOTING_WINDOW_LEDGERS {
                panic!("Voting duration too long");
            }
            duration_ledgers
        };
        let deadline_ledger = env
            .ledger()
            .sequence()
            .checked_add(window)
            .expect("Voting deadline overflow");

        let proposal = VoteProposal {
            project_id: project_id.clone(),
            votes_for: 0,
            votes_against: 0,
            deadline_ledger,
            resolved: false,
        };
        write_persistent(&env, &DataKey::Proposal(project_id.clone()), &proposal);
        env.events()
            .publish((symbol_short!("prop_new"), admin), (project_id, window));
    }

    /// **DEPRECATED** — use `verify_project` via DAO governance instead.
    ///
    /// Casts a **weighted** vote on a project-verification proposal.
    ///
    /// Refuses to run once a DAO contract is registered (see the section
    /// comment for the cutover rules).
    ///
    /// # Sybil resistance
    ///
    /// Vote weight equals the voter's cumulative `total_donated` value in
    /// stroops, so a donor who contributed 1 000 XLM carries 10× the weight
    /// of a donor who contributed 100 XLM.  The eligibility threshold is
    /// raised to `VOTE_ELIGIBILITY_STROOP` (100 XLM, Tree tier) — an
    /// attacker must spend 100 XLM *per Sybil address* rather than 10 XLM,
    /// and each address only contributes proportional weight, so the total
    /// cost to out-vote a large legitimate donor equals that donor's own
    /// stake.  One vote (of any weight) per address per proposal is still
    /// enforced to prevent double-counting.
    pub fn vote_verify_project(env: Env, voter: Address, project_id: String, approve: bool) {
        voter.require_auth();
        Self::require_not_paused(&env);
        if env.storage().instance().has(&DataKey::DaoContract) {
            panic!("DAO governance is active; legacy voting is retired");
        }

        let stats: DonorStats = read_persistent(&env, &DataKey::DonorStats(voter.clone()))
            .unwrap_or(DonorStats {
                total_donated: 0,
                donation_count: 0,
                badge: BadgeTier::None,
                co2_offset_grams: 0,
            });

        // Compute weight; rejects donors below the Tree-tier eligibility bar.
        let weight = vote_weight_for_donor(stats.total_donated);
        if weight == 0 {
            panic!("Insufficient donation stake to vote (Tree tier / 100 XLM minimum)");
        }

        let mut proposal: VoteProposal =
            read_persistent(&env, &DataKey::Proposal(project_id.clone()))
                .expect("Proposal not found");
        if proposal.resolved {
            panic!("Proposal already resolved");
        }
        if env.ledger().sequence() > proposal.deadline_ledger {
            panic!("Voting window has closed");
        }

        let voted_key = DataKey::HasVoted(project_id.clone(), voter.clone());
        if has_persistent(&env, &voted_key) {
            panic!("Already voted on this proposal");
        }
        write_persistent(&env, &voted_key, &true);

        if approve {
            proposal.votes_for = proposal
                .votes_for
                .checked_add(weight)
                .expect("votes_for overflow");
        } else {
            proposal.votes_against = proposal
                .votes_against
                .checked_add(weight)
                .expect("votes_against overflow");
        }
        write_persistent(&env, &DataKey::Proposal(project_id.clone()), &proposal);
        env.events()
            .publish((symbol_short!("voted"), voter, project_id), approve);
    }

    /// **DEPRECATED** — use `verify_project` via DAO governance instead.
    ///
    /// Callable by anyone after the deadline. Resolves based on weighted
    /// majority: `votes_for > votes_against` approves the project.
    /// Emits `proj_ver` on approval, `prop_rej` on rejection (including ties).
    ///
    /// Unlike `create_proposal` and `vote_verify_project`, this function
    /// deliberately remains callable after a DAO contract is registered: it is
    /// the documented resolution path for in-flight legacy proposals across
    /// the cutover. It only settles votes that were already cast — new votes
    /// are blocked by the gate on `vote_verify_project` — so it cannot inject
    /// new participation into a retired proposal.
    ///
    /// Requires that combined weight (`votes_for + votes_against`) is at least
    /// `VOTE_ELIGIBILITY_STROOP` (i.e. at least one eligible vote was cast)
    /// so a proposal with zero participation cannot silently self-approve.
    pub fn resolve_proposal(env: Env, project_id: String) {
        let mut proposal: VoteProposal =
            read_persistent(&env, &DataKey::Proposal(project_id.clone()))
                .expect("Proposal not found");
        if proposal.resolved {
            panic!("Proposal already resolved");
        }
        if env.ledger().sequence() <= proposal.deadline_ledger {
            panic!("Voting window not yet closed");
        }
        // Require at least one eligible vote to have been cast.
        let total_weight = proposal
            .votes_for
            .checked_add(proposal.votes_against)
            .expect("total weight overflow");
        if total_weight < VOTE_ELIGIBILITY_STROOP {
            panic!("Quorum not reached: no eligible votes cast");
        }
        proposal.resolved = true;
        if proposal.votes_for > proposal.votes_against {
            env.events()
                .publish((symbol_short!("proj_ver"),), project_id.clone());
        } else {
            env.events()
                .publish((symbol_short!("prop_rej"),), project_id.clone());
        }
        write_persistent(&env, &DataKey::Proposal(project_id), &proposal);
    }

    /// Returns current vote counts and status for a proposal.
    pub fn get_proposal(env: Env, project_id: String) -> VoteProposal {
        read_persistent(&env, &DataKey::Proposal(project_id)).expect("Proposal not found")
    }

    // ─── Upgrade & Migration ──────────────────────────────────────────────────

    /// Replaces the contract's WASM with a new hash.
    /// Only the admin (set at `initialize`) may call this.
    /// Emits an `upgraded` event containing the new hash.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        if stored_admin != admin {
            panic!("Only admin can upgrade");
        }
        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());
        env.events()
            .publish((symbol_short!("upgraded"), admin), new_wasm_hash);
    }

    /// Replaces contract WASM and initializes an incremental schema migration.
    /// Returns the number of un-migrated items remaining (0 when complete).
    pub fn upgrade_and_migrate(
        env: Env,
        admin: Address,
        new_wasm_hash: BytesN<32>,
        new_version: u32,
        batch_limit: u32,
    ) -> u32 {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        if stored_admin != admin {
            panic!("Only admin can upgrade");
        }
        let current_v = Self::get_version(env.clone());
        if new_version <= current_v {
            panic!("New version must be greater than current version");
        }
        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());
        env.events()
            .publish((symbol_short!("upgraded"), admin.clone()), new_wasm_hash);

        let total_projects: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ProjectCount)
            .unwrap_or(0);

        let state = MigrationState {
            target_version: new_version,
            cursor: 0,
            total_items: total_projects,
            completed: total_projects == 0,
        };

        if state.completed {
            env.storage()
                .instance()
                .set(&DataKey::Version, &new_version);
            env.storage()
                .instance()
                .set(&DataKey::MigrationState, &state);
            0
        } else {
            env.storage()
                .instance()
                .set(&DataKey::MigrationState, &state);
            Self::execute_migration_batch(&env, state, batch_limit)
        }
    }

    /// Executes the next batch of pending schema migrations.
    /// Returns the number of un-migrated items remaining (0 when complete).
    pub fn migrate_schema(env: Env, admin: Address, batch_limit: u32) -> u32 {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        if stored_admin != admin {
            panic!("Only admin can migrate");
        }
        let state: MigrationState = env
            .storage()
            .instance()
            .get(&DataKey::MigrationState)
            .expect("No pending migration");

        if state.completed {
            return 0;
        }

        Self::execute_migration_batch(&env, state, batch_limit)
    }

    /// Returns the current pending or completed migration state.
    pub fn get_migration_state(env: Env) -> Option<MigrationState> {
        env.storage().instance().get(&DataKey::MigrationState)
    }

    fn execute_migration_batch(env: &Env, mut state: MigrationState, batch_limit: u32) -> u32 {
        let batch_size = if batch_limit == 0 { 1 } else { batch_limit };
        let mut processed = 0u32;

        while processed < batch_size && state.cursor < state.total_items {
            state.cursor += 1;
            processed += 1;
        }

        if state.cursor >= state.total_items {
            state.completed = true;
            env.storage()
                .instance()
                .set(&DataKey::Version, &state.target_version);
        }
        env.storage()
            .instance()
            .set(&DataKey::MigrationState, &state);
        state.total_items.saturating_sub(state.cursor)
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate alloc;
    use super::*;
    use alloc::format;
    use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};
    use soroban_sdk::{
        testutils::{Address as _, Ledger as _},
        vec, Address, Env, String,
    };

    // ─── Existing tests ───────────────────────────────────────────────────────

    #[test]
    fn test_initialize() {
        let env = Env::default();
        let id = env.register_contract(None, GreenPayContract);
        let client = GreenPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        assert_eq!(client.get_admin(), admin);
        assert_eq!(client.get_project_count(), 0);
        assert_eq!(client.get_donation_count(), 0);
        assert_eq!(client.get_global_total(), 0);
        assert!(!client.is_paused());
    }

    #[test]
    fn test_impact_attestation_anchor_verify_and_revoke() {
        let (env, _cid, client, admin, _pid) = setup();
        let verifier = Address::generate(&env);
        let claim_id = String::from_str(&env, "claim-2026-001");
        let attestation_hash = BytesN::from_array(&env, &[7u8; 32]);
        let wrong_hash = BytesN::from_array(&env, &[8u8; 32]);
        let reason_hash = BytesN::from_array(&env, &[9u8; 32]);
        let expires_at = env.ledger().timestamp() + 86_400;

        client.set_impact_verifier(&admin, &verifier, &true);
        assert!(client.is_impact_verifier(&verifier));
        client.anchor_impact_attestation(&verifier, &claim_id, &attestation_hash, &expires_at);

        assert!(client.verify_impact_attestation(&claim_id, &attestation_hash));
        assert!(!client.verify_impact_attestation(&claim_id, &wrong_hash));
        let anchored = client.get_impact_attestation(&claim_id);
        assert_eq!(anchored.claim_id, claim_id);
        assert_eq!(anchored.attestation_hash, attestation_hash);
        assert_eq!(anchored.verifier, verifier);
        assert!(!anchored.revoked);

        client.revoke_impact_attestation(&verifier, &claim_id, &reason_hash);
        let revoked = client.get_impact_attestation(&claim_id);
        assert!(revoked.revoked);
        assert_eq!(revoked.revocation_reason_hash, reason_hash);
        assert!(!client.verify_impact_attestation(&claim_id, &attestation_hash));
    }

    #[test]
    #[should_panic(expected = "Verifier is not approved")]
    fn test_unapproved_impact_verifier_cannot_anchor() {
        let (env, _cid, client, _admin, _pid) = setup();
        let verifier = Address::generate(&env);
        client.anchor_impact_attestation(
            &verifier,
            &String::from_str(&env, "claim-unapproved"),
            &BytesN::from_array(&env, &[1u8; 32]),
            &(env.ledger().timestamp() + 100),
        );
    }

    #[test]
    #[should_panic(expected = "Contract already initialized")]
    fn test_double_init_fails() {
        let env = Env::default();
        let id = env.register_contract(None, GreenPayContract);
        let client = GreenPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        client.initialize(&admin);
    }

    // ─── Pause / emergency-stop tests ──────────────────────────────────────

    #[test]
    fn test_pause_and_unpause() {
        let (_env, _cid, client, admin, _pid) = setup();
        assert!(!client.is_paused());
        client.pause(&admin);
        assert!(client.is_paused());
        client.unpause(&admin);
        assert!(!client.is_paused());
    }

    #[test]
    #[should_panic(expected = "Only admin can pause")]
    fn test_pause_non_admin_fails() {
        let (env, _cid, client, _admin, _pid) = setup();
        let rando = Address::generate(&env);
        client.pause(&rando);
    }

    #[test]
    #[should_panic(expected = "Only admin can unpause")]
    fn test_unpause_non_admin_fails() {
        let (env, _cid, client, _admin, _pid) = setup();
        let rando = Address::generate(&env);
        client.unpause(&rando);
    }

    #[test]
    #[should_panic(expected = "Contract is paused")]
    fn test_donate_rejected_when_paused() {
        let (env, _cid, client, admin, pid) = setup();
        let donor = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        client.pause(&admin);
        client.donate(&token, &donor, &pid, &1000, &1u32);
    }

    #[test]
    fn test_donor_badge_none_below_threshold() {
        let env = Env::default();
        let id = env.register_contract(None, GreenPayContract);
        let client = GreenPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        let donor = Address::generate(&env);
        assert_eq!(client.get_badge(&donor), BadgeTier::None);
    }

    #[test]
    fn test_calculate_badge_thresholds() {
        assert_eq!(calculate_badge(0), BadgeTier::None);
        assert_eq!(calculate_badge(9 * STROOP), BadgeTier::None);
        assert_eq!(calculate_badge(10 * STROOP), BadgeTier::Seedling);
        assert_eq!(calculate_badge(99 * STROOP), BadgeTier::Seedling);
        assert_eq!(calculate_badge(100 * STROOP), BadgeTier::Tree);
        assert_eq!(calculate_badge(499 * STROOP), BadgeTier::Tree);
        assert_eq!(calculate_badge(500 * STROOP), BadgeTier::Forest);
        assert_eq!(calculate_badge(1999 * STROOP), BadgeTier::Forest);
        assert_eq!(calculate_badge(2000 * STROOP), BadgeTier::EarthGuardian);
        assert_eq!(calculate_badge(100000 * STROOP), BadgeTier::EarthGuardian);
    }

    /// Set up contract + SAC token for donation tests.
    fn setup_donation() -> (
        Env,
        soroban_sdk::Address,
        GreenPayContractClient<'static>,
        Address,
        String,
        soroban_sdk::Address,
        StellarAssetClient<'static>,
    ) {
        let (env, cid, client, admin, pid) = setup();
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin.clone())
            .address();
        let token_client = StellarAssetClient::new(&env, &token);

        client.allow_token(&admin, &token);

        (env, cid, client, admin, pid, token, token_client)
    }

    fn token_balance(env: &Env, token: &soroban_sdk::Address, account: &Address) -> i128 {
        TokenClient::new(env, token).balance(account)
    }

    fn mint_to(_env: &Env, token_client: &StellarAssetClient, donor: &Address, amount: i128) {
        token_client.mint(donor, &amount);
    }

    #[test]
    #[should_panic(expected = "Token is not supported")]
    fn test_donate_with_unsupported_token_panics() {
        let (env, _cid, client, _admin, pid) = setup();
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let donor = Address::generate(&env);
        client.donate(&token, &donor, &pid, &1000, &0u32);
    }

    // ─── Donation / overflow regression tests ─────────────────────────────────

    #[test]
    fn test_register_project_accepts_max_co2_per_xlm() {
        let (env, _cid, client, admin, _pid) = setup();
        let wallet = Address::generate(&env);
        let pid = String::from_str(&env, "max-co2");
        client.register_project(
            &admin,
            &pid,
            &String::from_str(&env, "Max CO2 Project"),
            &wallet,
            &MAX_CO2_PER_XLM,
        );
        assert_eq!(client.get_project(&pid).co2_per_xlm, MAX_CO2_PER_XLM);
    }

    #[test]
    #[should_panic(expected = "co2_per_xlm exceeds maximum allowed")]
    fn test_register_project_rejects_excessive_co2_per_xlm() {
        let (env, _cid, client, admin, _pid) = setup();
        let wallet = Address::generate(&env);
        let pid = String::from_str(&env, "bad-co2");
        client.register_project(
            &admin,
            &pid,
            &String::from_str(&env, "Bad CO2 Project"),
            &wallet,
            &(MAX_CO2_PER_XLM + 1),
        );
    }

    #[test]
    fn test_max_co2_per_xlm_mul_invariant_holds_at_i128_max_amount() {
        let xlm_units = i128::MAX / STROOP;
        xlm_units
            .checked_mul(MAX_CO2_PER_XLM as i128)
            .expect("bound proof: product must fit in i128");
    }

    #[test]
    fn test_donate_at_legacy_max_rate_does_not_create_impact() {
        let (env, _cid, client, admin, _pid, token, token_client) = setup_donation();
        let wallet = Address::generate(&env);
        let pid = String::from_str(&env, "max-co2-donate");
        client.register_project(
            &admin,
            &pid,
            &String::from_str(&env, "Stress"),
            &wallet,
            &MAX_CO2_PER_XLM,
        );
        let donor = Address::generate(&env);
        let amount = i128::MAX;
        mint_to(&env, &token_client, &donor, amount);
        client.donate(&token, &donor, &pid, &amount, &0u32);

        assert_eq!(client.get_project(&pid).total_raised, amount);
        assert_eq!(client.get_global_co2(), 0);
        assert_eq!(client.get_donor_stats(&donor).co2_offset_grams, 0);
    }

    #[test]
    fn test_donate_basic_flow_after_cei_reorder() {
        let (env, _cid, client, _admin, pid, token, token_client) = setup_donation();
        let donor = Address::generate(&env);
        let amount = 25 * STROOP;
        mint_to(&env, &token_client, &donor, amount);

        client.donate(&token, &donor, &pid, &amount, &42u32);

        let project = client.get_project(&pid);
        assert_eq!(project.total_raised, amount);
        assert_eq!(project.donor_count, 1);
        assert_eq!(client.get_global_total(), amount);
        assert_eq!(client.get_global_co2(), 0);
        assert_eq!(client.get_donor_stats(&donor).co2_offset_grams, 0);
        assert_eq!(client.get_donation_count(), 1);
        assert_eq!(token_balance(&env, &token, &donor), 0);
        assert_eq!(token_balance(&env, &token, &project.wallet), amount);
    }

    #[test]
    #[should_panic(expected = "Project total_raised overflow")]
    fn test_donate_total_raised_overflow_protected() {
        let (env, cid, client, _admin, pid, token, token_client) = setup_donation();
        let donor = Address::generate(&env);
        let amount = STROOP;
        mint_to(&env, &token_client, &donor, amount);

        env.as_contract(&cid, || {
            let mut project: Project = env
                .storage()
                .persistent()
                .get(&DataKey::Project(pid.clone()))
                .expect("project");
            project.total_raised = i128::MAX - (STROOP / 2);
            env.storage()
                .persistent()
                .set(&DataKey::Project(pid.clone()), &project);
        });

        client.donate(&token, &donor, &pid, &amount, &0u32);
    }

    #[test]
    fn test_donate_total_raised_overflow_rolls_back_state_and_token() {
        let (env, cid, client, _admin, pid, token, token_client) = setup_donation();
        let donor = Address::generate(&env);
        let amount = STROOP;
        mint_to(&env, &token_client, &donor, amount);

        env.as_contract(&cid, || {
            let mut project: Project = env
                .storage()
                .persistent()
                .get(&DataKey::Project(pid.clone()))
                .expect("project");
            project.total_raised = i128::MAX - (STROOP / 2);
            env.storage()
                .persistent()
                .set(&DataKey::Project(pid.clone()), &project);
        });

        let project_before = client.get_project(&pid);
        let global_before = client.get_global_total();
        let donor_balance_before = token_balance(&env, &token, &donor);
        let wallet_balance_before = token_balance(&env, &token, &project_before.wallet);

        let result = client.try_donate(&token, &donor, &pid, &amount, &0u32);
        assert!(result.is_err(), "donate must fail on total_raised overflow");

        assert_eq!(
            client.get_project(&pid).total_raised,
            project_before.total_raised
        );
        assert_eq!(client.get_global_total(), global_before);
        assert_eq!(client.get_donation_count(), 0);
        assert_eq!(token_balance(&env, &token, &donor), donor_balance_before);
        assert_eq!(
            token_balance(&env, &token, &project_before.wallet),
            wallet_balance_before
        );
    }

    #[test]
    #[should_panic(expected = "co2_per_xlm exceeds maximum allowed")]
    fn test_donate_co2_overflow_protected_at_registration() {
        let (env, _cid, client, admin, _pid, _token, _token_client) = setup_donation();
        let wallet = Address::generate(&env);
        let pid = String::from_str(&env, "proj-co2");
        // Pre-cap behaviour: u32::MAX co2 would allow mul overflow at donate-time.
        // With the register_project ceiling this is rejected before any donation path.
        client.register_project(
            &admin,
            &pid,
            &String::from_str(&env, "CO2 overflow"),
            &wallet,
            &u32::MAX,
        );
    }

    #[test]
    fn test_donate_does_not_touch_legacy_global_co2_accumulator() {
        let (env, cid, client, admin, _pid, token, token_client) = setup_donation();
        let wallet = Address::generate(&env);
        let pid = String::from_str(&env, "co2-cap-proj");
        client.register_project(
            &admin,
            &pid,
            &String::from_str(&env, "CO2 cap"),
            &wallet,
            &MAX_CO2_PER_XLM,
        );

        let donor = Address::generate(&env);
        let amount = STROOP;
        mint_to(&env, &token_client, &donor, amount);

        env.as_contract(&cid, || {
            env.storage().instance().set(
                &DataKey::GlobalCO2OffsetGrams,
                &(i128::MAX - (MAX_CO2_PER_XLM as i128 / 2)),
            );
        });

        let global_co2_before = client.get_global_co2();
        client.donate(&token, &donor, &pid, &amount, &0u32);

        assert_eq!(client.get_global_co2(), global_co2_before);
        assert_eq!(client.get_global_total(), amount);
        assert_eq!(client.get_donation_count(), 1);
        assert_eq!(token_balance(&env, &token, &donor), 0);
    }

    #[test]
    fn test_donate_unique_donor_count_not_inflated() {
        let (env, _cid, client, _admin, pid, token, token_client) = setup_donation();
        let donor = Address::generate(&env);
        let amount = STROOP;
        mint_to(&env, &token_client, &donor, amount * 3);

        for _ in 0..3 {
            client.donate(&token, &donor, &pid, &amount, &0u32);
        }

        let project = client.get_project(&pid);
        assert_eq!(project.donor_count, 1);
        assert_eq!(client.get_donation_count(), 3);
        assert_eq!(client.get_donor_stats(&donor).donation_count, 3);
    }

    #[test]
    fn test_donate_distinct_donors_increment_count() {
        let (env, _cid, client, _admin, pid, token, token_client) = setup_donation();
        let amount = STROOP;

        for _ in 0..3 {
            let donor = Address::generate(&env);
            mint_to(&env, &token_client, &donor, amount);
            client.donate(&token, &donor, &pid, &amount, &0u32);
        }

        assert_eq!(client.get_project(&pid).donor_count, 3);
        assert_eq!(client.get_donation_count(), 3);
    }

    /// Proves the `create_proposal` deadline add would overflow near `u32::MAX`.
    /// Full host integration at this ledger is impractical (instance TTL / context
    /// limits in the test VM); the contract uses the same `checked_add` path.
    #[test]
    fn test_voting_deadline_checked_add_guard() {
        let ledger = u32::MAX - MIN_VOTING_WINDOW_LEDGERS;
        assert!(
            ledger.checked_add(VOTING_WINDOW_LEDGERS).is_none(),
            "default voting window must not wrap deadline_ledger"
        );
        assert!(
            ledger.checked_add(MAX_VOTING_WINDOW_LEDGERS).is_none(),
            "max custom voting window must not wrap deadline_ledger"
        );
    }

    // ─── Governance helpers ───────────────────────────────────────────────────

    /// Set up a fresh contract with one registered project.
    fn setup() -> (
        Env,
        soroban_sdk::Address,
        GreenPayContractClient<'static>,
        Address,
        String,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, GreenPayContract);
        let client = GreenPayContractClient::new(&env, &cid);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        let pid = String::from_str(&env, "proj-001");
        let wallet = Address::generate(&env);
        client.register_project(
            &admin,
            &pid,
            &String::from_str(&env, "Test Project"),
            &wallet,
            &100u32,
        );
        (env, cid, client, admin, pid)
    }

    /// Inject a Tree-tier badge directly into persistent storage for a voter.
    ///
    /// Uses 100 XLM (`VOTE_ELIGIBILITY_STROOP`) — the minimum stake required
    /// by the weighted-voting system.  Tests that need a specific amount
    /// should call `grant_badge_with_amount` instead.
    fn grant_badge(env: &Env, cid: &soroban_sdk::Address, voter: &Address) {
        grant_badge_with_amount(env, cid, voter, 100 * STROOP);
    }

    /// Inject a donor record with an explicit `total_donated` (stroops) and
    /// matching badge tier so governance tests can express precise vote weights.
    fn grant_badge_with_amount(
        env: &Env,
        cid: &soroban_sdk::Address,
        voter: &Address,
        total_donated: i128,
    ) {
        let badge = if total_donated >= 2000 * STROOP {
            BadgeTier::EarthGuardian
        } else if total_donated >= 500 * STROOP {
            BadgeTier::Forest
        } else if total_donated >= 100 * STROOP {
            BadgeTier::Tree
        } else if total_donated >= 10 * STROOP {
            BadgeTier::Seedling
        } else {
            BadgeTier::None
        };
        env.as_contract(cid, || {
            env.storage().persistent().set(
                &DataKey::DonorStats(voter.clone()),
                &DonorStats {
                    total_donated,
                    donation_count: 1,
                    badge,
                    co2_offset_grams: 0,
                },
            );
        });
    }

    /// Extend instance TTL before a large ledger jump so config storage isn't
    /// archived. Per-entity persistent entries are TTL-extended on every read by
    /// `extend_persistent_ttl`, so they survive the ledger jump automatically.
    fn extend_ttl(env: &Env, cid: &soroban_sdk::Address) {
        env.as_contract(cid, || {
            env.storage()
                .instance()
                .extend_ttl(VOTING_WINDOW_LEDGERS * 4, VOTING_WINDOW_LEDGERS * 4);
        });
    }

    #[test]
    fn test_upgrade_preserves_donation_state_and_storage_keys() {
        let (env, cid, client_v1, _admin, pid) = setup();
        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_client = StellarAssetClient::new(&env, &token);
        let amount = 25 * STROOP;
        let expected_co2 = 0i128;

        client_v1.allow_token(&_admin, &token);

        token_client.mint(&donor, &amount);
        client_v1.donate(&token, &donor, &pid, &amount, &42u32);

        let project_before = client_v1.get_project(&pid);
        assert_eq!(project_before.total_raised, amount);
        assert_eq!(project_before.donor_count, 1);
        assert_eq!(client_v1.get_donation_count(), 1);
        assert_eq!(client_v1.get_global_total(), amount);
        assert_eq!(client_v1.get_global_co2(), expected_co2);

        // The test host replaces the executable at the same contract address,
        // modeling a v2 deployment with the same storage key definitions.
        let v2_cid = env.register_contract(Some(&cid), GreenPayContract);
        assert_eq!(v2_cid, cid);

        let client_v2 = GreenPayContractClient::new(&env, &cid);
        let project_after = client_v2.get_project(&pid);
        assert_eq!(project_after.id, project_before.id);
        assert_eq!(project_after.name, project_before.name);
        assert_eq!(project_after.wallet, project_before.wallet);
        assert_eq!(project_after.co2_per_xlm, project_before.co2_per_xlm);
        assert_eq!(project_after.total_raised, amount);
        assert_eq!(project_after.donor_count, 1);
        assert!(project_after.active);
        assert_eq!(project_after.registered_at, project_before.registered_at);

        let donor_stats = client_v2.get_donor_stats(&donor);
        assert_eq!(donor_stats.total_donated, amount);
        assert_eq!(donor_stats.donation_count, 1);
        assert_eq!(donor_stats.badge, BadgeTier::Seedling);
        assert_eq!(donor_stats.co2_offset_grams, expected_co2);
        assert!(client_v2.has_nft(&donor, &BadgeTier::Seedling));
        assert_eq!(client_v2.get_project_count(), 1);
        assert_eq!(client_v2.get_donation_count(), 1);
        assert_eq!(client_v2.get_global_total(), amount);
        assert_eq!(client_v2.get_global_co2(), expected_co2);

        env.as_contract(&cid, || {
            // Per-entity records now live in *persistent* storage with
            // per-key TTLs (v2+ layout).
            let stored_project: Project = env
                .storage()
                .persistent()
                .get(&DataKey::Project(pid.clone()))
                .expect("project key must be in persistent storage after upgrade");
            assert_eq!(stored_project.total_raised, amount);
            assert_eq!(stored_project.donor_count, 1);

            let stored_stats: DonorStats = env
                .storage()
                .persistent()
                .get(&DataKey::DonorStats(donor.clone()))
                .expect("donor stats key must be in persistent storage after upgrade");
            assert_eq!(stored_stats.total_donated, amount);
            assert_eq!(stored_stats.donation_count, 1);
            assert_eq!(stored_stats.badge, BadgeTier::Seedling);
            assert_eq!(stored_stats.co2_offset_grams, expected_co2);

            let has_donated: bool = env
                .storage()
                .persistent()
                .get(&DataKey::HasDonated(pid.clone(), donor.clone()))
                .expect("unique donor key must be in persistent storage after upgrade");
            assert!(has_donated);

            // Contract-wide config remains in instance storage.
            let donation_count: u32 = env
                .storage()
                .instance()
                .get(&DataKey::DonationCount)
                .expect("donation count key must remain readable after upgrade");
            let global_total: i128 = env
                .storage()
                .instance()
                .get(&DataKey::GlobalTotalRaised)
                .expect("global total key must remain readable after upgrade");
            let global_co2: i128 = env
                .storage()
                .instance()
                .get(&DataKey::GlobalCO2OffsetGrams)
                .expect("global CO2 key must remain readable after upgrade");

            assert_eq!(donation_count, 1);
            assert_eq!(global_total, amount);
            assert_eq!(global_co2, expected_co2);
        });
    }

    // ─── Persistent storage / migration tests ────────────────────────────────

    /// Legacy v1 per-entity entries in instance storage are transparently
    /// migrated to persistent storage on first access, without data loss.
    #[test]
    fn test_lazy_migration_from_instance_to_persistent_storage() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, GreenPayContract);
        let client = GreenPayContractClient::new(&env, &cid);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        let pid = String::from_str(&env, "proj-001");
        let donor = Address::generate(&env);

        // Simulate a v1 deployment: per-entity records written to instance
        // storage (the pre-fix layout).
        env.as_contract(&cid, || {
            env.storage().instance().set(
                &DataKey::Project(pid.clone()),
                &Project {
                    id: pid.clone(),
                    name: String::from_str(&env, "Legacy Project"),
                    wallet: Address::generate(&env),
                    co2_per_xlm: 100,
                    total_raised: 5 * STROOP,
                    donor_count: 1,
                    active: true,
                    registered_at: 1,
                },
            );
            env.storage().instance().set(
                &DataKey::DonorStats(donor.clone()),
                &DonorStats {
                    total_donated: 5 * STROOP,
                    donation_count: 1,
                    badge: BadgeTier::Seedling,
                    co2_offset_grams: 500,
                },
            );
            env.storage()
                .instance()
                .set(&DataKey::HasDonated(pid.clone(), donor.clone()), &true);
            env.storage().instance().set(
                &DataKey::ImpactNFT(donor.clone(), BadgeTier::Seedling),
                &ImpactNFT {
                    owner: donor.clone(),
                    tier: BadgeTier::Seedling,
                    total_donated: 5 * STROOP,
                    minted_at_ledger: 1,
                },
            );
        });

        // First access through the public getters migrates Project and
        // DonorStats via the read_persistent helper.
        let project = client.get_project(&pid);
        assert_eq!(project.total_raised, 5 * STROOP);
        assert_eq!(project.donor_count, 1);

        let stats = client.get_donor_stats(&donor);
        assert_eq!(stats.total_donated, 5 * STROOP);
        assert_eq!(stats.badge, BadgeTier::Seedling);

        assert!(client.has_nft(&donor, &BadgeTier::Seedling));

        // Migrate HasDonated and ImpactNFT through the internal helper inside
        // the contract context (no public getter returns their values).
        env.as_contract(&cid, || {
            let has_donated: Option<bool> =
                read_persistent(&env, &DataKey::HasDonated(pid.clone(), donor.clone()));
            assert_eq!(has_donated, Some(true));

            let nft_opt: Option<ImpactNFT> = read_persistent(
                &env,
                &DataKey::ImpactNFT(donor.clone(), BadgeTier::Seedling),
            );
            assert!(
                nft_opt.is_some(),
                "ImpactNFT must be migrated to persistent storage"
            );
            assert_eq!(nft_opt.unwrap().total_donated, 5 * STROOP);
        });

        // After migration every per-entity record lives in persistent storage
        // and the legacy instance entries are gone.
        env.as_contract(&cid, || {
            let migrated_project: Project = env
                .storage()
                .persistent()
                .get(&DataKey::Project(pid.clone()))
                .expect("project must be migrated to persistent storage");
            assert_eq!(migrated_project.total_raised, 5 * STROOP);
            assert!(
                !env.storage().instance().has(&DataKey::Project(pid.clone())),
                "legacy instance project entry must be removed after migration"
            );

            let migrated_stats: DonorStats = env
                .storage()
                .persistent()
                .get(&DataKey::DonorStats(donor.clone()))
                .expect("donor stats must be migrated to persistent storage");
            assert_eq!(migrated_stats.total_donated, 5 * STROOP);
            assert!(
                !env.storage()
                    .instance()
                    .has(&DataKey::DonorStats(donor.clone())),
                "legacy instance donor stats entry must be removed after migration"
            );

            let has_donated: bool = env
                .storage()
                .persistent()
                .get(&DataKey::HasDonated(pid.clone(), donor.clone()))
                .expect("HasDonated must be migrated to persistent storage");
            assert!(has_donated);
            assert!(
                !env.storage()
                    .instance()
                    .has(&DataKey::HasDonated(pid.clone(), donor.clone())),
                "legacy instance HasDonated entry must be removed after migration"
            );

            let nft: ImpactNFT = env
                .storage()
                .persistent()
                .get(&DataKey::ImpactNFT(donor.clone(), BadgeTier::Seedling))
                .expect("ImpactNFT must be migrated to persistent storage");
            assert_eq!(nft.total_donated, 5 * STROOP);
            assert!(
                !env.storage()
                    .instance()
                    .has(&DataKey::ImpactNFT(donor.clone(), BadgeTier::Seedling)),
                "legacy instance ImpactNFT entry must be removed after migration"
            );
        });

        // The migrated state remains fully functional through the contract,
        // including the pre-existing HasDonated flag (donor_count stays 1).
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_client = StellarAssetClient::new(&env, &token);
        client.allow_token(&admin, &token);
        token_client.mint(&donor, &STROOP);
        client.donate(&token, &donor, &pid, &STROOP, &0u32);
        assert_eq!(client.get_project(&pid).total_raised, 6 * STROOP);
        assert_eq!(client.get_donor_stats(&donor).donation_count, 2);
        assert_eq!(
            client.get_project(&pid).donor_count,
            1,
            "migrated HasDonated flag must prevent donor_count inflation"
        );
    }

    /// Registering hundreds of projects, with a subset receiving donations,
    /// keeps every per-entity record in persistent storage (each with its own
    /// TTL) instead of inflating the shared instance footprint.
    ///
    /// The donation set is kept smaller than the project set because the
    /// Soroban test host's VM on Windows has a stack ceiling on many sequential
    /// contract invocations in a single Env; the assertion that all records
    /// live in persistent storage is what matters for this regression.
    #[test]
    fn test_scale_hundreds_of_projects_and_donors() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, GreenPayContract);
        let client = GreenPayContractClient::new(&env, &cid);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_client = StellarAssetClient::new(&env, &token);
        client.allow_token(&admin, &token);

        // Register 100 projects ("hundreds" scale).
        for i in 0..100u32 {
            let pid = String::from_str(&env, &format!("proj-{:03}", i));
            let wallet = Address::generate(&env);
            client.register_project(
                &admin,
                &pid,
                &String::from_str(&env, &format!("Project {}", i)),
                &wallet,
                &100u32,
            );
        }
        assert_eq!(client.get_project_count(), 100);

        // Donate to the first 10 projects using distinct donors.
        for i in 0..10u32 {
            let pid = String::from_str(&env, &format!("proj-{:03}", i));
            let donor = Address::generate(&env);
            token_client.mint(&donor, &STROOP);
            client.donate(&token, &donor, &pid, &STROOP, &0u32);
        }

        assert_eq!(client.get_donation_count(), 10);
        assert_eq!(client.get_global_total(), 10 * STROOP);

        // Every project record — including the 90 without donations — lives in
        // persistent storage, not the shared instance footprint.
        env.as_contract(&cid, || {
            for i in 0..100u32 {
                let pid = String::from_str(&env, &format!("proj-{:03}", i));
                let project: Project = env
                    .storage()
                    .persistent()
                    .get(&DataKey::Project(pid.clone()))
                    .expect("project must be in persistent storage");
                let expected = if i < 10 { STROOP } else { 0 };
                assert_eq!(project.total_raised, expected);
            }
        });

        // Spot-check getters remain correct across the range.
        for i in (0..100u32).step_by(25) {
            let pid = String::from_str(&env, &format!("proj-{:03}", i));
            let expected = if i < 10 { STROOP } else { 0 };
            assert_eq!(client.get_project(&pid).total_raised, expected);
        }
    }

    /// Per-entity persistent entries have their TTL extended on every read and
    /// write, so they survive long ledger jumps without manual intervention.
    #[test]
    fn test_persistent_ttl_extended_on_read_and_write() {
        let (env, cid, client, admin, pid) = setup();
        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_client = StellarAssetClient::new(&env, &token);
        client.allow_token(&admin, &token);
        token_client.mint(&donor, &STROOP);
        client.donate(&token, &donor, &pid, &STROOP, &0u32);

        // Extend the GreenPay instance config so it survives the jump; then
        // jump beyond the default 4096-ledger instance entry TTL. Per-entity
        // persistent entries were TTL-extended to PERSISTENT_TTL_EXTEND on
        // write, so they must still be readable.
        extend_ttl(&env, &cid);
        env.ledger().set_sequence_number(5_000);

        // Reading extends TTL again — per-entity persistent entries survive
        // the jump because write-time TTL extension put them far beyond it.
        let project = client.get_project(&pid);
        assert_eq!(project.total_raised, STROOP);
        let stats = client.get_donor_stats(&donor);
        assert_eq!(stats.total_donated, STROOP);

        // Writing extends TTL too: register a new project after the jump and
        // read it back (avoids the SAC token balance TTL artifact).
        let new_pid = String::from_str(&env, "proj-after-jump");
        let wallet = Address::generate(&env);
        client.register_project(
            &admin,
            &new_pid,
            &String::from_str(&env, "After Jump"),
            &wallet,
            &100u32,
        );
        assert_eq!(client.get_project(&new_pid).total_raised, 0);
        assert_eq!(client.get_project_count(), 2);
    }

    // ─── Governance tests ─────────────────────────────────────────────────────

    #[test]
    fn test_create_proposal() {
        let (env, _cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);
        let p = client.get_proposal(&pid);
        assert_eq!(p.votes_for, 0i128);
        assert_eq!(p.votes_against, 0i128);
        assert!(!p.resolved);
        assert!(p.deadline_ledger > env.ledger().sequence());
    }

    #[test]
    #[should_panic(expected = "Proposal already exists for this project")]
    fn test_create_duplicate_proposal_fails() {
        let (_env, _cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);
        client.create_proposal(&admin, &pid, &0u32);
    }

    #[test]
    fn test_cast_vote() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);
        let voter = Address::generate(&env);
        grant_badge(&env, &cid, &voter); // 100 XLM = 100 * STROOP weight
        client.vote_verify_project(&voter, &pid, &true);
        let p = client.get_proposal(&pid);
        assert_eq!(p.votes_for, 100 * STROOP);
        assert_eq!(p.votes_against, 0i128);
    }

    #[test]
    #[should_panic(expected = "Insufficient donation stake to vote (Tree tier / 100 XLM minimum)")]
    fn test_non_badge_holder_cannot_vote() {
        let (env, _cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);
        let non_donor = Address::generate(&env);
        client.vote_verify_project(&non_donor, &pid, &true);
    }

    /// A Seedling-tier donor (10 XLM, below the Tree threshold) must also be
    /// rejected — it satisfies the old badge check but not the new stake bar.
    #[test]
    #[should_panic(expected = "Insufficient donation stake to vote (Tree tier / 100 XLM minimum)")]
    fn test_seedling_holder_cannot_vote() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);
        let seedling_donor = Address::generate(&env);
        grant_badge_with_amount(&env, &cid, &seedling_donor, 10 * STROOP); // only 10 XLM
        client.vote_verify_project(&seedling_donor, &pid, &true);
    }

    #[test]
    #[should_panic(expected = "Already voted on this proposal")]
    fn test_double_vote_prevented() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);
        let voter = Address::generate(&env);
        grant_badge(&env, &cid, &voter);
        client.vote_verify_project(&voter, &pid, &true);
        client.vote_verify_project(&voter, &pid, &true); // should panic
    }

    #[test]
    fn test_resolve_proposal_approved() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);
        // 2 approve (100 XLM each = 200 * STROOP for), 1 rejects (100 XLM = 100 * STROOP against)
        for i in 0..3u32 {
            let voter = Address::generate(&env);
            grant_badge(&env, &cid, &voter); // each voter has 100 XLM
            client.vote_verify_project(&voter, &pid, &(i < 2));
        }
        extend_ttl(&env, &cid);
        env.ledger().set_sequence_number(VOTING_WINDOW_LEDGERS + 2);
        client.resolve_proposal(&pid);
        let p = client.get_proposal(&pid);
        assert!(p.resolved);
        assert_eq!(p.votes_for, 200 * STROOP);
        assert_eq!(p.votes_against, 100 * STROOP);
    }

    #[test]
    fn test_resolve_proposal_rejected() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);
        // 1 approves (100 XLM = 100 * STROOP for), 2 reject (100 XLM each = 200 * STROOP against)
        for i in 0..3u32 {
            let voter = Address::generate(&env);
            grant_badge(&env, &cid, &voter); // each voter has 100 XLM
            client.vote_verify_project(&voter, &pid, &(i == 0));
        }
        extend_ttl(&env, &cid);
        env.ledger().set_sequence_number(VOTING_WINDOW_LEDGERS + 2);
        client.resolve_proposal(&pid);
        let p = client.get_proposal(&pid);
        assert!(p.resolved);
        assert_eq!(p.votes_for, 100 * STROOP);
        assert_eq!(p.votes_against, 200 * STROOP);
    }

    #[test]
    #[should_panic(expected = "Voting window not yet closed")]
    fn test_resolve_before_deadline_fails() {
        let (_env, _cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);
        client.resolve_proposal(&pid);
    }

    /// Resolving a proposal that received zero votes must panic with the
    /// quorum message rather than silently approving or rejecting.
    #[test]
    #[should_panic(expected = "Quorum not reached: no eligible votes cast")]
    fn test_resolve_with_no_votes_fails_quorum() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);
        extend_ttl(&env, &cid);
        env.ledger().set_sequence_number(VOTING_WINDOW_LEDGERS + 2);
        client.resolve_proposal(&pid);
    }

    #[test]
    #[should_panic(expected = "Proposal already resolved")]
    fn test_double_resolve_fails() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);

        // Cast one eligible vote so the first resolve clears the quorum check
        // and actually resolves the proposal. Without a vote the first call
        // panics on quorum and the second call is never reached.
        let voter = Address::generate(&env);
        grant_badge_with_amount(&env, &cid, &voter, 100 * STROOP);
        client.vote_verify_project(&voter, &pid, &true);

        extend_ttl(&env, &cid);
        env.ledger().set_sequence_number(VOTING_WINDOW_LEDGERS + 2);
        client.resolve_proposal(&pid);
        // Extend again so the second call reaches our panic, not an archive error
        extend_ttl(&env, &cid);
        client.resolve_proposal(&pid);
    }

    // ─── Legacy-path cutover tests (Issue #317) ──────────────────────────────
    //
    // The legacy badge-holder voting path must retire atomically once a DAO
    // contract is registered: no new legacy proposals or votes, while in-flight
    // proposals keep a resolution path.

    /// No DAO registered → legacy path works (baseline covered exhaustively by
    /// the tests above). Once a DAO is registered, creating a new legacy
    /// proposal must refuse.
    #[test]
    #[should_panic(expected = "DAO governance is active; legacy proposals are retired")]
    fn test_legacy_create_proposal_retired_when_dao_registered() {
        let (env, _cid, client, admin, pid) = setup();
        let dao = Address::generate(&env);
        client.set_dao_contract(&admin, &Some(dao));
        client.create_proposal(&admin, &pid, &0u32);
    }

    /// An in-flight legacy proposal cannot receive new votes after the DAO is
    /// registered — the cutover freezes participation on it.
    #[test]
    #[should_panic(expected = "DAO governance is active; legacy voting is retired")]
    fn test_legacy_vote_retired_when_dao_registered() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);
        let dao = Address::generate(&env);
        client.set_dao_contract(&admin, &Some(dao));

        let voter = Address::generate(&env);
        grant_badge(&env, &cid, &voter);
        client.vote_verify_project(&voter, &pid, &true);
    }

    /// In-flight legacy proposals created before the cutover keep their
    /// resolution path: `resolve_proposal` still settles them from the votes
    /// already cast, even with a DAO registered.
    #[test]
    fn test_legacy_resolve_settles_inflight_proposal_after_dao_registration() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);

        // Two eligible votes cast BEFORE the cutover (2 × 100 XLM for).
        for _ in 0..2u32 {
            let voter = Address::generate(&env);
            grant_badge(&env, &cid, &voter);
            client.vote_verify_project(&voter, &pid, &true);
        }

        // Cutover happens mid-flight.
        let dao = Address::generate(&env);
        client.set_dao_contract(&admin, &Some(dao));

        extend_ttl(&env, &cid);
        env.ledger().set_sequence_number(VOTING_WINDOW_LEDGERS + 2);
        client.resolve_proposal(&pid);

        let p = client.get_proposal(&pid);
        assert!(p.resolved);
        assert_eq!(p.votes_for, 200 * STROOP);
        assert_eq!(p.votes_against, 0);
    }

    /// Clearing the DAO registration (set_dao_contract None) re-enables the
    /// legacy path for deployments that need to roll back the cutover.
    #[test]
    fn test_legacy_re_enabled_after_dao_cleared() {
        let (env, _cid, client, admin, pid) = setup();
        let dao = Address::generate(&env);
        client.set_dao_contract(&admin, &Some(dao));

        // Retired while registered.
        let retired = client.try_create_proposal(&admin, &pid, &0u32);
        assert!(retired.is_err());

        // Re-enabled once cleared.
        client.set_dao_contract(&admin, &None);
        client.create_proposal(&admin, &pid, &0u32);
        let p = client.get_proposal(&pid);
        assert!(!p.resolved);
    }

    // ─── Sybil-resistance tests (Issue #113) ─────────────────────────────────

    /// **Core Sybil scenario**: N addresses each staking the minimum 100 XLM
    /// (Tree tier) all vote FOR, while a single large donor stakes MORE than
    /// the entire Sybil coalition and votes AGAINST.  The large donor must win.
    ///
    /// Setup:
    ///   • 20 Sybil addresses × 100 XLM each → 20 × 100 × STROOP FOR weight
    ///   • 1 legitimate donor  × 2 100 XLM   →      2 100 × STROOP AGAINST weight
    ///
    /// Result: votes_against (2 100 * STROOP) > votes_for (2 000 * STROOP) →
    /// proposal rejected despite the Sybil majority of *address count*.
    #[test]
    fn test_sybil_many_minimum_donors_lose_to_one_large_donor() {
        const SYBIL_COUNT: u32 = 20;
        const SYBIL_STAKE_XLM: i128 = 100; // exactly at the Tree threshold
        const WHALE_STAKE_XLM: i128 = 2_100; // just above 20 × 100

        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);

        // 20 Sybil addresses each vote FOR with minimum eligible stake.
        for _ in 0..SYBIL_COUNT {
            let sybil = Address::generate(&env);
            grant_badge_with_amount(&env, &cid, &sybil, SYBIL_STAKE_XLM * STROOP);
            client.vote_verify_project(&sybil, &pid, &true);
        }

        // One large legitimate donor votes AGAINST with stake exceeding the
        // entire Sybil coalition combined.
        let whale = Address::generate(&env);
        grant_badge_with_amount(&env, &cid, &whale, WHALE_STAKE_XLM * STROOP);
        client.vote_verify_project(&whale, &pid, &false);

        extend_ttl(&env, &cid);
        env.ledger().set_sequence_number(VOTING_WINDOW_LEDGERS + 2);
        client.resolve_proposal(&pid);

        let p = client.get_proposal(&pid);
        assert!(p.resolved);

        let expected_for: i128 = SYBIL_COUNT as i128 * SYBIL_STAKE_XLM * STROOP;
        let expected_against: i128 = WHALE_STAKE_XLM * STROOP;
        assert_eq!(
            p.votes_for, expected_for,
            "FOR weight should equal 20 × 100 XLM = {} stroops",
            expected_for
        );
        assert_eq!(
            p.votes_against, expected_against,
            "AGAINST weight should equal 2100 XLM = {} stroops",
            expected_against
        );

        // The whale outweighs all 20 Sybil addresses combined → proposal rejected.
        assert!(
            p.votes_against > p.votes_for,
            "whale ({}s) must outweigh {} Sybil voters ({}s)",
            p.votes_against,
            SYBIL_COUNT,
            p.votes_for
        );
    }

    /// **Symmetrical Sybil scenario**: N Sybil addresses each at the minimum
    /// 100 XLM vote FOR; a counter-coalition with the *same* total stake but
    /// concentrated in fewer addresses also votes AGAINST.  Result is a tie,
    /// which resolves as rejection (votes_for <= votes_against rule).
    #[test]
    fn test_sybil_equal_stake_resolves_as_rejection() {
        const SYBIL_COUNT: u32 = 10;
        const SYBIL_STAKE_XLM: i128 = 100;
        // Opposing side uses same total stake in a single address.
        const COUNTER_STAKE_XLM: i128 = SYBIL_COUNT as i128 * SYBIL_STAKE_XLM; // 1 000 XLM

        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);

        for _ in 0..SYBIL_COUNT {
            let sybil = Address::generate(&env);
            grant_badge_with_amount(&env, &cid, &sybil, SYBIL_STAKE_XLM * STROOP);
            client.vote_verify_project(&sybil, &pid, &true);
        }

        let counter = Address::generate(&env);
        grant_badge_with_amount(&env, &cid, &counter, COUNTER_STAKE_XLM * STROOP);
        client.vote_verify_project(&counter, &pid, &false);

        extend_ttl(&env, &cid);
        env.ledger().set_sequence_number(VOTING_WINDOW_LEDGERS + 2);
        client.resolve_proposal(&pid);

        let p = client.get_proposal(&pid);
        assert!(p.resolved);
        assert_eq!(
            p.votes_for, p.votes_against,
            "stakes are equal so this should be a tie"
        );
        // Ties resolve as rejection (votes_for <= votes_against).
        assert!(
            p.votes_for <= p.votes_against,
            "a tie must not approve the project"
        );
    }

    // ─── Configurable voting-duration tests ───────────────────────────────────

    /// A non-zero `duration_ledgers` within bounds is honored verbatim.
    #[test]
    fn test_create_proposal_custom_duration() {
        let (env, _cid, client, admin, pid) = setup();
        let custom: u32 = 5_000;
        let start = env.ledger().sequence();
        client.create_proposal(&admin, &pid, &custom);
        let p = client.get_proposal(&pid);
        assert_eq!(p.deadline_ledger, start + custom);
    }

    /// `0` means "use the default 7-day window".
    #[test]
    fn test_create_proposal_zero_duration_uses_default() {
        let (env, _cid, client, admin, pid) = setup();
        let start = env.ledger().sequence();
        client.create_proposal(&admin, &pid, &0u32);
        let p = client.get_proposal(&pid);
        assert_eq!(p.deadline_ledger, start + VOTING_WINDOW_LEDGERS);
    }

    #[test]
    #[should_panic(expected = "Voting duration too short")]
    fn test_create_proposal_rejects_too_short_duration() {
        let (_env, _cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &(MIN_VOTING_WINDOW_LEDGERS - 1));
    }

    #[test]
    #[should_panic(expected = "Voting duration too long")]
    fn test_create_proposal_rejects_too_long_duration() {
        let (_env, _cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &(MAX_VOTING_WINDOW_LEDGERS + 1));
    }

    // ─── DAO integration tests (Issue #112) ──────────────────────────────────

    /// After `set_dao_contract`, `get_dao_contract` returns the stored address.
    #[test]
    fn test_set_and_get_dao_contract() {
        let (env, _cid, client, admin, _pid) = setup();
        let dao = Address::generate(&env);
        client.set_dao_contract(&admin, &Some(dao.clone()));
        assert_eq!(client.get_dao_contract(), Some(dao));
    }

    /// Only the contract admin may call `set_dao_contract`.
    #[test]
    #[should_panic(expected = "Only admin can set DAO contract")]
    fn test_set_dao_contract_rejects_non_admin() {
        let (env, _cid, client, _admin, _pid) = setup();
        let impostor = Address::generate(&env);
        let dao = Address::generate(&env);
        client.set_dao_contract(&impostor, &Some(dao));
    }

    /// Clearing the DAO address removes it from storage.
    #[test]
    fn test_clear_dao_contract() {
        let (env, _cid, client, admin, _pid) = setup();
        let dao = Address::generate(&env);
        client.set_dao_contract(&admin, &Some(dao));
        client.set_dao_contract(&admin, &None);
        assert_eq!(client.get_dao_contract(), None);
    }

    /// The registered DAO contract address can successfully call `verify_project`.
    #[test]
    fn test_verify_project_by_dao_succeeds() {
        let (env, _cid, client, admin, pid) = setup();
        let dao = Address::generate(&env);
        client.set_dao_contract(&admin, &Some(dao.clone()));
        client.verify_project(&dao, &pid);
        // Project remains active and registered after DAO verification.
        let p = client.get_project(&pid);
        assert!(p.active);
    }

    /// Any address that is NOT the registered DAO contract is rejected.
    #[test]
    #[should_panic(expected = "Only the registered DAO contract can verify projects")]
    fn test_verify_project_rejects_non_dao() {
        let (env, _cid, client, admin, pid) = setup();
        let dao = Address::generate(&env);
        client.set_dao_contract(&admin, &Some(dao));
        let impostor = Address::generate(&env);
        client.verify_project(&impostor, &pid);
    }

    /// Calling `verify_project` when no DAO contract is registered panics with
    /// a clear message so integrators know to call `set_dao_contract` first.
    #[test]
    #[should_panic(expected = "DAO contract not registered; call set_dao_contract first")]
    fn test_verify_project_panics_when_no_dao_registered() {
        let (env, _cid, client, _admin, pid) = setup();
        let caller = Address::generate(&env);
        client.verify_project(&caller, &pid);
    }

    /// `verify_project` panics on an unknown project ID.
    #[test]
    #[should_panic(expected = "Project not found")]
    fn test_verify_project_unknown_project() {
        let (env, _cid, client, admin, _pid) = setup();
        let dao = Address::generate(&env);
        client.set_dao_contract(&admin, &Some(dao.clone()));
        client.verify_project(&dao, &String::from_str(&env, "does-not-exist"));
    }

    /// `verify_project` panics on an inactive project (deactivated by admin).
    #[test]
    #[should_panic(expected = "Cannot verify an inactive project")]
    fn test_verify_project_inactive_project() {
        let (env, _cid, client, admin, pid) = setup();
        let dao = Address::generate(&env);
        client.set_dao_contract(&admin, &Some(dao.clone()));
        client.deactivate_project(&admin, &pid);
        client.verify_project(&dao, &pid);
    }

    /// Re-registering a new DAO address replaces the old one, and the old
    /// address can no longer call `verify_project`.
    #[test]
    #[should_panic(expected = "Only the registered DAO contract can verify projects")]
    fn test_update_dao_contract_revokes_old_address() {
        let (env, _cid, client, admin, pid) = setup();
        let dao_v1 = Address::generate(&env);
        let dao_v2 = Address::generate(&env);
        client.set_dao_contract(&admin, &Some(dao_v1.clone()));
        // Replace with dao_v2
        client.set_dao_contract(&admin, &Some(dao_v2));
        // dao_v1 should now be rejected
        client.verify_project(&dao_v1, &pid);
    }

    // ─── Upgrade tests ────────────────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "Only admin can upgrade")]
    fn test_upgrade_rejects_non_admin() {
        let (env, _cid, client, _admin, _pid) = setup();
        let impostor = Address::generate(&env);
        // BytesN<32> filled with zeros
        let hash = soroban_sdk::BytesN::from_array(&env, &[0u8; 32]);
        client.upgrade(&impostor, &hash);
    }

    #[test]
    fn test_upgrade_preserves_state_and_emits_event() {
        // Deploy V1, make a donation, then "upgrade" to the same WASM (same binary
        // re-registered at the same address — the standard test-env upgrade pattern).
        // After upgrade, all storage reads must still succeed.
        let (env, cid, client_v1, admin, pid) = setup();
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let sac = soroban_sdk::token::StellarAssetClient::new(&env, &token);
        let amount = 25 * STROOP;
        client_v1.allow_token(&admin, &token);
        sac.mint(&Address::generate(&env), &amount);
        let donor = Address::generate(&env);
        sac.mint(&donor, &amount);
        client_v1.donate(&token, &donor, &pid, &amount, &0u32);

        // Record state before upgrade
        let total_before = client_v1.get_global_total();
        let count_before = client_v1.get_donation_count();

        // Perform upgrade: re-register the same contract binary at the same address.
        // In production this is env.deployer().update_current_contract_wasm(hash);
        // In the test SDK the equivalent is re-registering at the same address.
        let new_cid = env.register_contract(Some(&cid), GreenPayContract);
        assert_eq!(new_cid, cid);

        // Verify state survived
        let client_v2 = GreenPayContractClient::new(&env, &cid);
        assert_eq!(client_v2.get_global_total(), total_before);
        assert_eq!(client_v2.get_donation_count(), count_before);
        assert_eq!(client_v2.get_project(&pid).total_raised, amount);
    }

    // ─── Impact NFT interface tests (Issue #114) ────────────────────────────

    /// After earning a badge, the badge is discoverable through the standard
    /// NFT interface (`name`/`symbol`/`decimals`/`balance_of`/`owner_of`/
    /// `tokens_of`/`token_metadata`), not just through the contract's custom
    /// `has_nft` getter.
    #[test]
    fn test_nft_interface_discoverability() {
        let (env, _cid, client, _admin, pid, token, token_client) = setup_donation();
        let donor = Address::generate(&env);
        let amount = 10 * STROOP; // Seedling tier
        mint_to(&env, &token_client, &donor, amount);
        client.donate(&token, &donor, &pid, &amount, &0u32);

        // Collection metadata.
        assert_eq!(
            client.name(),
            String::from_str(&env, "GreenPay Impact Badge")
        );
        assert_eq!(client.symbol(), String::from_str(&env, "GPB"));
        assert_eq!(client.decimals(), 0);

        // The badge is a real, addressable token: it has an id, an owner, a
        // balance, and full on-chain metadata.
        let token_id = client
            .get_token_id(&donor, &BadgeTier::Seedling)
            .expect("earned badge must have a token id");
        assert_eq!(client.total_supply(), 1);
        assert_eq!(client.balance_of(&donor), 1);
        assert_eq!(client.owner_of(&token_id), donor);
        assert_eq!(client.tokens_of(&donor), vec![&env, token_id]);
        assert_eq!(client.token_tier(&token_id), BadgeTier::Seedling);

        let meta = client.token_metadata(&token_id);
        assert_eq!(meta.owner, donor);
        assert_eq!(meta.tier, BadgeTier::Seedling);
        assert_eq!(meta.total_donated, amount);
        assert_eq!(meta.minted_at_ledger, env.ledger().sequence());

        // A donor with no badges has no tokens.
        let stranger = Address::generate(&env);
        assert_eq!(client.balance_of(&stranger), 0);
        assert_eq!(client.tokens_of(&stranger).len(), 0);
    }

    /// Badge tokens transfer to a new owner: balances, ownership, and
    /// `has_nft`/`get_token_id` all follow the new owner.
    #[test]
    fn test_nft_transfer() {
        let (env, _cid, client, _admin, pid, token, token_client) = setup_donation();
        let donor = Address::generate(&env);
        let friend = Address::generate(&env);
        let amount = 10 * STROOP;
        mint_to(&env, &token_client, &donor, amount);
        client.donate(&token, &donor, &pid, &amount, &0u32);

        let token_id = client
            .get_token_id(&donor, &BadgeTier::Seedling)
            .expect("badge must be minted");
        client.transfer(&donor, &friend, &token_id);

        assert_eq!(client.balance_of(&donor), 0);
        assert_eq!(client.balance_of(&friend), 1);
        assert_eq!(client.owner_of(&token_id), friend);
        assert_eq!(client.token_metadata(&token_id).owner, friend);
        assert!(!client.has_nft(&donor, &BadgeTier::Seedling));
        assert!(client.has_nft(&friend, &BadgeTier::Seedling));
        assert_eq!(client.get_token_id(&donor, &BadgeTier::Seedling), None);
        assert_eq!(
            client.get_token_id(&friend, &BadgeTier::Seedling),
            Some(token_id)
        );
        assert_eq!(client.tokens_of(&friend), vec![&env, token_id]);

        // The original donor's badge tier is unchanged — the badge tier
        // reflects giving history, not token ownership.
        assert_eq!(client.get_badge(&donor), BadgeTier::Seedling);
    }

    /// A transfer to a recipient who earned the same tier themselves keeps
    /// both tokens: the recipient ends up owning their own badge and the
    /// transferred one.
    #[test]
    fn test_nft_transfer_preserves_recipients_own_same_tier_badge() {
        let (env, _cid, client, _admin, pid, token, token_client) = setup_donation();
        let donor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let amount = 10 * STROOP; // Seedling
        mint_to(&env, &token_client, &donor, amount);
        client.donate(&token, &donor, &pid, &amount, &0u32);
        let donor_token = client
            .get_token_id(&donor, &BadgeTier::Seedling)
            .expect("donor badge must be minted");

        // The recipient earned Seedling too.
        mint_to(&env, &token_client, &recipient, amount);
        client.donate(&token, &recipient, &pid, &amount, &0u32);
        let recipient_token = client
            .get_token_id(&recipient, &BadgeTier::Seedling)
            .expect("recipient badge must be minted");
        assert_ne!(donor_token, recipient_token);
        assert_eq!(client.balance_of(&recipient), 1);

        // The donor transfers their badge to the recipient.
        client.transfer(&donor, &recipient, &donor_token);

        assert_eq!(client.balance_of(&donor), 0);
        assert_eq!(client.balance_of(&recipient), 2);
        assert_eq!(client.owner_of(&recipient_token), recipient);
        assert_eq!(client.owner_of(&donor_token), recipient);
        assert_eq!(
            client.tokens_of(&recipient),
            vec![&env, recipient_token, donor_token]
        );
        assert!(client.has_nft(&recipient, &BadgeTier::Seedling));
    }

    /// Only the current owner may transfer a badge token.
    #[test]
    #[should_panic(expected = "Only the token owner can transfer it")]
    fn test_nft_transfer_rejects_non_owner() {
        let (env, _cid, client, _admin, pid, token, token_client) = setup_donation();
        let donor = Address::generate(&env);
        let attacker = Address::generate(&env);
        let other = Address::generate(&env);
        let amount = 10 * STROOP;
        mint_to(&env, &token_client, &donor, amount);
        client.donate(&token, &donor, &pid, &amount, &0u32);

        let token_id = client
            .get_token_id(&donor, &BadgeTier::Seedling)
            .expect("badge must be minted");
        // `attacker` is not the owner; the transfer must panic before any
        // state change.
        client.transfer(&attacker, &other, &token_id);
    }

    /// Badges minted before the NFT interface existed (legacy
    /// `ImpactNFT(donor, tier)` markers only) are discovered and materialized
    /// by the standard interface on first query — `balance_of`, `owner_of`,
    /// and `transfer` all see them, not just `has_nft`.
    #[test]
    fn test_nft_legacy_marker_discoverable_via_interface() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, GreenPayContract);
        let client = GreenPayContractClient::new(&env, &cid);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        let donor = Address::generate(&env);

        // Simulate a pre-interface deployment: only the legacy marker exists,
        // with no token registry entries.
        env.as_contract(&cid, || {
            env.storage().persistent().set(
                &DataKey::ImpactNFT(donor.clone(), BadgeTier::Seedling),
                &ImpactNFT {
                    owner: donor.clone(),
                    tier: BadgeTier::Seedling,
                    total_donated: 10 * STROOP,
                    minted_at_ledger: 1,
                },
            );
        });

        // The standard interface discovers it and materializes a real token.
        assert_eq!(client.balance_of(&donor), 1);
        let token_id = client
            .get_token_id(&donor, &BadgeTier::Seedling)
            .expect("legacy badge must backfill into the token registry");
        assert_eq!(client.owner_of(&token_id), donor);
        assert_eq!(client.token_metadata(&token_id).total_donated, 10 * STROOP);
        assert_eq!(client.total_supply(), 1);

        // And it is transferable like any other token.
        let friend = Address::generate(&env);
        client.transfer(&donor, &friend, &token_id);
        assert_eq!(client.owner_of(&token_id), friend);
        assert_eq!(client.balance_of(&donor), 0);
        assert_eq!(client.balance_of(&friend), 1);
        assert!(client.has_nft(&friend, &BadgeTier::Seedling));
    }

    #[test]
    fn test_version_exposed_and_default_v1() {
        let env = Env::default();
        let cid = env.register_contract(None, GreenPayContract);
        let client = GreenPayContractClient::new(&env, &cid);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        assert_eq!(client.get_version(), 1);
        assert_eq!(client.version(), 1);
    }

    #[test]
    fn test_storage_lifetimes_instance_vs_persistent() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, GreenPayContract);
        let client = GreenPayContractClient::new(&env, &cid);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let p1 = String::from_str(&env, "proj-ttl-1");
        let w = Address::generate(&env);
        client.register_project(&admin, &p1, &String::from_str(&env, "P TTL"), &w, &10);

        // Verify version key lives in instance storage, project in persistent
        env.as_contract(&cid, || {
            assert!(env.storage().instance().has(&DataKey::Version));
            assert!(env.storage().persistent().has(&DataKey::Project(p1)));
        });
    }
}
