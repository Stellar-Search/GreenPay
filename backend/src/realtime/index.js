/**
 * src/realtime/index.js
 *
 * Cross-replica delivery for the live donation feed.
 *
 * Socket.IO holds its connections in per-process memory. `io.emit` on a pod
 * therefore reaches only the clients whose sockets that pod is holding. The
 * backend runs a minimum of two replicas (k8s/hpa.yaml), so roughly half of
 * connected donors never saw a donation event; at ten replicas, ninety percent
 * did not. Nothing errored, which is why it survived so long — the feed simply
 * looked quiet.
 *
 * The fix is a shared adapter: every pod publishes broadcasts to Redis and
 * subscribes to the broadcasts of every other pod, so one `emit` fans out to
 * all connected clients regardless of which pod is holding them.
 *
 * Deliberate design decisions, each with a test that pins it:
 *
 * 1. No Redis configured is a supported mode, not a failure. Local development
 *    runs one process, where per-process delivery is complete by definition.
 *    Behaviour there is unchanged.
 *
 * 2. Redis configured but unreachable degrades loudly. Events keep flowing to
 *    the clients on the emitting pod — partial delivery beats none — but the
 *    subsystem reports `degraded`, logs at error level, and tells connected
 *    clients so they can fall back to polling REST. It never silently pretends
 *    delivery was complete. Readiness deliberately still passes: failing it
 *    would pull every pod out of rotation over a feature that is not the API.
 *
 * 3. Every broadcast is recorded in a replay log and carries the cursor
 *    identifying it, so a client that misses events while disconnected can
 *    determine and recover exactly what it missed rather than silently
 *    carrying a gap. See eventLog.js.
 */
"use strict";

const { logger } = require("../utils/logger");
const { EventLog, INSTANCE_ID } = require("./eventLog");
const metrics = require("./metrics");

// Channel prefix for the adapter's own pub/sub traffic. Namespaced so a shared
// Redis serving other workloads cannot collide with it.
const ADAPTER_KEY = "greenpay:socket";

// Emitted to a client as soon as it connects, and again whenever the mode
// changes, so the client never has to infer delivery guarantees from silence.
const STATUS_EVENT = "realtime:status";

const state = {
  io: null,
  eventLog: new EventLog(null),
  mode: "single-process",
  degradedReason: null,
  pubClient: null,
  subClient: null,
  logClient: null,
};

/**
 * Build the Redis connections this module needs.
 *
 * Three, not two, and the split is deliberate.
 *
 * The adapter's two clients (Socket.IO requires a dedicated subscriber, since a
 * connection in subscriber mode cannot issue ordinary commands) are configured
 * so that a command can never reject. @socket.io/redis-adapter issues every
 * `publish` and `psubscribe` without awaiting or catching it, so a rejection
 * there surfaces as an unhandled rejection and, on Node 18+, takes the process
 * down. A Redis outage would then stop being a degraded feed and start being a
 * crash-looping pod — a strictly worse failure than the bug being fixed. With
 * `maxRetriesPerRequest: null` and the offline queue left on, commands wait for
 * the connection to come back instead of being flushed with an error, and the
 * adapter heals by itself when Redis returns.
 *
 * The event log gets its own client with the opposite settings, because its
 * calls ARE awaited — by the donation request handler. There a command must
 * fail fast rather than queue behind an unreachable server, so it is bounded by
 * both a retry limit and a command timeout, and every call site catches.
 *
 * @param {string} redisUrl
 * @param {object} [options] Injection seam for tests.
 * @returns {{pubClient: object, subClient: object, logClient: object}}
 */
function createRedisClients(redisUrl, options = {}) {
  const RedisCtor = options.RedisCtor || require("ioredis");

  // Never rejects: waits for reconnection instead. See the note above — an
  // uncaught rejection from inside the adapter would crash the pod.
  const adapterOptions = {
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    lazyConnect: false,
    ...options.redisOptions,
  };

  // Fails fast, but bounded by a timeout rather than by refusing to queue.
  // Turning the offline queue off looks like the fail-fast choice and is the
  // wrong one here: a client is "not writeable" for the first few hundred
  // milliseconds after construction while it connects, so the first events a
  // freshly started pod publishes would be rejected and silently diverted to
  // the process-local buffer — absent from the shared replay log exactly when a
  // rolling deploy is reconnecting every client. The command timeout gives the
  // same protection against a genuinely unreachable server without losing the
  // startup window.
  const logOptions = {
    maxRetriesPerRequest: 1,
    commandTimeout: 2000,
    enableOfflineQueue: true,
    lazyConnect: false,
    ...options.redisOptions,
  };

  const pubClient = new RedisCtor(redisUrl, adapterOptions);
  const subClient = new RedisCtor(redisUrl, adapterOptions);
  const logClient = new RedisCtor(redisUrl, logOptions);

  return { pubClient, subClient, logClient };
}

/**
 * Attach cross-replica delivery to a Socket.IO server.
 *
 * Resolves once the mode is decided. It never rejects: a broken Redis must not
 * stop the API from starting, since every non-realtime route is unaffected.
 *
 * @param {import("socket.io").Server} io
 * @param {object} [options]
 * @param {string|null} [options.redisUrl]
 * @param {Function} [options.RedisCtor] Injection seam for tests.
 * @param {Function} [options.createAdapterFn] Injection seam for tests.
 * @returns {Promise<{mode: string, degraded: boolean}>}
 */
async function initializeRealtime(io, options = {}) {
  state.io = io;

  const redisUrl = options.redisUrl !== undefined
    ? options.redisUrl
    : require("../config/env").env.redisUrl;

  instrumentConnections(io);

  if (!redisUrl) {
    // Documented, supported single-process mode.
    state.mode = "single-process";
    state.degradedReason = null;
    state.eventLog = new EventLog(null);
    logger.info({
      msg: "realtime running in single-process mode; broadcasts reach only this instance",
      instanceId: INSTANCE_ID,
      hint: "set REDIS_URL to fan out across replicas",
    });
    return { mode: state.mode, degraded: false };
  }

  try {
    const createAdapter = options.createAdapterFn
      || require("@socket.io/redis-adapter").createAdapter;
    const { pubClient, subClient, logClient } = options.clients
      || createRedisClients(redisUrl, options);

    state.pubClient = pubClient;
    state.subClient = subClient;
    state.logClient = logClient;

    // A late failure must flip the mode too, not just log — the status a client
    // is told has to track reality after startup. These handlers are also what
    // stop ioredis's "error" events from being unhandled, which is fatal for an
    // EventEmitter.
    const clients = [["publisher", pubClient], ["subscriber", subClient], ["event-log", logClient]];
    for (const [role, client] of clients) {
      client.on("error", (err) => markDegraded(`redis ${role}: ${err.message}`));
      client.on("ready", () => {
        // Only clear once every connection is healthy again; one recovered
        // client does not mean delivery is global.
        if (clients.every(([, candidate]) => candidate.status === "ready")) clearDegraded();
      });
    }

    instrumentFanout(options.RedisAdapterClass);
    io.adapter(createAdapter(pubClient, subClient, { key: ADAPTER_KEY }));
    state.eventLog = new EventLog(logClient);
    state.mode = "redis-adapter";
    state.degradedReason = null;

    // Wait briefly for the connections to come up so the mode this returns —
    // and the status the first connecting clients are told — reflects reality
    // instead of optimism. Timing out is not fatal: the clients keep retrying
    // in the background and clearDegraded() promotes the instance when they
    // succeed.
    await waitForReady([pubClient, subClient, logClient], options.readyTimeoutMs ?? 5000);

    logger.info({
      msg: "realtime cross-replica delivery enabled",
      instanceId: INSTANCE_ID,
      adapterKey: ADAPTER_KEY,
      degraded: isDegraded(),
    });
    return { mode: state.mode, degraded: isDegraded() };
  } catch (err) {
    // Configured but unusable. Keep serving, and be explicit about it.
    state.mode = "redis-adapter";
    state.eventLog = new EventLog(null);
    markDegraded(`adapter initialization failed: ${err.message}`);
    return { mode: state.mode, degraded: true };
  }
}

/**
 * Count broadcasts arriving from other replicas.
 *
 * This is the counter that makes the original bug detectable: a pod holding
 * connections whose `fanoutObserved` never moves, while other pods publish, is
 * receiving nothing. Without it the failure is invisible again, which is the
 * whole reason it survived so long.
 *
 * Patched on the prototype rather than the instance because the adapter binds
 * its own `onmessage` as the Redis listener in its constructor
 * (`this.onmessage.bind(this)`), so an instance-level override is captured too
 * late and never runs. Patching the prototype before the first adapter is
 * constructed means the bind picks up the wrapper.
 *
 * Applied once per process; re-initialising must not stack wrappers.
 */
let fanoutInstrumented = false;

function instrumentFanout(RedisAdapterClass) {
  if (fanoutInstrumented) return;

  const AdapterClass = RedisAdapterClass || require("@socket.io/redis-adapter").RedisAdapter;
  const original = AdapterClass?.prototype?.onmessage;
  if (typeof original !== "function") {
    // A version that no longer exposes this seam: skip instrumentation rather
    // than break delivery. The counter stays at zero and the status endpoint
    // still reports mode and connections.
    logger.warn({ msg: "realtime fanout instrumentation unavailable on this adapter version" });
    return;
  }

  AdapterClass.prototype.onmessage = function instrumentedOnMessage(pattern, channel, msg) {
    try {
      const channelName = channel.toString();
      // Same two conditions the adapter itself uses to decide a message is a
      // real remote broadcast: right channel, and not this node's own echo.
      if (channelName.startsWith(this.channel)) {
        const [uid] = this.parser.decode(msg);
        if (uid !== this.uid) metrics.fanoutObserved();
      }
    } catch {
      // Instrumentation must never be able to drop an event.
    }
    return original.call(this, pattern, channel, msg);
  };

  fanoutInstrumented = true;
}

/**
 * Resolve once every client reports ready, or after `timeoutMs`. Never rejects:
 * a slow Redis delays the promotion to global delivery, it does not stop the
 * API from starting.
 */
function waitForReady(clients, timeoutMs) {
  const pending = clients.filter((client) => client.status !== "ready");
  if (pending.length === 0) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pending.forEach((client) => client.off("ready", onReady));
      resolve();
    };
    const onReady = () => {
      if (pending.every((client) => client.status === "ready")) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    if (timer.unref) timer.unref();
    pending.forEach((client) => client.on("ready", onReady));
  });
}

/**
 * Count connections per pod and mirror the delivery mode to each client.
 */
function instrumentConnections(io) {
  io.on("connection", (socket) => {
    metrics.connectionOpened();
    socket.emit(STATUS_EVENT, describeStatus());
    socket.on("disconnect", () => metrics.connectionClosed());
  });
}

/**
 * Broadcast an event to every connected client across every replica, recording
 * it for replay first so the cursor can travel with it.
 *
 * The record-then-emit order matters: a client that receives an event carrying
 * cursor C and later reconnects asks for "everything after C". If the emit
 * happened first, that cursor could name an event the log had not yet stored.
 *
 * @param {string} name
 * @param {object} payload
 * @returns {Promise<{cursor: string|null, degraded: boolean}>}
 */
async function publish(name, payload) {
  if (!state.io) {
    // Nothing is listening (a unit test, or a script importing a route file).
    return { cursor: null, degraded: true };
  }

  let cursor = null;
  let logDegraded = false;
  try {
    const appended = await state.eventLog.append({ name, payload });
    cursor = appended.cursor;
    logDegraded = appended.degraded;
  } catch (err) {
    // append() is written not to throw; this is belt-and-braces so a bug in the
    // replay path can never stop a donation reaching the feed.
    logDegraded = true;
    logger.error({ msg: "realtime replay log append threw", error: err.message });
  }

  const envelope = { ...payload, cursor, emittedAt: new Date().toISOString() };

  try {
    state.io.emit(name, envelope);
    metrics.eventPublished();
  } catch (err) {
    metrics.publishFailed();
    logger.error({ msg: "realtime broadcast failed", event: name, error: err.message });
    return { cursor, degraded: true };
  }

  return { cursor, degraded: logDegraded || isDegraded() };
}

function markDegraded(reason) {
  const changed = state.degradedReason !== reason;
  state.degradedReason = reason;
  if (changed) {
    logger.error({
      msg: "realtime delivery degraded to this instance only",
      instanceId: INSTANCE_ID,
      reason,
      impact: "clients on other replicas will not receive broadcasts until this recovers",
    });
    broadcastStatus();
  }
}

function clearDegraded() {
  if (state.degradedReason === null) return;
  state.degradedReason = null;
  logger.info({ msg: "realtime delivery recovered", instanceId: INSTANCE_ID });
  broadcastStatus();
}

function broadcastStatus() {
  // Local-only on purpose: each pod tells the clients it is holding about its
  // own health. Fanning this out would be both misleading and, in the degraded
  // case, impossible.
  if (state.io) {
    try {
      state.io.local.emit(STATUS_EVENT, describeStatus());
    } catch {
      // A failure to announce degradation must not itself throw.
    }
  }
}

function isDegraded() {
  return state.degradedReason !== null || state.eventLog.isDegraded();
}

/**
 * What clients and operators are told about delivery guarantees right now.
 */
function describeStatus() {
  return {
    instanceId: INSTANCE_ID,
    mode: state.mode,
    degraded: isDegraded(),
    reason: state.degradedReason,
    // The contract a client needs in order to decide whether to trust the feed:
    // "global" means every replica's clients receive this pod's broadcasts.
    delivery: deliveryScope(),
    replay: state.eventLog.status(),
  };
}

function deliveryScope() {
  if (state.mode === "single-process") return "instance";
  return isDegraded() ? "instance" : "global";
}

function getEventLog() {
  return state.eventLog;
}

async function shutdownRealtime() {
  const clients = [state.pubClient, state.subClient, state.logClient].filter(Boolean);
  state.pubClient = null;
  state.subClient = null;
  state.logClient = null;
  await Promise.all(
    clients.map((client) =>
      Promise.resolve()
        .then(() => client.quit())
        .catch(() => client.disconnect?.()),
    ),
  );
}

/** Test seam: restore module state between suites. */
function resetRealtime() {
  state.io = null;
  state.eventLog = new EventLog(null);
  state.mode = "single-process";
  state.degradedReason = null;
  state.pubClient = null;
  state.subClient = null;
  state.logClient = null;
}

module.exports = {
  initializeRealtime,
  publish,
  describeStatus,
  getEventLog,
  shutdownRealtime,
  resetRealtime,
  createRedisClients,
  ADAPTER_KEY,
  STATUS_EVENT,
  INSTANCE_ID,
  metrics,
};
