# proptest regression seeds

When a property test finds a counterexample, `proptest` shrinks it and writes a seed
here. Re-run with:

```bash
cd contracts
PROPTEST_CASES=2000 cargo test --workspace --features testutils prop_
```

Convert any new counterexample into a deterministic `regression_*` unit test in the
relevant `property_tests.rs` or `fuzz_tests.rs` module.
