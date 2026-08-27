/**
 * src/utils/metrics.js
 *
 * Prometheus instrumentation for the donation path: HTTP traffic, donation
 * outcomes, event-sourcing projection lag and adaptive batching, background
 * job queue health, and Stellar/Soroban chain call latency and errors.
 *
 * Every label set here is bounded and enumerable ahead of time (status
 * codes, fixed queue names, fixed chain operation names, route patterns).
 * Nothing is labelled by project id, donor address, or any other
 * unbounded identifier — that cardinality would grow forever and make the
 * metric unusable (and expensive) in Prometheus.
 */
"use strict";

const client = require("prom-client");

const register = new client.Registry();
client.collectDefaultMetrics({ register });

// ── HTTP traffic ──────────────────────────────────────────────────────────
// Backs the existing Argo Rollout canary AnalysisTemplates in k8s/backend.yaml
// (backend-error-rate, backend-latency), which already query
// http_requests_total and http_request_duration_seconds_bucket but had no
// data source until this endpoint existed. `route` is the matched Express
// route pattern (e.g. "/api/v1/donations/donor/:publicKey"), never the raw
// URL, so a path parameter can't turn into unbounded label values.
const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests handled, by method, route pattern and status code",
  labelNames: ["method", "route", "code"],
  registers: [register],
});

const httpRequestDurationSeconds = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds, by method, route pattern and status code",
  labelNames: ["method", "route", "code"],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

function routeLabel(req) {
  if (req.route && typeof req.route.path === "string") {
    return (req.baseUrl || "") + req.route.path;
  }
  return "unmatched";
}

function httpMetricsMiddleware(req, res, next) {
  const end = httpRequestDurationSeconds.startTimer();
  res.on("finish", () => {
    const labels = { method: req.method, route: routeLabel(req), code: String(res.statusCode) };
    httpRequestsTotal.inc(labels);
    end(labels);
  });
  next();
}

// ── Donation outcomes ────────────────────────────────────────────────────
// `failure_mode` is a small fixed enum (see classifyDonationFailure callers)
// — never a raw error message, which would be unbounded.
const donationOutcomesTotal = new client.Counter({
  name: "greenpay_donation_outcomes_total",
  help: "Donations recorded, by outcome status and failure mode",
  labelNames: ["status", "failure_mode"],
  registers: [register],
});

function recordDonationOutcome(status, failureMode = "none") {
  donationOutcomesTotal.inc({ status, failure_mode: failureMode });
}

// ── Event-sourcing: projection lag and adaptive batching ────────────────
// Single pipeline, so these are unlabelled gauges rather than one per
// projection — every projection subscribed to a given event is applied in
// the same dispatch pass (see eventSourcing/projections.js), so they share
// one lag figure.
const projectionLagSeconds = new client.Gauge({
  name: "greenpay_projection_lag_seconds",
  help: "Age of the oldest unprocessed event in the event_stream, in seconds",
  registers: [register],
});

const eventStoreBatchSize = new client.Gauge({
  name: "greenpay_event_store_batch_size",
  help: "Current adaptive batch size used by the event-store dispatch scheduler",
  registers: [register],
});

const eventStoreConsecutiveSaturatedBatches = new client.Gauge({
  name: "greenpay_event_store_consecutive_saturated_batches",
  help: "Consecutive full (saturated) dispatch batches — sustained growth indicates a growing backlog",
  registers: [register],
});

function setProjectionLagSeconds(seconds) {
  projectionLagSeconds.set(Math.max(0, seconds));
}

function setEventStoreBatchStats({ batchSize, consecutiveSaturated }) {
  eventStoreBatchSize.set(batchSize);
  eventStoreConsecutiveSaturatedBatches.set(consecutiveSaturated);
}

// ── Background job queues (pg-boss) ──────────────────────────────────────
// `queue` is one of a fixed, small set of queue names declared at startup
// (ai-summary, update-push-notify, update-email-notify, and their
// dead-letter counterparts) — never a per-job or per-project identifier.
const jobQueueDepth = new client.Gauge({
  name: "greenpay_job_queue_depth",
  help: "Number of jobs currently queued, by queue name",
  labelNames: ["queue"],
  registers: [register],
});

const jobPermanentFailuresTotal = new client.Counter({
  name: "greenpay_job_permanent_failures_total",
  help: "Jobs that exhausted their retry limit and were routed to a dead-letter queue",
  labelNames: ["queue"],
  registers: [register],
});

function setJobQueueDepth(queue, depth) {
  jobQueueDepth.set({ queue }, depth);
}

function recordJobPermanentFailure(queue) {
  jobPermanentFailuresTotal.inc({ queue });
}

// ── Chain interaction (Horizon / Soroban RPC) ────────────────────────────
// `operation` is one of a fixed set of named call sites (rpc_simulate_transaction,
// rpc_get_events, rpc_get_latest_ledger, horizon_stream) — never a per-account
// or per-transaction label.
const chainRequestDurationSeconds = new client.Histogram({
  name: "greenpay_chain_request_duration_seconds",
  help: "Latency of Horizon/Soroban RPC calls, by operation and outcome",
  labelNames: ["operation", "outcome"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

const chainRequestErrorsTotal = new client.Counter({
  name: "greenpay_chain_request_errors_total",
  help: "Horizon/Soroban RPC calls that failed, by operation",
  labelNames: ["operation"],
  registers: [register],
});

/**
 * Times a chain call, recording latency under both a "success" and "error"
 * outcome and incrementing the error counter on failure. Rethrows so
 * existing error handling at the call site is unaffected.
 */
async function timeChainCall(operation, fn) {
  const end = chainRequestDurationSeconds.startTimer({ operation });
  try {
    const result = await fn();
    end({ outcome: "success" });
    return result;
  } catch (err) {
    end({ outcome: "error" });
    chainRequestErrorsTotal.inc({ operation });
    throw err;
  }
}

/** For error signals with no discrete request/response pair (e.g. a stream's onerror). */
function recordChainError(operation) {
  chainRequestErrorsTotal.inc({ operation });
}

module.exports = {
  register,
  httpMetricsMiddleware,
  recordDonationOutcome,
  setProjectionLagSeconds,
  setEventStoreBatchStats,
  setJobQueueDepth,
  recordJobPermanentFailure,
  timeChainCall,
  recordChainError,
};
