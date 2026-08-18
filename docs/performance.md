# Performance Targets

## POST /api/donations

| Metric | Target |
|--------|--------|
| p50 latency | < 150 ms |
| p95 latency | < 500 ms |
| p99 latency | < 1 000 ms |
| Error rate | < 1 % |
| Throughput (sustained) | ≥ 100 req/s |

These targets are validated by the k6 load test at `scripts/load-test.js`
(100 virtual users × 60 seconds). The p95 < 500 ms threshold is enforced as
a hard k6 `thresholds` check; the test exits with a non-zero status if it
is violated.

## Running the test

```bash
# Install k6: https://k6.io/docs/get-started/installation/
# brew install k6  (macOS)

# Against local dev server
k6 run scripts/load-test.js

# Against a deployed staging environment
BASE_URL=https://your-deployed-staging.example.com k6 run scripts/load-test.js

# HTML report
k6 run --out json=results.json scripts/load-test.js
```

## Baseline results (testnet, 2026-06-02)

_Run after initial backend deployment. Update this table after each significant
infrastructure change._

| Metric | Result |
|--------|--------|
| p50 | — ms |
| p95 | — ms |
| p99 | — ms |
| Error rate | — % |
| Peak RPS | — |

Re-run the test and fill in actual numbers before merging backend changes that
touch the donations route or the Stellar submission path.
