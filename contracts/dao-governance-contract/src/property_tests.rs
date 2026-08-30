/// Property-based tests for DAO Governance token conservation paths.
///
/// See `contracts/INVARIANTS.md` for the plain-language invariants encoded here.
#[cfg(all(test, feature = "testutils"))]
mod property {
    extern crate std;

    use std::vec::Vec;

    use crate::{DaoGovernanceContract, DaoGovernanceContractClient};
    use proptest::prelude::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::token::StellarAssetClient;
    use soroban_sdk::{Address, Env};

    const MIN_LOCK: u32 = 120_960; // 7 days
    const STROOP: i128 = 10_000_000;

    fn setup_with_balance(
        voter_balance: i128,
    ) -> (
        Env,
        DaoGovernanceContractClient<'static>,
        Address,
        Address,
        Address,
        StellarAssetClient<'static>,
    ) {
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

        client.initialize(&gp_token, &500i128, &MIN_LOCK, &MIN_LOCK, &admin);

        let voter = Address::generate(&env);
        token_client.mint(&voter, &voter_balance);

        (env, client, cid, voter, gp_token, token_client)
    }

    #[derive(Clone, Debug)]
    enum LockOp {
        Lock(i128),
        WithdrawAfterExpiry,
    }

    fn arb_lock_sequence(max_ops: usize) -> impl Strategy<Value = Vec<LockOp>> {
        prop::collection::vec(
            prop_oneof![
                (STROOP..=(50 * STROOP)).prop_map(LockOp::Lock),
                Just(LockOp::WithdrawAfterExpiry),
            ],
            1..=max_ops,
        )
    }

    proptest! {
        #![proptest_config(ProptestConfig::default())]

        /// Total locked tracks the active lock amount after lock/withdraw sequences.
        #[test]
        fn prop_total_locked_matches_active_lock(
            balance in (10 * STROOP..=(200 * STROOP)),
            lock_amount in STROOP..=(50 * STROOP),
        ) {
            let (env, client, _cid, voter, _gp_token, _token_client) = setup_with_balance(balance);
            let lock_amt = lock_amount.min(balance);

            client.lock_tokens(&voter, &lock_amt, &MIN_LOCK);
            prop_assert_eq!(client.get_total_locked(), lock_amt);

            env.ledger().set_sequence_number(env.ledger().sequence() + MIN_LOCK + 1);
            client.withdraw(&voter);
            prop_assert_eq!(client.get_total_locked(), 0);
        }

        /// After expiry, a new lock replaces the prior lock amount in total_locked.
        #[test]
        fn prop_relock_replaces_prior_lock(
            balance in (20 * STROOP..=(100 * STROOP)),
            first in STROOP..=(30 * STROOP),
            second in STROOP..=(40 * STROOP),
        ) {
            let (env, client, _cid, voter, _gp_token, _token_client) = setup_with_balance(balance);
            let a = first.min(balance);
            let b = second.min(balance);

            client.lock_tokens(&voter, &a, &MIN_LOCK);
            prop_assert_eq!(client.get_total_locked(), a);

            env.ledger().set_sequence_number(env.ledger().sequence() + MIN_LOCK + 1);
            client.withdraw(&voter);

            client.lock_tokens(&voter, &b, &MIN_LOCK);
            prop_assert_eq!(client.get_total_locked(), b);
        }

        /// Lock/withdraw sequences preserve token conservation.
        #[test]
        fn prop_lock_withdraw_sequence_conservation(
            balance in (30 * STROOP..=(150 * STROOP)),
            ops in arb_lock_sequence(5),
        ) {
            let (env, client, contract_addr, voter, gp_token, _token_client) = setup_with_balance(balance);
            let token = soroban_sdk::token::Client::new(&env, &gp_token);

            let mut expected_locked: i128 = 0;

            for op in ops {
                match op {
                    LockOp::Lock(amt) => {
                        if expected_locked > 0 {
                            env.ledger()
                                .set_sequence_number(env.ledger().sequence() + MIN_LOCK + 1);
                            client.withdraw(&voter);
                        }
                        let lock_amt = amt.min(balance);
                        client.lock_tokens(&voter, &lock_amt, &MIN_LOCK);
                        expected_locked = lock_amt;
                        prop_assert_eq!(client.get_total_locked(), expected_locked);
                    }
                    LockOp::WithdrawAfterExpiry => {
                        if expected_locked > 0 {
                            env.ledger().set_sequence_number(env.ledger().sequence() + MIN_LOCK + 1);
                            client.withdraw(&voter);
                            expected_locked = 0;
                            prop_assert_eq!(client.get_total_locked(), 0);
                        }
                    }
                }
            }

            // Contract-held tokens must equal total_locked.
            let contract_balance = token.balance(&contract_addr);
            prop_assert_eq!(contract_balance, client.get_total_locked());
        }

        /// Voting power is always non-negative after locking.
        #[test]
        fn prop_voting_power_non_negative_after_lock(
            balance in (10 * STROOP..=(100 * STROOP)),
            lock_amount in STROOP..=(40 * STROOP),
        ) {
            let (env, client, _cid, voter, _gp_token, _token_client) = setup_with_balance(balance);
            let lock_amt = lock_amount.min(balance);
            client.lock_tokens(&voter, &lock_amt, &MIN_LOCK);
            let power = client.get_voting_power(&voter, &env.ledger().sequence());
            prop_assert!(power >= 0);
            prop_assert_eq!(client.get_total_locked(), lock_amt);
        }

        /// Total locked arithmetic rejects amounts that would underflow on withdraw.
        #[test]
        fn prop_lock_amount_overflow_rejected(
            balance in (STROOP..=(20 * STROOP)),
        ) {
            let (_env, client, _cid, voter, _gp_token, _token_client) = setup_with_balance(balance);
            let result = client.try_lock_tokens(&voter, &i128::MAX, &MIN_LOCK);
            prop_assert!(result.is_err());
            prop_assert_eq!(client.get_total_locked(), 0);
        }

        /// Checked arithmetic: lock amount must be positive.
        #[test]
        fn prop_lock_rejects_non_positive_amount(
            balance in (STROOP..=(50 * STROOP)),
        ) {
            let (_env, client, _cid, voter, _gp_token, _token_client) = setup_with_balance(balance);
            let result = client.try_lock_tokens(&voter, &0i128, &MIN_LOCK);
            prop_assert!(result.is_err());
        }
    }

    /// Regression: withdraw before expiry must fail without changing total locked.
    #[test]
    fn regression_withdraw_before_expiry_preserves_total_locked() {
        let balance = 20 * STROOP;
        let (_env, client, _cid, voter, _gp_token, _token_client) = setup_with_balance(balance);
        let lock_amt = 5 * STROOP;

        client.lock_tokens(&voter, &lock_amt, &MIN_LOCK);
        assert_eq!(client.get_total_locked(), lock_amt);

        let result = client.try_withdraw(&voter);
        assert!(result.is_err());
        assert_eq!(client.get_total_locked(), lock_amt);
    }
}
