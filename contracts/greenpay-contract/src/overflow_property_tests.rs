/// Property-based overflow and underflow guards on GreenPay money paths.
///
/// Exercises donation accumulators, CO₂ math, and rejection of pathological inputs
/// that would wrap i128 totals if unchecked.
#[cfg(all(test, feature = "testutils"))]
mod overflow {
    extern crate std;

    use crate::{
        GreenPayContract, GreenPayContractClient, MAX_CO2_PER_XLM, MAX_REALISTIC_DONATION_STROOPS,
        STROOP,
    };
    use proptest::prelude::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::token::StellarAssetClient;
    use soroban_sdk::{Address, Env, String as SorobanString};

    fn setup(
        co2_per_xlm: u32,
    ) -> (
        Env,
        GreenPayContractClient<'static>,
        Address,
        Address,
        StellarAssetClient<'static>,
        SorobanString,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, GreenPayContract);
        let client = GreenPayContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let project_id = SorobanString::from_str(&env, "overflow-prop");
        let wallet = Address::generate(&env);
        client.register_project(
            &admin,
            &project_id,
            &SorobanString::from_str(&env, "Overflow Project"),
            &wallet,
            &co2_per_xlm,
        );

        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_client = StellarAssetClient::new(&env, &token);
        client.allow_token(&admin, &token);

        (env, client, admin, token, token_client, project_id)
    }

    proptest! {
        #![proptest_config(ProptestConfig::default())]

        /// Realistic donation sequences keep global totals equal to sum of amounts.
        #[test]
        fn prop_global_total_equals_sum(
            amounts in prop::collection::vec(STROOP..=(3 * STROOP), 1..=10),
        ) {
            let (env, client, _admin, token, token_client, project_id) =
                setup(8_500);
            let donor = Address::generate(&env);

            let expected: i128 = amounts.iter().copied().sum();
            for amount in &amounts {
                token_client.mint(&donor, amount);
                client.donate(&token, &donor, &project_id, amount, &0u32);
            }

            prop_assert_eq!(client.get_global_total(), expected);
            prop_assert_eq!(client.get_project(&project_id).total_raised, expected);
        }

        /// CO₂ accumulator stays non-negative for realistic co2_per_xlm.
        #[test]
        fn prop_co2_non_negative(
            amount in STROOP..=MAX_REALISTIC_DONATION_STROOPS,
            co2 in 1u32..=MAX_CO2_PER_XLM,
        ) {
            let (env, client, _admin, token, token_client, project_id) = setup(co2);
            let donor = Address::generate(&env);
            token_client.mint(&donor, &amount);
            client.donate(&token, &donor, &project_id, &amount, &0u32);

            prop_assert!(client.get_global_co2() >= 0);
            prop_assert!(client.get_donor_stats(&donor).co2_offset_grams >= 0);
        }

        /// Donation count increments exactly once per successful donate.
        #[test]
        fn prop_donation_count_increments(
            n in 1usize..=8,
            amount in STROOP..=(2 * STROOP),
        ) {
            let (env, client, _admin, token, token_client, project_id) =
                setup(5_000);
            let donor = Address::generate(&env);

            for _ in 0..n {
                token_client.mint(&donor, &amount);
                client.donate(&token, &donor, &project_id, &amount, &0u32);
            }

            prop_assert_eq!(client.get_donor_stats(&donor).donation_count, n as u32);
        }
    }

    #[test]
    #[should_panic(expected = "donation amount must be positive")]
    fn regression_zero_donation_rejected() {
        let (env, client, _admin, token, token_client, project_id) = setup(1_000);
        let donor = Address::generate(&env);
        token_client.mint(&donor, &STROOP);
        client.donate(&token, &donor, &project_id, &0i128, &0u32);
    }

    #[test]
    fn regression_i128_max_donation_rejected_or_rollback() {
        let (env, client, _admin, token, token_client, project_id) = setup(1_000);
        let donor = Address::generate(&env);
        token_client.mint(&donor, &i128::MAX);

        let before = client.get_global_total();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.donate(&token, &donor, &project_id, &i128::MAX, &0u32);
        }));

        if result.is_err() {
            assert_eq!(client.get_global_total(), before);
        }
    }

    #[test]
    fn regression_multi_project_totals_conserved() {
        let (env, client, admin, token, token_client, project_a) = setup(2_000);
        let project_b = SorobanString::from_str(&env, "overflow-prop-b");
        let wallet = Address::generate(&env);
        client.register_project(
            &admin,
            &project_b,
            &SorobanString::from_str(&env, "Overflow B"),
            &wallet,
            &2_000,
        );

        let donor = Address::generate(&env);
        let a_amt = 5 * STROOP;
        let b_amt = 7 * STROOP;
        token_client.mint(&donor, &(a_amt + b_amt));
        client.donate(&token, &donor, &project_a, &a_amt, &0u32);
        client.donate(&token, &donor, &project_b, &b_amt, &0u32);

        assert_eq!(client.get_global_total(), a_amt + b_amt);
        assert_eq!(client.get_project(&project_a).total_raised, a_amt);
        assert_eq!(client.get_project(&project_b).total_raised, b_amt);
    }
}
