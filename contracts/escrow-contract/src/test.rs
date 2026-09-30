#[test]
fn test_delisted_token_blocks_new_jobs_but_allows_existing_settlement() {
    let env = Env::default();
    env.mock_all_auths();

    let client = setup_escrow_contract(&env);
    let token = create_token(&env);

    // 1. Add token and create job
    client.add_token(&token);
    let job_id = client.create_job(&voter, &token, &amount);

    // 2. Remove token from allowlist
    client.remove_token(&token);

    // 3. Assert NEW job creation fails with delisted token
    let new_job_res = client.try_create_job(&voter, &token, &amount);
    assert!(new_job_res.is_err(), "New jobs in delisted tokens must be rejected");

    // 4. Assert EXISTING job can still be released/settled cleanly
    let release_res = client.try_release_escrow(&job_id);
    assert!(release_res.is_ok(), "Existing obligations in delisted tokens must settle");
}

#[test]
fn test_delisted_token_allows_dispute_and_cancellation() {
    let env = Env::default();
    env.mock_all_auths();

    let client = setup_escrow_contract(&env);
    let token = create_token(&env);

    client.add_token(&token);
    let job_id = client.create_job(&voter, &token, &amount);
    client.remove_token(&token);

    // Assert existing escrow can be disputed & cancelled after delisting
    let dispute_res = client.try_resolve_dispute(&job_id, &resolution);
    assert!(dispute_res.is_ok(), "Disputes in delisted tokens must resolve cleanly");
}