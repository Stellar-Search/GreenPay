"use strict";

/**
 * Load harness for the event-sourcing pipeline.
 *
 * It drives the real `EventStoreService` (append -> getUnprocessed ->
 * dispatchToProjections -> markProcessedBatch) and the real projection code
 * against an in-memory stand-in for the `event_stream` table, on a virtual
 * clock. Every simulated statement charges a configurable round-trip cost, so a
 * scenario that would take ten minutes of wall clock finishes in seconds while
 * still reproducing the pipeline's queueing behaviour.
 *
 * What it models
 *   - the projection worker is single-threaded and sequential (one statement at
 *     a time), which is what the current implementation does;
 *   - the scheduler cadence, including the `isProcessing` guard that makes
 *     overlapping ticks a no-op;
 *   - donation arrivals as an independent stream, on their own connections.
 *
 * What it does not model
 *   - Postgres contention: statement cost is a constant plus jitter, so the
 *     simulated database does not slow down as the table grows or as ingestion
 *     and projection writes compete. Numbers from this harness are therefore an
 *     optimistic bound; calibrate `queryLatencyMs` from `pg_stat_statements` on
 *     the target database (see docs/performance.md).
 *
 * Usage: `node scripts/event-pipeline-load-test.js` (CLI) or `runBurstScenario`
 * from a test.
 */

const { EventStoreService } = require("./eventStore");
const { DonationRecordedEvent } = require("./events");

/** Deterministic PRNG (mulberry32) so scenarios are reproducible. */
function createRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Monotonic virtual clock, advanced explicitly by simulated work. */
class VirtualClock {
  constructor() {
    this.nowMs = 0;
  }

  now() {
    return this.nowMs;
  }

  advance(ms) {
    this.nowMs += ms;
  }
}

/**
 * In-memory stand-in for the pg pool, covering the statements the event store
 * and the projections issue. Unrecognised statements (projection UPDATEs,
 * transaction control) succeed with no rows, which is what those call sites
 * expect.
 */
class SimulatedPool {
  constructor({ clock, queryLatencyMs = 1.2, jitterMs = 0.4, seed = 1 } = {}) {
    this.clock = clock;
    this.queryLatencyMs = queryLatencyMs;
    this.jitterMs = jitterMs;
    this.rng = createRng(seed);
    this.rows = [];
    this.byEventId = new Map();
    this.lane = "worker";
    this.queryCount = { worker: 0, ingest: 0 };
    this.busyMs = { worker: 0, ingest: 0 };
    this.onProcessed = null;
    // Running donor_stats totals, keyed by public_key. Modelling this matters
    // for capacity: upsertDonorStats only has to write the profiles FK guard
    // row on a donor's *first* donation, so a stub that always reports "no
    // such donor" makes every event look like a first-time donation and
    // overstates steady-state statements per event.
    this.donorStats = new Map();
  }

  /**
   * Runs `fn` with statements attributed to `lane`. Only the worker lane
   * advances the clock: ingestion runs on its own connections in the API
   * process, so it does not consume projection-worker time.
   */
  async withLane(lane, fn) {
    const previous = this.lane;
    this.lane = lane;
    try {
      return await fn();
    } finally {
      this.lane = previous;
    }
  }

  charge() {
    const cost = this.queryLatencyMs + this.rng() * this.jitterMs;
    this.queryCount[this.lane] += 1;
    this.busyMs[this.lane] += cost;
    if (this.lane === "worker") this.clock.advance(cost);
    return cost;
  }

  async query(sql, params = []) {
    this.charge();
    const text = String(sql);

    if (/INSERT INTO event_stream/i.test(text)) {
      return this.insertEvent(params);
    }
    if (/FROM event_stream/i.test(text) && /processed\s*=\s*false/i.test(text)) {
      if (/COUNT\(\*\)/i.test(text)) {
        return { rows: [{ count: String(this.pendingCount()) }], rowCount: 1 };
      }
      return this.selectUnprocessed(params[0]);
    }
    if (/UPDATE event_stream/i.test(text) && /processed\s*=\s*true/i.test(text)) {
      return this.markProcessed(params[0]);
    }
    if (/FROM donor_stats/i.test(text)) {
      const existing = this.donorStats.get(params[0]);
      if (existing === undefined) return { rows: [], rowCount: 0 };
      return { rows: [{ total_donated_xlm: existing }], rowCount: 1 };
    }
    if (/INTO donor_stats/i.test(text)) {
      // params: [public_key, total_donated_xlm, badges, projection_cursor]
      this.donorStats.set(params[0], params[1]);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  async connect() {
    const client = {
      query: (sql, params) => this.query(sql, params),
      release: () => {},
    };
    return client;
  }

  insertEvent(params) {
    const [eventId, streamId, aggregateType, aggregateId, eventType, version, aggregateVersion, payload, actor, occurredAt, createdAt] = params;
    if (this.byEventId.has(eventId)) return { rows: [], rowCount: 0 };
    const row = {
      event_id: eventId,
      stream_id: streamId,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      event_type: eventType,
      version,
      aggregate_version: aggregateVersion,
      payload: typeof payload === "string" ? JSON.parse(payload) : payload,
      actor,
      occurred_at: occurredAt,
      created_at: createdAt,
      processed: false,
      enqueued_at_ms: this.clock.now(),
    };
    this.rows.push(row);
    this.byEventId.set(eventId, row);
    return { rows: [], rowCount: 1 };
  }

  selectUnprocessed(limit) {
    const pending = [];
    for (const row of this.rows) {
      if (row.processed) continue;
      pending.push(row);
      if (pending.length >= limit) break;
    }
    return { rows: pending, rowCount: pending.length };
  }

  markProcessed(eventIds) {
    const ids = Array.isArray(eventIds) ? eventIds : [eventIds];
    let updated = 0;
    for (const eventId of ids) {
      const row = this.byEventId.get(eventId);
      if (!row || row.processed) continue;
      row.processed = true;
      row.processed_at_ms = this.clock.now();
      updated += 1;
      if (this.onProcessed) this.onProcessed(row);
    }
    return { rows: [], rowCount: updated };
  }

  pendingCount() {
    let count = 0;
    for (const row of this.rows) if (!row.processed) count += 1;
    return count;
  }
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, index)];
}

function buildArrivalSchedule({ donations, spikeDurationMs, rng }) {
  // Poisson-ish arrivals: uniform jitter inside each slot keeps the mean rate at
  // donations / spikeDurationMs while avoiding a perfectly regular cadence.
  const slot = spikeDurationMs / donations;
  const schedule = new Array(donations);
  for (let i = 0; i < donations; i += 1) {
    schedule[i] = Math.min(spikeDurationMs, i * slot + rng() * slot);
  }
  return schedule.sort((a, b) => a - b);
}

function buildDonationEvent(index) {
  return new DonationRecordedEvent({
    aggregateId: `load-donation-${index}`,
    version: 1,
    actor: "load-harness",
    projectId: `project-${index % 10}`,
    donorAddress: `GLOAD${String(index % 500).padStart(50, "0")}`,
    amountXlm: 1 + (index % 25),
    currency: "XLM",
    message: "load harness donation",
    transactionHash: `tx-${index}`,
  });
}

/**
 * Replays a donation spike through the event-sourcing pipeline.
 *
 * @param {object} options
 * @param {number} options.donations       donations in the spike
 * @param {number} options.spikeDurationMs window the donations arrive in
 * @param {boolean} options.adaptive       adaptive batching + catch-up cadence
 * @param {number} options.batchSize       starting batch size
 * @param {number} options.pollIntervalMs  idle/static cadence between batches
 * @param {number} options.queryLatencyMs  simulated statement round trip
 * @param {number} options.maxVirtualMs    give up (backlog unbounded) after this
 * @returns {Promise<object>} capacity report
 */
async function runBurstScenario(options = {}) {
  const {
    donations = 5000,
    spikeDurationMs = 60000,
    adaptive = true,
    batchSize = 200,
    pollIntervalMs = 500,
    queryLatencyMs = 1.2,
    jitterMs = 0.4,
    maxVirtualMs = 30 * 60 * 1000,
    seed = 42,
    label = adaptive ? "adaptive" : "static",
  } = options;

  const rng = createRng(seed);
  const clock = new VirtualClock();
  const pool = new SimulatedPool({ clock, queryLatencyMs, jitterMs, seed });
  const store = new EventStoreService(pool);
  store.adaptiveBatch = adaptive;
  store.batchSize = batchSize;

  const arrivals = buildArrivalSchedule({ donations, spikeDurationMs, rng });
  const lagsMs = [];
  let peakBacklog = 0;
  let lastProcessedAtMs = 0;

  pool.onProcessed = (row) => {
    lagsMs.push(row.processed_at_ms - row.enqueued_at_ms);
    lastProcessedAtMs = row.processed_at_ms;
  };

  let nextArrival = 0;
  let batches = 0;
  let timedOut = false;

  const admitArrivals = async () => {
    while (nextArrival < arrivals.length && arrivals[nextArrival] <= clock.now()) {
      const index = nextArrival;
      nextArrival += 1;
      await pool.withLane("ingest", () => store.append(buildDonationEvent(index)));
    }
  };

  for (;;) {
    await admitArrivals();

    const backlog = pool.pendingCount();
    if (backlog > peakBacklog) peakBacklog = backlog;

    if (backlog === 0 && nextArrival >= arrivals.length) break;

    if (clock.now() > maxVirtualMs) {
      timedOut = true;
      break;
    }

    if (backlog === 0) {
      // Idle: wait for the next donation rather than spinning on empty polls.
      clock.advance(Math.max(1, arrivals[nextArrival] - clock.now()));
      continue;
    }

    const batchStartedAt = clock.now();
    const result = await store.processBatch(store.batchSize);
    batches += 1;
    store.recordBatchOutcome(result);

    const batchDurationMs = clock.now() - batchStartedAt;

    if (adaptive) {
      clock.advance(store.nextDelayMs(result, batchDurationMs));
    } else {
      // The fixed-interval scheduler fires on a 500 ms grid and skips ticks that
      // land while a batch is still running, so the next batch starts at the
      // first grid point at or after the current one finished.
      const finishedAt = clock.now();
      const nextTick = (Math.floor(finishedAt / pollIntervalMs) + 1) * pollIntervalMs;
      clock.advance(nextTick - finishedAt);
    }
    if (batchStartedAt === clock.now()) clock.advance(1); // guard against a no-op tick
  }

  const sortedLags = lagsMs.slice().sort((a, b) => a - b);
  const spikeEndMs = arrivals.length > 0 ? arrivals[arrivals.length - 1] : 0;
  const processed = sortedLags.length;

  return {
    label,
    config: {
      donations,
      spikeDurationMs,
      arrivalRatePerSec: Number((donations / (spikeDurationMs / 1000)).toFixed(1)),
      adaptive,
      startingBatchSize: batchSize,
      pollIntervalMs,
      queryLatencyMs,
    },
    drained: !timedOut,
    processed,
    unprocessed: donations - processed,
    batches,
    finalBatchSize: store.batchSize,
    peakBacklog,
    statementsPerEvent: processed > 0 ? Number((pool.queryCount.worker / processed).toFixed(2)) : 0,
    // Sustained rate the worker achieved while it had work to do.
    sustainedThroughputPerSec: lastProcessedAtMs > 0
      ? Number((processed / (lastProcessedAtMs / 1000)).toFixed(1))
      : 0,
    catchUpMs: timedOut ? null : Math.max(0, Math.round(lastProcessedAtMs - spikeEndMs)),
    lagMs: {
      p50: Math.round(percentile(sortedLags, 50)),
      p95: Math.round(percentile(sortedLags, 95)),
      p99: Math.round(percentile(sortedLags, 99)),
      max: Math.round(sortedLags[sortedLags.length - 1] || 0),
    },
    virtualDurationMs: Math.round(clock.now()),
  };
}

module.exports = {
  VirtualClock,
  SimulatedPool,
  runBurstScenario,
  createRng,
  percentile,
};
