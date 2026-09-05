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

#[test]
fn resolve_stale_dispute_splits_funds_and_sets_status() {
    let (env, cid, contract, _admin, client, freelancer, token, job_id, _amount, _expiry) =
        setup_with_cid();

    // 1. Raise a dispute
    let timeout_ledger = dispute_job_and_get_timeout(&env, &contract, &client, &job_id);

    // 2. Extend storage TTL and advance ledger sequence past the timeout
    extend_ttl(&env, &cid, &token);
    env.ledger().set_sequence_number(timeout_ledger + 1);

    // 3. Trigger fallback resolution
    contract.resolve_stale_dispute(&client, &job_id);

    // 4. Verify job state updated to SplitResolved
    let job = contract.get_job(&job_id).unwrap();
    assert_eq!(job.status, JobStatus::SplitResolved);
    assert_eq!(job.remaining_amount, 0);

    // 5. Verify 50/50 token split (100 total amount -> 50 each)
    let token_client = token::Client::new(&env, &token);
    assert_eq!(token_client.balance(&freelancer), 50);
    assert_eq!(token_client.balance(&client), 50);
}

#[test]
#[should_panic(expected = "Dispute has not timed out yet")]
fn resolve_stale_dispute_before_timeout_panics() {
    let (env, contract, _admin, client, _freelancer, _token, job_id, _amount, _expiry) =
        setup();
    contract.dispute(&client, &job_id);

    // Try calling fallback before advancing the ledger timeout
    contract.resolve_stale_dispute(&client, &job_id);
}