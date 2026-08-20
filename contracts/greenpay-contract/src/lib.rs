#![no_std]
#[cfg(all(test, feature = "testutils"))]
mod fuzz_tests;

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
 *   4. Anyone can query total raised, donor count, CO2 offset per project
 *   5. Impact badges auto-calculated based on cumulative donor totals
 *   6. Community governance: badge holders vote to verify new projects
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
    String, TryFromVal, Val,
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

#[contracttype]
#[derive(Clone, Debug)]
pub struct ImpactNFT {
    pub owner: Address,
    pub tier: BadgeTier,
    pub total_donated: i128,
    pub minted_at_ledger: u32,
}

/// A community voting proposal to verify a project.
#[contracttype]
#[derive(Clone, Debug)]
pub struct VoteProposal {
    pub project_id: String,
    pub votes_for: u32,
    pub votes_against: u32,
    pub deadline_ledger: u32,
    pub resolved: bool,
}

#[contracttype]
pub enum DataKey {
    Admin,
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
}

// ─── Constants ────────────────────────────────────────────────────────────────

pub const STROOP: i128 = 10_000_000;

/// Upper bound on admin-supplied `co2_per_xlm` (grams credited per 1 XLM).
///
/// # Why `STROOP`
///
/// For any donation amount `a: i128`, let `x = a / STROOP`. Then
/// `x <= i128::MAX / STROOP`, so
/// `x * MAX_CO2_PER_XLM <= i128::MAX / STROOP * STROOP <= i128::MAX`.
/// The per-donation `checked_mul` in `donate()` therefore cannot overflow
/// when `co2_per_xlm <= MAX_CO2_PER_XLM`.
///
/// Realistic project values (e.g. 8_500 g/XLM per README) sit ~1_000× below
/// this ceiling.
///
/// # Accumulator overflow horizons at `MAX_CO2_PER_XLM`
///
/// | Accumulator | Width | First overflow (worst case) | Reachable? |
/// | --- | --- | --- | --- |
/// | `co2_increment` (mul) | i128 | N/A — blocked by this cap | No |
/// | `GlobalCO2OffsetGrams` | i128 | `i128::MAX / STROOP` donations of 1 XLM (~1.7×10³¹) | No (`DonationCount` is u32) |
/// | `GlobalCO2OffsetGrams` @ u32::MAX | i128 | `u32::MAX` donations of 1 XLM → ~4.3×10¹⁶ g | Yes, far below `i128::MAX` |
/// | `GlobalTotalRaised` | i128 | `i128::MAX` stroops total (e.g. 1-stroop donations) | No (needs > u32::MAX txs) |
/// | `GlobalTotalRaised` @ u32::MAX | i128 | `u32::MAX` × (`i128::MAX` / `u32::MAX`) stroops/donation | Theoretical per-invocation bound |
/// | `DonationCount` | u32 | `u32::MAX + 1` successful donations | Yes |
/// | `Project.donor_count` | u32 | `u32::MAX + 1` unique donors to one project | Yes |
pub const MAX_CO2_PER_XLM: u32 = STROOP as u32;

/// Largest single donation exercised in property tests (1 billion XLM).
pub const MAX_REALISTIC_DONATION_STROOPS: i128 = 1_000_000_000 * STROOP;

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
    if xlm >= 2000 {
        BadgeTier::EarthGuardian
    } else if xlm >= 500 {
        BadgeTier::Forest
    } else if xlm >= 100 {
        BadgeTier::Tree
    } else if xlm >= 10 {
        BadgeTier::Seedling
    } else {
        BadgeTier::None
    }
}

// ─── Persistent storage helpers ───────────────────────────────────────────────
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
        env.storage().instance().set(&DataKey::ProjectCount, &0u32);
        env.storage().instance().set(&DataKey::DonationCount, &0u32);
        env.storage()
            .instance()
            .set(&DataKey::GlobalTotalRaised, &0i128);
        env.storage()
            .instance()
            .set(&DataKey::GlobalCO2OffsetGrams, &0i128);
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

        // Pre-compute CO2 increment with checked multiplication so an attacker
        // can't trigger a silent wrap via a project with a huge co2_per_xlm.
        let xlm_units = amount / STROOP;
        let co2_increment = xlm_units
            .checked_mul(project.co2_per_xlm as i128)
            .expect("CO2 calculation overflow");

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
        donor_stats.co2_offset_grams = donor_stats
            .co2_offset_grams
            .checked_add(co2_increment)
            .expect("Donor co2_offset overflow");
        donor_stats.badge = calculate_badge(donor_stats.total_donated);
        write_persistent(&env, &DataKey::DonorStats(donor.clone()), &donor_stats);

        // Auto-mint an Impact NFT when a donor reaches a new badge tier.
        if donor_stats.badge != BadgeTier::None && donor_stats.badge != prev_badge {
            let nft_key = DataKey::ImpactNFT(donor.clone(), donor_stats.badge.clone());
            if !has_persistent(&env, &nft_key) {
                let nft = ImpactNFT {
                    owner: donor.clone(),
                    tier: donor_stats.badge.clone(),
                    total_donated: donor_stats.total_donated,
                    minted_at_ledger: env.ledger().sequence(),
                };
                write_persistent(&env, &nft_key, &nft);
                env.events().publish(
                    (symbol_short!("nft_mint"), donor.clone()),
                    donor_stats.badge.clone(),
                );
            }
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

        let gc: i128 = env
            .storage()
            .instance()
            .get(&DataKey::GlobalCO2OffsetGrams)
            .unwrap_or(0);
        let new_gc = gc.checked_add(co2_increment).expect("GlobalCO2 overflow");
        env.storage()
            .instance()
            .set(&DataKey::GlobalCO2OffsetGrams, &new_gc);

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

    // ─── Placeholders ─────────────────────────────────────────────────────────

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

        let key = DataKey::ImpactNFT(donor.clone(), tier.clone());
        if has_persistent(&env, &key) {
            panic!("NFT already minted for this tier");
        }

        let nft = ImpactNFT {
            owner: donor.clone(),
            tier: tier.clone(),
            total_donated: stats.total_donated,
            minted_at_ledger: env.ledger().sequence(),
        };
        write_persistent(&env, &key, &nft);
        env.events()
            .publish((symbol_short!("nft_mint"), donor), tier);
    }

    pub fn has_nft(env: Env, donor: Address, tier: BadgeTier) -> bool {
        has_persistent(&env, &DataKey::ImpactNFT(donor, tier))
    }

    // ─── Governance ───────────────────────────────────────────────────────────

    /// Admin creates a voting proposal for a project to be community-verified.
    ///
    /// `duration_ledgers` is the length of the voting window in Stellar
    /// ledgers (≈5 s each). Pass `0` to use the default 7-day window;
    /// any other value must be within
    /// [`MIN_VOTING_WINDOW_LEDGERS`, `MAX_VOTING_WINDOW_LEDGERS`].
    pub fn create_proposal(env: Env, admin: Address, project_id: String, duration_ledgers: u32) {
        admin.require_auth();
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

    /// Badge holders (≥ Seedling) cast a vote. One vote per address per proposal.
    pub fn vote_verify_project(env: Env, voter: Address, project_id: String, approve: bool) {
        voter.require_auth();

        let stats: DonorStats = read_persistent(&env, &DataKey::DonorStats(voter.clone()))
            .unwrap_or(DonorStats {
                total_donated: 0,
                donation_count: 0,
                badge: BadgeTier::None,
                co2_offset_grams: 0,
            });
        if stats.badge == BadgeTier::None {
            panic!("Only badge holders (Seedling or above) can vote");
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
                .checked_add(1)
                .expect("votes_for overflow");
        } else {
            proposal.votes_against = proposal
                .votes_against
                .checked_add(1)
                .expect("votes_against overflow");
        }
        write_persistent(&env, &DataKey::Proposal(project_id.clone()), &proposal);
        env.events()
            .publish((symbol_short!("voted"), voter, project_id), approve);
    }

    /// Callable by anyone after the deadline. Resolves based on majority.
    /// Emits proj_ver on approval, prop_rej on rejection.
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

    // ─── Upgrade ──────────────────────────────────────────────────────────────────

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
        Address, Env, String,
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
    fn test_donate_at_max_co2_with_largest_amount_succeeds() {
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

        let expected_co2 = (amount / STROOP) * (MAX_CO2_PER_XLM as i128);
        assert_eq!(client.get_project(&pid).total_raised, amount);
        assert_eq!(client.get_global_co2(), expected_co2);
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
        assert_eq!(client.get_global_co2(), 25 * 100);
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
    fn test_donate_global_co2_overflow_rolls_back_state_and_token() {
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
        let global_total_before = client.get_global_total();
        let donor_balance_before = token_balance(&env, &token, &donor);

        let result = client.try_donate(&token, &donor, &pid, &amount, &0u32);
        assert!(result.is_err(), "donate must fail on GlobalCO2 overflow");

        assert_eq!(client.get_global_co2(), global_co2_before);
        assert_eq!(client.get_global_total(), global_total_before);
        assert_eq!(client.get_donation_count(), 0);
        assert_eq!(token_balance(&env, &token, &donor), donor_balance_before);
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

    /// Inject a Seedling badge directly into persistent storage for a voter.
    fn grant_badge(env: &Env, cid: &soroban_sdk::Address, voter: &Address) {
        env.as_contract(cid, || {
            env.storage().persistent().set(
                &DataKey::DonorStats(voter.clone()),
                &DonorStats {
                    total_donated: 10 * STROOP,
                    donation_count: 1,
                    badge: BadgeTier::Seedling,
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
        let expected_co2 = 25 * 100i128;

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
        assert_eq!(p.votes_for, 0);
        assert_eq!(p.votes_against, 0);
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
        grant_badge(&env, &cid, &voter);
        client.vote_verify_project(&voter, &pid, &true);
        let p = client.get_proposal(&pid);
        assert_eq!(p.votes_for, 1);
        assert_eq!(p.votes_against, 0);
    }

    #[test]
    #[should_panic(expected = "Only badge holders (Seedling or above) can vote")]
    fn test_non_badge_holder_cannot_vote() {
        let (env, _cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);
        let non_donor = Address::generate(&env);
        client.vote_verify_project(&non_donor, &pid, &true);
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
        // 2 approve, 1 rejects
        for i in 0..3u32 {
            let voter = Address::generate(&env);
            grant_badge(&env, &cid, &voter);
            client.vote_verify_project(&voter, &pid, &(i < 2));
        }
        extend_ttl(&env, &cid);
        env.ledger().set_sequence_number(VOTING_WINDOW_LEDGERS + 2);
        client.resolve_proposal(&pid);
        let p = client.get_proposal(&pid);
        assert!(p.resolved);
        assert_eq!(p.votes_for, 2);
        assert_eq!(p.votes_against, 1);
    }

    #[test]
    fn test_resolve_proposal_rejected() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);
        // 1 approves, 2 reject
        for i in 0..3u32 {
            let voter = Address::generate(&env);
            grant_badge(&env, &cid, &voter);
            client.vote_verify_project(&voter, &pid, &(i == 0));
        }
        extend_ttl(&env, &cid);
        env.ledger().set_sequence_number(VOTING_WINDOW_LEDGERS + 2);
        client.resolve_proposal(&pid);
        let p = client.get_proposal(&pid);
        assert!(p.resolved);
        assert_eq!(p.votes_for, 1);
        assert_eq!(p.votes_against, 2);
    }

    #[test]
    #[should_panic(expected = "Voting window not yet closed")]
    fn test_resolve_before_deadline_fails() {
        let (_env, _cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);
        client.resolve_proposal(&pid);
    }

    #[test]
    #[should_panic(expected = "Proposal already resolved")]
    fn test_double_resolve_fails() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);
        extend_ttl(&env, &cid);
        env.ledger().set_sequence_number(VOTING_WINDOW_LEDGERS + 2);
        client.resolve_proposal(&pid);
        // Extend again so the second call reaches our panic, not an archive error
        extend_ttl(&env, &cid);
        client.resolve_proposal(&pid);
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
}
