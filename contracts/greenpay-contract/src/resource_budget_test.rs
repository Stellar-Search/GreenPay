// contracts/greenpay-contract/src/resource_budget_test.rs
//
// Resource/fee budgeting for the GreenPay contract (issue #512).
//
// Goals:
//   1. RECORD how much host resource each public entrypoint consumes (CPU
//      instructions, memory, and the recording-ledger footprint: reads/writes
//      plus an XDR byte estimate of the keys) when run against realistic,
//      accumulated on-chain state — so we know per-call headroom before
//      contract calls start silently failing as the ledger grows.
//   2. ENFORCE budgets in CI: numbers are persisted in
//      `contracts/resource-budgets.json`; this suite fails when a call exceeds
//      its recorded budget by more than `HEADROOM_FACTOR`, and asserts the NFT
//      hot paths stay ~flat as a donor accumulates tokens (guarding the O(1)
//      tier-pointer fix).
//   3. PRINT a per-function report (and refresh the baseline) in `GREENPAY_UPDATE_BUDGETS=1`
//      mode so a developer can regenerate the baseline after a deliberate, reviewed change.
//
// Run:
//   cargo test -p greenpay-contract --lib --features testutils resource_budget
//   GREENPAY_UPDATE_BUDGETS=1 cargo test -p greenpay-contract --lib --features testutils \
//       resource_budget::measure_all_entrypoints_and_compare
//
// See docs/resource-budgeting.md for the WASM-vs-native caveat.

#[cfg(all(test, feature = "testutils"))]
mod resource_budget {
    extern crate alloc;
    extern crate std;

    use crate::resource_measurement::{from_json, measure, print_report, to_json, ResourceUsage};
    use crate::{GreenPayContract, GreenPayContractClient, STROOP};
    use alloc::vec::Vec;
    use soroban_sdk::token::StellarAssetClient;
    use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, String as SorobanString};

    const BASELINE_REL: &str = "../resource-budgets.json";

    /// A measured value is allowed to exceed its recorded baseline by at most
    /// this factor. Generous, because native measurements are noisy.
    const HEADROOM_FACTOR: f64 = 1.75;

    const SCALE_ALLOWED: u32 = 6; // hot-path cost may grow at most 6× for 33× tokens
    const TOKENS_FOR_GROWTH: u32 = 32;

    const N_PROJECTS: u32 = 8;
    const N_DONORS: u32 = 24;
    const N_ATTESTATIONS: u32 = 3;

    // ── Fixtures ──────────────────────────────────────────────────────────────

    struct EnvFull {
        env: Env,
        client: GreenPayContractClient<'static>,
        admin: Address,
        token: Address,
        token_client: StellarAssetClient<'static>,
        pid: SorobanString,
    }

    fn bytes32(env: &Env, seed: u32) -> BytesN<32> {
        let mut arr = [0u8; 32];
        for (idx, b) in arr.iter_mut().enumerate() {
            *b = (seed as u8).wrapping_add(idx as u8);
        }
        BytesN::from_array(env, &arr)
    }

    /// Base fixture: initialized contract + allow-listed SAC token + one project.
    fn base() -> EnvFull {
        let env = Env::default();
        env.mock_all_auths();
        // These fixtures are measuring cost shape, not enforcing limits, so
        // widen the default test budget enough that accumulating state plus a
        // full donate/transfer pipeline never trips it.
        let mut budget = env.budget();
        budget.reset_unlimited();
        let cid = env.register_contract(None, GreenPayContract);
        let client = GreenPayContractClient::new(&env, &cid);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin.clone())
            .address();
        let token_client = StellarAssetClient::new(&env, &token);
        client.allow_token(&admin, &token);

        let pid = SorobanString::from_str(&env, "proj-000");
        let wallet = Address::generate(&env);
        client.register_project(
            &admin,
            &pid,
            &SorobanString::from_str(&env, "Fixtured Project"),
            &wallet,
            &100u32,
        );
        EnvFull {
            env,
            client,
            admin,
            token,
            token_client,
            pid,
        }
    }

    /// Populate realistic accumulated state through the public interface.
    fn populate(f: &EnvFull) {
        let env = &f.env;
        for i in 1..N_PROJECTS {
            let pid = SorobanString::from_str(env, &alloc::format!("proj-{:03}", i));
            let wallet = Address::generate(env);
            f.client.register_project(
                &f.admin,
                &pid,
                &SorobanString::from_str(env, "Populated Project"),
                &wallet,
                &100u32,
            );
        }
        for i in 0..N_DONORS {
            let donor = Address::generate(env);
            let base_stroops = (i as i128 + 1) * 10 * STROOP;
            for k in 0..3 {
                let pid = SorobanString::from_str(env, &alloc::format!("proj-{:03}", k));
                f.token_client.mint(&donor, &base_stroops);
                f.client
                    .donate(&f.token, &donor, &pid, &base_stroops, &0u32);
            }
        }
        let verifier = Address::generate(env);
        f.client.set_impact_verifier(&f.admin, &verifier, &true);
        for i in 0..N_ATTESTATIONS {
            let claim = SorobanString::from_str(env, &alloc::format!("claim-pop-{:03}", i));
            let expires = env.ledger().timestamp() + 86_400;
            f.client
                .anchor_impact_attestation(&verifier, &claim, &bytes32(env, 100 + i), &expires);
        }
        f.client.create_proposal(&f.admin, &f.pid, &0u32);
    }

    /// A donor (with a minted badge) used as the focus of NFT measurements.
    fn target_donor(f: &EnvFull) -> Address {
        let donor = Address::generate(&f.env);
        let base_stroops = 240 * STROOP; // Tree tier (≥100 XLM, < 500)
        f.token_client.mint(&donor, &base_stroops);
        f.client
            .donate(&f.token, &donor, &f.pid, &base_stroops, &0u32);
        donor
    }

    /// Measure `call` on `f`'s env and return the usage.
    fn m(f: &EnvFull, name: &str, state: &str, call: impl FnOnce()) -> ResourceUsage {
        let (usage, _) = measure(&f.env, name, state, call);
        usage
    }

    // ── Enforcement helpers ───────────────────────────────────────────────────

    fn baseline_for<'a>(usages: &'a [ResourceUsage], function: &str) -> Option<&'a ResourceUsage> {
        usages.iter().find(|u| u.function == function)
    }

    fn assert_within_baseline(measured: &ResourceUsage, baseline: Option<&ResourceUsage>) {
        let Some(base) = baseline else {
            std::panic!(
                "resource-budget: no baseline entry for '{}' — run with GREENPAY_UPDATE_BUDGETS=1 to record it.",
                measured.function
            );
        };
        let mut problems: Vec<alloc::string::String> = Vec::new();
        check(
            &mut problems,
            "cpu_insns",
            measured.cpu_insns,
            base.cpu_insns,
        );
        check(
            &mut problems,
            "mem_bytes",
            measured.mem_bytes,
            base.mem_bytes,
        );
        check(
            &mut problems,
            "ledger_reads",
            measured.ledger_reads,
            base.ledger_reads,
        );
        check(
            &mut problems,
            "ledger_writes",
            measured.ledger_writes,
            base.ledger_writes,
        );
        if !problems.is_empty() {
            std::panic!(
                "resource-budget: '{}' exceeded its recorded budget:\n  {}\n  (headroom factor {}. Re-run with GREENPAY_UPDATE_BUDGETS=1 only after a deliberate, reviewed resource change.)",
                measured.function,
                problems.join("\n  "),
                HEADROOM_FACTOR,
            );
        }
    }

    fn check(out: &mut Vec<alloc::string::String>, label: &str, measured: u64, base: u64) {
        let limit = (base as f64 * HEADROOM_FACTOR) as u64;
        if measured > limit {
            out.push(alloc::format!(
                "{label}: measured={measured} baseline={base} limit={limit}"
            ));
        }
    }

    // ── Entrypoint measurement ────────────────────────────────────────────────

    #[test]
    fn measure_all_entrypoints_and_compare() {
        let update = std::env::var("GREENPAY_UPDATE_BUDGETS")
            .map(|v| v == "1")
            .unwrap_or(false);
        let mut usages: Vec<ResourceUsage> = Vec::new();

        // Fresh-ledger: the write path (donate).
        {
            let f = base();
            let donor = Address::generate(&f.env);
            let amount = 25 * STROOP;
            f.token_client.mint(&donor, &amount);
            let u = m(&f, "donate", "fresh ledger", || {
                f.client.donate(&f.token, &donor, &f.pid, &amount, &42u32);
            });
            assert!(
                u.ledger_writes >= 2,
                "donate should write ≥2 entries: {u:?}"
            );
            usages.push(u);
        }

        // Fresh-ledger: initialize (measured on a fresh env, not the base fixture).
        {
            let env = Env::default();
            env.mock_all_auths();
            let mut budget = env.budget();
            budget.reset_unlimited();
            let cid = env.register_contract(None, GreenPayContract);
            let client = GreenPayContractClient::new(&env, &cid);
            let admin = Address::generate(&env);
            let (u, _) = measure(&env, "initialize", "fresh ledger", || {
                client.initialize(&admin);
            });
            usages.push(u);
        }


        // Populated ledger: everything else.
        {
            let f = base();
            populate(&f);
            let verifier = Address::generate(&f.env);
            f.client.set_impact_verifier(&f.admin, &verifier, &true);
            let donor = target_donor(&f);
            let tier = f.client.get_donor_stats(&donor).badge;

            usages.push(m(&f, "get_project", "populated ledger", || {
                f.client.get_project(&f.pid);
            }));
            usages.push(m(&f, "get_donor_stats", "populated ledger", || {
                f.client.get_donor_stats(&donor);
            }));
            usages.push(m(&f, "get_badge", "populated ledger", || {
                f.client.get_badge(&donor);
            }));
            usages.push(m(&f, "get_global_total", "populated ledger", || {
                f.client.get_global_total();
            }));
            usages.push(m(&f, "get_donation_count", "populated ledger", || {
                f.client.get_donation_count();
            }));

            usages.push(m(&f, "has_nft", "populated ledger", || {
                let _ = f.client.has_nft(&donor, &tier);
            }));
            usages.push(m(&f, "get_token_id", "populated ledger", || {
                let _ = f.client.get_token_id(&donor, &tier);
            }));
            let token_id = f
                .client
                .get_token_id(&donor, &tier)
                .expect("target donor badge minted");
            usages.push(m(&f, "owner_of", "populated ledger", || {
                let _ = f.client.owner_of(&token_id);
            }));
            usages.push(m(&f, "tokens_of", "populated ledger", || {
                let _ = f.client.tokens_of(&donor);
            }));
            usages.push(m(&f, "balance_of", "populated ledger", || {
                let _ = f.client.balance_of(&donor);
            }));

            let claim = SorobanString::from_str(&f.env, "claim-pop-000");
            usages.push(m(&f, "get_impact_attestation", "populated ledger", || {
                f.client.get_impact_attestation(&claim);
            }));
            usages.push(m(
                &f,
                "verify_impact_attestation",
                "populated ledger",
                || {
                    let _ = f
                        .client
                        .verify_impact_attestation(&claim, &bytes32(&f.env, 100));
                },
            ));

            // Governance (fresh proposal + vote) on a populated ledger.
            usages.push(m(&f, "create_proposal", "populated ledger", || {
                let other = SorobanString::from_str(&f.env, "proj-002");
                f.client.create_proposal(&f.admin, &other, &0u32);
            }));
            usages.push(m(&f, "vote_verify_project", "populated ledger", || {
                f.client.vote_verify_project(&donor, &f.pid, &true);
            }));
            usages.push(m(&f, "get_proposal", "populated ledger", || {
                f.client.get_proposal(&f.pid);
            }));

            // Impact attestation operations.
            usages.push(m(&f, "anchor_impact_attestation", "populated ledger", || {
                let claim = SorobanString::from_str(&f.env, "claim-measure");
                let expires = f.env.ledger().timestamp() + 86_400;
                f.client.anchor_impact_attestation(&verifier, &claim, &bytes32(&f.env, 200), &expires);
            }));
            usages.push(m(&f, "revoke_impact_attestation", "populated ledger", || {
                let claim = SorobanString::from_str(&f.env, "claim-revoke");
                let expires = f.env.ledger().timestamp() + 86_400;
                f.client.anchor_impact_attestation(&verifier, &claim, &bytes32(&f.env, 300), &expires);
                f.client.revoke_impact_attestation(&verifier, &claim, &bytes32(&f.env, 999));
            }));

            // DAO integration operations.
            usages.push(m(&f, "set_dao_contract", "populated ledger", || {
                let dao_addr = Address::generate(&f.env);
                f.client.set_dao_contract(&f.admin, &Some(dao_addr));
            }));
            usages.push(m(&f, "verify_project", "populated ledger", || {
                // Temporarily set DAO contract to enable verify_project
                let dao_addr = Address::generate(&f.env);
                f.client.set_dao_contract(&f.admin, &Some(dao_addr.clone()));
                f.client.verify_project(&dao_addr, &f.pid);
            }));

            // Transfer (NFT write path) on the populated ledger.
            let recipient = target_donor(&f);
            usages.push(m(&f, "transfer", "populated ledger", || {
                let tid = f.client.get_token_id(&donor, &tier).unwrap();
                f.client.transfer(&donor, &recipient, &tid);
            }));
        }

        print_report(&usages);

        if update {
            let path = baseline_path();
            std::fs::write(&path, to_json(&usages)).expect("write resource-budgets.json");
            std::println!("resource-budget: updated baseline -> {path}");
            return;
        }

        let blob = std::fs::read_to_string(baseline_path()).unwrap_or_else(|_| {
            std::panic!(
                "could not read the resource baseline ({}). Run with GREENPAY_UPDATE_BUDGETS=1 to create it.",
                baseline_path()
            )
        });
        let baseline = from_json(&blob);
        for u in &usages {
            assert_within_baseline(u, baseline_for(&baseline, &u.function));
        }
    }

    // ── Flatness / O(1) growth guards (independent of the JSON baseline) ──────

    /// `has_nft` must stay flat as a donor accumulates many same-tier tokens,
    /// proving the O(1) tier-pointer fix. The pre-pointer implementation
    /// scanned the whole ownership index (O(n)); this test would see cost climb
    /// with `TOKENS_FOR_GROWTH`.
    #[test]
    fn has_nft_is_flat_as_donor_accumulates_tokens() {
        let f = base();
        let donor = Address::generate(&f.env);
        let amount = 100 * STROOP; // Tree tier
        f.token_client.mint(&donor, &amount);
        f.client.donate(&f.token, &donor, &f.pid, &amount, &0u32);
        let tier = f.client.get_donor_stats(&donor).badge;

        let (single, _) = measure(&f.env, "has_nft", "1 token", || {
            let _ = f.client.has_nft(&donor, &tier);
        });

        // Grow the donor's index with many gifts of the SAME tier.
        for _ in 0..TOKENS_FOR_GROWTH {
            let giver = Address::generate(&f.env);
            let amt = 100 * STROOP;
            f.token_client.mint(&giver, &amt);
            f.client.donate(&f.token, &giver, &f.pid, &amt, &0u32);
            let gid = f.client.get_token_id(&giver, &tier).unwrap();
            f.client.transfer(&giver, &donor, &gid);
        }

        let (grown, _) = measure(
            &f.env,
            "has_nft",
            &alloc::format!("{} tokens", TOKENS_FOR_GROWTH + 1),
            || {
                let _ = f.client.has_nft(&donor, &tier);
            },
        );

        let limit = single.cpu_insns.max(1) * SCALE_ALLOWED as u64;
        assert!(
            grown.cpu_insns <= limit,
            "has_nft cost grew with ownership: single cpu={} grown cpu={} limit={}. The O(1) tier-pointer fast path likely regressed.",
            single.cpu_insns, grown.cpu_insns, limit
        );
    }

    /// `transfer` removes from a (grown) sender index and must stay within a
    /// bounded budget regardless of index size.
    #[test]
    fn transfer_removal_is_bounded() {
        let f = base();
        let donor = Address::generate(&f.env);
        let amount = 100 * STROOP;
        f.token_client.mint(&donor, &amount);
        f.client.donate(&f.token, &donor, &f.pid, &amount, &0u32);
        let tier = f.client.get_donor_stats(&donor).badge;
        for _ in 0..TOKENS_FOR_GROWTH {
            let giver = Address::generate(&f.env);
            let amt = 100 * STROOP;
            f.token_client.mint(&giver, &amt);
            f.client.donate(&f.token, &giver, &f.pid, &amt, &0u32);
            let gid = f.client.get_token_id(&giver, &tier).unwrap();
            f.client.transfer(&giver, &donor, &gid);
        }
        let receiver = Address::generate(&f.env);
        let tid = f.client.get_token_id(&donor, &tier).unwrap();
        let (grown, _) = measure(&f.env, "transfer", "large sender index", || {
            f.client.transfer(&donor, &receiver, &tid);
        });
        assert!(
            grown.cpu_insns <= 50_000_000,
            "transfer unexpectedly expensive: cpu={}",
            grown.cpu_insns
        );
    }

    /// Absolute path of the baseline JSON, walking up from the crate dir.
    fn baseline_path() -> alloc::string::String {
        let cwd = std::env::current_dir().expect("current dir");
        for dir in std::iter::once(cwd.as_path()).chain(cwd.ancestors()) {
            let p = dir.join(BASELINE_REL);
            if p.exists() {
                return p.to_string_lossy().into_owned();
            }
        }
        cwd.join(BASELINE_REL).to_string_lossy().into_owned()
    }
}
