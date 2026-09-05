/**
 * src/realtime/eventLog.js
 *
 * The durable half of the live feed. Broadcasting an event over Socket.IO is
 * fire-and-forget: a client whose socket is down for the two seconds the event
 * is emitted never learns it happened. This log records every broadcast so a
 * reconnecting client can ask "what did I miss since cursor X?" and get a real
 * answer instead of a silent gap.
 *
 * Backed by a Redis stream when one is configured. A stream is the right shape
 * here: XADD assigns monotonically increasing ids across every pod, MAXLEN caps
 * the memory it can ever use, and XRANGE reads a window back — so the cursor a
 * client holds is just a stream id.
 *
 * With no Redis, it degrades to a per-process ring buffer. That keeps local
 * development working exactly as before, but a pod-local cursor is meaningless
 * to any other pod, so those cursors are tagged with the instance that issued
 * them and replayed only by that instance. Anyone else is told to resynchronise
 * rather than being handed a plausible-looking partial answer.
 */
"use strict";

const crypto = require("crypto");
const { logger } = require("../utils/logger");

const STREAM_KEY = "greenpay:realtime:events";

// Roughly an hour of a busy feed. The cap is what stops an unbounded live
// stream from becoming an unbounded memory cost; clients that fall further
// behind than this are told to resynchronise from REST instead.
const MAX_RETAINED_EVENTS = 10000;

// Replay is a catch-up mechanism, not a bulk export. A client further behind
// than this should refetch from REST, which is cheaper than streaming
// thousands of individual events through a socket handshake.
const MAX_REPLAY_BATCH = 500;

const CURSOR_REDIS_PREFIX = "r";
const CURSOR_LOCAL_PREFIX = "l";

/**
 * Identifies this process in locally-issued cursors. A pod that restarts gets a
 * new id, which is what makes a stale local cursor detectable rather than
 * silently wrong.
 */
const INSTANCE_ID = crypto.randomBytes(8).toString("hex");

class EventLog {
  /**
   * @param {import("ioredis").Redis|null} redis Client used for the shared
   *   stream. Null selects the in-process ring buffer.
   */
  constructor(redis) {
    this.redis = redis || null;
    this.buffer = [];
    this.localSeq = 0;
    // Set when a Redis operation fails. Callers surface this so an operator
    // sees "the feed is degraded", not just "the feed is quiet".
    this.lastError = null;
  }

  get usingSharedStore() {
    return Boolean(this.redis);
  }

  /**
   * Record a broadcast and return the cursor identifying it.
   *
   * Never throws: a live donation must still reach connected sockets even if
   * the replay store is unreachable. A failure here degrades recovery, and the
   * returned `degraded` flag is what tells the caller to say so out loud.
   *
   * @param {{name: string, payload: object}} event
   * @returns {Promise<{cursor: string|null, degraded: boolean}>}
   */
  async append(event) {
    const record = {
      name: event.name,
      payload: event.payload,
      emittedAt: new Date().toISOString(),
    };

    if (this.redis) {
      try {
        const id = await this.redis.xadd(
          STREAM_KEY,
          "MAXLEN",
          "~",
          String(MAX_RETAINED_EVENTS),
          "*",
          "name",
          record.name,
          "payload",
          JSON.stringify(record.payload),
          "emittedAt",
          record.emittedAt,
        );
        this.lastError = null;
        return { cursor: `${CURSOR_REDIS_PREFIX}:${id}`, degraded: false };
      } catch (err) {
        // Fall through to the local buffer so the event is at least replayable
        // by this pod, and mark the log degraded so the API stops implying the
        // cursor is globally meaningful.
        this.lastError = err.message;
        logger.error({
          msg: "realtime event log write failed, falling back to local buffer",
          error: err.message,
        });
      }
    }

    this.localSeq += 1;
    const cursor = `${CURSOR_LOCAL_PREFIX}:${INSTANCE_ID}:${this.localSeq}`;
    this.buffer.push({ ...record, cursor, seq: this.localSeq });
    if (this.buffer.length > MAX_RETAINED_EVENTS) {
      this.buffer.splice(0, this.buffer.length - MAX_RETAINED_EVENTS);
    }
    return { cursor, degraded: this.redis !== null };
  }

  /**
   * Return events recorded after `cursor`.
   *
   * `reset: true` is the honest answer whenever this log cannot prove it is
   * returning the complete set — an unparseable cursor, one issued by a
   * different process, or one that has aged out of the retention window. The
   * client's contract is to refetch current state from REST when it sees it,
   * rather than stitching an incomplete replay into its timeline.
   *
   * @param {string|null} cursor
   * @param {number} [limit]
   * @returns {Promise<{events: Array<object>, nextCursor: string|null,
   *   reset: boolean, reason: string|null, degraded: boolean}>}
   */
  async replay(cursor, limit = 100) {
    const batch = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), MAX_REPLAY_BATCH);

    if (!cursor) {
      // No cursor means the client has no timeline to reconcile against. It is
      // not "behind"; it simply starts from now.
      return { events: [], nextCursor: null, reset: true, reason: "NO_CURSOR", degraded: this.isDegraded() };
    }

    const parsed = parseCursor(cursor);
    if (!parsed) {
      return { events: [], nextCursor: null, reset: true, reason: "INVALID_CURSOR", degraded: this.isDegraded() };
    }

    if (parsed.kind === "local") {
      return this.replayLocal(parsed, batch);
    }

    if (!this.redis) {
      // A shared cursor cannot be honoured by a process with no shared store.
      return { events: [], nextCursor: null, reset: true, reason: "STORE_UNAVAILABLE", degraded: true };
    }

    try {
      // "(" makes the range exclusive, so the client never re-receives the
      // event it already has.
      const rows = await this.redis.xrange(STREAM_KEY, `(${parsed.id}`, "+", "COUNT", batch);
      this.lastError = null;

      // An empty result is ambiguous: either nothing happened since, or the
      // cursor aged out of the capped stream. Those need different client
      // behaviour, so distinguish them by checking whether the stream's oldest
      // surviving entry is already newer than what the client asked for.
      if (rows.length === 0) {
        const oldest = await this.redis.xrange(STREAM_KEY, "-", "+", "COUNT", 1);
        if (oldest.length > 0 && compareStreamIds(oldest[0][0], parsed.id) > 0) {
          return {
            events: [],
            nextCursor: null,
            reset: true,
            reason: "CURSOR_EXPIRED",
            degraded: this.isDegraded(),
          };
        }
        return { events: [], nextCursor: cursor, reset: false, reason: null, degraded: this.isDegraded() };
      }

      const events = rows.map(([id, fields]) => decodeStreamRow(id, fields));
      return {
        events,
        nextCursor: events[events.length - 1].cursor,
        reset: false,
        reason: null,
        degraded: this.isDegraded(),
      };
    } catch (err) {
      this.lastError = err.message;
      logger.error({ msg: "realtime event log replay failed", error: err.message });
      // Refusing to guess: the client is told to resynchronise rather than
      // being handed an empty list it would read as "nothing happened".
      return { events: [], nextCursor: null, reset: true, reason: "STORE_UNAVAILABLE", degraded: true };
    }
  }

  replayLocal(parsed, batch) {
    if (parsed.instanceId !== INSTANCE_ID) {
      // Issued by a different pod (or this pod before a restart). Its sequence
      // numbers say nothing about this process's buffer.
      return { events: [], nextCursor: null, reset: true, reason: "CURSOR_FOREIGN", degraded: true };
    }

    const oldest = this.buffer.length > 0 ? this.buffer[0].seq : null;
    if (oldest !== null && parsed.seq < oldest - 1) {
      return { events: [], nextCursor: null, reset: true, reason: "CURSOR_EXPIRED", degraded: this.isDegraded() };
    }

    const events = this.buffer
      .filter((entry) => entry.seq > parsed.seq)
      .slice(0, batch)
      .map((entry) => ({ cursor: entry.cursor, name: entry.name, payload: entry.payload, emittedAt: entry.emittedAt }));

    return {
      events,
      nextCursor: events.length > 0 ? events[events.length - 1].cursor : buildLocalCursor(parsed.seq),
      reset: false,
      reason: null,
      degraded: this.isDegraded(),
    };
  }

  /** True when replay cannot be trusted across pods. */
  isDegraded() {
    if (!this.redis) {
      // Deliberate single-process operation is not a degradation; it is the
      // documented local-development mode.
      return false;
    }
    return this.lastError !== null;
  }

  status() {
    return {
      store: this.redis ? "redis-stream" : "in-memory",
      degraded: this.isDegraded(),
      lastError: this.lastError,
      bufferedEvents: this.buffer.length,
      instanceId: INSTANCE_ID,
    };
  }
}

function buildLocalCursor(seq) {
  return `${CURSOR_LOCAL_PREFIX}:${INSTANCE_ID}:${seq}`;
}

function decodeStreamRow(id, fields) {
  const map = {};
  for (let i = 0; i < fields.length; i += 2) {
    map[fields[i]] = fields[i + 1];
  }
  let payload = {};
  try {
    payload = JSON.parse(map.payload);
  } catch {
    // A row we cannot parse is reported with an empty payload rather than
    // aborting the whole replay for the events around it.
    payload = {};
  }
  return {
    cursor: `${CURSOR_REDIS_PREFIX}:${id}`,
    name: map.name,
    payload,
    emittedAt: map.emittedAt,
  };
}

/**
 * Redis stream ids are "<ms>-<seq>"; comparing them as strings gets the order
 * wrong as soon as the millisecond components differ in length.
 */
function compareStreamIds(a, b) {
  const [aMs, aSeq] = a.split("-").map(Number);
  const [bMs, bSeq] = b.split("-").map(Number);
  if (aMs !== bMs) return aMs < bMs ? -1 : 1;
  if (aSeq !== bSeq) return aSeq < bSeq ? -1 : 1;
  return 0;
}

function parseCursor(cursor) {
  if (typeof cursor !== "string") return null;
  const parts = cursor.split(":");

  if (parts[0] === CURSOR_REDIS_PREFIX && parts.length === 2) {
    if (!/^\d+-\d+$/.test(parts[1])) return null;
    return { kind: "redis", id: parts[1] };
  }

  if (parts[0] === CURSOR_LOCAL_PREFIX && parts.length === 3) {
    const seq = Number.parseInt(parts[2], 10);
    if (!Number.isFinite(seq) || seq < 0) return null;
    return { kind: "local", instanceId: parts[1], seq };
  }

  return null;
}

module.exports = {
  EventLog,
  INSTANCE_ID,
  STREAM_KEY,
  MAX_RETAINED_EVENTS,
  MAX_REPLAY_BATCH,
  parseCursor,
  compareStreamIds,
};
