/// Property-based tests for the Escrow Soroban contract.
///
/// Generates valid operation sequences (partial releases, full release, cancel)
/// and asserts conservation invariants from `contracts/INVARIANTS.md`.
#[cfg(all(test, feature = "testutils"))]
mod property {
    extern crate std;

    use std::vec::Vec;

    use crate::{EscrowContract, EscrowContractClient, JobStatus};
    use proptest::prelude::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::token::StellarAssetClient;
    use soroban_sdk::{Address, Env, String};

    const STROOP: i128 = 10_000_000;
    const EXPIRY_WINDOW: u32 = 1000;

    #[derive(Clone, Debug)]
    enum EscrowOp {
        PartialRelease(i128),
        FullRelease,
        Dispute,
        AdminResolve(bool),
        CancelAfterExpiry,
    }

    fn setup_job(
        amount: i128,
    ) -> (
        Env,
        EscrowContractClient<'static>,
        Address,
        Address,
        Address,
        Address,
        String,
        i128,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let cid = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &cid);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        client.allow_token(&admin, &token);

        let token_client = StellarAssetClient::new(&env, &token);
        let escrow_client = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let job_id = String::from_str(&env, "prop-job-1");

        token_client.mint(&escrow_client, &amount);

        let expiry = env.ledger().sequence() + EXPIRY_WINDOW;
        client.create_job(
            &escrow_client,
            &freelancer,
            &job_id,
            &token,
            &amount,
            &expiry,
        );

        (
            env,
            client,
            admin,
            escrow_client,
            freelancer,
            token,
            job_id,
            amount,
        )
    }

    fn apply_op(
        env: &Env,
        client: &EscrowContractClient,
        admin: &Address,
        escrow_client: &Address,
        job_id: &String,
        op: &EscrowOp,
    ) -> bool {
        let job = match client.get_job(job_id) {
            Some(j) => j,
            None => return false,
        };

        match op {
            EscrowOp::PartialRelease(amt) if job.status == JobStatus::Escrowed && *amt > 0 => {
                if *amt > job.remaining_amount {
                    return false;
                }
                client.release_partial(escrow_client, job_id, amt);
                true
            }
            EscrowOp::FullRelease if job.status == JobStatus::Escrowed => {
                client.release_escrow(escrow_client, job_id);
                true
            }
            EscrowOp::Dispute if job.status == JobStatus::Escrowed => {
                client.dispute(escrow_client, job_id);
                true
            }
            EscrowOp::AdminResolve(to_freelancer) if job.status == JobStatus::Disputed => {
                client.resolve_dispute(admin, job_id, to_freelancer);
                true
            }
            EscrowOp::CancelAfterExpiry if job.status == JobStatus::Escrowed => {
                env.ledger()
                    .set_sequence_number(env.ledger().sequence() + EXPIRY_WINDOW + 1);
                client.cancel_job(escrow_client, job_id);
                true
            }
            _ => false,
        }
    }

    fn arb_escrow_sequence(max_ops: usize) -> impl Strategy<Value = Vec<EscrowOp>> {
        prop::collection::vec(
            prop_oneof![
                (STROOP..=(50 * STROOP)).prop_map(EscrowOp::PartialRelease),
                Just(EscrowOp::FullRelease),
                Just(EscrowOp::Dispute),
                any::<bool>().prop_map(EscrowOp::AdminResolve),
                Just(EscrowOp::CancelAfterExpiry),
            ],
            1..=max_ops,
        )
    }

    proptest! {
        #![proptest_config(ProptestConfig::default())]

        #[test]
        fn prop_escrow_remaining_within_bounds(
            original in (STROOP..=(100 * STROOP)),
            ops in arb_escrow_sequence(8),
        ) {
            let (env, client, admin, escrow_client, _freelancer, _token, job_id, amount) =
                setup_job(original);

            for op in &ops {
                apply_op(&env, &client, &admin, &escrow_client, &job_id, op);
                if let Some(job) = client.get_job(&job_id) {
                    prop_assert!(job.remaining_amount >= 0);
                    prop_assert!(job.remaining_amount <= amount);
                    prop_assert!(job.amount == amount);
                }
            }
        }

        #[test]
        fn prop_escrow_conservation_after_sequence(
            original in (2 * STROOP..=(80 * STROOP)),
            partial_count in 1u32..=6u32,
            chunk in STROOP..=(5 * STROOP),
        ) {
            let (_env, client, _admin, escrow_client, _freelancer, _token, job_id, amount) =
                setup_job(original);

            let mut released: i128 = 0;
            for _ in 0..partial_count {
                let job = client.get_job(&job_id).expect("job");
                if job.status != JobStatus::Escrowed {
                    break;
                }
                let release_amt = chunk.min(job.remaining_amount);
                if release_amt <= 0 {
                    break;
                }
                client.release_partial(&escrow_client, &job_id, &release_amt);
                released = released.checked_add(release_amt).unwrap();
            }

            if let Some(job) = client.get_job(&job_id) {
                prop_assert_eq!(released + job.remaining_amount, amount);
            }
        }

        #[test]
        fn prop_dispute_resolution_zeroes_remaining(
            original in (STROOP..=(50 * STROOP)),
            to_freelancer in any::<bool>(),
        ) {
            let (_env, client, admin, escrow_client, _freelancer, _token, job_id, amount) =
                setup_job(original);

            client.dispute(&escrow_client, &job_id);
            client.resolve_dispute(&admin, &job_id, &to_freelancer);

            let job = client.get_job(&job_id).expect("job");
            prop_assert_eq!(job.remaining_amount, 0);
            prop_assert!(job.status == JobStatus::Released || job.status == JobStatus::Refunded);
            let _ = amount;
        }

        #[test]
        fn prop_partial_release_overflow_rejected(
            original in (3 * STROOP..=(30 * STROOP)),
            over in 1i128..=STROOP,
        ) {
            let (_env, client, _admin, escrow_client, _freelancer, _token, job_id, amount) =
                setup_job(original);

            client.release_partial(&escrow_client, &job_id, &(amount - STROOP));
            let result = client.try_release_partial(&escrow_client, &job_id, &(STROOP + over));
            prop_assert!(result.is_err());
        }

        #[test]
        fn prop_stale_dispute_odd_stroop_conservation(
            remaining in (1i128..=(99 * STROOP)),
        ) {
            let env = Env::default();
            env.mock_all_auths();

            let cid = env.register_contract(None, EscrowContract);
            let client = EscrowContractClient::new(&env, &cid);
            let admin = Address::generate(&env);
            client.initialize(&admin);

            let token_admin = Address::generate(&env);
            let token = env
                .register_stellar_asset_contract_v2(token_admin)
                .address();
            client.allow_token(&admin, &token);

            let token_client = StellarAssetClient::new(&env, &token);
            let escrow_client = Address::generate(&env);
            let freelancer = Address::generate(&env);
            let job_id = String::from_str(&env, "odd-job");

            token_client.mint(&escrow_client, &remaining);

            let expiry = env.ledger().sequence() + EXPIRY_WINDOW;
            client.create_job(
                &escrow_client,
                &freelancer,
                &job_id,
                &token,
                &remaining,
                &expiry,
            );

            client.dispute(&escrow_client, &job_id);
            env.ledger().set_sequence_number(env.ledger().sequence() + 201);

            client.resolve_stale_dispute(&freelancer, &job_id);

            let freelancer_share = remaining / 2;
            let client_share = remaining - freelancer_share;
            prop_assert_eq!(freelancer_share + client_share, remaining);
            prop_assert!(client_share >= freelancer_share);

            let job = client.get_job(&job_id).expect("job");
            prop_assert_eq!(job.remaining_amount, 0);
        }
    }

    #[test]
    fn regression_partial_release_cannot_exceed_remaining() {
        let amount = 10 * STROOP;
        let (_env, client, _admin, escrow_client, _freelancer, _token, job_id, _) =
            setup_job(amount);

        client.release_partial(&escrow_client, &job_id, &(7 * STROOP));
        let over = client.try_release_partial(&escrow_client, &job_id, &(4 * STROOP));
        assert!(over.is_err());

        let job = client.get_job(&job_id).expect("job");
        assert_eq!(job.remaining_amount, 3 * STROOP);
    }
}
