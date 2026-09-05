"use strict";

/**
 * The regression test for cross-replica delivery.
 *
 * Socket.IO keeps its connections in per-process memory, so `io.emit` on one
 * pod reaches only the clients that pod is holding. The backend runs at least
 * two replicas (k8s/hpa.yaml), which meant roughly half of connected donors
 * never saw a donation event, and at ten replicas ninety percent did not.
 *
 * Nothing about that is observable in a single process, which is why it went
 * unnoticed: every existing socket test, and every local dev server, runs one.
 * So these tests spawn genuinely separate node processes and connect real
 * socket.io clients to them. An in-process double would only prove the double
 * works.
 *
 * Requires Redis. Skips itself when none is reachable so the default `npm test`
 * still runs everywhere; CI provides one (see .github/workflows/ci.yml).
 */

const { io: connectClient } = require("socket.io-client");
const { execFileSync } = require("child_process");

const { startCluster, stopCluster, startInstance } = require("./harness/cluster");

jest.setTimeout(60000);

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

function redisReachable() {
  const probe = `
    const Redis = require("ioredis");
    const client = new Redis(${JSON.stringify(REDIS_URL)}, {
      lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null,
    });
    client.connect()
      .then(() => client.ping())
      .then(() => { client.disconnect(); process.exit(0); })
      .catch(() => process.exit(1));
  `;
  try {
    execFileSync(process.execPath, ["-e", probe], { stdio: "ignore", timeout: 8000, cwd: __dirname });
    return true;
  } catch {
    return false;
  }
}

const describeIfRedis = redisReachable() ? describe : describe.skip;

/**
 * Connect a socket.io client and resolve once it is connected, so a test never
 * races the handshake against the publish it is about to make.
 */
function connect(url, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = connectClient(url, { transports: ["websocket"], forceNew: true, ...options });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`client did not connect to ${url}`));
    }, 15000);
    socket.on("connect", () => { clearTimeout(timer); resolve(socket); });
    socket.on("connect_error", (err) => { clearTimeout(timer); reject(err); });
  });
}

/** Register for the handshake status before opening the socket. */
async function connectWithInitialStatus(url, timeoutMs = 15000) {
  const socket = connectClient(url, {
    transports: ["websocket"],
    forceNew: true,
    autoConnect: false,
  });
  const statusPromise = nextEvent(socket, "realtime:status", timeoutMs);
  const connected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`client did not connect to ${url}`));
    }, timeoutMs);
    socket.on("connect", () => { clearTimeout(timer); resolve(); });
    socket.on("connect_error", (error) => { clearTimeout(timer); reject(error); });
  });
  socket.connect();
  await connected;
  return { socket, status: await statusPromise };
}

/** Resolve with the first matching event, or reject on timeout. */
function nextEvent(socket, name, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => { socket.off(name, handler); reject(new Error(`no ${name} within ${timeoutMs}ms`)); },
      timeoutMs,
    );
    const handler = (payload) => { clearTimeout(timer); socket.off(name, handler); resolve(payload); };
    socket.on(name, handler);
  });
}

describeIfRedis("cross-replica realtime delivery", () => {
  describe("an event emitted by one process reaches clients on every other", () => {
    let nodes;
    let sockets = [];

    beforeAll(async () => {
      nodes = await startCluster(3, { redisUrl: REDIS_URL });
    });

    afterEach(() => {
      sockets.forEach((socket) => socket.close());
      sockets = [];
    });

    afterAll(async () => {
      await stopCluster(nodes);
    });

    it("starts genuinely separate processes", () => {
      const ids = new Set(nodes.map((node) => node.instanceId));
      const pids = new Set(nodes.map((node) => node.child.pid));
      // If these collapsed to one, every assertion below would pass trivially.
      expect(ids.size).toBe(3);
      expect(pids.size).toBe(3);
      nodes.forEach((node) => expect(node.mode).toBe("redis-adapter"));
    });

    it("delivers to a client attached to a different process than the emitter", async () => {
      const listener = await connect(nodes[1].url);
      sockets.push(listener);

      const received = nextEvent(listener, "donation_event");
      const published = await nodes[0].publish("donation_event", {
        projectId: "project-cross-pod",
        donorAddress: "GDONOR",
        amountXLM: 42,
        transactionHash: "a".repeat(64),
        timestamp: new Date().toISOString(),
      });

      const payload = await received;
      expect(payload.projectId).toBe("project-cross-pod");
      expect(payload.amountXLM).toBe(42);
      // The cursor travels with the event; it is what a reconnecting client
      // presents to recover the gap.
      expect(payload.cursor).toBe(published.cursor);
    });

    it("delivers one emit to clients on all three processes at once", async () => {
      const listeners = await Promise.all(nodes.map((node) => connect(node.url)));
      sockets.push(...listeners);

      const waiting = listeners.map((socket) => nextEvent(socket, "donation_event"));
      await nodes[2].publish("donation_event", {
        projectId: "project-fanout",
        donorAddress: "GDONOR",
        amountXLM: 7,
        transactionHash: "b".repeat(64),
        timestamp: new Date().toISOString(),
      });

      const payloads = await Promise.all(waiting);
      expect(payloads).toHaveLength(3);
      payloads.forEach((payload) => expect(payload.projectId).toBe("project-fanout"));
      // Every replica delivered the same event with the same cursor, so clients
      // on different pods hold consistent timelines.
      expect(new Set(payloads.map((p) => p.cursor)).size).toBe(1);
    });

    it("counts broadcasts arriving from other pods, which is the signal a silent pod fails", async () => {
      const before = await Promise.all(nodes.map((node) => node.status()));

      await nodes[0].publish("donation_event", { projectId: "fanout-metric" });
      // The adapter round-trips through Redis, so the receiving pods observe it
      // slightly after the publish resolves.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const after = await Promise.all(nodes.map((node) => node.status()));

      // The two pods that did not originate it must each have observed it. This
      // is the counter the runbook alerts on: flat at zero on a pod holding
      // connections, while others publish, is broken cross-replica delivery.
      expect(after[1].metrics.fanoutObserved).toBeGreaterThan(before[1].metrics.fanoutObserved);
      expect(after[2].metrics.fanoutObserved).toBeGreaterThan(before[2].metrics.fanoutObserved);

      // The publisher counts it as published, and does not count its own
      // broadcast as remote fan-out.
      expect(after[0].metrics.eventsPublished).toBeGreaterThan(before[0].metrics.eventsPublished);
      expect(after[0].metrics.fanoutObserved).toBe(before[0].metrics.fanoutObserved);
    });

    it("reports connection counts per instance so a silent pod is visible", async () => {
      const onFirst = await Promise.all([connect(nodes[0].url), connect(nodes[0].url)]);
      const onSecond = await connect(nodes[1].url);
      sockets.push(...onFirst, onSecond);

      // Socket.IO's connection bookkeeping completes just after the client's
      // connect callback fires.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const first = await nodes[0].status();
      const second = await nodes[1].status();

      expect(first.metrics.currentConnections).toBe(2);
      expect(second.metrics.currentConnections).toBe(1);
      // Per-instance, not aggregate: an aggregate of 3 would look identical
      // whether one pod held all three or three pods held one each, which is
      // exactly the blindness that let this bug survive.
      expect(first.metrics.instanceId).not.toBe(second.metrics.instanceId);
    });
  });

  describe("reconnect recovery", () => {
    let nodes;

    beforeAll(async () => {
      nodes = await startCluster(2, { redisUrl: REDIS_URL });
    });

    afterAll(async () => {
      await stopCluster(nodes);
    });

    async function replay(node, cursor, limit) {
      const query = new URLSearchParams();
      if (cursor) query.set("cursor", cursor);
      if (limit) query.set("limit", String(limit));
      const response = await fetch(`${node.url}/replay?${query}`);
      return response.json();
    }

    it("recovers events a client missed while disconnected, from any instance", async () => {
      const socket = await connect(nodes[0].url);
      const firstSeen = nextEvent(socket, "donation_event");
      await nodes[0].publish("donation_event", { projectId: "p0", marker: "before-drop" });
      const anchor = (await firstSeen).cursor;

      // The client drops. Events continue to arrive on the other replica —
      // exactly the window in which the old implementation lost them silently.
      socket.close();
      const missed = [];
      for (let i = 0; i < 3; i++) {
        const published = await nodes[1].publish("donation_event", { projectId: `p${i + 1}`, marker: `missed-${i}` });
        missed.push(published.cursor);
      }

      // On reconnect the client asks what happened after the last cursor it saw.
      const result = await replay(nodes[0], anchor);

      expect(result.reset).toBe(false);
      expect(result.events.map((event) => event.cursor)).toEqual(missed);
      expect(result.events.map((event) => event.payload.marker)).toEqual([
        "missed-0", "missed-1", "missed-2",
      ]);
      // The cursor to resume from, so the client can chain further pages.
      expect(result.nextCursor).toBe(missed[missed.length - 1]);
    });

    it("answers a cursor issued by a different instance, because the log is shared", async () => {
      const published = await nodes[1].publish("donation_event", { projectId: "px", marker: "from-node-2" });
      const later = await nodes[1].publish("donation_event", { projectId: "py", marker: "after" });

      // Asked of node 1, about a cursor node 2 issued.
      const result = await replay(nodes[0], published.cursor);

      expect(result.reset).toBe(false);
      expect(result.events.map((event) => event.cursor)).toContain(later.cursor);
    });

    it("tells a client to resynchronise rather than implying an empty replay is complete", async () => {
      const cases = [
        ["no cursor at all", undefined, "NO_CURSOR"],
        ["a malformed cursor", "not-a-cursor", "INVALID_CURSOR"],
        ["a cursor from a pod that has restarted", "l:0000000000000000:5", "CURSOR_FOREIGN"],
      ];

      for (const [, cursor, expectedReason] of cases) {
        const result = await replay(nodes[0], cursor);
        // The distinction that matters: `events: []` alone is ambiguous between
        // "nothing happened" and "your cursor is unusable". `reset` disambiguates.
        expect(result.events).toEqual([]);
        expect(result.reset).toBe(true);
        expect(result.reason).toBe(expectedReason);
      }
    });

    it("reports no gap when the client is already up to date", async () => {
      const published = await nodes[0].publish("donation_event", { projectId: "pz", marker: "latest" });
      const result = await replay(nodes[0], published.cursor);

      expect(result.reset).toBe(false);
      expect(result.events).toEqual([]);
      expect(result.nextCursor).toBe(published.cursor);
    });
  });

  describe("degradation when the shared store is unavailable", () => {
    let node;

    afterEach(async () => {
      if (node) await node.stop();
      node = null;
    });

    it("keeps serving and reports itself degraded rather than silently dropping events", async () => {
      // Configured for a shared store, pointed at a port with nothing on it.
      node = await startInstance({ redisUrl: "redis://127.0.0.1:6399" });

      const { socket, status } = await connectWithInitialStatus(node.url);
      try {
        // The contract: a client is told the delivery scope, so it can decide to
        // fall back to polling REST instead of trusting a feed that will not
        // reach it. Silence here is what the old code did.
        expect(status.degraded).toBe(true);
        expect(status.delivery).toBe("instance");

        // Local delivery still works — partial delivery beats none.
        const received = nextEvent(socket, "donation_event");
        await node.publish("donation_event", { projectId: "degraded", marker: "local-only" });
        const payload = await received;
        expect(payload.projectId).toBe("degraded");
      } finally {
        socket.close();
      }

      const reported = await node.status();
      expect(reported.status.degraded).toBe(true);
      expect(reported.status.delivery).toBe("instance");
    });
  });

  describe("single-process mode is unchanged", () => {
    let node;

    afterAll(async () => {
      if (node) await node.stop();
    });

    it("runs without Redis and reports the mode honestly", async () => {
      node = await startInstance({ redisUrl: null });
      expect(node.mode).toBe("single-process");

      const { socket, status } = await connectWithInitialStatus(node.url);
      try {
        // Not degraded: one process delivering to its own clients is complete
        // delivery, which is what local development is.
        expect(status.degraded).toBe(false);
        expect(status.mode).toBe("single-process");
        expect(status.delivery).toBe("instance");

        const received = nextEvent(socket, "donation_event");
        await node.publish("donation_event", { projectId: "local", amountXLM: 1 });
        expect((await received).projectId).toBe("local");
      } finally {
        socket.close();
      }
    });
  });
});
