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

A fixed 2-pod fleet cannot hold those numbers under a donation spike. Replica
count for the public Rollouts is owned by `autoscaling/v2` HPAs:

| Workload | Manifest | Metrics | Range |
| --- | --- | --- | --- |
| backend | `k8s/hpa.yaml` / `helm/greenpay/templates/hpa.yaml` | CPU 60%, p95 latency 400 ms, queue depth 25 | 2–10 (12 on mainnet) |
| frontend | same files | CPU 70%, 40 req/s per pod | 2–8 (10 on mainnet) |
| ml-inference | `k8s/ml-workloads/ml-inference.yaml` | GPU util 70%, queue depth 50 | 1–8 |

Scale-up has no stabilization window and may double (or add 4 pods) every 15 s
so p95 is corrected before it crosses 500 ms. Scale-down waits 5 minutes.
Backend `topologySpreadConstraints` (`maxSkew: 1`, `DoNotSchedule`) are
unchanged; maxReplicas stays small enough to place on a 2- or 3-node cluster.

CPU comes from metrics-server. Latency, queue depth and RPS come from
prometheus-adapter — the same custom-metrics stack `ml-inference-hpa` already
requires. The HPA targets the Argo `Rollout`, not a `Deployment`.

## Running the test

```bash
# Install k6: https://k6.io/docs/get-started/installation/
# brew install k6  (macOS)

# Against local dev server
k6 run scripts/load-test.js

# Against a deployed staging environment (HPA-enabled)
BASE_URL=https://your-deployed-staging.example.com k6 run scripts/load-test.js
# In another terminal, confirm replicas move during the spike:
# kubectl -n greenpay get hpa backend-hpa frontend-hpa -w

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

---

# Event-Sourcing Pipeline Capacity

The k6 test above measures the synchronous half of a donation: the HTTP request
that appends a `DonationRecorded` event. Everything a donor actually sees on the
project page — `projects.raised_xlm`, `donor_stats`, badges, match state — is
written later by the projection worker in
`backend/src/eventSourcing/eventStore.js`. A donation spike therefore has a
second failure mode that no HTTP metric detects: the API stays fast while read
models fall arbitrarily far behind.

## The pipeline load test

```bash
# Defaults: 60 s spikes at 50/100/150/200/400/800 donations per second
node scripts/event-pipeline-load-test.js

# Sweep specific rates, print a markdown table
node scripts/event-pipeline-load-test.js --rates 100,200,400 --format markdown

# Model a managed Postgres with a 3 ms statement round trip
node scripts/event-pipeline-load-test.js --latency 3

# Compare the fixed-interval scheduler against adaptive batching
node scripts/event-pipeline-load-test.js --mode static
```

The harness (`backend/src/eventSourcing/loadHarness.js`) drives the real
`EventStoreService` and the real projection handlers against an in-memory
`event_stream` on a virtual clock, so a ten-minute spike replays in seconds and
results are deterministic. It reports catch-up time (last projection applied
minus last donation accepted), per-event lag percentiles, peak backlog and
sustained projection throughput. `backend/src/eventSourcing/loadHarness.test.js`
runs a reduced version of the same scenarios in CI as a capacity regression
guard.

**Model assumptions.** Statement cost is a constant plus jitter, the worker is
single-threaded and sequential (which the implementation is), and ingestion runs
on separate connections. Postgres contention, index growth, autovacuum and
replication lag are not modelled, so these numbers are an optimistic upper
bound. Set `--latency` from the p50 of `pg_stat_statements` on the target
database before quoting a capacity number for that environment.

## Measured capacity (2026-08-18)

60-second spikes, adaptive scheduler, `--latency 1.2` (co-located Postgres):

| Donations/s | Drained | Catch-up after spike | p95 lag | Peak backlog | Throughput |
|---|---|---|---|---|---|
| 50 | yes | 0.16 s | 149 ms | 26 | 50/s |
| 100 | yes | 0.29 s | 289 ms | 51 | 100/s |
| 150 | yes | 0.43 s | 431 ms | 76 | 149/s |
| 200 | yes | 10.6 s | 10.2 s | 1 824 | 170/s |
| 400 | yes | 75.5 s | 67.3 s | 12 800 | 177/s |
| 800 | yes | 209.6 s | 201.8 s | 36 999 | 178/s |

Same spikes with `--latency 3` (networked/managed Postgres):

| Donations/s | Drained | Catch-up after spike | p95 lag | Peak backlog | Throughput |
|---|---|---|---|---|---|
| 25 | yes | 0.17 s | 175 ms | 14 | 25/s |
| 50 | yes | 0.34 s | 340 ms | 26 | 50/s |
| 75 | yes | 0.99 s | 981 ms | 76 | 74/s |
| 100 | yes | 19.5 s | 17.3 s | 1 351 | 76/s |
| 200 | yes | 94.5 s | 88.4 s | 6 900 | 78/s |
| 400 | yes | 248.4 s | 230.6 s | 18 800 | 78/s |

### What the numbers mean

* **Capacity is set by statements per event, not by the batch size.** Dispatching
  one `DonationRecorded` costs four statements: the project `UPDATE`, and three
  for donor stats (`SELECT` current total, upsert, then the `COUNT(DISTINCT ...)`
  re-scan of `event_stream`), plus the amortised batch mark. Sustained
  throughput is therefore roughly `1 / (4 x statement latency)`: ~178/s at 1.2 ms
  and ~78/s at 3 ms.
* **A single projection worker sustains ~178 donations/s** co-located, ~78/s over
  a network hop. Below that, catch-up stays under a second. Above it, backlog and
  lag grow linearly with the overshoot for as long as the spike lasts.
* **Backlog drains at capacity minus arrival rate.** A 60-second spike at 400/s
  on a networked database leaves ~19 000 events queued and takes ~4 minutes to
  catch up. Nothing is lost — the pipeline is durable and it does drain — but for
  those minutes every project page under-reports its raised total.
* **Larger batches trade latency for throughput.** Events are marked processed at
  the end of their batch, so per-event lag tracks batch duration. Around the knee
  (75/s at 3 ms) adaptive batching can roughly double p95 lag while adding
  throughput; the trade is worth it under backlog and neutral when idle, because
  the batch size decays back to 200.

## Backpressure assessment

There is no backpressure. `POST /api/v1/donations` appends and returns; nothing
in the ingestion path consults the depth of `event_stream`, so the queue is
bounded only by the size of the spike. That is the right call for donations —
refusing a donation because projections are behind would be worse than serving a
stale total — but it makes two things mandatory: the backlog must be observable,
and catch-up capacity must be scalable.

### Shipped with this change

* **Adaptive batch sizing.** A batch that comes back full doubles the next batch
  (200 up to `EVENT_STORE_MAX_BATCH_SIZE`, default 2 000); batches that come back
  less than half full halve it back to the 200 baseline.
* **Catch-up cadence.** After a saturated batch the next poll fires in
  `EVENT_STORE_CATCHUP_INTERVAL_MS` (default 10 ms) instead of the full 500 ms
  poll interval. The fixed interval capped catch-up throughput at
  `batchSize / pollInterval` = ~133/s regardless of how fast projections ran; that
  ceiling is gone. Idle cadence is unchanged: unsaturated ticks realign to the
  500 ms grid.
* **Set-based batch completion.** `markProcessedBatch` now issues one
  `UPDATE ... WHERE event_id = ANY($1::uuid[])` instead of one statement per
  event, removing a round trip per event (5 statements per event down to 4).
* **Observability.** `eventStore.getSchedulerStats()` exposes batch count,
  processed/failed totals, current batch size, saturated-batch counters and last
  batch duration; the scheduler logs a warning every ten consecutive saturated
  batches. `eventStore.getPendingCount()` returns the live backlog.
* **Tunables** (`backend/.env.example`): `EVENT_STORE_BATCH_SIZE`,
  `EVENT_STORE_MAX_BATCH_SIZE`, `EVENT_STORE_POLL_INTERVAL_MS`,
  `EVENT_STORE_CATCHUP_INTERVAL_MS`, `EVENT_STORE_ADAPTIVE_BATCH`.

Net effect on the spike scenarios above: sustained throughput rises from ~133/s
to ~178/s (1.2 ms) and from ~67/s to ~78/s (3 ms), and catch-up after a
60-second 400/s spike drops from 120 s to 75 s (1.2 ms) and from 300 s to 248 s
(3 ms).

### Remaining plan (not in this change)

1. **Cut statements per event** — the largest single win available. The donor
   projection re-scans `event_stream` with `COUNT(DISTINCT ...)` for every event
   to recount supported projects; maintaining a `donor_project` membership table
   would remove that statement and its scan, taking the ceiling from four
   statements per event to two (~2x capacity). Grouping the project `UPDATE`s by
   `project_id` within a batch would remove most of the rest.
2. **Horizontal projection workers.** `getUnprocessed` has no claim step, so two
   workers would double-dispatch. Adding `SELECT ... FOR UPDATE SKIP LOCKED` (or
   a `claimed_by`/`claimed_at` lease) makes N workers safe and multiplies
   catch-up capacity by N, at the cost of global ordering across streams —
   acceptable for the projections here, which are per-project or per-donor, but
   it must be verified per projection before enabling.
3. **Event-driven wakeup.** Replace polling with `LISTEN`/`NOTIFY` on append so
   idle latency is not floored at half a poll interval.
4. **Alerting.** Export `pendingEvents` (already computed in
   `getEventStoreStatus`) and `consecutiveSaturated` as metrics, and page when
   the backlog exceeds one minute of capacity — 10 000 events co-located, 4 500
   over a network hop — or when catch-up has not completed within five minutes.
5. **Chaos coverage.** The harness models a healthy database. Failure injection
   (statement timeouts, a projection that throws for a subset of events, a worker
   restart mid-batch) belongs in the same harness; the dispatch loop already
   isolates per-event failures, but that path has no test.
