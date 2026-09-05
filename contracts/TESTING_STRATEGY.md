# Contract Testing & Verification Strategy

This document outlines the testing and verification strategy for smart contract deployments.

## Testing Pyramid

```
                    △
                   /|\
                  / | \
                 /  |  \
                /   E2E  \
               /    Tests  \
              /____________\
             /            /|\
            /   Integration/ | \
           /    Tests     /  |  \
          /____________ /   |   \
         /           /|\    |    \
        / Unit Tests / | \ /     \
       /____________/  |  X      \
      /           /    | / \      \
     / Snapshot  /     |/   \      \
    /____________/    Fuzzing\    \
```

## Test Types

### 1. Unit Tests
**What**: Test individual contract functions in isolation
**Where**: `src/lib.rs` with `#[test]` macros
**When**: Every compilation
**Command**: `cargo test --lib`

```rust
#[test]
fn test_register_project() {
    // Arrange: Set up initial state
    let env = Env::default();
    let contract = GreenpayContract::new(&env);
    
    // Act: Call the function
    contract.register_project(...);
    
    // Assert: Verify result
    assert_eq!(contract.get_project(...), expected);
}
```

### 2. Integration Tests
**What**: Test contract interactions and workflows
**Where**: `tests/` directory
**When**: Before deployment
**Command**: `cargo test --test '*'`

```rust
// tests/integration_test.rs
#[test]
fn test_donation_flow() {
    let env = Env::default();
    let donor = Address::generate(&env);
    
    // 1. Register project
    // 2. Make donation
    // 3. Verify state updates
}
```

### 3. Snapshot Tests
**What**: Verify contract behavior doesn't change
**Where**: `test_snapshots/` directory
**When**: Before upgrades
**Command**: `cargo test` (uses `insta` crate)

```rust
#[test]
fn test_donation_snapshot() {
    insta::assert_json_snapshot!(donation_event);
}
```

### 4. Property Tests (Money Paths)
**What**: State-machine and conservation invariants over donation, escrow, and lock/withdraw sequences
**Where**: `contracts/INVARIANTS.md` (spec), `src/fuzz_tests.rs`, `src/property_tests.rs`
**When**: Every PR (fast) and nightly (deep)
**Commands**:
```bash
# Fast profile (CI)
PROPTEST_CASES=32 cargo test --workspace --features testutils prop_ regression_ -- --test-threads=1

# Deep profile (nightly)
PROPTEST_CASES=2000 cargo test --workspace --features testutils prop_ -- --test-threads=1

# Coverage report on money paths
./contracts/scripts/money-path-coverage.sh
```

Property tests use `proptest` with shrinking. Counterexample seeds are saved under
`proptest-regressions/` and converted to deterministic `regression_*` unit tests.

| Profile | `PROPTEST_CASES` | Trigger |
|---------|------------------|---------|
| Fast | 32 | Every PR (`ci.yml`) |
| Deep | 2000 | Nightly (`contracts-property-deep.yml`) |

### 5. Fuzz Tests (Legacy name — see Property Tests above)
**What**: Random input exploration for donation amounts and CO₂ arithmetic
**Where**: `greenpay-contract/src/fuzz_tests.rs`
**Command**: `cargo test --features testutils prop_`

### 6. Upgrade Tests
**What**: Verify storage compatibility and state preservation
**Where**: `src/lib.rs` with upgrade regression test
**When**: Every contract upgrade
**Command**: `cargo test test_upgrade_`

```rust
#[test]
fn test_upgrade_preserves_donation_state_and_storage_keys() {
    // 1. Deploy v1 contract
    // 2. Record state
    // 3. Upgrade to v2 (same code)
    // 4. Verify state unchanged
}
```

## Coverage Requirements

| Code Type | Minimum Coverage | Target |
|-----------|------------------|--------|
| Core logic | 80% | 95% |
| Upgrade paths | 100% | 100% |
| Error paths | 70% | 90% |
| Admin functions | 100% | 100% |

Run coverage:
```bash
cargo tarpaulin --workspace --out Html
```

## Continuous Integration Strategy

### PR Checks
1. **Formatting**: `cargo fmt --check`
2. **Linting**: `cargo clippy --all-targets`
3. **Unit Tests**: `cargo test --lib`
4. **Integration Tests**: `cargo test --test '*'`
5. **Security Audit**: `cargo audit`

### Pre-Deployment Checks
1. **All PR checks** pass
2. **Code review** approved (2+)
3. **Coverage** meets minimum
4. **Snapshot tests** verified
5. **Upgrade tests** pass
6. **No security vulnerabilities** found

### Post-Deployment Verification
1. **On-chain verification**: WASM hash matches
2. **State queries**: Contract responds to calls
3. **Functional tests**: All exposed functions work
4. **Storage validation**: Old data still accessible
5. **Monitoring**: No error spikes

## Storage Testing

### Before Upgrade

Test that storage remains compatible:

```rust
#[test]
fn test_storage_migration() {
    let env = Env::default();
    
    // Create v1 state
    let project = Project {
        id: "p1".to_string(),
        name: "Amazon".to_string(),
        wallet: Address::generate(&env),
        co2_per_xlm: 8500,
    };
    
    // Store with v1 key format
    env.storage().persistent().set(
        &DataKey::Project("p1".to_string()),
        &project,
    );
    
    // "Upgrade" happens here (same contract, new slot)
    
    // Read with v2 key format (must be identical!)
    let retrieved: Project = env.storage().persistent().get(
        &DataKey::Project("p1".to_string()),
    ).unwrap();
    
    assert_eq!(project, retrieved);
}
```

### Storage Version Updates

When storage format changes:

```rust
pub enum DataKey {
    // v1 keys (always read-compatible)
    Admin,
    Project(String),
    ProjectCount,
    
    // v2 keys (new feature)
    ProjectMetadata(String),
    ProjectTags(String),
}

// Version marker for tracking
const STORAGE_VERSION: u32 = 2;

#[test]
fn test_v1_to_v2_migration() {
    // Verify v1 keys still work
    // Migrate v1 data to v2 format if needed
    // Test both old and new keys accessible
}
```

## Security Testing

### Input Validation

```rust
#[test]
fn test_invalid_inputs() {
    assert_err!(contract.register_project("", ...));      // Empty ID
    assert_err!(contract.donate(0, ...));                // Zero amount
    assert_err!(contract.register_project(INVALID_ID)); // Invalid format
}
```

### Authorization Testing

```rust
#[test]
fn test_unauthorized_access() {
    let admin = Address::generate(&env);
    let attacker = Address::generate(&env);
    
    assert_err!(contract.register_project(
        admin_only_fn,
        attacker,  // Not admin
        ...
    ));
}
```

### Overflow/Underflow Testing

```rust
#[test]
fn test_no_integer_overflow() {
    let max_amount = u128::MAX;
    assert_ok!(contract.donate(max_amount));
    
    // Double donation shouldn't overflow
    assert_ok!(contract.donate(max_amount));
}
```

## Formal Verification

For critical contracts, consider formal verification:

### Tools
- **Prover**: Z3 SMT solver
- **Framework**: Soroban formal verification framework

### Example
```rust
// Properties to prove
// 1. Donation always increases global total
// 2. Storage keys never collide
// 3. Admin functions only callable by admin
```

## Test Data Management

### Fixtures
```rust
fn setup_test_env() -> (Env, Address, Address) {
    let env = Env::default();
    let admin = Address::generate(&env);
    let donor = Address::generate(&env);
    (env, admin, donor)
}
```

### Sample Data
```json
{
  "projects": [
    {
      "id": "amazon-001",
      "name": "Amazon Reforestation",
      "wallet": "GXXXX...",
      "co2_per_xlm": 8500
    }
  ],
  "donations": [
    {
      "donor": "GXXXX...",
      "project_id": "amazon-001",
      "amount": 100,
      "timestamp": 1719100800
    }
  ]
}
```

## Performance Testing

Test gas costs and ledger size limits:

```rust
#[test]
fn test_gas_costs() {
    let env = Env::default();
    env.budget().reset_unlimited();
    
    // Expensive operation should still be reasonable
    for i in 0..1000 {
        env.invoke_contract_fn(contract.donate(...));
    }
    
    let budget = env.budget().get_tracker();
    assert!(budget.cpu() < MAX_CPU_BUDGET);
    assert!(budget.memory() < MAX_MEMORY_BUDGET);
}
```

## Test Execution Pipeline

```
PR Created
    ↓
├─ cargo fmt --check
├─ cargo clippy
├─ cargo test --lib
├─ cargo test --test '*'
└─ cargo audit
    ↓
All Pass?
├─ Yes → Ready for review
└─ No → Fail PR

Code Review
    ↓
Review Approved?
├─ Yes → Merge to main
└─ No → Request changes

Merged to main
    ↓
├─ cargo test --workspace
├─ cargo build --release
├─ Snapshot tests
├─ Upgrade tests
└─ Generate WASM
    ↓
All Pass?
├─ Yes → Ready for deployment
└─ No → Revert commit

Deployment to Testnet
    ↓
├─ Deploy contracts
├─ Verify on-chain
└─ Run integration tests
    ↓
Testnet Pass?
├─ Yes → Create DAO proposal
└─ No → Investigate & fix

Mainnet (DAO Governed)
    ↓
├─ Wait for voting
├─ Voting passes?
│   ├─ Yes → Execute upgrade
│   └─ No → Discard proposal
└─ Post-execution tests
```

## Local Testing Workflow

```bash
# 1. Development
cargo test --lib              # Test your code
cargo fmt                      # Format
cargo clippy                   # Lint
cargo test --workspace         # Full suite

# 2. Pre-commit
make lint                      # Format + clippy
make test                      # All tests
make test-upgrade             # Upgrade regression

# 3. Pre-push
make audit                     # Security scan
make build                     # Release build

# 4. CI/CD
# (automatic on push)
cargo test
cargo build --release
cargo audit
```

## Troubleshooting Test Failures

### Unit Test Failure
```bash
cargo test test_name -- --nocapture
cargo test test_name -- --nocapture --test-threads=1
RUST_LOG=debug cargo test test_name
```

### Integration Test Failure
```bash
cargo test --test integration_test -- --nocapture
cargo test --test integration_test --features integration
```

### Snapshot Test Changes
```bash
# Review the diff
cargo test --lib -- --nocapture | grep "snapshots"

# Accept if correct
cargo insta review
```

### Flaky Tests
- Increase timeouts
- Use deterministic seeding
- Check for race conditions
- Avoid external dependencies in tests

## Best Practices

1. **Test Names**: Be descriptive (`test_donate_updates_global_total` not `test_1`)
2. **Arrange-Act-Assert**: Clear test structure
3. **Single Assertion**: Test one thing per test
4. **No Test Dependencies**: Each test should be independent
5. **Realistic Data**: Use representative inputs
6. **Error Cases**: Test both success and failure paths
7. **Comments**: Explain non-obvious test setup
8. **DRY**: Reuse fixtures and helpers

## References

- [Rust Testing Guide](https://doc.rust-lang.org/book/ch11-00-testing.html)
- [Soroban Testing Docs](https://developers.stellar.org/docs/learn/testing)
- [Test Best Practices](https://doc.rust-lang.org/cargo/guide/project-layout.html)

---

**Last Updated**: 2024-06-22
**Maintainers**: @B-Hands/contract-team
