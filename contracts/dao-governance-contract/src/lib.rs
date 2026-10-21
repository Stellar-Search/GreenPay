#![no_std]
#[cfg(all(test, feature = "testutils"))]
mod governance_property_tests;
#[cfg(all(test, feature = "testutils"))]
mod property_tests;

use soroban_sdk::{
    contract, contractimpl, contracttype, token, vec, Address, Bytes, BytesN, Env, IntoVal, String,
    Symbol,
};

// ─── Constants ───────────────────────────────────────────────────────────────

/// 4 years × 365 days × 24 h × 3600 s ÷ 5 s per ledger
const MAX_LOCK_LEDGERS: u32 = 2_102_400;

/// 7 days × 24 h × 3600 s ÷ 5 s per ledger
const MIN_LOCK_LEDGERS: u32 = 120_960;

/// Minimum voting window (7 days)
const MIN_VOTING_WINDOW: u32 = 120_960;

// ─── Data types ──────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub struct Lock {
    pub amount: i128,
    pub unlock_ledger: u32,
    pub created_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum ProposalStage {
    Discussion,
    SnapshotVote,
    Execution,
    Defeated,
    Executed,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Proposal {
    pub id: u64,
    pub title: String,
    pub description: String,
    pub target_contract: Address,
    pub function: Symbol,
    pub calldata: Bytes,
    pub proposer: Address,
    pub stage: ProposalStage,
    pub snapshot_ledger: u32,
    pub vote_end_ledger: u32,
    pub votes_for: i128,
    pub votes_against: i128,
    /// Absolute vote total required for approval, computed as
    /// `quorum_bps` × total locked tokens at `advance_to_snapshot` time and
    /// frozen on the proposal so a mid-vote change in locked supply cannot
    /// move the goalposts. Zero when no tokens are locked at the snapshot.
    pub quorum_requirement: i128,
    pub executable_from_ledger: u32,
    pub created_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Config {
    pub gp_token: Address,
    /// Quorum expressed in basis points (1/10000) of the total locked GP
    /// supply at the proposal's snapshot — e.g. 500 means a proposal needs
    /// votes totalling at least 5% of locked tokens to pass. Replaces the
    /// original absolute vote count, which drifted out of calibration as the
    /// DAO's locked supply grew or shrank.
    pub quorum_bps: i128,
    pub voting_period_ledgers: u32,
    pub timelock_ledgers: u32,
    pub dao_admin: Address,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub voting_power: i128,
}

/// Immutable record of a voter's lock state at a specific ledger, written on
/// every `lock_tokens` and `extend_lock` call.  `get_voting_power` resolves
/// historical queries against these checkpoints rather than the live, mutable
/// `Lock` record — preventing retroactive inflation via `extend_lock` after a
/// proposal's snapshot has already been taken.
///
/// # `effective_from_ledger` semantics
///
/// * `lock_tokens` sets `effective_from_ledger = checkpoint_ledger`:
///   the lock is valid starting at the ledger it was created, so a snapshot
///   taken in the same ledger correctly sees the initial power.
///
/// * `extend_lock` sets `effective_from_ledger = checkpoint_ledger + 1`:
///   an extension called within the same ledger as a snapshot must NOT
///   retroactively inflate the power counted for that snapshot.  The extended
///   unlock_ledger only takes effect from the following ledger onward.
#[contracttype]
#[derive(Clone, Debug)]
pub struct LockCheckpoint {
    /// First ledger at which this checkpoint's lock state is canonical.
    /// See struct-level docs for the difference between lock and extend paths.
    pub effective_from_ledger: u32,
    /// Token amount locked (unchanged by extension).
    pub amount: i128,
    /// `unlock_ledger` as it stood when this checkpoint was written.
    pub unlock_ledger: u32,
    /// `created_ledger` of the original lock (unchanged by extension).
    pub created_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct MigrationState {
    pub target_version: u32,
    pub cursor: u32,
    pub total_items: u64,
    pub completed: bool,
}

#[contracttype]
pub enum DataKey {
    Config,
    Version,
    MigrationState,
    Lock(Address),
    Proposal(u64),
    Snapshot(u64, Address),
    ProposalCount,
    AllowedTarget(Address, Symbol),
    /// Monotonically-increasing count of checkpoints recorded for a voter.
    /// Stored in instance storage so it shares the contract's TTL.
    LockCheckpointCount(Address),
    /// The n-th checkpoint for a voter (0-indexed).
    LockCheckpoint(Address, u32),
    /// Incrementally-maintained sum of all locked token amounts (updated on
    /// `lock_tokens` and `withdraw`). Used as the denominator for the
    /// proportional quorum so it never requires iterating over lockers.
    TotalLocked,
    Paused,
}

pub const CONTRACT_VERSION: u32 = 1;

// ─── Contract ────────────────────────────────────────────────────────────────

#[contract]
pub struct DaoGovernanceContract;

#[contractimpl]
impl DaoGovernanceContract {
    // ─── Requirement 1: Initialisation ─────────────────────────────────────

    pub fn initialize(
        env: Env,
        gp_token: Address,
        quorum_bps: i128,
        voting_period_ledgers: u32,
        timelock_ledgers: u32,
        dao_admin: Address,
    ) {
        if env.storage().instance().has(&DataKey::Config) {
            panic!("already initialized");
        }
        if quorum_bps <= 0 {
            panic!("quorum must be positive");
        }
        if voting_period_ledgers < MIN_VOTING_WINDOW {
            panic!("voting period too short");
        }
        if timelock_ledgers == 0 {
            panic!("timelock must be positive");
        }
        let config = Config {
            gp_token,
            quorum_bps,
            voting_period_ledgers,
            timelock_ledgers,
            dao_admin,
        };
        env.storage().instance().set(&DataKey::Config, &config);
        env.storage()
            .instance()
            .set(&DataKey::Version, &CONTRACT_VERSION);
        env.storage().instance().set(&DataKey::ProposalCount, &0u64);
        env.storage().instance().set(&DataKey::TotalLocked, &0i128);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage()
            .instance()
            .extend_ttl(MIN_VOTING_WINDOW, MAX_LOCK_LEDGERS);
        env.events().publish((Symbol::new(&env, "init"),), config);
    }

    /// Exposes the contract's current schema version to off-chain consumers and governance tools.
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

    pub fn get_config(env: Env) -> Config {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .expect("not initialized")
    }

    // ─── Requirement 2: GP Token Locking ───────────────────────────────────

    pub fn lock_tokens(env: Env, voter: Address, amount: i128, lock_duration_ledgers: u32) {
        voter.require_auth();
        Self::require_not_paused(&env);
        if amount <= 0 {
            panic!("amount must be positive");
        }
        if lock_duration_ledgers < MIN_LOCK_LEDGERS {
            panic!("lock duration too short");
        }
        if lock_duration_ledgers > MAX_LOCK_LEDGERS {
            panic!("lock duration too long");
        }

        let lock_key = DataKey::Lock(voter.clone());
        if env.storage().persistent().has(&lock_key) {
            let existing: Lock = env.storage().persistent().get(&lock_key).unwrap();
            if existing.unlock_ledger > env.ledger().sequence() {
                panic!("existing lock must be extended or expired");
            }
            // Replacing an expired lock: drop its amount from the running total
            // so the accumulator only reflects currently-locked tokens.
            adjust_total_locked(&env, -existing.amount);
        }

        let current_ledger = env.ledger().sequence();
        let unlock_ledger = current_ledger
            .checked_add(lock_duration_ledgers)
            .expect("unlock ledger overflow");

        let lock = Lock {
            amount,
            unlock_ledger,
            created_ledger: current_ledger,
        };
        env.storage().persistent().set(&lock_key, &lock);
        extend_persistent_ttl(&env, &lock_key);

        // Record an immutable checkpoint so historical voting-power queries
        // are not affected by future extend_lock calls.
        write_lock_checkpoint(&env, &voter, &lock, current_ledger);

        // Maintain the total-locked accumulator incrementally.
        adjust_total_locked(&env, amount);

        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .expect("not initialized");
        let token_client = token::Client::new(&env, &config.gp_token);
        token_client.transfer(&voter, &env.current_contract_address(), &amount);

        env.events().publish(
            (Symbol::new(&env, "locked"), voter),
            (amount, unlock_ledger),
        );
    }

    pub fn get_lock(env: Env, voter: Address) -> Lock {
        let lock_key = DataKey::Lock(voter.clone());
        if env.storage().persistent().has(&lock_key) {
            let lock: Lock = env.storage().persistent().get(&lock_key).unwrap();
            extend_persistent_ttl(&env, &lock_key);
            lock
        } else {
            Lock {
                amount: 0,
                unlock_ledger: 0,
                created_ledger: 0,
            }
        }
    }

    // ─── Requirement 3: Lock Extension ─────────────────────────────────────

    pub fn extend_lock(env: Env, voter: Address, new_unlock_ledger: u32) {
        voter.require_auth();
        Self::require_not_paused(&env);
        let lock_key = DataKey::Lock(voter.clone());
        if !env.storage().persistent().has(&lock_key) {
            panic!("no active lock");
        }
        let mut lock: Lock = env.storage().persistent().get(&lock_key).unwrap();
        if new_unlock_ledger <= lock.unlock_ledger {
            panic!("new unlock must be later");
        }
        let max_unlock = env
            .ledger()
            .sequence()
            .checked_add(MAX_LOCK_LEDGERS)
            .expect("max unlock overflow");
        if new_unlock_ledger > max_unlock {
            panic!("lock duration too long");
        }
        lock.unlock_ledger = new_unlock_ledger;
        env.storage().persistent().set(&lock_key, &lock);
        extend_persistent_ttl(&env, &lock_key);

        // Record an immutable checkpoint capturing the NEW unlock_ledger so
        // that any proposal snapshot taken after this ledger sees the extended
        // duration, while snapshots taken BEFORE this ledger continue to
        // resolve against the pre-extension checkpoint.
        // effective_from_ledger is set to sequence()+1 so that a snapshot
        // taken in the SAME ledger as this extend_lock sees the pre-extension
        // state, not the inflated unlock_ledger.
        let extend_ledger = env.ledger().sequence();
        write_lock_checkpoint(
            &env,
            &voter,
            &lock,
            extend_ledger
                .checked_add(1)
                .expect("checkpoint ledger overflow"),
        );

        env.events().publish(
            (Symbol::new(&env, "extend"), voter.clone()),
            new_unlock_ledger,
        );
    }

    // ─── Requirement 4: Token Withdrawal ───────────────────────────────────

    pub fn withdraw(env: Env, voter: Address) {
        voter.require_auth();
        Self::require_not_paused(&env);
        let lock_key = DataKey::Lock(voter.clone());
        if !env.storage().persistent().has(&lock_key) {
            panic!("no lock found");
        }
        let lock: Lock = env.storage().persistent().get(&lock_key).unwrap();
        if env.ledger().sequence() < lock.unlock_ledger {
            panic!("lock not yet expired");
        }
        let amount = lock.amount;
        env.storage().persistent().remove(&lock_key);

        // The withdrawn tokens are no longer locked — keep the accumulator in
        // sync so the quorum denominator tracks the outstanding supply.
        adjust_total_locked(&env, -amount);

        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .expect("not initialized");
        let token_client = token::Client::new(&env, &config.gp_token);
        token_client.transfer(&env.current_contract_address(), &voter, &amount);

        env.events()
            .publish((Symbol::new(&env, "withdrw"), voter), amount);
    }

    // ─── Requirement 5: Voting Power Calculation ───────────────────────────

    /// Returns the voting power of `voter` as it stood at `at_ledger`.
    ///
    /// # Security: checkpoint-based historical lookup
    ///
    /// Power is derived from the **checkpoint** whose `effective_from_ledger`
    /// is the highest value that is still `<= at_ledger`.  Checkpoints are
    /// written on every `lock_tokens` and `extend_lock` call, so the record
    /// found this way faithfully reflects the lock state that existed at the
    /// moment of the snapshot — regardless of any subsequent `extend_lock`
    /// mutations.  The live `Lock` record is consulted only as a fallback when
    /// no checkpoint predates `at_ledger` (which cannot happen in normal
    /// operation, but keeps the function correct for edge cases).
    pub fn get_voting_power(env: Env, voter: Address, at_ledger: u32) -> i128 {
        // Try to find the most-recent checkpoint whose effective_from_ledger <=
        // at_ledger by scanning backwards through the checkpoint array.
        let count_key = DataKey::LockCheckpointCount(voter.clone());
        let count: u32 = env.storage().instance().get(&count_key).unwrap_or(0u32);

        if count > 0 {
            // Linear scan from newest to oldest; checkpoints are appended in
            // effective_from_ledger order so we find the right one quickly.
            let mut i = count;
            loop {
                i -= 1;
                let cp_key = DataKey::LockCheckpoint(voter.clone(), i);
                if env.storage().persistent().has(&cp_key) {
                    let cp: LockCheckpoint = env.storage().persistent().get(&cp_key).unwrap();
                    extend_persistent_ttl(&env, &cp_key);
                    if cp.effective_from_ledger <= at_ledger {
                        // This is the checkpoint that was current at at_ledger.
                        if at_ledger >= cp.unlock_ledger || at_ledger < cp.created_ledger {
                            return 0;
                        }
                        let remaining = cp.unlock_ledger - at_ledger;
                        return (cp.amount * remaining as i128) / MAX_LOCK_LEDGERS as i128;
                    }
                }
                if i == 0 {
                    break;
                }
            }
            // All checkpoints became effective after at_ledger — voter had no
            // lock at that point (same as the created_ledger guard in old code).
            return 0;
        }

        // No checkpoints: fall back to the live Lock record (legacy path,
        // safe because no extend_lock has ever been called for this voter).
        let lock_key = DataKey::Lock(voter.clone());
        if !env.storage().persistent().has(&lock_key) {
            return 0;
        }
        let lock: Lock = env.storage().persistent().get(&lock_key).unwrap();
        extend_persistent_ttl(&env, &lock_key);
        if at_ledger >= lock.unlock_ledger || at_ledger < lock.created_ledger {
            return 0;
        }
        let remaining = lock.unlock_ledger - at_ledger;
        (lock.amount * remaining as i128) / MAX_LOCK_LEDGERS as i128
    }

    pub fn get_snapshot_power(env: Env, voter: Address, proposal_id: u64) -> i128 {
        let snap_key = DataKey::Snapshot(proposal_id, voter.clone());
        if env.storage().persistent().has(&snap_key) {
            let snap: Snapshot = env.storage().persistent().get(&snap_key).unwrap();
            extend_persistent_ttl(&env, &snap_key);
            snap.voting_power
        } else {
            0
        }
    }

    /// Returns the total number of GP tokens currently locked in the contract,
    /// maintained incrementally on every `lock_tokens` / `withdraw` — never
    /// recomputed by iterating lockers. This is the denominator the
    /// proportional quorum is measured against.
    pub fn get_total_locked(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalLocked)
            .unwrap_or(0)
    }

    // ─── Execution Target Allowlist ─────────────────────────────────────────
    //
    // execute_proposal invokes proposal.target_contract/function with
    // proposer-supplied calldata. Without a restriction here, a successful
    // vote would let a proposal invoke arbitrary calldata against any
    // contract/function pair.
    //
    // Design & Admin Escape Hatch:
    // Only the dao_admin may change the allowlist. This design acts as an
    // administrative emergency circuit-breaker to block malicious, compromised,
    // or deprecated execution targets.
    //
    // Governance Risk & Mid-Flight Semantics:
    // The (target_contract, function) pair is validated both when a proposal is
    // created (preventing the creation of unexecutable proposals) and again
    // immediately prior to on-chain execution in `execute_proposal`.
    // Consequently, `dao_admin` has the authority to unilaterally veto a passed
    // proposal by removing its target from the allowlist before execution occurs.

    // ─── Emergency pause ────────────────────────────────────────────────────

    pub fn pause(env: Env, caller: Address) {
        caller.require_auth();
        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .expect("Not initialized");
        if config.dao_admin != caller {
            panic!("Only admin can pause");
        }
        env.storage().instance().set(&DataKey::Paused, &true);
    }

    pub fn unpause(env: Env, caller: Address) {
        caller.require_auth();
        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .expect("Not initialized");
        if config.dao_admin != caller {
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

    /// Adds a `(target_contract, function)` pair to the execution allowlist.
    ///
    /// # Access Control
    /// Restricted to `config.dao_admin`.
    ///
    /// # Admin Escape Hatch & Governance Risk
    /// The allowlist is designed as an administrative escape hatch and circuit-breaker.
    /// Adding an allowed target permits proposals to be created for and executed against
    /// this contract/function pair.
    pub fn add_allowed_target(
        env: Env,
        caller: Address,
        target_contract: Address,
        function: Symbol,
    ) {
        caller.require_auth();
        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .expect("not initialized");
        if caller != config.dao_admin {
            panic!("not authorised to modify allowlist");
        }
        let key = DataKey::AllowedTarget(target_contract.clone(), function.clone());
        env.storage().persistent().set(&key, &true);
        extend_persistent_ttl(&env, &key);
        env.events()
            .publish((Symbol::new(&env, "tgt_add"),), (target_contract, function));
    }

    /// Removes a `(target_contract, function)` pair from the execution allowlist.
    ///
    /// # Access Control
    /// Restricted to `config.dao_admin`.
    ///
    /// # Mid-Flight Semantics & Emergency Veto
    /// If an allowlist entry is removed while a proposal is in-flight (Discussion,
    /// Voting, or Timelocked Execution), `execute_proposal` will fail with
    /// `"target/function not allowlisted"`. This provides an emergency circuit-breaker
    /// for the DAO admin to halt execution of approved proposals targeting compromised
    /// contracts, while intentionally introducing an administrative veto risk.
    pub fn remove_allowed_target(
        env: Env,
        caller: Address,
        target_contract: Address,
        function: Symbol,
    ) {
        caller.require_auth();
        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .expect("not initialized");
        if caller != config.dao_admin {
            panic!("not authorised to modify allowlist");
        }
        let key = DataKey::AllowedTarget(target_contract.clone(), function.clone());
        env.storage().persistent().remove(&key);
        env.events()
            .publish((Symbol::new(&env, "tgt_rmv"),), (target_contract, function));
    }

    /// Queries whether a `(target_contract, function)` pair is currently allowlisted.
    pub fn is_allowed_target(env: Env, target_contract: Address, function: Symbol) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::AllowedTarget(target_contract, function))
    }

    // ─── Requirement 6: Proposal Creation ──────────────────────────────────

    /// Creates a new proposal in the `Discussion` stage.
    ///
    /// # Proposal Target Allowlist Check
    /// Rejects proposal creation immediately if `(target_contract, function)`
    /// is not present in the allowlist (`DataKey::AllowedTarget`), preventing
    /// the DAO from spending voting and discussion cycles on unexecutable proposals.
    pub fn create_proposal(
        env: Env,
        proposer: Address,
        title: String,
        description: String,
        target_contract: Address,
        function: Symbol,
        calldata: Bytes,
    ) -> u64 {
        proposer.require_auth();
        Self::require_not_paused(&env);
        let current = env.ledger().sequence();
        let power = Self::get_voting_power(env.clone(), proposer.clone(), current);
        if power <= 0 {
            panic!("insufficient voting power to propose");
        }
        let allow_key = DataKey::AllowedTarget(target_contract.clone(), function.clone());
        if !env.storage().persistent().has(&allow_key) {
            panic!("target/function not allowlisted");
        }
        extend_persistent_ttl(&env, &allow_key);
        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0);
        let proposal_id = count.checked_add(1).expect("proposal id overflow");
        let proposal = Proposal {
            id: proposal_id,
            title,
            description,
            target_contract,
            function,
            calldata,
            proposer,
            stage: ProposalStage::Discussion,
            snapshot_ledger: 0,
            vote_end_ledger: 0,
            votes_for: 0,
            votes_against: 0,
            quorum_requirement: 0, // set when the proposal advances to snapshot
            executable_from_ledger: 0,
            created_ledger: current,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        extend_persistent_ttl(&env, &DataKey::Proposal(proposal_id));
        env.storage()
            .instance()
            .set(&DataKey::ProposalCount, &proposal_id);
        env.storage()
            .instance()
            .extend_ttl(MIN_VOTING_WINDOW, MAX_LOCK_LEDGERS);
        env.events()
            .publish((Symbol::new(&env, "prop_new"), proposal_id), ());
        proposal_id
    }

    pub fn get_proposal(env: Env, proposal_id: u64) -> Proposal {
        let key = DataKey::Proposal(proposal_id);
        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&key)
            .expect("proposal not found");
        extend_persistent_ttl(&env, &key);
        proposal
    }

    pub fn get_proposal_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0)
    }

    // ─── Requirement 7: Discussion → Snapshot ──────────────────────────────

    pub fn advance_to_snapshot(env: Env, caller: Address, proposal_id: u64) {
        caller.require_auth();
        let key = DataKey::Proposal(proposal_id);
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&key)
            .expect("proposal not found");
        if proposal.stage != ProposalStage::Discussion {
            panic!("invalid stage transition");
        }
        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .expect("not initialized");
        if caller != config.dao_admin {
            let power =
                Self::get_voting_power(env.clone(), caller.clone(), env.ledger().sequence());
            if power <= 0 {
                panic!("not authorised to advance proposal");
            }
        }
        let current = env.ledger().sequence();
        proposal.stage = ProposalStage::SnapshotVote;
        proposal.snapshot_ledger = current;
        proposal.vote_end_ledger = current
            .checked_add(config.voting_period_ledgers)
            .expect("vote end overflow");
        proposal.votes_for = 0;
        proposal.votes_against = 0;

        // Freeze the quorum threshold at the snapshot: a proportion of the
        // total locked supply as it stands NOW, so locked tokens added or
        // withdrawn mid-vote cannot move the goalposts.
        let total_locked: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalLocked)
            .unwrap_or(0);
        proposal.quorum_requirement = (total_locked
            .checked_mul(config.quorum_bps)
            .expect("quorum requirement overflow"))
            / 10000;

        env.storage().persistent().set(&key, &proposal);
        extend_persistent_ttl(&env, &key);
        env.events().publish(
            (Symbol::new(&env, "snap_str"), proposal_id),
            (proposal.snapshot_ledger, proposal.vote_end_ledger),
        );
    }

    // ─── Requirement 8: Snapshotted Voting ─────────────────────────────────

    pub fn cast_vote(env: Env, voter: Address, proposal_id: u64, approve: bool) {
        voter.require_auth();
        let key = DataKey::Proposal(proposal_id);
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&key)
            .expect("proposal not found");
        if proposal.stage != ProposalStage::SnapshotVote {
            panic!("voting not active");
        }
        if env.ledger().sequence() > proposal.vote_end_ledger {
            panic!("voting period closed");
        }
        let snap_key = DataKey::Snapshot(proposal_id, voter.clone());
        if env.storage().persistent().has(&snap_key) {
            panic!("already voted");
        }
        let power = Self::get_voting_power(env.clone(), voter.clone(), proposal.snapshot_ledger);
        if power <= 0 {
            panic!("no voting power at snapshot");
        }
        let snapshot = Snapshot {
            voting_power: power,
        };
        env.storage().persistent().set(&snap_key, &snapshot);
        extend_persistent_ttl(&env, &snap_key);

        if approve {
            proposal.votes_for = proposal
                .votes_for
                .checked_add(power)
                .expect("votes_for overflow");
        } else {
            proposal.votes_against = proposal
                .votes_against
                .checked_add(power)
                .expect("votes_against overflow");
        }
        env.storage().persistent().set(&key, &proposal);
        extend_persistent_ttl(&env, &key);
        env.events().publish(
            (Symbol::new(&env, "vote_cst"), proposal_id, voter),
            (approve, power),
        );
    }

    // ─── Requirement 9: Snapshot → Execution / Defeated ────────────────────

    pub fn finalise_vote(env: Env, proposal_id: u64) {
        let key = DataKey::Proposal(proposal_id);
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&key)
            .expect("proposal not found");
        if proposal.stage != ProposalStage::SnapshotVote {
            panic!("invalid stage transition");
        }
        if env.ledger().sequence() <= proposal.vote_end_ledger {
            panic!("voting period not closed");
        }
        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .expect("not initialized");

        let total_votes = proposal
            .votes_for
            .checked_add(proposal.votes_against)
            .expect("total votes overflow");

        // Quorum is the proportion of the total locked supply frozen on the
        // proposal at its snapshot, not a fixed absolute count.
        let approved = total_votes >= proposal.quorum_requirement
            && proposal.votes_for > proposal.votes_against;

        if approved {
            let current = env.ledger().sequence();
            proposal.stage = ProposalStage::Execution;
            proposal.executable_from_ledger = current
                .checked_add(config.timelock_ledgers)
                .expect("timelock overflow");
            env.storage().persistent().set(&key, &proposal);
            extend_persistent_ttl(&env, &key);
            env.events().publish(
                (Symbol::new(&env, "vote_fnl"), proposal_id),
                (proposal.votes_for, proposal.votes_against),
            );
        } else {
            proposal.stage = ProposalStage::Defeated;
            env.storage().persistent().set(&key, &proposal);
            extend_persistent_ttl(&env, &key);
            env.events().publish(
                (Symbol::new(&env, "prop_dft"), proposal_id),
                (proposal.votes_for, proposal.votes_against),
            );
        }
    }

    // ─── Requirement 10: On-Chain Execution ────────────────────────────────

    /// Executes an approved proposal once its timelock has elapsed.
    ///
    /// # Dual-Validation Allowlist Check & Admin Circuit Breaker
    /// Re-validates that `(target_contract, function)` remains allowlisted at execution
    /// time. If `dao_admin` removed the target entry mid-flight (during discussion,
    /// voting, or timelock), execution panics with `"target/function not allowlisted"`.
    pub fn execute_proposal(env: Env, proposal_id: u64) {
        Self::require_not_paused(&env);
        let key = DataKey::Proposal(proposal_id);
        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&key)
            .expect("proposal not found");
        if proposal.stage != ProposalStage::Execution {
            panic!("proposal not executable");
        }
        if env.ledger().sequence() < proposal.executable_from_ledger {
            panic!("timelock not elapsed");
        }
        let allow_key =
            DataKey::AllowedTarget(proposal.target_contract.clone(), proposal.function.clone());
        if !env.storage().persistent().has(&allow_key) {
            panic!("target/function not allowlisted");
        }
        let args = vec![&env, proposal.calldata.into_val(&env)];
        env.invoke_contract::<()>(&proposal.target_contract, &proposal.function, args);

        let mut executed = proposal;
        executed.stage = ProposalStage::Executed;
        env.storage().persistent().set(&key, &executed);
        extend_persistent_ttl(&env, &key);
        env.events()
            .publish((Symbol::new(&env, "executed"), proposal_id), ());
    }

    // ─── Requirement 11: On-Chain Upgrade & Schema Migration ───────────────────

    /// Replaces the contract's WASM with a new hash.
    /// Only the `dao_admin` (set at `initialize`) may call this.
    /// For on-chain governance, route calls through `execute_proposal`.
    /// Emits an `upgraded` event containing the new hash.
    pub fn upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>) {
        caller.require_auth();
        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .expect("not initialized");
        if caller != config.dao_admin {
            panic!("only dao_admin can upgrade");
        }
        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());
        env.events()
            .publish((Symbol::new(&env, "upgraded"), caller), new_wasm_hash);
    }

    /// Replaces contract WASM and initiates an incremental schema migration.
    /// Returns the number of un-migrated items remaining (0 when complete).
    pub fn upgrade_and_migrate(
        env: Env,
        caller: Address,
        new_wasm_hash: BytesN<32>,
        new_version: u32,
        batch_limit: u32,
    ) -> u64 {
        caller.require_auth();
        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .expect("not initialized");
        if caller != config.dao_admin {
            panic!("only dao_admin can upgrade");
        }
        let current_v = Self::get_version(env.clone());
        if new_version <= current_v {
            panic!("new version must be greater than current version");
        }
        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());
        env.events().publish(
            (Symbol::new(&env, "upgraded"), caller.clone()),
            new_wasm_hash,
        );

        let total_proposals: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0);

        let state = MigrationState {
            target_version: new_version,
            cursor: 0,
            total_items: total_proposals,
            completed: total_proposals == 0,
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
    pub fn migrate_schema(env: Env, caller: Address, batch_limit: u32) -> u64 {
        caller.require_auth();
        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .expect("not initialized");
        if caller != config.dao_admin {
            panic!("only dao_admin can migrate");
        }
        let state: MigrationState = env
            .storage()
            .instance()
            .get(&DataKey::MigrationState)
            .expect("no pending migration");

        if state.completed {
            return 0;
        }

        Self::execute_migration_batch(&env, state, batch_limit)
    }

    /// Returns the current pending or completed migration state.
    pub fn get_migration_state(env: Env) -> Option<MigrationState> {
        env.storage().instance().get(&DataKey::MigrationState)
    }

    fn execute_migration_batch(env: &Env, mut state: MigrationState, batch_limit: u32) -> u64 {
        let batch_size = if batch_limit == 0 {
            1
        } else {
            batch_limit as u64
        };
        let mut processed = 0u64;

        while processed < batch_size && (state.cursor as u64) < state.total_items {
            state.cursor += 1;
            processed += 1;
        }

        if (state.cursor as u64) >= state.total_items {
            state.completed = true;
            env.storage()
                .instance()
                .set(&DataKey::Version, &state.target_version);
        }
        env.storage()
            .instance()
            .set(&DataKey::MigrationState, &state);
        state.total_items.saturating_sub(state.cursor as u64)
    }

    // ─── Requirement 12: DAO-Governed Config Update ───────────────────────────

    /// Updates the DAO configuration parameters (quorum, voting period, timelock, etc.).
    ///
    /// # Authorization
    /// Must be authorized by the DAO contract itself (`env.current_contract_address().require_auth()`),
    /// ensuring configuration updates can only be executed via a successful, passed DAO proposal.
    ///
    /// # Bounds checks
    /// * `quorum_bps`: must be > 0 and <= 10_000 (100%).
    /// * `voting_period_ledgers`: must be >= `MIN_VOTING_WINDOW` (120_960 ledgers).
    /// * `timelock_ledgers`: must be > 0.
    pub fn set_config(env: Env, new_config: Config) {
        env.current_contract_address().require_auth();
        if new_config.quorum_bps <= 0 {
            panic!("quorum must be positive");
        }
        if new_config.quorum_bps > 10_000 {
            panic!("quorum too high");
        }
        if new_config.voting_period_ledgers < MIN_VOTING_WINDOW {
            panic!("voting period too short");
        }
        if new_config.timelock_ledgers == 0 {
            panic!("timelock must be positive");
        }
        env.storage().instance().set(&DataKey::Config, &new_config);
        env.storage()
            .instance()
            .extend_ttl(MIN_VOTING_WINDOW, MAX_LOCK_LEDGERS);
        env.events()
            .publish((Symbol::new(&env, "set_cfg"),), new_config);
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn extend_persistent_ttl(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, MIN_VOTING_WINDOW, MAX_LOCK_LEDGERS);
}

/// Record a point-in-time snapshot of a voter's lock state.
///
/// `effective_from_ledger` controls when this checkpoint becomes canonical:
/// * Pass `env.ledger().sequence()` from `lock_tokens` — a newly-created lock
///   is valid starting from its creation ledger.
/// * Pass `env.ledger().sequence() + 1` from `extend_lock` — the extension
///   only takes effect from the next ledger, so a snapshot taken in the same
///   ledger as the extension sees the pre-extension state.
///
/// Adjust the incrementally-maintained total-locked accumulator by `delta`
/// (positive on `lock_tokens`, negative on `withdraw` and when an expired lock
/// is replaced). The accumulator can never go negative: every decrement is
/// paired with a lock that was previously added.
fn adjust_total_locked(env: &Env, delta: i128) {
    let current: i128 = env
        .storage()
        .instance()
        .get(&DataKey::TotalLocked)
        .unwrap_or(0);
    let updated = current.checked_add(delta).expect("total locked overflow");
    env.storage()
        .instance()
        .set(&DataKey::TotalLocked, &updated);
    env.storage()
        .instance()
        .extend_ttl(MIN_VOTING_WINDOW, MAX_LOCK_LEDGERS);
}

fn write_lock_checkpoint(env: &Env, voter: &Address, lock: &Lock, effective_from_ledger: u32) {
    // Read and increment the per-voter checkpoint counter.
    let count_key = DataKey::LockCheckpointCount(voter.clone());
    let index: u32 = env.storage().instance().get(&count_key).unwrap_or(0u32);

    let cp = LockCheckpoint {
        effective_from_ledger,
        amount: lock.amount,
        unlock_ledger: lock.unlock_ledger,
        created_ledger: lock.created_ledger,
    };
    let cp_key = DataKey::LockCheckpoint(voter.clone(), index);
    env.storage().persistent().set(&cp_key, &cp);
    extend_persistent_ttl(env, &cp_key);

    env.storage().instance().set(&count_key, &(index + 1));
    env.storage()
        .instance()
        .extend_ttl(MIN_VOTING_WINDOW, MAX_LOCK_LEDGERS);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger as _},
        token::{self, StellarAssetClient},
        Address, Env,
    };

    /// Quorum in basis points: 1000 bps = 10% of the total locked supply.
    const QUORUM_BPS: i128 = 1000;
    const VOTING_PERIOD: u32 = 121_000;
    const TIMELOCK: u32 = 10_000;

    #[contract]
    struct Noop;

    #[contractimpl]
    impl Noop {
        pub fn noop(_env: Env, _data: Bytes) {}
    }

    fn deploy_noop(env: &Env) -> Address {
        let addr = env.register_contract(None, Noop);
        env.as_contract(&addr, || {
            env.storage().instance().extend_ttl(1000000, 1000000);
        });
        addr
    }

    fn deploy(env: &Env) -> (Address, Config, DaoGovernanceContractClient<'static>) {
        let admin = Address::generate(env);
        let token_admin = Address::generate(env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        env.as_contract(&token, || {
            env.storage().instance().extend_ttl(1000000, 1000000);
        });
        let cid = env.register_contract(None, DaoGovernanceContract);
        let client = DaoGovernanceContractClient::new(env, &cid);
        client.initialize(&token, &QUORUM_BPS, &VOTING_PERIOD, &TIMELOCK, &admin);
        let config = Config {
            gp_token: token,
            quorum_bps: QUORUM_BPS,
            voting_period_ledgers: VOTING_PERIOD,
            timelock_ledgers: TIMELOCK,
            dao_admin: admin,
        };
        (cid, config, client)
    }

    fn mk_proposal(
        env: &Env,
        client: &DaoGovernanceContractClient<'static>,
        proposer: &Address,
    ) -> u64 {
        let target = Address::generate(env);
        let function = Symbol::new(env, "fn");
        let admin = client.get_config().dao_admin;
        client.add_allowed_target(&admin, &target, &function);
        client.create_proposal(
            proposer,
            &String::from_str(env, "Test"),
            &String::from_str(env, "Desc"),
            &target,
            &function,
            &Bytes::from_slice(env, &[1, 2, 3]),
        )
    }

    fn snapshot(client: &DaoGovernanceContractClient<'static>, caller: &Address, pid: u64) {
        client.advance_to_snapshot(caller, &pid);
    }

    fn vote(
        client: &DaoGovernanceContractClient<'static>,
        voter: &Address,
        pid: u64,
        approve: bool,
    ) {
        client.cast_vote(voter, &pid, &approve);
    }

    fn finalise(client: &DaoGovernanceContractClient<'static>, pid: u64) {
        client.finalise_vote(&pid);
    }

    fn balance_of(env: &Env, token: &Address, who: &Address) -> i128 {
        token::Client::new(env, token).balance(who)
    }

    // ─── R1: Initialisation ───────────────────────────────────────────────

    #[test]
    fn test_init_ok() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let c = client.get_config();
        assert_eq!(c.gp_token, cfg.gp_token);
        assert_eq!(c.quorum_bps, QUORUM_BPS);
        assert_eq!(c.voting_period_ledgers, VOTING_PERIOD);
        assert_eq!(c.timelock_ledgers, TIMELOCK);
        assert_eq!(c.dao_admin, cfg.dao_admin);
        assert_eq!(client.get_proposal_count(), 0);
        assert_eq!(client.get_total_locked(), 0);
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_double_init_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let a = Address::generate(&env);
        let ta = Address::generate(&env);
        let t = env.register_stellar_asset_contract_v2(ta).address();
        let cid = env.register_contract(None, DaoGovernanceContract);
        let cl = DaoGovernanceContractClient::new(&env, &cid);
        cl.initialize(&t, &QUORUM_BPS, &VOTING_PERIOD, &TIMELOCK, &a);
        cl.initialize(&t, &QUORUM_BPS, &VOTING_PERIOD, &TIMELOCK, &a);
    }

    #[test]
    #[should_panic(expected = "quorum must be positive")]
    fn test_init_zero_quorum_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let a = Address::generate(&env);
        let ta = Address::generate(&env);
        let t = env.register_stellar_asset_contract_v2(ta).address();
        let cid = env.register_contract(None, DaoGovernanceContract);
        let cl = DaoGovernanceContractClient::new(&env, &cid);
        cl.initialize(&t, &0i128, &VOTING_PERIOD, &TIMELOCK, &a);
    }

    #[test]
    #[should_panic(expected = "voting period too short")]
    fn test_init_short_voting_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let a = Address::generate(&env);
        let ta = Address::generate(&env);
        let t = env.register_stellar_asset_contract_v2(ta).address();
        let cid = env.register_contract(None, DaoGovernanceContract);
        let cl = DaoGovernanceContractClient::new(&env, &cid);
        cl.initialize(&t, &QUORUM_BPS, &(MIN_VOTING_WINDOW - 1), &TIMELOCK, &a);
    }

    #[test]
    #[should_panic(expected = "timelock must be positive")]
    fn test_init_zero_timelock_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let a = Address::generate(&env);
        let ta = Address::generate(&env);
        let t = env.register_stellar_asset_contract_v2(ta).address();
        let cid = env.register_contract(None, DaoGovernanceContract);
        let cl = DaoGovernanceContractClient::new(&env, &cid);
        cl.initialize(&t, &QUORUM_BPS, &VOTING_PERIOD, &0u32, &a);
    }

    // ─── R2: GP Token Locking ─────────────────────────────────────────────

    #[test]
    fn test_lock_creates_lock() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let voter = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&voter, &5000i128);

        let d = MIN_LOCK_LEDGERS + 1000;
        let start = env.ledger().sequence();
        client.lock_tokens(&voter, &5000i128, &d);

        let lock = client.get_lock(&voter);
        assert_eq!(lock.amount, 5000);
        assert_eq!(lock.unlock_ledger, start + d);
        assert_eq!(lock.created_ledger, start);

        let bal = balance_of(&env, &cfg.gp_token, &_cid);
        assert_eq!(bal, 5000);
    }

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_lock_zero_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, _cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        client.lock_tokens(&v, &0i128, &MIN_LOCK_LEDGERS);
    }

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_lock_neg_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, _cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        client.lock_tokens(&v, &(-100i128), &MIN_LOCK_LEDGERS);
    }

    #[test]
    #[should_panic(expected = "lock duration too short")]
    fn test_lock_too_short_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, _cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        client.lock_tokens(&v, &100i128, &(MIN_LOCK_LEDGERS - 1));
    }

    #[test]
    #[should_panic(expected = "lock duration too long")]
    fn test_lock_too_long_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, _cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        client.lock_tokens(&v, &100i128, &(MAX_LOCK_LEDGERS + 1));
    }

    #[test]
    #[should_panic(expected = "existing lock must be extended or expired")]
    fn test_lock_active_exists_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &10000i128);
        client.lock_tokens(&v, &5000i128, &MIN_LOCK_LEDGERS);
        client.lock_tokens(&v, &5000i128, &MIN_LOCK_LEDGERS);
    }

    #[test]
    fn test_lock_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        let (cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &1000i128);
        client.lock_tokens(&v, &1000i128, &MIN_LOCK_LEDGERS);
        let events = env.events().all();
        assert_eq!(events.last().unwrap().0, cid);
    }

    #[test]
    fn test_get_lock_default() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, _cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let lock = client.get_lock(&v);
        assert_eq!(lock.amount, 0);
        assert_eq!(lock.unlock_ledger, 0);
        assert_eq!(lock.created_ledger, 0);
    }

    // ─── R3: Lock Extension ───────────────────────────────────────────────

    #[test]
    fn test_extend_ok() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &5000i128);
        client.lock_tokens(&v, &5000i128, &MIN_LOCK_LEDGERS);
        let before = client.get_lock(&v);
        let nu = before.unlock_ledger + 100_000;
        client.extend_lock(&v, &nu);
        let after = client.get_lock(&v);
        assert_eq!(after.unlock_ledger, nu);
        assert_eq!(after.amount, 5000);
    }

    #[test]
    #[should_panic(expected = "no active lock")]
    fn test_extend_no_lock_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, _cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        client.extend_lock(&v, &100_000u32);
    }

    #[test]
    #[should_panic(expected = "new unlock must be later")]
    fn test_extend_same_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &5000i128);
        client.lock_tokens(&v, &5000i128, &MIN_LOCK_LEDGERS);
        let lock = client.get_lock(&v);
        client.extend_lock(&v, &lock.unlock_ledger);
    }

    #[test]
    #[should_panic(expected = "lock duration too long")]
    fn test_extend_beyond_max_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &5000i128);
        client.lock_tokens(&v, &5000i128, &MIN_LOCK_LEDGERS);
        let max = env.ledger().sequence() + MAX_LOCK_LEDGERS;
        client.extend_lock(&v, &(max + 1));
    }

    // ─── R4: Token Withdrawal ─────────────────────────────────────────────

    #[test]
    fn test_withdraw_after_expiry() {
        let env = Env::default();
        env.mock_all_auths();
        let (cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &5000i128);

        let bal_before = balance_of(&env, &cfg.gp_token, &v);
        let short = MIN_LOCK_LEDGERS;
        client.lock_tokens(&v, &5000i128, &short);

        assert_eq!(balance_of(&env, &cfg.gp_token, &cid), 5000);

        env.ledger()
            .set_sequence_number(env.ledger().sequence() + short + 1);
        client.withdraw(&v);

        assert_eq!(balance_of(&env, &cfg.gp_token, &v), bal_before);
        assert_eq!(client.get_lock(&v).amount, 0);
    }

    #[test]
    #[should_panic(expected = "no lock found")]
    fn test_withdraw_no_lock_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, _cfg, client) = deploy(&env);
        client.withdraw(&Address::generate(&env));
    }

    #[test]
    #[should_panic(expected = "lock not yet expired")]
    fn test_withdraw_before_expiry_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &5000i128);
        client.lock_tokens(&v, &5000i128, &MIN_LOCK_LEDGERS);
        client.withdraw(&v);
    }

    // ─── R5: Voting Power ─────────────────────────────────────────────────

    #[test]
    fn test_vp_scales_with_time() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v1 = Address::generate(&env);
        let v2 = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v1, &500_000i128);
        sac.mint(&v2, &500_000i128);
        client.lock_tokens(&v1, &1000i128, &MIN_LOCK_LEDGERS);
        client.lock_tokens(&v2, &1000i128, &MAX_LOCK_LEDGERS);
        let cur = env.ledger().sequence();
        let short = client.get_voting_power(&v1, &cur);
        let long = client.get_voting_power(&v2, &cur);
        assert!(long > short);
    }

    #[test]
    fn test_vp_zero_after_expiry() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &1000i128);
        client.lock_tokens(&v, &1000i128, &MIN_LOCK_LEDGERS);
        let after = env.ledger().sequence() + MIN_LOCK_LEDGERS + 1;
        assert_eq!(client.get_voting_power(&v, &after), 0);
    }

    #[test]
    fn test_vp_positive_at_creation() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &1000i128);
        client.lock_tokens(&v, &1000i128, &MAX_LOCK_LEDGERS);
        assert!(client.get_voting_power(&v, &env.ledger().sequence()) > 0);
    }

    #[test]
    fn test_vp_zero_no_lock() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, _cfg, client) = deploy(&env);
        assert_eq!(
            client.get_voting_power(&Address::generate(&env), &100u32),
            0
        );
    }

    #[test]
    fn test_snapshot_power_matches_vp_at_snapshot() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);

        let cur = env.ledger().sequence();
        let pid = mk_proposal(&env, &client, &v);
        snapshot(&client, &v, pid);
        vote(&client, &v, pid, true);

        let expected = client.get_voting_power(&v, &cur);
        assert_eq!(client.get_snapshot_power(&v, &pid), expected);
    }

    // ─── R6: Proposal Creation ────────────────────────────────────────────

    #[test]
    fn test_create_proposal() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);

        let pid = mk_proposal(&env, &client, &v);
        assert_eq!(pid, 1);
        let p = client.get_proposal(&pid);
        assert_eq!(p.stage, ProposalStage::Discussion);
        assert_eq!(p.votes_for, 0);
        assert_eq!(p.votes_against, 0);
    }

    #[test]
    fn test_proposal_ids_increment() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);

        assert_eq!(mk_proposal(&env, &client, &v), 1);
        assert_eq!(mk_proposal(&env, &client, &v), 2);
        assert_eq!(client.get_proposal_count(), 2);
    }

    #[test]
    #[should_panic(expected = "insufficient voting power to propose")]
    fn test_create_no_power_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, _cfg, client) = deploy(&env);
        mk_proposal(&env, &client, &Address::generate(&env));
    }

    // ─── R7: Discussion → Snapshot ────────────────────────────────────────

    #[test]
    fn test_advance_by_proposer() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);

        let pid = mk_proposal(&env, &client, &v);
        let cur = env.ledger().sequence();
        snapshot(&client, &v, pid);

        let p = client.get_proposal(&pid);
        assert_eq!(p.stage, ProposalStage::SnapshotVote);
        assert_eq!(p.snapshot_ledger, cur);
        assert_eq!(p.vote_end_ledger, cur + VOTING_PERIOD);
    }

    #[test]
    fn test_advance_by_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);
        let pid = mk_proposal(&env, &client, &v);
        snapshot(&client, &cfg.dao_admin, pid);
        assert_eq!(client.get_proposal(&pid).stage, ProposalStage::SnapshotVote);
    }

    #[test]
    #[should_panic(expected = "invalid stage transition")]
    fn test_advance_from_wrong_stage_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);
        let pid = mk_proposal(&env, &client, &v);
        snapshot(&client, &v, pid);
        snapshot(&client, &v, pid);
    }

    #[test]
    #[should_panic(expected = "not authorised to advance proposal")]
    fn test_advance_by_rando_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);
        let pid = mk_proposal(&env, &client, &v);
        snapshot(&client, &Address::generate(&env), pid);
    }

    // ─── R8: Snapshotted Voting ───────────────────────────────────────────

    #[test]
    fn test_vote_for() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);
        let pid = mk_proposal(&env, &client, &v);
        snapshot(&client, &v, pid);
        vote(&client, &v, pid, true);
        let p = client.get_proposal(&pid);
        assert!(p.votes_for > 0);
        assert_eq!(p.votes_against, 0);
    }

    #[test]
    fn test_vote_against() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);
        let pid = mk_proposal(&env, &client, &v);
        snapshot(&client, &v, pid);
        vote(&client, &v, pid, false);
        let p = client.get_proposal(&pid);
        assert_eq!(p.votes_for, 0);
        assert!(p.votes_against > 0);
    }

    #[test]
    #[should_panic(expected = "voting not active")]
    fn test_vote_in_discussion_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);
        vote(&client, &v, mk_proposal(&env, &client, &v), true);
    }

    #[test]
    #[should_panic(expected = "already voted")]
    fn test_double_vote_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);
        let pid = mk_proposal(&env, &client, &v);
        snapshot(&client, &v, pid);
        vote(&client, &v, pid, true);
        vote(&client, &v, pid, false);
    }

    #[test]
    #[should_panic(expected = "no voting power at snapshot")]
    fn test_vote_no_power_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);
        let pid = mk_proposal(&env, &client, &v);
        snapshot(&client, &v, pid);
        vote(&client, &Address::generate(&env), pid, true);
    }

    #[test]
    fn test_vote_power_frozen_at_snapshot() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &(MAX_LOCK_LEDGERS as i128));
        let max = MAX_LOCK_LEDGERS as i128;
        client.lock_tokens(&v, &max, &MAX_LOCK_LEDGERS);

        let pid = mk_proposal(&env, &client, &v);
        let snap_ledger = env.ledger().sequence();
        snapshot(&client, &v, pid);
        let snap_power = client.get_voting_power(&v, &snap_ledger);

        env.ledger().set_sequence_number(snap_ledger + 100_000);
        vote(&client, &v, pid, true);

        assert_eq!(client.get_snapshot_power(&v, &pid), snap_power);
    }

    // ─── R9: Proportional quorum ─────────────────────────────────────────

    #[test]
    fn test_quorum_scales_with_locked_supply() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);

        let a = Address::generate(&env);
        sac.mint(&a, &500_000i128);
        client.lock_tokens(&a, &500_000i128, &MAX_LOCK_LEDGERS);

        // 500k locked → 10% quorum is 50_000 votes.
        let pid1 = mk_proposal(&env, &client, &a);
        snapshot(&client, &a, pid1);
        let q1 = client.get_proposal(&pid1).quorum_requirement;
        assert_eq!(q1, 50_000);

        // Doubling the locked supply doubles the threshold: the same fraction
        // of a bigger pool demands more votes. An absolute quorum would have
        // stayed flat at 1000, which is exactly the drift this replaces.
        let b = Address::generate(&env);
        sac.mint(&b, &500_000i128);
        client.lock_tokens(&b, &500_000i128, &MAX_LOCK_LEDGERS);

        let pid2 = mk_proposal(&env, &client, &a);
        snapshot(&client, &a, pid2);
        let q2 = client.get_proposal(&pid2).quorum_requirement;
        assert_eq!(q2, 100_000);
        assert_eq!(q2, 2 * q1);
    }

    #[test]
    fn test_quorum_shrinks_when_supply_withdrawn() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);

        let a = Address::generate(&env);
        sac.mint(&a, &10_000i128);
        client.lock_tokens(&a, &10_000i128, &MIN_LOCK_LEDGERS);
        let pid1 = mk_proposal(&env, &client, &a);
        snapshot(&client, &a, pid1);
        assert_eq!(client.get_proposal(&pid1).quorum_requirement, 1_000);

        // The whole supply is withdrawn; a smaller pool is locked afterwards.
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + MIN_LOCK_LEDGERS + 1);
        client.withdraw(&a);
        assert_eq!(client.get_total_locked(), 0);

        let b = Address::generate(&env);
        sac.mint(&b, &5_000i128);
        client.lock_tokens(&b, &5_000i128, &MAX_LOCK_LEDGERS);
        let pid2 = mk_proposal(&env, &client, &b);
        snapshot(&client, &b, pid2);
        let q2 = client.get_proposal(&pid2).quorum_requirement;
        assert_eq!(q2, 500);
        assert!(q2 < client.get_proposal(&pid1).quorum_requirement);
    }

    #[test]
    fn test_quorum_frozen_at_snapshot() {
        // A mid-vote change in locked supply must not move the goalposts: the
        // threshold is snapshotted when the proposal advances to vote.
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);

        let a = Address::generate(&env);
        let b = Address::generate(&env);
        sac.mint(&a, &5_000i128);
        sac.mint(&b, &5_000i128);
        client.lock_tokens(&a, &5_000i128, &MAX_LOCK_LEDGERS);
        client.lock_tokens(&b, &5_000i128, &MAX_LOCK_LEDGERS);

        let pid = mk_proposal(&env, &client, &a);
        snapshot(&client, &a, pid);
        let frozen = client.get_proposal(&pid).quorum_requirement;
        assert_eq!(frozen, 1_000); // 10% of 10_000 locked at the snapshot

        // A whale locks mid-vote, quintupling the pool to 500k. Recomputing
        // quorum live would demand 50_000 votes and this proposal would fail;
        // the snapshotted threshold keeps it at 1_000.
        let whale = Address::generate(&env);
        sac.mint(&whale, &490_000i128);
        client.lock_tokens(&whale, &490_000i128, &MAX_LOCK_LEDGERS);

        let end = env.ledger().sequence() + VOTING_PERIOD;
        vote(&client, &a, pid, true);
        vote(&client, &b, pid, true);
        env.ledger().set_sequence_number(end + 1);
        finalise(&client, pid);

        let p = client.get_proposal(&pid);
        assert_eq!(p.quorum_requirement, frozen);
        assert_eq!(p.stage, ProposalStage::Execution);
    }

    #[test]
    fn test_total_locked_tracks_locks_and_withdrawals() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);

        assert_eq!(client.get_total_locked(), 0);

        let a = Address::generate(&env);
        sac.mint(&a, &10_000i128);
        client.lock_tokens(&a, &5_000i128, &MIN_LOCK_LEDGERS);
        assert_eq!(client.get_total_locked(), 5_000);

        let b = Address::generate(&env);
        sac.mint(&b, &10_000i128);
        client.lock_tokens(&b, &3_000i128, &MIN_LOCK_LEDGERS);
        assert_eq!(client.get_total_locked(), 8_000);

        // Replacing an expired lock drops the old amount before adding the new.
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + MIN_LOCK_LEDGERS + 1);
        client.lock_tokens(&a, &4_000i128, &MIN_LOCK_LEDGERS);
        assert_eq!(client.get_total_locked(), 7_000);

        // Withdrawing removes the lock's amount from the total.
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + MIN_LOCK_LEDGERS + 1);
        client.withdraw(&a);
        assert_eq!(client.get_total_locked(), 3_000);
    }

    // ─── R9: Snapshot → Execution / Defeated ──────────────────────────────

    #[test]
    fn test_finalise_approves() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&a, &500_000i128);
        sac.mint(&b, &500_000i128);
        client.lock_tokens(&a, &500_000i128, &MAX_LOCK_LEDGERS);
        client.lock_tokens(&b, &500_000i128, &MAX_LOCK_LEDGERS);

        let pid = mk_proposal(&env, &client, &a);
        snapshot(&client, &a, pid);
        let end = env.ledger().sequence() + VOTING_PERIOD;
        vote(&client, &a, pid, true);
        vote(&client, &b, pid, true);
        env.ledger().set_sequence_number(end + 1);
        finalise(&client, pid);

        let p = client.get_proposal(&pid);
        assert_eq!(p.stage, ProposalStage::Execution);
        assert!(p.executable_from_ledger > env.ledger().sequence() - TIMELOCK);
    }

    #[test]
    fn test_finalise_defeated_no_quorum() {
        // Quorum is 10% of the total locked supply. Most of the supply is held
        // by a voter who does not participate, so the votes cast fall short of
        // the proportional threshold even though they are a huge absolute count.
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&a, &500i128);
        sac.mint(&b, &500_000i128);
        client.lock_tokens(&a, &500i128, &MAX_LOCK_LEDGERS);
        client.lock_tokens(&b, &500_000i128, &MAX_LOCK_LEDGERS);
        let pid = mk_proposal(&env, &client, &a);
        snapshot(&client, &a, pid);
        // 10% of 500_500 = 50_050; a alone votes ~500.
        assert_eq!(client.get_proposal(&pid).quorum_requirement, 50_050);
        let end = env.ledger().sequence() + VOTING_PERIOD;
        vote(&client, &a, pid, true);
        env.ledger().set_sequence_number(end + 1);
        finalise(&client, pid);
        assert_eq!(client.get_proposal(&pid).stage, ProposalStage::Defeated);
    }

    #[test]
    fn test_finalise_defeated_tie() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&a, &600i128);
        sac.mint(&b, &600i128);
        client.lock_tokens(&a, &600i128, &MAX_LOCK_LEDGERS);
        client.lock_tokens(&b, &600i128, &MAX_LOCK_LEDGERS);
        let pid = mk_proposal(&env, &client, &a);
        snapshot(&client, &a, pid);
        let end = env.ledger().sequence() + VOTING_PERIOD;
        vote(&client, &a, pid, true);
        vote(&client, &b, pid, false);
        env.ledger().set_sequence_number(end + 1);
        finalise(&client, pid);
        assert_eq!(client.get_proposal(&pid).stage, ProposalStage::Defeated);
    }

    #[test]
    #[should_panic(expected = "invalid stage transition")]
    fn test_finalise_discussion_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);
        finalise(&client, mk_proposal(&env, &client, &v));
    }

    #[test]
    #[should_panic(expected = "voting period not closed")]
    fn test_finalise_before_end_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);
        let pid = mk_proposal(&env, &client, &v);
        snapshot(&client, &v, pid);
        finalise(&client, pid);
    }

    // ─── R10: On-Chain Execution ──────────────────────────────────────────

    #[test]
    fn test_execute_proposal() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let target = deploy_noop(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&a, &500_000i128);
        sac.mint(&b, &500_000i128);
        client.lock_tokens(&a, &500_000i128, &MAX_LOCK_LEDGERS);
        client.lock_tokens(&b, &500_000i128, &MAX_LOCK_LEDGERS);

        let noop_fn = Symbol::new(&env, "noop");
        client.add_allowed_target(&cfg.dao_admin, &target, &noop_fn);
        let pid = client.create_proposal(
            &a,
            &String::from_str(&env, "X"),
            &String::from_str(&env, "Y"),
            &target,
            &noop_fn,
            &Bytes::new(&env),
        );
        snapshot(&client, &a, pid);
        let end = env.ledger().sequence() + VOTING_PERIOD;
        vote(&client, &a, pid, true);
        vote(&client, &b, pid, true);
        env.ledger().set_sequence_number(end + 1);
        finalise(&client, pid);

        let p = client.get_proposal(&pid);
        env.ledger().set_sequence_number(p.executable_from_ledger);
        client.execute_proposal(&pid);
        assert_eq!(client.get_proposal(&pid).stage, ProposalStage::Executed);
    }

    #[test]
    #[should_panic(expected = "proposal not executable")]
    fn test_execute_non_execution_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);
        client.execute_proposal(&mk_proposal(&env, &client, &v));
    }

    #[test]
    #[should_panic(expected = "timelock not elapsed")]
    fn test_execute_before_timelock_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let target = deploy_noop(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&a, &500_000i128);
        sac.mint(&b, &500_000i128);
        client.lock_tokens(&a, &500_000i128, &MAX_LOCK_LEDGERS);
        client.lock_tokens(&b, &500_000i128, &MAX_LOCK_LEDGERS);

        let noop_fn = Symbol::new(&env, "noop");
        client.add_allowed_target(&cfg.dao_admin, &target, &noop_fn);
        let pid = client.create_proposal(
            &a,
            &String::from_str(&env, "X"),
            &String::from_str(&env, "Y"),
            &target,
            &noop_fn,
            &Bytes::new(&env),
        );
        snapshot(&client, &a, pid);
        let end = env.ledger().sequence() + VOTING_PERIOD;
        vote(&client, &a, pid, true);
        vote(&client, &b, pid, true);
        env.ledger().set_sequence_number(end + 1);
        finalise(&client, pid);
        client.execute_proposal(&pid);
    }

    // ─── R11: Economic Invariants ─────────────────────────────────────────

    #[test]
    fn test_round_trip_conservation() {
        let env = Env::default();
        env.mock_all_auths();
        let (cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &10_000i128);

        let bal_before = balance_of(&env, &cfg.gp_token, &v);
        client.lock_tokens(&v, &10_000i128, &MIN_LOCK_LEDGERS);
        assert_eq!(balance_of(&env, &cfg.gp_token, &v), bal_before - 10_000);
        assert_eq!(balance_of(&env, &cfg.gp_token, &cid), 10_000);

        env.ledger()
            .set_sequence_number(env.ledger().sequence() + MIN_LOCK_LEDGERS + 1);
        client.withdraw(&v);
        assert_eq!(balance_of(&env, &cfg.gp_token, &v), bal_before);
        assert_eq!(balance_of(&env, &cfg.gp_token, &cid), 0);
    }

    #[test]
    fn test_vp_monotonically_decreasing() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        let max = MAX_LOCK_LEDGERS as i128;
        sac.mint(&v, &max);
        client.lock_tokens(&v, &max, &MAX_LOCK_LEDGERS);

        let t1 = env.ledger().sequence();
        let t2 = t1 + 100_000;
        let t3 = t2 + 100_000;
        let p1 = client.get_voting_power(&v, &t1);
        let p2 = client.get_voting_power(&v, &t2);
        let p3 = client.get_voting_power(&v, &t3);
        assert!(p1 > p2 && p2 > p3);
    }

    #[test]
    fn test_snapshot_immutable_after_extend() {
        // Regression test: extend_lock after a proposal's snapshot_ledger must
        // NOT inflate the voting power counted for that proposal.
        //
        // expected_power is captured BEFORE extend_lock.  After the extension
        // we verify the voted power equals the pre-extension value, and also
        // directly verify (using the live Lock fields) that the extension did
        // change the lock in a way that would have inflated power on an unfixed
        // contract — confirming the scenario is meaningful.
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        let max = MAX_LOCK_LEDGERS as i128;
        sac.mint(&v, &max);
        client.lock_tokens(&v, &max, &MIN_LOCK_LEDGERS);

        let pid = mk_proposal(&env, &client, &v);
        let snap_ledger = env.ledger().sequence();
        snapshot(&client, &v, pid);

        // Capture expected power BEFORE extending — this is the power the
        // voter held at the snapshot and what the vote must be counted as.
        let expected_power = client.get_voting_power(&v, &snap_ledger);

        // Voter extends their lock after the snapshot has been taken.
        let lock_before = client.get_lock(&v);
        let new_unlock = lock_before.unlock_ledger + 500_000;
        client.extend_lock(&v, &new_unlock);

        // Manually compute what an unfixed contract would have returned using
        // the new (extended) unlock_ledger and the same formula.
        // This proves the attack scenario is real and the test is meaningful.
        let unfixed_remaining = new_unlock - snap_ledger;
        let unfixed_power = (max * unfixed_remaining as i128) / MAX_LOCK_LEDGERS as i128;
        assert!(
            unfixed_power > expected_power,
            "the extended unlock_ledger must produce a larger power at snap_ledger \
             on the raw formula; if not, the test scenario itself is trivial"
        );

        // Now cast the vote.  The recorded snapshot power must equal
        // expected_power (pre-extension), not the unfixed inflated value.
        env.ledger().set_sequence_number(snap_ledger + 100_000);
        vote(&client, &v, pid, true);

        assert_eq!(
            client.get_snapshot_power(&v, &pid),
            expected_power,
            "voted power must reflect the lock state AT the snapshot, \
             not the retroactively extended unlock_ledger"
        );
        assert!(
            client.get_snapshot_power(&v, &pid) < unfixed_power,
            "fix confirmed: snapshot power is less than the inflated power \
             that an unfixed contract would have counted"
        );
    }

    /// Acceptance-criteria regression test for the snapshot-inflation
    /// vulnerability (see SECURITY.md §CVE-DAO-GOV-2026-001).
    ///
    /// Attack sequence reproduced here:
    ///   1. Voter locks tokens with a SHORT duration → low voting power.
    ///   2. Proposal advances to SnapshotVote (snapshot_ledger = L).
    ///   3. Before voting, voter calls extend_lock to push unlock_ledger far
    ///      into the future — this would inflate their power at ledger L on an
    ///      unfixed contract.
    ///   4. Voter casts vote.
    ///
    /// The test asserts:
    ///   • The power actually counted equals what the voter held AT L.
    ///   • A second honest voter with the equivalent long lock (same amount,
    ///     same final unlock_ledger, but locked BEFORE the snapshot) gets the
    ///     larger power — confirming the attacker gains no advantage from the
    ///     post-snapshot extension.
    #[test]
    fn test_extend_lock_after_snapshot_does_not_inflate_vote() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);

        // ── Attacker: locks with MIN duration (low power at snapshot). ──────
        let attacker = Address::generate(&env);
        sac.mint(&attacker, &1_000_000i128);
        client.lock_tokens(&attacker, &1_000_000i128, &MIN_LOCK_LEDGERS);

        // ── Honest voter: locks with MAX duration (high power). ─────────────
        let honest = Address::generate(&env);
        sac.mint(&honest, &1_000_000i128);
        client.lock_tokens(&honest, &1_000_000i128, &MAX_LOCK_LEDGERS);

        // Snapshot both voters at the same ledger.
        let pid = mk_proposal(&env, &client, &honest);
        let snap_ledger = env.ledger().sequence();
        snapshot(&client, &honest, pid);

        // Record expected powers AT the snapshot, before any extension.
        let attacker_power_at_snap = client.get_voting_power(&attacker, &snap_ledger);
        let honest_power_at_snap = client.get_voting_power(&honest, &snap_ledger);

        // Attacker's power at snap must be strictly less than honest voter's,
        // because the attacker only locked for MIN_LOCK_LEDGERS.
        assert!(
            attacker_power_at_snap < honest_power_at_snap,
            "test setup: attacker's short lock should yield less power than honest voter's"
        );

        // ── Attack: extend unlock_ledger to match MAX_LOCK_LEDGERS AFTER snap.
        let extended_unlock = env.ledger().sequence() + MAX_LOCK_LEDGERS;
        client.extend_lock(&attacker, &extended_unlock);

        // Manually compute what an unfixed contract would have returned using
        // the new (extended) unlock_ledger and the same formula — this proves
        // the attack vector is real and the scenario is meaningful.
        let unfixed_remaining = extended_unlock - snap_ledger;
        let unfixed_attacker_power =
            (1_000_000i128 * unfixed_remaining as i128) / MAX_LOCK_LEDGERS as i128;
        assert!(
            unfixed_attacker_power > attacker_power_at_snap,
            "the extended unlock_ledger must produce a higher power at snap_ledger \
             on the raw formula; if not, the test scenario itself is trivial"
        );

        // ── Both voters cast their votes. ────────────────────────────────────
        env.ledger().set_sequence_number(snap_ledger + 10_000);
        vote(&client, &attacker, pid, true);
        vote(&client, &honest, pid, true);

        // ── Core assertion: attacker's counted vote == pre-extension power. ──
        let attacker_counted = client.get_snapshot_power(&attacker, &pid);
        assert_eq!(
            attacker_counted, attacker_power_at_snap,
            "counted vote power must equal the power held AT the snapshot, \
             not the retroactively inflated value"
        );

        // ── Honest voter retains their legitimate power unchanged. ───────────
        assert_eq!(
            client.get_snapshot_power(&honest, &pid),
            honest_power_at_snap,
            "honest voter's power must be unchanged by attacker's extend_lock"
        );

        // ── Attacker gained no advantage: their counted power is still less. ─
        assert!(
            attacker_counted < client.get_snapshot_power(&honest, &pid),
            "attacker must not have gained power parity with the honest voter \
             through a post-snapshot lock extension"
        );
    }

    // ─── R12: Flash Loan Prevention ───────────────────────────────────────

    #[test]
    fn test_vote_uses_snapshot_ledger() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let p = Address::generate(&env);
        let late = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&p, &500_000i128);
        client.lock_tokens(&p, &500_000i128, &MAX_LOCK_LEDGERS);
        let pid = mk_proposal(&env, &client, &p);
        let snap_ledger = env.ledger().sequence();
        snapshot(&client, &p, pid);

        env.ledger().set_sequence_number(snap_ledger + 5000);
        sac.mint(&late, &500_000i128);
        client.lock_tokens(&late, &500_000i128, &MAX_LOCK_LEDGERS);

        assert_eq!(client.get_voting_power(&late, &snap_ledger), 0);
        assert!(client.get_voting_power(&late, &env.ledger().sequence()) > 0);
    }

    #[test]
    fn test_cannot_vote_without_lock() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let p = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&p, &500_000i128);
        client.lock_tokens(&p, &500_000i128, &MAX_LOCK_LEDGERS);
        let pid = mk_proposal(&env, &client, &p);
        snapshot(&client, &p, pid);
        assert_eq!(
            client.get_voting_power(&Address::generate(&env), &env.ledger().sequence()),
            0
        );
    }

    // ─── R13: Calldata Round-Trip ─────────────────────────────────────────

    #[test]
    fn test_calldata_round_trip() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);

        let target = Address::generate(&env);
        let function = Symbol::new(&env, "f");
        client.add_allowed_target(&cfg.dao_admin, &target, &function);

        let orig = Bytes::from_slice(&env, &[1, 2, 3, 255, 0, 128]);
        let pid = client.create_proposal(
            &v,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
            &target,
            &function,
            &orig,
        );
        let p = client.get_proposal(&pid);
        assert_eq!(p.calldata, orig);
        assert_eq!(p.calldata.len(), orig.len());
    }

    #[test]
    fn test_empty_calldata_accepted() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);

        let target = Address::generate(&env);
        let function = Symbol::new(&env, "f");
        client.add_allowed_target(&cfg.dao_admin, &target, &function);

        let pid = client.create_proposal(
            &v,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
            &target,
            &function,
            &Bytes::new(&env),
        );
        assert_eq!(client.get_proposal(&pid).calldata.len(), 0);
    }

    // ─── R14: Access Control ──────────────────────────────────────────────

    #[test]
    fn test_execute_anyone_can_call() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let target = deploy_noop(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&a, &500_000i128);
        sac.mint(&b, &500_000i128);
        client.lock_tokens(&a, &500_000i128, &MAX_LOCK_LEDGERS);
        client.lock_tokens(&b, &500_000i128, &MAX_LOCK_LEDGERS);

        let noop_fn = Symbol::new(&env, "noop");
        client.add_allowed_target(&cfg.dao_admin, &target, &noop_fn);
        let pid = client.create_proposal(
            &a,
            &String::from_str(&env, "X"),
            &String::from_str(&env, "Y"),
            &target,
            &noop_fn,
            &Bytes::new(&env),
        );
        snapshot(&client, &a, pid);
        let end = env.ledger().sequence() + VOTING_PERIOD;
        vote(&client, &a, pid, true);
        vote(&client, &b, pid, true);
        env.ledger().set_sequence_number(end + 1);
        finalise(&client, pid);

        let p = client.get_proposal(&pid);
        env.ledger().set_sequence_number(p.executable_from_ledger);
        client.execute_proposal(&pid);
        assert_eq!(client.get_proposal(&pid).stage, ProposalStage::Executed);
    }

    // ─── R11: Upgrade ─────────────────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "only dao_admin can upgrade")]
    fn test_upgrade_rejects_non_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, _cfg, client) = deploy(&env);
        let impostor = Address::generate(&env);
        let hash = soroban_sdk::BytesN::from_array(&env, &[0u8; 32]);
        client.upgrade(&impostor, &hash);
    }

    #[test]
    fn test_upgrade_preserves_lock_and_proposal_state() {
        let env = Env::default();
        env.mock_all_auths();
        let (cid, cfg, client) = deploy(&env);

        // Lock tokens and create a proposal so there is real state to survive.
        let voter = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&voter, &500_000i128);
        client.lock_tokens(&voter, &500_000i128, &MAX_LOCK_LEDGERS);
        let pid = mk_proposal(&env, &client, &voter);

        // Re-register same binary at same address.
        let new_cid = env.register_contract(Some(&cid), DaoGovernanceContract);
        assert_eq!(new_cid, cid);

        let client_v2 = DaoGovernanceContractClient::new(&env, &cid);
        let lock = client_v2.get_lock(&voter);
        assert_eq!(lock.amount, 500_000);
        let proposal = client_v2.get_proposal(&pid);
        assert_eq!(proposal.stage, ProposalStage::Discussion);
    }

    // ─── R15: Execution Target Allowlist ──────────────────────────────────

    #[test]
    #[should_panic(expected = "target/function not allowlisted")]
    fn test_create_proposal_rejects_unallowlisted_target() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);

        client.create_proposal(
            &v,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
            &Address::generate(&env),
            &Symbol::new(&env, "f"),
            &Bytes::new(&env),
        );
    }

    #[test]
    #[should_panic(expected = "target/function not allowlisted")]
    fn test_create_proposal_rejects_unallowlisted_function() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);

        let target = Address::generate(&env);
        client.add_allowed_target(&cfg.dao_admin, &target, &Symbol::new(&env, "foo"));

        // Same target, different function: allowlisting must be checked as a
        // (target, function) pair, not the target alone.
        client.create_proposal(
            &v,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
            &target,
            &Symbol::new(&env, "bar"),
            &Bytes::new(&env),
        );
    }

    #[test]
    fn test_allowed_target_add_and_remove_persist() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let target = Address::generate(&env);
        let function = Symbol::new(&env, "f");

        assert!(!client.is_allowed_target(&target, &function));
        client.add_allowed_target(&cfg.dao_admin, &target, &function);
        assert!(client.is_allowed_target(&target, &function));
        client.remove_allowed_target(&cfg.dao_admin, &target, &function);
        assert!(!client.is_allowed_target(&target, &function));
    }

    #[test]
    #[should_panic(expected = "not authorised to modify allowlist")]
    fn test_add_allowed_target_unauthorized_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, _cfg, client) = deploy(&env);
        let rando = Address::generate(&env);
        client.add_allowed_target(&rando, &Address::generate(&env), &Symbol::new(&env, "f"));
    }

    #[test]
    #[should_panic(expected = "not authorised to modify allowlist")]
    fn test_remove_allowed_target_unauthorized_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let target = Address::generate(&env);
        let function = Symbol::new(&env, "f");
        client.add_allowed_target(&cfg.dao_admin, &target, &function);

        let rando = Address::generate(&env);
        client.remove_allowed_target(&rando, &target, &function);
    }

    #[test]
    #[should_panic(expected = "target/function not allowlisted")]
    fn test_removed_target_cannot_execute() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let target = deploy_noop(&env);
        let function = Symbol::new(&env, "noop");
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&a, &500_000i128);
        sac.mint(&b, &500_000i128);
        client.lock_tokens(&a, &500_000i128, &MAX_LOCK_LEDGERS);
        client.lock_tokens(&b, &500_000i128, &MAX_LOCK_LEDGERS);

        client.add_allowed_target(&cfg.dao_admin, &target, &function);
        let pid = client.create_proposal(
            &a,
            &String::from_str(&env, "X"),
            &String::from_str(&env, "Y"),
            &target,
            &function,
            &Bytes::new(&env),
        );
        snapshot(&client, &a, pid);
        let end = env.ledger().sequence() + VOTING_PERIOD;
        vote(&client, &a, pid, true);
        vote(&client, &b, pid, true);
        env.ledger().set_sequence_number(end + 1);
        finalise(&client, pid);

        // Allowlist entry is revoked while the proposal sits in its timelock;
        // execution must re-check the allowlist, not just trust the pair
        // that was valid at proposal-creation time.
        client.remove_allowed_target(&cfg.dao_admin, &target, &function);

        let p = client.get_proposal(&pid);
        env.ledger().set_sequence_number(p.executable_from_ledger);
        client.execute_proposal(&pid);
    }

    // ─── R16: DAO-Governed Config Updates ─────────────────────────────────

    #[test]
    fn test_set_config_ok() {
        let env = Env::default();
        env.mock_all_auths();
        let (cid, cfg, client) = deploy(&env);

        let new_admin = Address::generate(&env);
        let new_cfg = Config {
            gp_token: cfg.gp_token.clone(),
            quorum_bps: 1500,
            voting_period_ledgers: VOTING_PERIOD + 10_000,
            timelock_ledgers: TIMELOCK + 5_000,
            dao_admin: new_admin.clone(),
        };

        // When called with contract's own authorization (e.g. via mock_all_auths or internal invocation)
        client.set_config(&new_cfg);

        let updated = client.get_config();
        assert_eq!(updated.gp_token, cfg.gp_token);
        assert_eq!(updated.quorum_bps, 1500);
        assert_eq!(updated.voting_period_ledgers, VOTING_PERIOD + 10_000);
        assert_eq!(updated.timelock_ledgers, TIMELOCK + 5_000);
        assert_eq!(updated.dao_admin, new_admin);

        // Verify event was emitted
        let events = env.events().all();
        let last_event = events.last().unwrap();
        assert_eq!(last_event.0, cid);
    }

    #[test]
    #[should_panic(expected = "quorum must be positive")]
    fn test_set_config_zero_quorum_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);

        let mut new_cfg = cfg.clone();
        new_cfg.quorum_bps = 0;
        client.set_config(&new_cfg);
    }

    #[test]
    #[should_panic(expected = "quorum must be positive")]
    fn test_set_config_negative_quorum_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);

        let mut new_cfg = cfg.clone();
        new_cfg.quorum_bps = -500;
        client.set_config(&new_cfg);
    }

    #[test]
    #[should_panic(expected = "quorum too high")]
    fn test_set_config_excessive_quorum_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);

        let mut new_cfg = cfg.clone();
        new_cfg.quorum_bps = 10_001;
        client.set_config(&new_cfg);
    }

    #[test]
    #[should_panic(expected = "voting period too short")]
    fn test_set_config_short_voting_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);

        let mut new_cfg = cfg.clone();
        new_cfg.voting_period_ledgers = MIN_VOTING_WINDOW - 1;
        client.set_config(&new_cfg);
    }

    #[test]
    #[should_panic(expected = "timelock must be positive")]
    fn test_set_config_zero_timelock_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);

        let mut new_cfg = cfg.clone();
        new_cfg.timelock_ledgers = 0;
        client.set_config(&new_cfg);
    }

    #[test]
    fn test_mid_flight_target_removal_and_readdition_semantics() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let target = deploy_noop(&env);
        let function = Symbol::new(&env, "noop");
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&a, &500_000i128);
        sac.mint(&b, &500_000i128);
        client.lock_tokens(&a, &500_000i128, &MAX_LOCK_LEDGERS);
        client.lock_tokens(&b, &500_000i128, &MAX_LOCK_LEDGERS);

        // 1. Target is allowlisted and proposal is created
        client.add_allowed_target(&cfg.dao_admin, &target, &function);
        let pid = client.create_proposal(
            &a,
            &String::from_str(&env, "X"),
            &String::from_str(&env, "Y"),
            &target,
            &function,
            &Bytes::new(&env),
        );

        // 2. Proposal is voted on, passes, and enters Execution stage
        snapshot(&client, &a, pid);
        let end = env.ledger().sequence() + VOTING_PERIOD;
        vote(&client, &a, pid, true);
        vote(&client, &b, pid, true);
        env.ledger().set_sequence_number(end + 1);
        finalise(&client, pid);

        let p = client.get_proposal(&pid);
        assert_eq!(p.stage, ProposalStage::Execution);

        // 3. Admin removes target mid-flight (emergency circuit-breaker)
        client.remove_allowed_target(&cfg.dao_admin, &target, &function);
        assert!(!client.is_allowed_target(&target, &function));

        // 4. Admin re-adds target after resolving concerns
        client.add_allowed_target(&cfg.dao_admin, &target, &function);
        assert!(client.is_allowed_target(&target, &function));

        // 5. Execution now proceeds successfully once timelock has elapsed
        env.ledger().set_sequence_number(p.executable_from_ledger);
        client.execute_proposal(&pid);
        assert_eq!(client.get_proposal(&pid).stage, ProposalStage::Executed);
    }

    // ─── Pause / emergency-stop tests ──────────────────────────────────────

    #[test]
    fn test_pause_and_unpause() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        assert!(!client.is_paused());
        client.pause(&cfg.dao_admin);
        assert!(client.is_paused());
        client.unpause(&cfg.dao_admin);
        assert!(!client.is_paused());
    }

    #[test]
    #[should_panic(expected = "Only admin can pause")]
    fn test_pause_non_admin_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, _cfg, client) = deploy(&env);
        let rando = Address::generate(&env);
        client.pause(&rando);
    }

    #[test]
    #[should_panic(expected = "Contract is paused")]
    fn test_lock_tokens_rejected_when_paused() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        client.pause(&cfg.dao_admin);
        let voter = Address::generate(&env);
        let token = StellarAssetClient::new(&env, &cfg.gp_token);
        token.mint(&voter, &1_000_000);
        client.lock_tokens(&voter, &1_000_000, &MIN_LOCK_LEDGERS);
    }

    #[test]
    #[should_panic(expected = "Contract is paused")]
    fn test_create_proposal_rejected_when_paused() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let proposer = Address::generate(&env);
        let token = StellarAssetClient::new(&env, &cfg.gp_token);
        token.mint(&proposer, &1_000_000);
        client.lock_tokens(&proposer, &1_000_000, &MIN_LOCK_LEDGERS);
        client.pause(&cfg.dao_admin);
        let target = Address::generate(&env);
        let function = Symbol::new(&env, "do_thing");
        client.create_proposal(
            &proposer,
            &soroban_sdk::String::from_str(&env, "Title"),
            &soroban_sdk::String::from_str(&env, "Desc"),
            &target,
            &function,
            &soroban_sdk::Bytes::new(&env),
        );
    }
}
