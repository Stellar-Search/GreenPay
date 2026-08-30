#![no_std]

//! Escrow with dispute resolution and expiry: a client locks funds with
//! `create_job`, then either `release_escrow` sends them to the freelancer,
//! or either party can `dispute` a stalled job for the admin to resolve via
//! `resolve_dispute`. If a job's `expiry_ledger` passes with no release or
//! dispute, the client can reclaim funds with `cancel_job`.
//!
//! Dispute timeout fallback: if the admin does not call `resolve_dispute`
//! within `DISPUTE_TIMEOUT_LEDGERS` ledgers of the dispute being raised,
//! either party (client or freelancer) may call `resolve_stale_dispute` to
//! trigger an automatic 50/50 split of the remaining escrowed funds.

#[cfg(all(test, feature = "testutils"))]
mod property_tests;

/// Number of ledgers the admin has to resolve a dispute before the 50/50
/// fallback becomes available. At ~5 s per ledger this is roughly 30 days.
/// Adjust at deploy time by changing this constant.
#[cfg(not(test))]
const DISPUTE_TIMEOUT_LEDGERS: u32 = 518_400;

/// Shorter timeout used in tests so the ledger can be advanced without
/// archiving SAC persistent balance entries.
#[cfg(test)]
const DISPUTE_TIMEOUT_LEDGERS: u32 = 200;

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, BytesN, Env, String,
};

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum JobStatus {
    Escrowed,
    Released,
    Disputed,
    Refunded,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Job {
    pub id: String,
    pub client: Address,
    pub freelancer: Address,
    pub token: Address,
    pub amount: i128,
    pub remaining_amount: i128,
    pub status: JobStatus,
    pub expiry_ledger: u32,
    /// Set to `current_ledger + DISPUTE_TIMEOUT_LEDGERS` when `dispute()` is
    /// called; zero while the job is not disputed.  Once this ledger passes
    /// without admin resolution, `resolve_stale_dispute` becomes callable.
    pub dispute_expiry_ledger: u32,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Job(String),
    AllowedToken(Address),
}

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// One-time setup: designates the admin address that resolves disputes.
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Contract already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    /// Allows a specific token to be used for jobs.
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

    /// Removes a token from the allowed list.
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

    /// Client funds escrow: transfers `amount` of `token` from client into this
    /// contract, then records the job. `expiry_ledger` must be a future ledger
    /// sequence — once it passes without release or dispute, the client can
    /// reclaim funds via `cancel_job`.
    pub fn create_job(
        env: Env,
        client: Address,
        freelancer: Address,
        job_id: String,
        token: Address,
        amount: i128,
        expiry_ledger: u32,
    ) {
        client.require_auth();
        if amount <= 0 {
            panic!("Amount must be positive");
        }
        if expiry_ledger <= env.ledger().sequence() {
            panic!("Expiry must be in the future");
        }
        if env.storage().instance().has(&DataKey::Job(job_id.clone())) {
            panic!("Job already exists");
        }
        if !env
            .storage()
            .instance()
            .has(&DataKey::AllowedToken(token.clone()))
        {
            panic!("Token is not supported");
        }

        let token_client = token::Client::new(&env, &token);
        let contract_addr = env.current_contract_address();
        token_client.transfer(&client, &contract_addr, &amount);

        let job = Job {
            id: job_id.clone(),
            client: client.clone(),
            freelancer,
            token: token.clone(),
            amount,
            remaining_amount: amount,
            status: JobStatus::Escrowed,
            expiry_ledger,
            dispute_expiry_ledger: 0,
        };
        env.storage().instance().set(&DataKey::Job(job_id), &job);
    }

    /// Client authorizes full release of remaining locked funds to the freelancer.
    pub fn release_escrow(env: Env, client: Address, job_id: String) {
        client.require_auth();
        let mut job: Job = env
            .storage()
            .instance()
            .get(&DataKey::Job(job_id.clone()))
            .expect("Job not found");
        if job.client != client {
            panic!("Only the client can release");
        }
        if job.status != JobStatus::Escrowed {
            panic!("Job is not in escrow");
        }

        // Effects: all state writes BEFORE the external token transfer
        // (Checks-Effects-Interactions to defend against reentrancy from a
        // malicious token contract passed via `token` in `create_job`).
        let release_amount = job.remaining_amount;
        job.remaining_amount = 0;
        job.status = JobStatus::Released;
        env.storage().instance().set(&DataKey::Job(job_id), &job);

        // Interaction: external call last.
        let token_client = token::Client::new(&env, &job.token);
        let contract_addr = env.current_contract_address();
        token_client.transfer(&contract_addr, &job.freelancer, &release_amount);
    }

    /// Client authorizes a partial payment release to the freelancer.
    /// Decrements `remaining_amount`. If `remaining_amount` reaches 0, status transitions to `Released`.
    pub fn release_partial(env: Env, client: Address, job_id: String, amount: i128) {
        client.require_auth();
        if amount <= 0 {
            panic!("Release amount must be positive");
        }
        let mut job: Job = env
            .storage()
            .instance()
            .get(&DataKey::Job(job_id.clone()))
            .expect("Job not found");
        if job.client != client {
            panic!("Only the client can release");
        }
        if job.status != JobStatus::Escrowed {
            panic!("Job is not in escrow");
        }
        if amount > job.remaining_amount {
            panic!("Amount exceeds remaining balance");
        }

        // Effects: all state writes BEFORE the external token transfer
        // (Checks-Effects-Interactions to defend against reentrancy from a
        // malicious token contract passed via `token` in `create_job`).
        job.remaining_amount -= amount;
        if job.remaining_amount == 0 {
            job.status = JobStatus::Released;
        }
        env.storage()
            .instance()
            .set(&DataKey::Job(job_id.clone()), &job);

        // Interaction: external call last.
        let token_client = token::Client::new(&env, &job.token);
        let contract_addr = env.current_contract_address();
        token_client.transfer(&contract_addr, &job.freelancer, &amount);
    }

    /// Either the client or the freelancer can flag a stalled job as disputed,
    /// freezing it until the admin resolves it.
    pub fn dispute(env: Env, caller: Address, job_id: String) {
        caller.require_auth();
        let mut job: Job = env
            .storage()
            .instance()
            .get(&DataKey::Job(job_id.clone()))
            .expect("Job not found");
        if caller != job.client && caller != job.freelancer {
            panic!("Only the client or freelancer can dispute this job");
        }
        if job.status != JobStatus::Escrowed {
            panic!("Job is not in escrow");
        }

        job.status = JobStatus::Disputed;
        job.dispute_expiry_ledger = env
            .ledger()
            .sequence()
            .checked_add(DISPUTE_TIMEOUT_LEDGERS)
            .expect("Dispute expiry overflow");
        env.storage()
            .instance()
            .set(&DataKey::Job(job_id.clone()), &job);
        env.events()
            .publish((symbol_short!("disputed"), caller), job_id);
    }

    /// Admin resolves a disputed job: releases remaining funds to freelancer or refunds remaining funds to client.
    pub fn resolve_dispute(env: Env, admin: Address, job_id: String, release_to_freelancer: bool) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        if stored_admin != admin {
            panic!("Only admin can resolve disputes");
        }

        let mut job: Job = env
            .storage()
            .instance()
            .get(&DataKey::Job(job_id.clone()))
            .expect("Job not found");
        if job.status != JobStatus::Disputed {
            panic!("Job is not disputed");
        }

        // Effects: all state writes BEFORE the external token transfer
        // (Checks-Effects-Interactions to defend against reentrancy from a
        // malicious token contract passed via `token` in `create_job`).
        let remaining = job.remaining_amount;
        let recipient = if release_to_freelancer {
            job.status = JobStatus::Released;
            job.freelancer.clone()
        } else {
            job.status = JobStatus::Refunded;
            job.client.clone()
        };
        job.remaining_amount = 0;
        env.storage()
            .instance()
            .set(&DataKey::Job(job_id.clone()), &job);

        // Interaction: external call last.
        let token_client = token::Client::new(&env, &job.token);
        let contract_addr = env.current_contract_address();
        token_client.transfer(&contract_addr, &recipient, &remaining);
        env.events().publish(
            (symbol_short!("resolved"), admin),
            (job_id, release_to_freelancer),
        );
    }

    /// Fallback resolution: if the admin has not called `resolve_dispute` within
    /// `DISPUTE_TIMEOUT_LEDGERS` ledgers of the dispute being raised, either the
    /// client or the freelancer may call this function to split the remaining
    /// escrowed funds 50/50.
    ///
    /// Odd-stroop remainder (when `remaining_amount` is odd) goes to the client
    /// so the freelancer never receives more than their half.
    ///
    /// CEI ordering: all state writes happen before both token transfers.
    pub fn resolve_stale_dispute(env: Env, caller: Address, job_id: String) {
        caller.require_auth();

        let mut job: Job = env
            .storage()
            .instance()
            .get(&DataKey::Job(job_id.clone()))
            .expect("Job not found");

        // Checks
        if caller != job.client && caller != job.freelancer {
            panic!("Only the client or freelancer can trigger the fallback");
        }
        if job.status != JobStatus::Disputed {
            panic!("Job is not disputed");
        }
        if env.ledger().sequence() <= job.dispute_expiry_ledger {
            panic!("Dispute has not timed out yet");
        }

        // Effects: commit all state before any token transfer (CEI).
        let remaining = job.remaining_amount;
        let freelancer_share = remaining / 2;
        let client_share = remaining
            .checked_sub(freelancer_share)
            .expect("Share arithmetic underflow");
        job.remaining_amount = 0;
        job.status = JobStatus::Refunded;
        let client_addr = job.client.clone();
        let freelancer_addr = job.freelancer.clone();
        env.storage()
            .instance()
            .set(&DataKey::Job(job_id.clone()), &job);

        // Interaction: token transfers last.
        let token_client = token::Client::new(&env, &job.token);
        let contract_addr = env.current_contract_address();
        if freelancer_share > 0 {
            token_client.transfer(&contract_addr, &freelancer_addr, &freelancer_share);
        }
        if client_share > 0 {
            token_client.transfer(&contract_addr, &client_addr, &client_share);
        }

        env.events().publish(
            (symbol_short!("stale_res"), caller),
            (job_id, freelancer_share, client_share),
        );
    }

    /// Client reclaims remaining funds once the job's expiry ledger has passed without
    /// a full release or a dispute being raised.
    pub fn cancel_job(env: Env, client: Address, job_id: String) {
        client.require_auth();
        let mut job: Job = env
            .storage()
            .instance()
            .get(&DataKey::Job(job_id.clone()))
            .expect("Job not found");
        if job.client != client {
            panic!("Only the client can cancel this job");
        }
        if job.status != JobStatus::Escrowed {
            panic!("Job is not in escrow");
        }
        if env.ledger().sequence() <= job.expiry_ledger {
            panic!("Job has not expired yet");
        }

        // Effects: all state writes BEFORE the external token transfer
        // (Checks-Effects-Interactions to defend against reentrancy from a
        // malicious token contract passed via `token` in `create_job`).
        let remaining = job.remaining_amount;
        job.remaining_amount = 0;
        job.status = JobStatus::Refunded;
        env.storage().instance().set(&DataKey::Job(job_id), &job);

        // Interaction: external call last.
        let token_client = token::Client::new(&env, &job.token);
        let contract_addr = env.current_contract_address();
        token_client.transfer(&contract_addr, &job.client, &remaining);
    }

    pub fn get_job(env: Env, job_id: String) -> Option<Job> {
        env.storage().instance().get(&DataKey::Job(job_id))
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

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::token::StellarAssetClient;
    use soroban_sdk::{Address, Env, String};

    const EXPIRY_WINDOW: u32 = 1000;

    /// Sets up a contract, a funded token, and one escrowed job. Returns
    /// everything a test needs to drive it further.
    fn setup() -> (
        Env,
        EscrowContractClient<'static>,
        Address, // admin
        Address, // client
        Address, // freelancer
        Address, // token
        String,  // job_id
        i128,    // amount
        u32,     // expiry_ledger
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let cid = env.register_contract(None, EscrowContract);
        let client_handle = EscrowContractClient::new(&env, &cid);

        let admin = Address::generate(&env);
        client_handle.initialize(&admin);

        let client = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_client = StellarAssetClient::new(&env, &token);

        let amount = 100_i128;
        token_client.mint(&client, &amount);

        client_handle.allow_token(&admin, &token);

        let job_id = String::from_str(&env, "job-1");
        let expiry_ledger = env.ledger().sequence() + EXPIRY_WINDOW;
        client_handle.create_job(
            &client,
            &freelancer,
            &job_id,
            &token,
            &amount,
            &expiry_ledger,
        );

        (
            env,
            client_handle,
            admin,
            client,
            freelancer,
            token,
            job_id,
            amount,
            expiry_ledger,
        )
    }

    #[test]
    #[should_panic(expected = "Job not found")]
    fn release_missing_job_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &cid);
        let addr = Address::generate(&env);
        client.release_escrow(&addr, &String::from_str(&env, "no-such-job"));
    }

    #[test]
    #[should_panic(expected = "Expiry must be in the future")]
    fn create_job_rejects_past_expiry() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, EscrowContract);
        let contract = EscrowContractClient::new(&env, &cid);
        let admin = Address::generate(&env);
        contract.initialize(&admin);

        let client = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client, &100);

        contract.allow_token(&admin, &token);

        let current = env.ledger().sequence();
        contract.create_job(
            &client,
            &freelancer,
            &String::from_str(&env, "job-bad-expiry"),
            &token,
            &100,
            &current,
        );
    }

    #[test]
    #[should_panic(expected = "Token is not supported")]
    fn create_job_with_unsupported_token_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, EscrowContract);
        let contract = EscrowContractClient::new(&env, &cid);
        let admin = Address::generate(&env);
        contract.initialize(&admin);

        let client = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();

        let current = env.ledger().sequence();
        contract.create_job(
            &client,
            &freelancer,
            &String::from_str(&env, "job-unsupported"),
            &token,
            &100,
            &(current + 1000),
        );
    }

    #[test]
    fn dispute_by_client_moves_job_to_disputed() {
        let (_env, contract, _admin, client, _freelancer, _token, job_id, _amount, _expiry) =
            setup();

        contract.dispute(&client, &job_id);

        let job = contract.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::Disputed);
    }

    #[test]
    fn dispute_by_freelancer_moves_job_to_disputed() {
        let (_env, contract, _admin, _client, freelancer, _token, job_id, _amount, _expiry) =
            setup();

        contract.dispute(&freelancer, &job_id);

        let job = contract.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::Disputed);
    }

    #[test]
    #[should_panic(expected = "Only the client or freelancer can dispute this job")]
    fn dispute_by_unrelated_address_panics() {
        let (env, contract, _admin, _client, _freelancer, _token, job_id, _amount, _expiry) =
            setup();
        let stranger = Address::generate(&env);
        contract.dispute(&stranger, &job_id);
    }

    #[test]
    fn admin_resolves_dispute_in_favour_of_freelancer() {
        let (env, contract, admin, _client, freelancer, token, job_id, amount, _expiry) = setup();
        contract.dispute(&freelancer, &job_id);

        contract.resolve_dispute(&admin, &job_id, &true);

        let job = contract.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::Released);
        let token_client = token::Client::new(&env, &token);
        assert_eq!(token_client.balance(&freelancer), amount);
    }

    #[test]
    fn admin_resolves_dispute_in_favour_of_client() {
        let (env, contract, admin, client, _freelancer, token, job_id, amount, _expiry) = setup();
        contract.dispute(&client, &job_id);

        contract.resolve_dispute(&admin, &job_id, &false);

        let job = contract.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::Refunded);
        let token_client = token::Client::new(&env, &token);
        assert_eq!(token_client.balance(&client), amount);
    }

    #[test]
    #[should_panic(expected = "Only admin can resolve disputes")]
    fn resolve_dispute_by_non_admin_panics() {
        let (env, contract, _admin, client, _freelancer, _token, job_id, _amount, _expiry) =
            setup();
        contract.dispute(&client, &job_id);
        let impostor = Address::generate(&env);
        contract.resolve_dispute(&impostor, &job_id, &true);
    }

    #[test]
    fn cancel_after_expiry_refunds_client() {
        let (env, contract, _admin, client, _freelancer, token, job_id, amount, expiry_ledger) =
            setup();
        env.ledger().set_sequence_number(expiry_ledger + 1);

        contract.cancel_job(&client, &job_id);

        let job = contract.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::Refunded);
        let token_client = token::Client::new(&env, &token);
        assert_eq!(token_client.balance(&client), amount);
    }

    #[test]
    #[should_panic(expected = "Job has not expired yet")]
    fn cancel_before_expiry_fails() {
        let (_env, contract, _admin, client, _freelancer, _token, job_id, _amount, _expiry) =
            setup();
        contract.cancel_job(&client, &job_id);
    }

    #[test]
    #[should_panic(expected = "Only the client can cancel this job")]
    fn cancel_by_non_client_panics() {
        let (env, contract, _admin, _client, freelancer, _token, job_id, _amount, expiry_ledger) =
            setup();
        env.ledger().set_sequence_number(expiry_ledger + 1);
        contract.cancel_job(&freelancer, &job_id);
    }

    #[test]
    fn release_partial_decrements_balance_and_keeps_escrowed() {
        let (env, contract, _admin, client, freelancer, token, job_id, amount, _expiry) = setup();

        contract.release_partial(&client, &job_id, &30);

        let job = contract.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::Escrowed);
        assert_eq!(job.amount, amount);
        assert_eq!(job.remaining_amount, 70);

        let token_client = token::Client::new(&env, &token);
        assert_eq!(token_client.balance(&freelancer), 30);
    }

    #[test]
    fn release_partial_until_zero_transitions_to_released() {
        let (env, contract, _admin, client, freelancer, token, job_id, amount, _expiry) = setup();

        contract.release_partial(&client, &job_id, &30);
        contract.release_partial(&client, &job_id, &70);

        let job = contract.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::Released);
        assert_eq!(job.remaining_amount, 0);

        let token_client = token::Client::new(&env, &token);
        assert_eq!(token_client.balance(&freelancer), amount);
    }

    #[test]
    #[should_panic(expected = "Amount exceeds remaining balance")]
    fn release_partial_exceeding_remaining_amount_panics() {
        let (_env, contract, _admin, client, _freelancer, _token, job_id, _amount, _expiry) =
            setup();

        contract.release_partial(&client, &job_id, &150);
    }

    #[test]
    #[should_panic(expected = "Release amount must be positive")]
    fn release_partial_zero_amount_panics() {
        let (_env, contract, _admin, client, _freelancer, _token, job_id, _amount, _expiry) =
            setup();

        contract.release_partial(&client, &job_id, &0);
    }

    #[test]
    fn dispute_and_resolve_after_partial_release() {
        let (env, contract, admin, client, freelancer, token, job_id, _amount, _expiry) = setup();

        contract.release_partial(&client, &job_id, &40);

        let token_client = token::Client::new(&env, &token);
        assert_eq!(token_client.balance(&freelancer), 40);

        contract.dispute(&freelancer, &job_id);

        contract.resolve_dispute(&admin, &job_id, &true);

        let job = contract.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::Released);
        assert_eq!(job.remaining_amount, 0);
        assert_eq!(token_client.balance(&freelancer), 100);
    }

    #[test]
    fn cancel_after_partial_release_refunds_remaining_only() {
        let (env, contract, _admin, client, freelancer, token, job_id, _amount, expiry_ledger) =
            setup();

        contract.release_partial(&client, &job_id, &40);

        let token_client = token::Client::new(&env, &token);
        assert_eq!(token_client.balance(&freelancer), 40);

        env.ledger().set_sequence_number(expiry_ledger + 1);
        contract.cancel_job(&client, &job_id);

        let job = contract.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::Refunded);
        assert_eq!(job.remaining_amount, 0);
        assert_eq!(token_client.balance(&client), 60);
    }

    // -------------------------------------------------------------------------
    // Dispute timeout / stale-dispute fallback tests
    // -------------------------------------------------------------------------

    /// Extend instance TTL before a large ledger jump so storage isn't archived.
    /// Extends both the escrow contract instance and the token contract instance.
    fn extend_ttl(env: &Env, cid: &soroban_sdk::Address, token: &soroban_sdk::Address) {
        env.as_contract(cid, || {
            env.storage()
                .instance()
                .extend_ttl(DISPUTE_TIMEOUT_LEDGERS * 4, DISPUTE_TIMEOUT_LEDGERS * 4);
        });
        env.as_contract(token, || {
            env.storage()
                .instance()
                .extend_ttl(DISPUTE_TIMEOUT_LEDGERS * 4, DISPUTE_TIMEOUT_LEDGERS * 4);
        });
    }

    /// Like `setup()` but also returns the raw contract address for TTL extension.
    fn setup_with_cid() -> (
        Env,
        Address, // contract id
        EscrowContractClient<'static>,
        Address, // admin
        Address, // client
        Address, // freelancer
        Address, // token
        String,  // job_id
        i128,    // amount
        u32,     // expiry_ledger
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let cid = env.register_contract(None, EscrowContract);
        let client_handle = EscrowContractClient::new(&env, &cid);

        let admin = Address::generate(&env);
        client_handle.initialize(&admin);

        let client = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_client = StellarAssetClient::new(&env, &token);

        let amount = 100_i128;
        token_client.mint(&client, &amount);

        client_handle.allow_token(&admin, &token);

        let job_id = String::from_str(&env, "job-1");
        let expiry_ledger = env.ledger().sequence() + EXPIRY_WINDOW;
        client_handle.create_job(
            &client,
            &freelancer,
            &job_id,
            &token,
            &amount,
            &expiry_ledger,
        );

        (
            env,
            cid,
            client_handle,
            admin,
            client,
            freelancer,
            token,
            job_id,
            amount,
            expiry_ledger,
        )
    }

    /// Helper: dispute a job and return the ledger at which the timeout expires.
    fn dispute_job_and_get_timeout(
        _env: &Env,
        contract: &EscrowContractClient,
        caller: &Address,
        job_id: &String,
    ) -> u32 {
        contract.dispute(caller, job_id);
        let job = contract.get_job(job_id).unwrap();
        job.dispute_expiry_ledger
    }

    // --- dispute() records dispute_expiry_ledger ---

    #[test]
    fn dispute_stamps_dispute_expiry_ledger() {
        let (env, contract, _admin, client, _freelancer, _token, job_id, _amount, _expiry) =
            setup();
        let before = env.ledger().sequence();
        contract.dispute(&client, &job_id);
        let job = contract.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::Disputed);
        assert_eq!(job.dispute_expiry_ledger, before + DISPUTE_TIMEOUT_LEDGERS);
    }

    // --- AC: fallback cannot be triggered before the timeout ---

    #[test]
    #[should_panic(expected = "Dispute has not timed out yet")]
    fn resolve_stale_dispute_cannot_trigger_early_by_client() {
        let (_env, _cid, contract, _admin, client, _freelancer, _token, job_id, _amount, _expiry) =
            setup_with_cid();
        contract.dispute(&client, &job_id);
        // timeout has NOT elapsed — must panic
        contract.resolve_stale_dispute(&client, &job_id);
    }

    #[test]
    #[should_panic(expected = "Dispute has not timed out yet")]
    fn resolve_stale_dispute_cannot_trigger_early_by_freelancer() {
        let (_env, _cid, contract, _admin, _client, freelancer, _token, job_id, _amount, _expiry) =
            setup_with_cid();
        contract.dispute(&freelancer, &job_id);
        contract.resolve_stale_dispute(&freelancer, &job_id);
    }

    #[test]
    #[should_panic(expected = "Dispute has not timed out yet")]
    fn resolve_stale_dispute_cannot_trigger_at_exact_expiry_ledger() {
        // The guard is `sequence() <= dispute_expiry_ledger`, so triggering at
        // exactly the expiry ledger must still be blocked.
        let (env, cid, contract, _admin, client, _freelancer, token, job_id, _amount, _expiry) =
            setup_with_cid();
        let timeout = dispute_job_and_get_timeout(&env, &contract, &client, &job_id);
        extend_ttl(&env, &cid, &token);
        env.ledger().set_sequence_number(timeout); // at boundary — not yet past
        contract.resolve_stale_dispute(&client, &job_id);
    }

    // --- AC: fallback triggers correctly after timeout (client calls) ---

    #[test]
    fn resolve_stale_dispute_after_timeout_splits_50_50_client_calls() {
        let (env, cid, contract, _admin, client, freelancer, token, job_id, amount, _expiry) =
            setup_with_cid();
        let timeout = dispute_job_and_get_timeout(&env, &contract, &client, &job_id);
        extend_ttl(&env, &cid, &token);
        env.ledger().set_sequence_number(timeout + 1);

        contract.resolve_stale_dispute(&client, &job_id);

        let job = contract.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::Refunded);
        assert_eq!(job.remaining_amount, 0);

        let token_client = token::Client::new(&env, &token);
        let freelancer_share = amount / 2;
        let client_share = amount - freelancer_share;
        assert_eq!(token_client.balance(&freelancer), freelancer_share);
        assert_eq!(token_client.balance(&client), client_share);
    }

    // --- AC: fallback triggers correctly after timeout (freelancer calls) ---

    #[test]
    fn resolve_stale_dispute_after_timeout_splits_50_50_freelancer_calls() {
        let (env, cid, contract, _admin, client, freelancer, token, job_id, amount, _expiry) =
            setup_with_cid();
        let timeout = dispute_job_and_get_timeout(&env, &contract, &freelancer, &job_id);
        extend_ttl(&env, &cid, &token);
        env.ledger().set_sequence_number(timeout + 1);

        contract.resolve_stale_dispute(&freelancer, &job_id);

        let job = contract.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::Refunded);
        assert_eq!(job.remaining_amount, 0);

        let token_client = token::Client::new(&env, &token);
        let freelancer_share = amount / 2;
        let client_share = amount - freelancer_share;
        assert_eq!(token_client.balance(&freelancer), freelancer_share);
        assert_eq!(token_client.balance(&client), client_share);
    }

    // --- Odd remainder goes to client ---

    #[test]
    fn resolve_stale_dispute_odd_remainder_goes_to_client() {
        // Use an odd amount so integer division produces a remainder of 1.
        let env = Env::default();
        env.mock_all_auths();

        let cid = env.register_contract(None, EscrowContract);
        let contract = EscrowContractClient::new(&env, &cid);
        let admin = Address::generate(&env);
        contract.initialize(&admin);

        let client = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let sac = soroban_sdk::token::StellarAssetClient::new(&env, &token);

        let odd_amount: i128 = 101;
        sac.mint(&client, &odd_amount);
        contract.allow_token(&admin, &token);

        let job_id = String::from_str(&env, "job-odd");
        let expiry_ledger = env.ledger().sequence() + EXPIRY_WINDOW;
        contract.create_job(
            &client,
            &freelancer,
            &job_id,
            &token,
            &odd_amount,
            &expiry_ledger,
        );

        let timeout = dispute_job_and_get_timeout(&env, &contract, &client, &job_id);
        extend_ttl(&env, &cid, &token);
        env.ledger().set_sequence_number(timeout + 1);
        contract.resolve_stale_dispute(&client, &job_id);

        let token_client = token::Client::new(&env, &token);
        // freelancer gets 50, client gets 51 (remainder goes to client)
        assert_eq!(token_client.balance(&freelancer), 50);
        assert_eq!(token_client.balance(&client), 51);
    }

    // --- AC: normal admin resolution still works (existing behaviour preserved) ---

    #[test]
    fn admin_resolves_before_timeout_still_works() {
        let (env, contract, admin, _client, freelancer, token, job_id, amount, _expiry) = setup();
        contract.dispute(&freelancer, &job_id);
        // Admin resolves well before timeout — no ledger advance needed.
        contract.resolve_dispute(&admin, &job_id, &true);

        let job = contract.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::Released);
        assert_eq!(job.remaining_amount, 0);
        let token_client = token::Client::new(&env, &token);
        assert_eq!(token_client.balance(&freelancer), amount);
    }

    // --- Fallback blocked for non-parties ---

    #[test]
    #[should_panic(expected = "Only the client or freelancer can trigger the fallback")]
    fn resolve_stale_dispute_by_stranger_panics() {
        let (env, cid, contract, _admin, client, _freelancer, token, job_id, _amount, _expiry) =
            setup_with_cid();
        let timeout = dispute_job_and_get_timeout(&env, &contract, &client, &job_id);
        extend_ttl(&env, &cid, &token);
        env.ledger().set_sequence_number(timeout + 1);
        let stranger = Address::generate(&env);
        contract.resolve_stale_dispute(&stranger, &job_id);
    }

    // --- Fallback blocked when job is not disputed ---

    #[test]
    #[should_panic(expected = "Job is not disputed")]
    fn resolve_stale_dispute_on_escrowed_job_panics() {
        let (env, cid, contract, _admin, client, _freelancer, token, job_id, _amount, _expiry) =
            setup_with_cid();
        // Advance ledger far enough that the timeout *would* pass if disputed —
        // but the job was never disputed.
        extend_ttl(&env, &cid, &token);
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + DISPUTE_TIMEOUT_LEDGERS + 1);
        contract.resolve_stale_dispute(&client, &job_id);
    }

    // --- Fallback cannot be called twice ---

    #[test]
    #[should_panic(expected = "Job is not disputed")]
    fn resolve_stale_dispute_cannot_double_trigger() {
        let (env, cid, contract, _admin, client, _freelancer, token, job_id, _amount, _expiry) =
            setup_with_cid();
        let timeout = dispute_job_and_get_timeout(&env, &contract, &client, &job_id);
        extend_ttl(&env, &cid, &token);
        env.ledger().set_sequence_number(timeout + 1);
        contract.resolve_stale_dispute(&client, &job_id);
        // Second call must fail — status is now Refunded, not Disputed.
        contract.resolve_stale_dispute(&client, &job_id);
    }

    // --- Fallback after partial release only splits remaining_amount ---

    #[test]
    fn resolve_stale_dispute_after_partial_release_splits_remaining_only() {
        let (env, cid, contract, _admin, client, freelancer, token, job_id, _amount, _expiry) =
            setup_with_cid();

        // Client already paid 40 to freelancer before the dispute arose.
        contract.release_partial(&client, &job_id, &40);

        let timeout = dispute_job_and_get_timeout(&env, &contract, &client, &job_id);
        extend_ttl(&env, &cid, &token);
        env.ledger().set_sequence_number(timeout + 1);
        contract.resolve_stale_dispute(&client, &job_id);

        // Remaining was 60 → freelancer gets 30, client gets 30.
        let token_client = token::Client::new(&env, &token);
        assert_eq!(token_client.balance(&freelancer), 40 + 30); // 40 from partial + 30 from split
        assert_eq!(token_client.balance(&client), 30);

        let job = contract.get_job(&job_id).unwrap();
        assert_eq!(job.remaining_amount, 0);
        assert_eq!(job.status, JobStatus::Refunded);
    }

    // -------------------------------------------------------------------------
    // Reentrancy regression tests (release_partial CEI ordering)
    // -------------------------------------------------------------------------

    /// A malicious token stub whose `transfer` re-enters the escrow contract's
    /// `release_partial` before the outer call has committed its state write.
    /// It is deliberately lenient: it never rejects a transfer, so the only
    /// thing that can stop an over-release is the escrow contract's own state
    /// ordering. It re-enters exactly once to avoid unbounded recursion.
    #[contract]
    struct ReentrantToken;

    #[contracttype]
    #[derive(Clone)]
    enum ReentrantKey {
        Balance(Address),
        /// (escrow contract, client, job id, amount to attempt on re-entry)
        Target,
        /// Set once re-entry has already happened for the current call chain.
        HasReentered,
    }

    #[contractimpl]
    impl ReentrantToken {
        /// Points the token at the escrow job it should try to drain, and the
        /// amount it should attempt on re-entry.
        pub fn set_target(
            env: Env,
            escrow: Address,
            client: Address,
            job_id: String,
            reentry_amount: i128,
        ) {
            env.storage().instance().set(
                &ReentrantKey::Target,
                &(escrow, client, job_id, reentry_amount),
            );
        }

        pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
            // Re-enter the escrow contract exactly once, before this token does
            // any of its own bookkeeping — mimicking a token that calls back
            // into its caller mid-transfer. Re-entry only fires when the escrow
            // contract itself is the sender (a release transfer); the deposit
            // transfer inside `create_job` (client → escrow) must pass through
            // untouched because the job does not exist yet at that point.
            if env.storage().instance().has(&ReentrantKey::Target) {
                let (escrow, client, job_id, reentry_amount): (Address, Address, String, i128) =
                    env.storage()
                        .instance()
                        .get(&ReentrantKey::Target)
                        .expect("target not set");
                if from == escrow && !env.storage().instance().has(&ReentrantKey::HasReentered) {
                    env.storage()
                        .instance()
                        .set(&ReentrantKey::HasReentered, &true);
                    let escrow_client = EscrowContractClient::new(&env, &escrow);
                    escrow_client.release_partial(&client, &job_id, &reentry_amount);
                }
            }

            // Lenient bookkeeping: always credit the recipient, never reject.
            let to_balance: i128 = env
                .storage()
                .instance()
                .get(&ReentrantKey::Balance(to.clone()))
                .unwrap_or(0);
            env.storage()
                .instance()
                .set(&ReentrantKey::Balance(to), &(to_balance + amount));
            let _ = from;
        }

        pub fn balance(env: Env, id: Address) -> i128 {
            env.storage()
                .instance()
                .get(&ReentrantKey::Balance(id))
                .unwrap_or(0)
        }
    }

    /// A token that re-enters `release_partial` from inside `transfer` must not
    /// be able to release more than the job's remaining balance. With CEI
    /// ordering the re-entrant call sees the already-decremented `remaining_amount`
    /// and is rejected; the failed transaction rolls back completely.
    #[test]
    fn release_partial_reentrant_token_cannot_over_release() {
        let env = Env::default();
        env.mock_all_auths();

        let escrow_id = env.register_contract(None, EscrowContract);
        let escrow = EscrowContractClient::new(&env, &escrow_id);

        let admin = Address::generate(&env);
        escrow.initialize(&admin);

        let client = Address::generate(&env);
        let freelancer = Address::generate(&env);

        let token_id = env.register_contract(None, ReentrantToken);
        let token = ReentrantTokenClient::new(&env, &token_id);
        escrow.allow_token(&admin, &token_id);

        let job_id = String::from_str(&env, "job-reentrant");
        let expiry_ledger = env.ledger().sequence() + EXPIRY_WINDOW;
        escrow.create_job(
            &client,
            &freelancer,
            &job_id,
            &token_id,
            &100,
            &expiry_ledger,
        );

        // The token tries to grab the full 100 by re-entering mid-transfer.
        token.set_target(&escrow_id, &client, &job_id, &100);

        // The client releases 30; the malicious token attempts to release the
        // remaining 100 before the outer call's state write lands. If CEI is
        // violated (the pre-fix ordering), the re-entrant call sees
        // remaining_amount == 100 and succeeds — the escrow accounting would
        // then have paid out 130 from a 100-amount job.
        let result = escrow.try_release_partial(&client, &job_id, &30);

        assert!(
            result.is_err(),
            "re-entrant over-release must be rejected by the updated remaining balance"
        );

        // The whole transaction rolled back: the job is intact and untouched.
        let job = escrow.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::Escrowed);
        assert_eq!(job.remaining_amount, 100);
        assert_eq!(token.balance(&freelancer), 0);
    }

    /// A benign re-entry (an amount within the remaining balance) during a full
    /// release is also safe: the second release attempt sees `status == Released`
    /// and is rejected, so funds cannot be double-paid even by a cooperative
    /// token that happens to call back.
    #[test]
    fn release_partial_reentrant_token_cannot_double_release_full() {
        let env = Env::default();
        env.mock_all_auths();

        let escrow_id = env.register_contract(None, EscrowContract);
        let escrow = EscrowContractClient::new(&env, &escrow_id);

        let admin = Address::generate(&env);
        escrow.initialize(&admin);

        let client = Address::generate(&env);
        let freelancer = Address::generate(&env);

        let token_id = env.register_contract(None, ReentrantToken);
        let token = ReentrantTokenClient::new(&env, &token_id);
        escrow.allow_token(&admin, &token_id);

        let job_id = String::from_str(&env, "job-reentrant-full");
        let expiry_ledger = env.ledger().sequence() + EXPIRY_WINDOW;
        escrow.create_job(
            &client,
            &freelancer,
            &job_id,
            &token_id,
            &100,
            &expiry_ledger,
        );

        // Re-enter with the full 100 on the first (and only) transfer.
        token.set_target(&escrow_id, &client, &job_id, &100);

        // Releasing everything in one call: the re-entrant attempt must hit
        // the "Job is not in escrow" guard because status was already flipped
        // to Released before the token was ever invoked.
        let result = escrow.try_release_partial(&client, &job_id, &100);

        assert!(
            result.is_err(),
            "re-entrant full release after status flip must be rejected"
        );

        let job = escrow.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::Escrowed);
        assert_eq!(job.remaining_amount, 100);
        assert_eq!(token.balance(&freelancer), 0);
    }
}
