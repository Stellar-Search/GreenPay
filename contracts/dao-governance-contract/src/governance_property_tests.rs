/// Property-based tests for DAO governance proposal lifecycle invariants.
///
/// Encodes `contracts/INVARIANTS.md` rules around proposal IDs, vote tallies,
/// quorum freezing at snapshot, and stage transitions.
#[cfg(all(test, feature = "testutils"))]
mod governance {
    extern crate std;

    use std::vec::Vec;

    use crate::{DaoGovernanceContract, DaoGovernanceContractClient, ProposalStage};
    use proptest::prelude::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::token::StellarAssetClient;
    use soroban_sdk::{contract, contractimpl, Address, Bytes, Env, String, Symbol};

    const MIN_LOCK: u32 = 120_960;
    const QUORUM_BPS: i128 = 500;
    const VOTING_PERIOD: u32 = 121_000;
    const TIMELOCK: u32 = 10_000;
    const STROOP: i128 = 10_000_000;

    #[contract]
    struct Noop;

    #[contractimpl]
    impl Noop {
        pub fn noop(_env: Env, _data: Bytes) {}
    }

    fn deploy_noop(env: &Env) -> Address {
        let addr = env.register_contract(None, Noop);
        env.as_contract(&addr, || {
            env.storage().instance().extend_ttl(1_000_000, 1_000_000);
        });
        addr
    }

    struct GovFixture {
        env: Env,
        client: DaoGovernanceContractClient<'static>,
        target: Address,
        noop_fn: Symbol,
    }

    fn setup_governance(voter_balance: i128) -> (GovFixture, Address, StellarAssetClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();

        let cid = env.register_contract(None, DaoGovernanceContract);
        let client = DaoGovernanceContractClient::new(&env, &cid);
        env.as_contract(&cid, || {
            env.storage().instance().extend_ttl(1_000_000, 1_000_000);
        });

        let admin = Address::generate(&env);
        let gp_admin = Address::generate(&env);
        let gp_token = env.register_stellar_asset_contract_v2(gp_admin).address();
        env.as_contract(&gp_token, || {
            env.storage().instance().extend_ttl(1_000_000, 1_000_000);
        });
        let token_client = StellarAssetClient::new(&env, &gp_token);

        client.initialize(&gp_token, &QUORUM_BPS, &VOTING_PERIOD, &TIMELOCK, &admin);

        let target = deploy_noop(&env);
        let noop_fn = Symbol::new(&env, "noop");
        client.add_allowed_target(&admin, &target, &noop_fn);

        let voter = Address::generate(&env);
        token_client.mint(&voter, &voter_balance);

        let fixture = GovFixture {
            env,
            client,
            target,
            noop_fn,
        };
        (fixture, voter, token_client)
    }

    fn lock_all(fixture: &GovFixture, voter: &Address, amount: i128) {
        fixture.client.lock_tokens(voter, &amount, &MIN_LOCK);
    }

    fn create_proposal(fixture: &GovFixture, proposer: &Address) -> u64 {
        fixture.client.create_proposal(
            proposer,
            &String::from_str(&fixture.env, "Prop"),
            &String::from_str(&fixture.env, "Desc"),
            &fixture.target,
            &fixture.noop_fn,
            &Bytes::new(&fixture.env),
        )
    }

    fn advance_snapshot(fixture: &GovFixture, caller: &Address, pid: u64) {
        fixture.client.advance_to_snapshot(caller, &pid);
    }

    fn cast_vote(fixture: &GovFixture, voter: &Address, pid: u64, approve: bool) {
        fixture.client.cast_vote(voter, &pid, &approve);
    }

    fn close_voting(fixture: &GovFixture, pid: u64) {
        let end = fixture.client.get_proposal(&pid).vote_end_ledger;
        fixture.env.ledger().set_sequence_number(end + 1);
        fixture.client.finalise_vote(&pid);
    }

    proptest! {
        #![proptest_config(ProptestConfig::default())]

        /// Proposal IDs are strictly monotonic across sequential creation.
        #[test]
        fn prop_proposal_ids_monotonic(count in 1usize..=8) {
            let balance = 50 * STROOP;
            let (fixture, voter, _token) = setup_governance(balance);
            lock_all(&fixture, &voter, balance);

            let mut last_id = 0u64;
            for _ in 0..count {
                let pid = create_proposal(&fixture, &voter);
                prop_assert!(pid > last_id);
                last_id = pid;
            }
            prop_assert_eq!(fixture.client.get_proposal_count(), count as u64);
        }

        /// Single voter can cast at most one ballot; tallies match snapshot power.
        #[test]
        fn prop_single_voter_tally_matches_power(
            lock_amount in (20 * STROOP..=(100 * STROOP)),
            approve in any::<bool>(),
        ) {
            let (fixture, voter, _token) = setup_governance(lock_amount);
            lock_all(&fixture, &voter, lock_amount);

            let pid = create_proposal(&fixture, &voter);
            advance_snapshot(&fixture, &voter, pid);
            cast_vote(&fixture, &voter, pid, approve);

            let proposal = fixture.client.get_proposal(&pid);
            let power = fixture.client.get_voting_power(
                &voter,
                &proposal.snapshot_ledger,
            );

            if approve {
                prop_assert_eq!(proposal.votes_for, power);
                prop_assert_eq!(proposal.votes_against, 0);
            } else {
                prop_assert_eq!(proposal.votes_against, power);
                prop_assert_eq!(proposal.votes_for, 0);
            }
        }

        /// Quorum requirement is frozen at snapshot from total_locked × quorum_bps.
        #[test]
        fn prop_quorum_frozen_at_snapshot(lock_amount in (30 * STROOP..=(80 * STROOP))) {
            let (fixture, voter, _token) = setup_governance(lock_amount);
            lock_all(&fixture, &voter, lock_amount);

            let pid = create_proposal(&fixture, &voter);
            let total_locked_before = fixture.client.get_total_locked();
            advance_snapshot(&fixture, &voter, pid);

            let proposal = fixture.client.get_proposal(&pid);
            let expected_quorum = (total_locked_before * QUORUM_BPS) / 10000;
            prop_assert_eq!(proposal.quorum_requirement, expected_quorum);
            prop_assert_eq!(proposal.stage, ProposalStage::SnapshotVote);
        }

        /// Unanimous approval with sufficient locked supply reaches Execution stage.
        #[test]
        fn prop_unanimous_approval_reaches_execution(
            lock_a in (25 * STROOP..=(60 * STROOP)),
            lock_b in (25 * STROOP..=(60 * STROOP)),
        ) {
            let total = lock_a.saturating_add(lock_b);
            let (fixture, voter_a, token) = setup_governance(total);
            let voter_b = Address::generate(&fixture.env);
            token.mint(&voter_b, &lock_b);

            lock_all(&fixture, &voter_a, lock_a);
            lock_all(&fixture, &voter_b, lock_b);

            let pid = create_proposal(&fixture, &voter_a);
            advance_snapshot(&fixture, &voter_a, pid);
            cast_vote(&fixture, &voter_a, pid, true);
            cast_vote(&fixture, &voter_b, pid, true);
            close_voting(&fixture, pid);

            let proposal = fixture.client.get_proposal(&pid);
            prop_assert_eq!(proposal.stage, ProposalStage::Execution);
            prop_assert!(proposal.executable_from_ledger > proposal.vote_end_ledger);
        }

        /// Split vote with more against than for ends Defeated when quorum met.
        #[test]
        fn prop_majority_against_defeats_proposal(
            lock_a in (40 * STROOP..=(70 * STROOP)),
            lock_b in (10 * STROOP..=(30 * STROOP)),
        ) {
            let total = lock_a.saturating_add(lock_b);
            let (fixture, voter_a, token) = setup_governance(total);
            let voter_b = Address::generate(&fixture.env);
            token.mint(&voter_b, &lock_b);

            lock_all(&fixture, &voter_a, lock_a);
            lock_all(&fixture, &voter_b, lock_b);

            let pid = create_proposal(&fixture, &voter_a);
            advance_snapshot(&fixture, &voter_a, pid);
            cast_vote(&fixture, &voter_a, pid, false);
            cast_vote(&fixture, &voter_b, pid, true);
            close_voting(&fixture, pid);

            let proposal = fixture.client.get_proposal(&pid);
            prop_assert_eq!(proposal.stage, ProposalStage::Defeated);
        }
    }

    #[test]
    fn regression_proposal_count_matches_created_ids() {
        let (fixture, voter, _token) = setup_governance(100 * STROOP);
        lock_all(&fixture, &voter, 100 * STROOP);

        let ids: Vec<u64> = (0..5).map(|_| create_proposal(&fixture, &voter)).collect();

        for (i, &pid) in ids.iter().enumerate() {
            assert_eq!(pid, (i + 1) as u64);
        }
        assert_eq!(fixture.client.get_proposal_count(), 5);
    }

    #[test]
    fn regression_snapshot_resets_vote_counters() {
        let (fixture, voter, _token) = setup_governance(50 * STROOP);
        lock_all(&fixture, &voter, 50 * STROOP);

        let pid = create_proposal(&fixture, &voter);
        advance_snapshot(&fixture, &voter, pid);

        let p = fixture.client.get_proposal(&pid);
        assert_eq!(p.votes_for, 0);
        assert_eq!(p.votes_against, 0);
        assert!(p.vote_end_ledger >= p.snapshot_ledger);
        assert_eq!(p.stage, ProposalStage::SnapshotVote);
    }
}
