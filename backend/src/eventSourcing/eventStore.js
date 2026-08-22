"use strict";

const pool = require("../db/pool");
const { dispatchToProjections } = require("./projections");
const { logger: rootLogger } = require("../utils/logger");

const logger = rootLogger.child({ service: "event-store" });

function intFromEnv(name, fallback, { min = 1 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

// Baseline batch size. While a backlog exists the scheduler grows the working
// batch size up to EVENT_STORE_MAX_BATCH_SIZE; see docs/performance.md for the
// measured capacity of the pipeline.
const EVENT_STORE_BATCH_SIZE = intFromEnv("EVENT_STORE_BATCH_SIZE", 200);
const EVENT_STORE_MAX_BATCH_SIZE = intFromEnv("EVENT_STORE_MAX_BATCH_SIZE", 2000, {
  min: EVENT_STORE_BATCH_SIZE,
});
// Idle cadence: how long to wait before re-polling once the stream is drained.
const EVENT_STORE_POLL_INTERVAL_MS = intFromEnv("EVENT_STORE_POLL_INTERVAL_MS", 500, { min: 10 });
// Catch-up cadence: how long to wait after a batch that came back full. Sleeping
// a full poll interval between saturated batches caps throughput at
// batchSize / pollInterval events per second no matter how fast the projections
// actually run, which is what turns a donation spike into a backlog that only
// grows.
const EVENT_STORE_CATCHUP_INTERVAL_MS = intFromEnv("EVENT_STORE_CATCHUP_INTERVAL_MS", 10, { min: 0 });
// Set EVENT_STORE_ADAPTIVE_BATCH=false to pin the scheduler to the fixed batch
// size and poll interval (the load harness uses this as its baseline).
const EVENT_STORE_ADAPTIVE_BATCH = process.env.EVENT_STORE_ADAPTIVE_BATCH !== "false";

let schedulerRunning = false;
let schedulerTimer = null;

class EventStoreService {
  /**
   * @param {object} [db] pg pool, or a compatible stand-in such as the
   *   simulated pool used by `loadHarness.js`. Defaults to the shared app pool.
   */
  constructor(db = pool) {
    this.pool = db;
    this.isProcessing = false;
    this.batchSize = EVENT_STORE_BATCH_SIZE;
    this.adaptiveBatch = EVENT_STORE_ADAPTIVE_BATCH;
    this.stats = {
      batches: 0,
      processed: 0,
      failed: 0,
      saturatedBatches: 0,
      consecutiveSaturated: 0,
      currentBatchSize: this.batchSize,
      lastBatchAt: null,
      lastBatchDurationMs: 0,
    };
  }

  async append(event) {
    const row = event.toRow();

    try {
      // DO NOTHING (not DO UPDATE) is what makes `inserted` meaningful: on a
      // conflict Postgres reports rowCount 0, so a matched row no longer fakes a
      // successful insert. The xmax = 0 RETURNING expression is a belt-and-braces
      // check — xmax is 0 only for freshly inserted rows — so even if a future
      // caller relies on the returned flag it stays provably correct.
      const result = await this.pool.query(
        `INSERT INTO event_stream (
          event_id, stream_id, aggregate_type, aggregate_id, event_type,
          version, aggregate_version, payload, actor, occurred_at, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
        ON CONFLICT (stream_id, version) DO NOTHING
        RETURNING (xmax = 0) AS inserted`,
        [
          row.event_id,
          row.stream_id,
          row.aggregate_type,
          row.aggregate_id,
          row.event_type,
          row.version,
          row.aggregate_version,
          JSON.stringify(row.payload),
          row.actor,
          row.occurred_at,
          row.created_at,
        ]
      );
      const inserted = result.rows.length > 0 ? result.rows[0].inserted : false;
      return { eventId: row.event_id, version: row.version, inserted };
    } catch (err) {
      if (err.code === "23505") {
        throw new Error(`Duplicate event: stream ${row.stream_id} version ${row.version} already exists`);
      }
      throw err;
    }
  }

  async appendBatch(events) {
    const client = await this.pool.connect();
    let inTransaction = false;
    try {
      await client.query("BEGIN");
      inTransaction = true;
      const results = [];
      for (const event of events) {
        const row = event.toRow();
        // DO NOTHING (not DO UPDATE) so re-running a migration batch skips rows
        // that were already written instead of touching them as "affected".
        const result = await client.query(
          `INSERT INTO event_stream (
            event_id, stream_id, aggregate_type, aggregate_id, event_type,
            version, aggregate_version, payload, actor, occurred_at, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
          ON CONFLICT (stream_id, version) DO NOTHING`,
          [
            row.event_id,
            row.stream_id,
            row.aggregate_type,
            row.aggregate_id,
            row.event_type,
            row.version,
            row.aggregate_version,
            JSON.stringify(row.payload),
            row.actor,
            row.occurred_at,
            row.created_at,
          ]
        );
        results.push({ eventId: row.event_id, version: row.version, inserted: (result.rowCount === 1) });
      }
      await client.query("COMMIT");
      inTransaction = false;
      return results;
    } catch (err) {
      if (inTransaction) await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getUnprocessed(limit = EVENT_STORE_BATCH_SIZE) {
    const result = await this.pool.query(
      `SELECT event_id, stream_id, aggregate_type, aggregate_id, event_type,
              version, aggregate_version, payload, actor, occurred_at, created_at
       FROM event_stream
       WHERE processed = false
       ORDER BY occurred_at ASC, version ASC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  async getPendingCount() {
    const result = await this.pool.query(
      "SELECT COUNT(*) AS count FROM event_stream WHERE processed = false"
    );
    return Number.parseInt(result.rows[0]?.count || "0", 10);
  }

  async markProcessed(eventId) {
    await this.pool.query(
      "UPDATE event_stream SET processed = true, processed_at = NOW() WHERE event_id = $1",
      [eventId]
    );
  }

  /**
   * Marks a whole batch processed in one statement. The previous
   * statement-per-event loop added a round trip per event, which is the single
   * largest fixed cost in the dispatch path once a backlog forms.
   */
  async markProcessedBatch(eventIds) {
    if (eventIds.length === 0) return;
    await this.pool.query(
      "UPDATE event_stream SET processed = true, processed_at = NOW() WHERE event_id = ANY($1::uuid[])",
      [eventIds]
    );
  }

  async getStream(aggregateType, aggregateId) {
    const streamId = `${aggregateType}:${aggregateId}`;
    const result = await this.pool.query(
      `SELECT event_id, stream_id, aggregate_type, aggregate_id, event_type,
          version, aggregate_version, payload, actor, occurred_at, created_at
       FROM event_stream
       WHERE stream_id = $1
       ORDER BY version ASC`,
      [streamId]
    );
    return result.rows;
  }

  async getStreamVersion(aggregateType, aggregateId) {
    const streamId = `${aggregateType}:${aggregateId}`;
    const result = await this.pool.query(
      "SELECT MAX(version) AS max_version FROM event_stream WHERE stream_id = $1",
      [streamId]
    );
    return result.rows[0]?.max_version || 0;
  }

  async processBatch(limit = EVENT_STORE_BATCH_SIZE) {
    if (this.isProcessing) return { processed: 0, failed: 0 };
    this.isProcessing = true;

    try {
      const batch = await this.getUnprocessed(limit);
      if (batch.length === 0) return { processed: 0, failed: 0, total: 0, limit };

      const { fromPayload } = require("./events");
      const processedIds = [];
      let failedCount = 0;

      for (const row of batch) {
        try {
          const event = fromPayload(row.payload);
          await dispatchToProjections(this.pool, event);
          processedIds.push(row.event_id);
        } catch (err) {
          logger.error({ msg: "failed to dispatch event", eventId: row.event_id, error: err.message });
          failedCount++;
        }
      }

      if (processedIds.length > 0) {
        await this.markProcessedBatch(processedIds);
      }

      return { processed: processedIds.length, failed: failedCount, total: batch.length, limit };
    } catch (err) {
      logger.error({ msg: "batch processing error", error: err.message });
      return { processed: 0, failed: 0, total: 0, limit, error: err.message };
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Records the outcome of a batch and returns the batch size to use next.
   *
   * A batch that comes back full means the stream still holds at least as many
   * unprocessed events as the limit that was asked for, so the worker is behind:
   * grow the window (bounded by EVENT_STORE_MAX_BATCH_SIZE) to amortise the
   * per-batch round trips. Once batches stop filling up, shrink back towards the
   * baseline so an idle system keeps small, low-latency batches.
   */
  recordBatchOutcome(result) {
    const total = result.total || 0;
    const limit = result.limit || this.batchSize;
    const saturated = total >= limit;

    this.stats.batches += 1;
    this.stats.processed += result.processed || 0;
    this.stats.failed += result.failed || 0;
    this.stats.lastBatchAt = new Date().toISOString();

    if (saturated) {
      this.stats.saturatedBatches += 1;
      this.stats.consecutiveSaturated += 1;
    } else {
      this.stats.consecutiveSaturated = 0;
    }

    if (this.adaptiveBatch) {
      if (saturated) {
        this.batchSize = Math.min(EVENT_STORE_MAX_BATCH_SIZE, this.batchSize * 2);
      } else if (total < limit / 2) {
        this.batchSize = Math.max(EVENT_STORE_BATCH_SIZE, Math.floor(this.batchSize / 2));
      }
    }

    this.stats.currentBatchSize = this.batchSize;
    return this.batchSize;
  }

  /**
   * Delay before the next batch. A saturated batch is followed immediately so
   * that catch-up throughput is bounded by projection cost rather than by the
   * idle poll interval; otherwise the tick is realigned to the poll grid, which
   * keeps the idle cadence identical to the fixed-interval scheduler.
   *
   * @param {object} result outcome of the batch that just ran
   * @param {number} elapsedMs how long that batch took
   */
  nextDelayMs(result, elapsedMs = 0) {
    const aligned = Math.max(1, EVENT_STORE_POLL_INTERVAL_MS - (elapsedMs % EVENT_STORE_POLL_INTERVAL_MS));
    if (!this.adaptiveBatch) return aligned;
    const saturated = (result.total || 0) >= (result.limit || this.batchSize);
    return saturated ? EVENT_STORE_CATCHUP_INTERVAL_MS : aligned;
  }

  getSchedulerStats() {
    return {
      running: schedulerRunning,
      adaptiveBatch: this.adaptiveBatch,
      baseBatchSize: EVENT_STORE_BATCH_SIZE,
      maxBatchSize: EVENT_STORE_MAX_BATCH_SIZE,
      pollIntervalMs: EVENT_STORE_POLL_INTERVAL_MS,
      catchUpIntervalMs: EVENT_STORE_CATCHUP_INTERVAL_MS,
      ...this.stats,
    };
  }

  async runSchedulerTick() {
    const startedAt = Date.now();
    const result = await this.processBatch(this.batchSize);
    this.stats.lastBatchDurationMs = Date.now() - startedAt;
    this.recordBatchOutcome(result);

    if (result.processed > 0 || result.failed > 0) {
      logger.info({
        msg: "event dispatch batch",
        processed: result.processed,
        failed: result.failed,
        total: result.total || 0,
        batchSize: this.stats.currentBatchSize,
        durationMs: this.stats.lastBatchDurationMs,
      });
    }
    if (this.stats.consecutiveSaturated > 0 && this.stats.consecutiveSaturated % 10 === 0) {
      logger.warn({
        msg: "event store backlog",
        consecutiveSaturated: this.stats.consecutiveSaturated,
        currentBatchSize: this.stats.currentBatchSize,
      });
    }
    return result;
  }

  async startScheduler() {
    if (schedulerRunning) return;
    schedulerRunning = true;
    logger.info({
      msg: "event store scheduler started",
      baseBatchSize: EVENT_STORE_BATCH_SIZE,
      maxBatchSize: EVENT_STORE_MAX_BATCH_SIZE,
      pollIntervalMs: EVENT_STORE_POLL_INTERVAL_MS,
      adaptive: this.adaptiveBatch,
    });

    const scheduleNext = (delay) => {
      schedulerTimer = setTimeout(loop, delay);
      if (typeof schedulerTimer.unref === "function") schedulerTimer.unref();
    };

    const loop = async () => {
      if (!schedulerRunning) return;
      let delay = EVENT_STORE_POLL_INTERVAL_MS;
      try {
        const result = await this.runSchedulerTick();
        delay = this.nextDelayMs(result, this.stats.lastBatchDurationMs);
      } catch (err) {
        logger.error({ msg: "event store scheduler tick error", error: err.message });
      }
      if (!schedulerRunning) return;
      scheduleNext(delay);
    };

    scheduleNext(EVENT_STORE_POLL_INTERVAL_MS);
  }

  async stopScheduler() {
    schedulerRunning = false;
    if (schedulerTimer) {
      clearTimeout(schedulerTimer);
      schedulerTimer = null;
    }
    logger.info({ msg: "event store scheduler stopped" });
  }
}

const eventStore = new EventStoreService();

module.exports = {
  EventStoreService,
  eventStore,
  EVENT_STORE_BATCH_SIZE,
  EVENT_STORE_MAX_BATCH_SIZE,
  EVENT_STORE_POLL_INTERVAL_MS,
  EVENT_STORE_CATCHUP_INTERVAL_MS,
};
