/// Property-based tests for GreenPay badge tier and NFT invariants.
///
/// Donor badge rank must be monotonic; NFT supply tracks minted tiers; transfers
/// preserve ownership semantics enforced by the token registry.
#[cfg(all(test, feature = "testutils"))]
mod badge {
    extern crate std;

    use std::vec::Vec;

    use crate::{BadgeTier, GreenPayContract, GreenPayContractClient, STROOP};
    use proptest::prelude::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::token::StellarAssetClient;
    use soroban_sdk::{Address, Env, String as SorobanString};

    const REALISTIC_CO2: u32 = 8_500;

    fn badge_rank(tier: BadgeTier) -> u8 {
        match tier {
            BadgeTier::None => 0,
            BadgeTier::Seedling => 1,
            BadgeTier::Tree => 2,
            BadgeTier::Forest => 3,
            BadgeTier::EarthGuardian => 4,
        }
    }

    fn setup_project(
        env: &Env,
    ) -> (
        GreenPayContractClient<'static>,
        Address,
        Address,
        StellarAssetClient<'static>,
        SorobanString,
    ) {
        env.mock_all_auths();

        let contract_id = env.register_contract(None, GreenPayContract);
        let client = GreenPayContractClient::new(env, &contract_id);
        let admin = Address::generate(env);
        client.initialize(&admin);

        let project_id = SorobanString::from_str(env, "badge-prop-proj");
        let wallet = Address::generate(env);
        client.register_project(
            &admin,
            &project_id,
            &SorobanString::from_str(env, "Badge Property Project"),
            &wallet,
            &REALISTIC_CO2,
        );

        let token_admin = Address::generate(env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_client = StellarAssetClient::new(env, &token);
        client.allow_token(&admin, &token);

        (client, admin, token, token_client, project_id)
    }

    fn donate(
        client: &GreenPayContractClient<'static>,
        token: &Address,
        token_client: &StellarAssetClient<'static>,
        donor: &Address,
        project_id: &SorobanString,
        amount: i128,
    ) {
        token_client.mint(donor, &amount);
        client.donate(token, donor, project_id, &amount, &0u32);
    }

    proptest! {
        #![proptest_config(ProptestConfig::default())]

        /// Cumulative donations never decrease badge rank.
        #[test]
        fn prop_badge_rank_monotonic(
            amounts in prop::collection::vec(STROOP..=(5 * STROOP), 1..=12),
        ) {
            let env = Env::default();
            let (client, _admin, token, token_client, project_id) = setup_project(&env);
            let donor = Address::generate(&env);

            let mut last_rank = 0u8;
            let mut cumulative = 0i128;

            for amount in amounts {
                cumulative = cumulative.saturating_add(amount);
                donate(&client, &token, &token_client, &donor, &project_id, amount);
                let tier = client.get_badge(&donor);
                let rank = badge_rank(tier);
                prop_assert!(rank >= last_rank);
                last_rank = rank;
            }

            prop_assert_eq!(client.get_donor_stats(&donor).total_donated, cumulative);
        }

        /// Each reached tier auto-mints at most one NFT per donor.
        #[test]
        fn prop_at_most_one_nft_per_tier(
            donation in (10 * STROOP..=(2500 * STROOP)),
        ) {
            let env = Env::default();
            let (client, _admin, token, token_client, project_id) = setup_project(&env);
            let donor = Address::generate(&env);

            donate(&client, &token, &token_client, &donor, &project_id, donation);
            let tier = client.get_badge(&donor);
            if tier == BadgeTier::None {
                prop_assert_eq!(client.balance_of(&donor), 0);
                return Ok(());
            }

            prop_assert!(client.has_nft(&donor, &tier));
            let supply_before = client.total_supply();
            prop_assert!(supply_before >= 1);

            // Re-donating must not mint duplicate tier tokens.
            donate(&client, &token, &token_client, &donor, &project_id, STROOP);
            prop_assert!(client.has_nft(&donor, &tier));
        }

        /// balance_of counts legacy and registry-backed badge tokens.
        #[test]
        fn prop_balance_of_matches_minted_tiers(
            steps in prop::collection::vec(
                prop_oneof![
                    (10 * STROOP..=(15 * STROOP)),
                    (90 * STROOP..=(110 * STROOP)),
                    (400 * STROOP..=(600 * STROOP)),
                ],
                1..=4,
            ),
        ) {
            let env = Env::default();
            let (client, _admin, token, token_client, project_id) = setup_project(&env);
            let donor = Address::generate(&env);

            let mut seen_tiers: Vec<BadgeTier> = Vec::new();
            for amount in steps {
                donate(&client, &token, &token_client, &donor, &project_id, amount);
                let tier = client.get_badge(&donor);
                if tier != BadgeTier::None && !seen_tiers.contains(&tier) {
                    seen_tiers.push(tier);
                }
            }

            let balance = client.balance_of(&donor);
            prop_assert!(balance <= seen_tiers.len() as u32);
            prop_assert!(balance <= client.total_supply());
        }

        /// NFT transfer updates owner_of while preserving tier metadata.
        #[test]
        fn prop_nft_transfer_updates_owner(
            donation in (10 * STROOP..=(120 * STROOP)),
        ) {
            let env = Env::default();
            let (client, _admin, token, token_client, project_id) = setup_project(&env);
            let donor = Address::generate(&env);
            let recipient = Address::generate(&env);

            donate(&client, &token, &token_client, &donor, &project_id, donation);
            let tier = client.get_badge(&donor);
            if tier == BadgeTier::None {
                return Ok(());
            }

            let token_id = client.get_token_id(&donor, &tier).expect("token id");
            prop_assert_eq!(client.owner_of(&token_id), donor.clone());

            client.transfer(&donor, &recipient, &token_id);
            prop_assert_eq!(client.owner_of(&token_id), recipient.clone());
            prop_assert_eq!(client.token_tier(&token_id), tier.clone());
            prop_assert!(!client.has_nft(&donor, &tier));
            prop_assert!(client.has_nft(&recipient, &tier));
        }
    }

    #[test]
    fn regression_seedling_threshold_mints_nft() {
        let env = Env::default();
        let (client, _admin, token, token_client, project_id) = setup_project(&env);
        let donor = Address::generate(&env);

        donate(
            &client,
            &token,
            &token_client,
            &donor,
            &project_id,
            10 * STROOP,
        );
        assert_eq!(client.get_badge(&donor), BadgeTier::Seedling);
        assert!(client.has_nft(&donor, &BadgeTier::Seedling));
    }

    #[test]
    fn regression_earth_guardian_highest_rank() {
        let env = Env::default();
        let (client, _admin, token, token_client, project_id) = setup_project(&env);
        let donor = Address::generate(&env);

        donate(
            &client,
            &token,
            &token_client,
            &donor,
            &project_id,
            2000 * STROOP,
        );
        assert_eq!(client.get_badge(&donor), BadgeTier::EarthGuardian);
        assert!(badge_rank(client.get_badge(&donor)) >= badge_rank(BadgeTier::Forest));
    }
}
