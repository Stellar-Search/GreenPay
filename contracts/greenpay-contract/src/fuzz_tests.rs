/// fuzz_tests.rs — Property-based tests for the GreenPay Soroban contract.
///
/// Uses `proptest` to drive thousands of iterations of `donate`, asserting that
/// with legacy `co2_per_xlm` inputs and realistic donation sizes:
///   - Donation amount and project-authored rates never create impact outcomes
///   - Global totals stay consistent with per-project totals
///   - Counters remain monotonic and non-negative
///
/// Run:
///   cargo test --features testutils -- fuzz
#[cfg(all(test, feature = "testutils"))]
mod fuzz {
    extern crate std;

    use crate::{
        BadgeTier, GreenPayContract, GreenPayContractClient, MAX_CO2_PER_XLM,
        MAX_REALISTIC_DONATION_STROOPS, STROOP,
    };
    use proptest::prelude::*;
    use soroban_sdk::{
        testutils::Address as _, token::StellarAssetClient, Address, Env, String as SorobanString,
    };

    /// Typical on-chain `co2_per_xlm` values (grams per XLM).
    const REALISTIC_CO2_PER_XLM: u32 = 8_500;

    fn setup_with_co2(
        co2_per_xlm: u32,
    ) -> (
        Env,
        GreenPayContractClient<'static>,
        Address,
        soroban_sdk::Address,
        StellarAssetClient<'static>,
        SorobanString,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, GreenPayContract);
        let client = GreenPayContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        let project_id = SorobanString::from_str(&env, "proj-fuzz-1");
        let wallet = Address::generate(&env);
        client.register_project(
            &admin,
            &project_id,
            &SorobanString::from_str(&env, "Fuzz Project"),
            &wallet,
            &co2_per_xlm,
        );

        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_client = StellarAssetClient::new(&env, &token);

        // Allow the token so donate() passes its allowlist check.
        client.allow_token(&admin, &token);

        (env, client, admin, token, token_client, project_id)
    }

    proptest! {
        #![proptest_config(ProptestConfig::default())]

        /// A legacy rate has no effect on the evidence-first impact registry.
        #[test]
        fn prop_realistic_donation_never_derives_impact(
            amount in STROOP..=MAX_REALISTIC_DONATION_STROOPS,
        ) {
            let (env, client, _admin, token, token_client, project_id) =
                setup_with_co2(REALISTIC_CO2_PER_XLM);
            let donor = Address::generate(&env);
            token_client.mint(&donor, &amount);

            client.donate(&token, &donor, &project_id, &amount, &1u32);

            prop_assert_eq!(client.get_global_total(), amount);
            prop_assert_eq!(client.get_global_co2(), 0);
            prop_assert_eq!(client.get_donor_stats(&donor).co2_offset_grams, 0);
            prop_assert_eq!(client.get_project(&project_id).total_raised, amount);
        }

        /// Even the largest accepted legacy rate creates no outcome quantity.
        #[test]
        fn prop_max_legacy_rate_never_derives_impact(
            amount in STROOP..=MAX_REALISTIC_DONATION_STROOPS,
        ) {
            let (env, client, _admin, token, token_client, project_id) =
                setup_with_co2(MAX_CO2_PER_XLM);
            let donor = Address::generate(&env);
            token_client.mint(&donor, &amount);

            client.donate(&token, &donor, &project_id, &amount, &1u32);

            prop_assert_eq!(client.get_global_co2(), 0);
            prop_assert_eq!(client.get_donor_stats(&donor).co2_offset_grams, 0);
        }

        /// Many donations still cannot manufacture a project outcome.
        #[test]
        fn prop_many_donations_never_derive_impact(
            n in 1u32..=16u32,
            amount in STROOP..=(100 * STROOP),
        ) {
            let (env, client, _admin, token, token_client, project_id) =
                setup_with_co2(MAX_CO2_PER_XLM);

            let mut expected_total: i128 = 0;

            for _ in 0..n {
                let donor = Address::generate(&env);
                token_client.mint(&donor, &amount);
                client.donate(&token, &donor, &project_id, &amount, &1u32);
                expected_total = expected_total.checked_add(amount).unwrap();
            }

            prop_assert_eq!(client.get_global_total(), expected_total);
            prop_assert_eq!(client.get_global_co2(), 0);
            prop_assert_eq!(client.get_donation_count(), n);
        }

        /// Two sequential donations must remain additive for global totals.
        #[test]
        fn prop_two_donations_are_additive(
            a in STROOP..=(MAX_REALISTIC_DONATION_STROOPS / 2),
            b in STROOP..=(MAX_REALISTIC_DONATION_STROOPS / 2),
        ) {
            let (env, client, _admin, token, token_client, project_id) =
                setup_with_co2(REALISTIC_CO2_PER_XLM);
            let donor_a = Address::generate(&env);
            let donor_b = Address::generate(&env);
            token_client.mint(&donor_a, &a);
            token_client.mint(&donor_b, &b);

            client.donate(&token, &donor_a, &project_id, &a, &1u32);
            client.donate(&token, &donor_b, &project_id, &b, &1u32);

            let expected_total = a.checked_add(b).expect("test helper overflow");
            prop_assert_eq!(client.get_global_total(), expected_total);
            prop_assert_eq!(client.get_global_co2(), 0);
            prop_assert_eq!(client.get_project(&project_id).donor_count, 2u32);
        }

        /// Random-length donation sequences preserve global/project totals (conservation).
        #[test]
        fn prop_donation_sequence_conservation(
            amounts in prop::collection::vec(STROOP..=(10 * STROOP), 1..=20usize),
        ) {
            let (env, client, _admin, token, token_client, project_id) =
                setup_with_co2(REALISTIC_CO2_PER_XLM);

            let mut expected_total: i128 = 0;
            let mut donor_count: u32 = 0;

            for amount in amounts {
                let donor = Address::generate(&env);
                token_client.mint(&donor, &amount);
                client.donate(&token, &donor, &project_id, &amount, &1u32);
                expected_total = expected_total.checked_add(amount).unwrap();
                donor_count += 1;
            }

            prop_assert_eq!(client.get_global_total(), expected_total);
            prop_assert_eq!(client.get_global_co2(), 0);
            prop_assert_eq!(client.get_project(&project_id).total_raised, expected_total);
            prop_assert_eq!(client.get_donation_count(), donor_count);
            prop_assert_eq!(client.get_project(&project_id).donor_count, donor_count);
        }

        /// Neither whole XLM nor a sub-stroop remainder creates an outcome.
        #[test]
        fn prop_donation_amount_never_derives_co2(
            whole_xlm in 1i128..=1000i128,
            remainder in 1i128..=(STROOP - 1),
        ) {
            let amount = whole_xlm * STROOP + remainder;
            let (env, client, _admin, token, token_client, project_id) =
                setup_with_co2(REALISTIC_CO2_PER_XLM);
            let donor = Address::generate(&env);
            token_client.mint(&donor, &amount);

            client.donate(&token, &donor, &project_id, &amount, &1u32);

            prop_assert_eq!(client.get_global_co2(), 0);
            prop_assert_eq!(client.get_donor_stats(&donor).co2_offset_grams, 0);
        }

        /// Global total equals the sum of per-project totals across projects.
        #[test]
        fn prop_global_total_equals_sum_of_projects(
            a in STROOP..=(20 * STROOP),
            b in STROOP..=(20 * STROOP),
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let contract_id = env.register_contract(None, GreenPayContract);
            let client = GreenPayContractClient::new(&env, &contract_id);
            let admin = Address::generate(&env);
            client.initialize(&admin);

            let pid_a = SorobanString::from_str(&env, "proj-a");
            let pid_b = SorobanString::from_str(&env, "proj-b");
            let wallet = Address::generate(&env);
            client.register_project(
                &admin, &pid_a,
                &SorobanString::from_str(&env, "A"),
                &wallet, &REALISTIC_CO2_PER_XLM,
            );
            client.register_project(
                &admin, &pid_b,
                &SorobanString::from_str(&env, "B"),
                &wallet, &REALISTIC_CO2_PER_XLM,
            );

            let token_admin = Address::generate(&env);
            let token = env.register_stellar_asset_contract_v2(token_admin).address();
            let token_client = StellarAssetClient::new(&env, &token);
            client.allow_token(&admin, &token);

            let donor_a = Address::generate(&env);
            let donor_b = Address::generate(&env);
            token_client.mint(&donor_a, &a);
            token_client.mint(&donor_b, &b);
            client.donate(&token, &donor_a, &pid_a, &a, &1u32);
            client.donate(&token, &donor_b, &pid_b, &b, &1u32);

            let sum = a.checked_add(b).unwrap();
            prop_assert_eq!(client.get_global_total(), sum);
            prop_assert_eq!(
                client.get_project(&pid_a).total_raised + client.get_project(&pid_b).total_raised,
                sum,
            );
        }

        /// Badge tier is monotonic: cumulative donations never downgrade badge.
        #[test]
        fn prop_badge_tier_monotonic_with_donations(
            amounts in prop::collection::vec(STROOP..=(50 * STROOP), 1..=8usize),
        ) {
            let (env, client, _admin, token, token_client, project_id) =
                setup_with_co2(REALISTIC_CO2_PER_XLM);
            let donor = Address::generate(&env);
            let mut total: i128 = 0;
            let mut last_rank = 0u8;

            for amount in amounts {
                total = total.checked_add(amount).unwrap();
                token_client.mint(&donor, &amount);
                client.donate(&token, &donor, &project_id, &amount, &1u32);
                let badge = client.get_badge(&donor);
                let rank = badge_rank(badge);
                prop_assert!(rank >= last_rank);
                last_rank = rank;
            }
        }

        /// Donations that would overflow accumulators are rejected without mutation.
        #[test]
        fn prop_donate_overflow_rolls_back(
            _seed in STROOP..=(10 * STROOP),
        ) {
            let (env, client, _admin, token, token_client, project_id) =
                setup_with_co2(REALISTIC_CO2_PER_XLM);
            let donor = Address::generate(&env);
            token_client.mint(&donor, &(100 * STROOP));

            let result = client.try_donate(&token, &donor, &project_id, &i128::MAX, &1u32);
            prop_assert!(result.is_err());
            prop_assert_eq!(client.get_global_total(), 0);
            prop_assert_eq!(client.get_donation_count(), 0);
        }
    }

    fn badge_rank(tier: BadgeTier) -> u8 {
        match tier {
            BadgeTier::None => 0,
            BadgeTier::Seedling => 1,
            BadgeTier::Tree => 2,
            BadgeTier::Forest => 3,
            BadgeTier::EarthGuardian => 4,
        }
    }

    #[test]
    fn fuzz_register_rejects_co2_above_ceiling() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, GreenPayContract);
        let client = GreenPayContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let result = client.try_register_project(
            &admin,
            &SorobanString::from_str(&env, "bad"),
            &SorobanString::from_str(&env, "Bad"),
            &Address::generate(&env),
            &(MAX_CO2_PER_XLM + 1),
        );
        assert!(result.is_err());
    }
}
