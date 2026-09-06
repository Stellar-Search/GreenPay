# Observability

Prometheus metrics for the donation path: what's exported, what it's labelled
by, and the dashboard and alerts built on top of it (issue: backend exposes no
metrics).

## Endpoint

`GET /metrics` on the backend (port 4000, same as the app) in Prometheus text
exposition format. No auth — scraped in-cluster only; the ingress in
`k8s/backend.yaml` does not route `/metrics`, so it isn't reachable outside
the cluster network.

## Cardinality

Every label below is a small, fixed enum decided at write time, never a raw
identifier:

- `failure_mode` — one of `validation_failed`, `project_not_found`,
  `tx_conflict`, `event_missing`, `client_error`, `internal_error`, `none`.
- `queue` — one of the six queue names declared at startup (`ai-summary`,
  `update-push-notify`, `update-email-notify`, and their `-dlq` counterparts).
- `operation` — one of `rpc_simulate_transaction`, `rpc_get_events`,
  `rpc_get_latest_ledger`, `horizon_stream`.
- `route` — the matched Express route *pattern* (e.g.
  `/api/v1/donations/donor/:publicKey`), never the resolved URL, so a real
  donor address or project id never becomes a label value.

No metric here is labelled by project id, donor address, transaction hash, or
job id. Labelling by any of those would grow the metric's cardinality without
bound as new projects and donors show up — the mistake the issue calls out
explicitly.

## Metrics

### HTTP

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `http_requests_total` | Counter | `method`, `route`, `code` | Backs the canary `backend-error-rate` AnalysisTemplate in `k8s/backend.yaml`, which queried this metric before it existed. |
| `http_request_duration_seconds` | Histogram | `method`, `route`, `code` | Backs `backend-latency` (p99 canary gate). |

### Donations

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `greenpay_donation_outcomes_total` | Counter | `status` (`success`/`duplicate`/`failure`), `failure_mode` | Recorded at both donation entry points: the `POST /api/v1/donations` route and the Horizon-stream indexer's `handleDonation`. |

### Event sourcing (`backend/src/eventSourcing`)

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `greenpay_projection_lag_seconds` | Gauge | none | Age of the oldest unprocessed row in `event_stream` at the start of the last dispatch batch. 0 when fully caught up. |
| `greenpay_event_store_batch_size` | Gauge | none | Current adaptive batch size (`EventStoreService.batchSize`). |
| `greenpay_event_store_consecutive_saturated_batches` | Gauge | none | Consecutive full batches — the signal the issue asked for: whether the adaptive batcher is coping or oscillating under load. |

Unlabelled: the five projections (project/donor/match/job/milestone) are all
applied within the same dispatch pass per event, so they share one lag figure
rather than five near-identical ones.

### Background jobs (pg-boss queues)

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `greenpay_job_queue_depth` | Gauge | `queue` | Polled every 15s via `pg-boss`'s `getQueueSize`, from each queue module's own `start()`. |
| `greenpay_job_permanent_failures_total` | Counter | `queue` | Incremented in each queue's dead-letter worker, alongside the existing `notificationFailures`/`ai_summary_job_failures` persistence. |

### Chain interaction (Horizon / Soroban RPC)

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `greenpay_chain_request_duration_seconds` | Histogram | `operation`, `outcome` (`success`/`error`) | Wraps `simulateTransaction` (`services/stellar.js`) and `getEvents`/`getLatestLedger` (`services/sorobanEventIndexer.js`). |
| `greenpay_chain_request_errors_total` | Counter | `operation` | Also incremented directly from the Horizon operations stream's `onerror` handler (`services/indexerService.js`), which has no discrete request/response pair to time. |

## Alerts

Defined in `k8s/monitoring/prometheusrule.yaml`. Threshold rationale is
inline as a comment on each rule; summarized:

- **DonationFailureRateHigh** (>5% for 10m) — matches the 5% bar the existing
  canary `backend-error-rate` template already uses for HTTP 5xx, applied to
  the higher-stakes donation outcome instead.
- **ProjectionLagHigh / ProjectionLagCritical** (>30s / >120s for 5m) — normal
  lag is sub-second given the 500ms idle poll interval and 10ms catch-up
  interval (`EVENT_STORE_POLL_INTERVAL_MS` / `EVENT_STORE_CATCHUP_INTERVAL_MS`).
- **EventStoreBacklogGrowing** (>20 consecutive saturated batches for 5m) —
  the adaptive batcher has been doubling its window and still can't drain.
- **JobQueueBacklog** (>500 for 10m) — several chunks' worth of fan-out stuck
  behind `teamSize: 2` workers, relative to the 50/100-recipient chunk sizes.
- **JobPermanentFailureRateHigh** (>5/hour) — each queue already retries 3
  times before dead-lettering, so this means retries aren't enough.
- **ChainRequestErrorRateHigh** (>10% for 5m) — set higher than the HTTP
  alerts since transient Horizon/RPC blips are more common than app bugs.
- **BackendHttpErrorRateHigh** (>5% for 5m) — the canary threshold applied
  continuously, not just during a rollout.

## Dashboard

`k8s/monitoring/donation-dashboard.json` is a Grafana dashboard (import
directly, or provision via a `GrafanaDashboard` / dashboard-sidecar
ConfigMap if your cluster uses one) covering the donation path end to end:

1. Donation outcome rate, by status
2. Donation failure rate, by failure_mode
3. Projection lag
4. Event-store adaptive batch size and consecutive saturated batches
5. Job queue depth, by queue
6. Job permanent failure rate, by queue
7. Chain request latency (p50/p95), by operation
8. Chain request error rate, by operation
9. Backend HTTP request rate and 5xx rate
10. Backend HTTP p99 latency (the same figure the canary `backend-latency`
    template gates on)

## Kubernetes wiring

`k8s/monitoring/` (applied separately — `kubectl apply -k k8s/monitoring/`,
same convention as `k8s/scheduler/` — since it needs the Prometheus Operator
CRDs already installed):

- Two `ServiceMonitor`s, one for `backend-stable` and one for `backend-canary`,
  each scraping `/metrics` and relabelling the `service` label to the full
  Service DNS name. That label is what the existing canary
  `AnalysisTemplate`s in `k8s/backend.yaml` already query — they were written
  against a metric that didn't exist until this endpoint shipped.
- The `PrometheusRule` described above.

`k8s/backend.yaml` itself also carries `prometheus.io/scrape` pod annotations
as a fallback for a plain (non-Operator) Prometheus using Kubernetes service
discovery.
