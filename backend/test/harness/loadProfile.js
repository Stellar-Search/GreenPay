#!/usr/bin/env node
/**
 * test/harness/loadProfile.js
 *
 * Measures the live feed at a realistic replica count, so the cost of the
 * shared adapter is a recorded number rather than an assumption.
 *
 * What it measures, and why each matters:
 *
 *   fan-out completeness — the fraction of connected clients that received each
 *     broadcast. This is the headline: before the adapter it was 1/replicas.
 *     Anything below 100% here means the fix is incomplete.
 *
 *   delivery latency — time from publish to arrival, at the median and the
 *     tail. The adapter adds a Redis round trip to every broadcast, and the
 *     tail is where that shows up first under load.
 *
 *   per-pod distribution — how connections and receipts spread across
 *     instances. An even spread of connections with an uneven spread of
 *     receipts is the signature of the original bug.
 *
 * Usage:
 *   node test/harness/loadProfile.js [--replicas 10] [--clients 300] [--events 200]
 *   node test/harness/loadProfile.js --noAdapter 1     # measure the "before"
 *
 * --noAdapter starts the instances with no shared store, which is exactly the
 * pre-fix behaviour: each pod broadcasts only to its own clients. It exists so
 * the baseline in docs/realtime.md is a measured number rather than an
 * arithmetic claim.
 *
 * Not part of `npm test`: it takes minutes and needs a real Redis. Results are
 * recorded in docs/realtime.md.
 */
"use strict";

const { io: connectClient } = require("socket.io-client");
const { startCluster, stopCluster } = require("./cluster");

function parseArgs(argv) {
  const args = {
    replicas: 10, clients: 300, events: 200, noAdapter: 0,
    redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "");
    const value = argv[i + 1];
    if (key in args) args[key] = key === "redisUrl" ? value : Number(value);
  }
  return args;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

async function main() {
  const args = parseArgs(process.argv);
  const useAdapter = !args.noAdapter;
  console.log(`Starting ${args.replicas} backend instances (${useAdapter ? "shared adapter" : "NO adapter — pre-fix baseline"})...`);
  const nodes = await startCluster(args.replicas, { redisUrl: useAdapter ? args.redisUrl : null });

  try {
    console.log(`Connecting ${args.clients} clients, spread round-robin across instances...`);
    const receipts = new Map();       // eventId -> count
    const latencies = [];
    const perPodReceipts = new Map(); // instanceId -> count

    const clients = await Promise.all(
      Array.from({ length: args.clients }, (_, i) => {
        const node = nodes[i % nodes.length];
        return new Promise((resolve, reject) => {
          const socket = connectClient(node.url, { transports: ["websocket"], forceNew: true });
          const timer = setTimeout(() => reject(new Error("client connect timeout")), 30000);
          socket.on("connect", () => { clearTimeout(timer); resolve({ socket, node }); });
          socket.on("connect_error", (err) => { clearTimeout(timer); reject(err); });
        });
      }),
    );

    for (const { socket, node } of clients) {
      socket.on("donation_event", (payload) => {
        if (payload.sentAt) latencies.push(Date.now() - payload.sentAt);
        receipts.set(payload.eventId, (receipts.get(payload.eventId) || 0) + 1);
        perPodReceipts.set(node.instanceId, (perPodReceipts.get(node.instanceId) || 0) + 1);
      });
    }

    console.log(`Publishing ${args.events} events round-robin across instances...`);
    const started = Date.now();
    for (let i = 0; i < args.events; i++) {
      const node = nodes[i % nodes.length];
      await node.publish("donation_event", {
        eventId: `event-${i}`,
        projectId: `project-${i % 7}`,
        amountXLM: 10,
        sentAt: Date.now(),
      });
    }

    // Let the tail arrive before measuring completeness.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const elapsedMs = Date.now() - started;

    const complete = [...receipts.values()].filter((count) => count === args.clients).length;
    const totalReceipts = [...receipts.values()].reduce((sum, count) => sum + count, 0);
    const expected = args.events * args.clients;
    const sorted = latencies.slice().sort((a, b) => a - b);

    console.log("\n─── live feed load profile ───────────────────────────────");
    console.log(`replicas                 ${args.replicas}`);
    console.log(`clients                  ${args.clients} (${(args.clients / args.replicas).toFixed(1)} per replica)`);
    console.log(`events published         ${args.events} in ${elapsedMs} ms (${(args.events / (elapsedMs / 1000)).toFixed(1)}/s)`);
    console.log(`deliveries               ${totalReceipts} of ${expected} expected`);
    console.log(`fan-out completeness     ${((totalReceipts / expected) * 100).toFixed(2)}%`);
    console.log(`events reaching everyone ${complete}/${args.events}`);
    console.log(`latency p50 / p95 / p99  ${percentile(sorted, 50)} / ${percentile(sorted, 95)} / ${percentile(sorted, 99)} ms`);
    console.log(`latency max              ${sorted[sorted.length - 1]} ms`);

    console.log("\nper-instance receipts (even spread = every pod is delivering):");
    for (const node of nodes) {
      const count = perPodReceipts.get(node.instanceId) || 0;
      const status = await node.status();
      console.log(
        `  ${node.instanceId.slice(0, 8)}  connections=${String(status.metrics.currentConnections).padStart(3)}` +
        `  receipts=${String(count).padStart(6)}  published=${String(status.metrics.eventsPublished).padStart(4)}`,
      );
    }

    if (useAdapter) {
      const predicted = (1 / args.replicas) * 100;
      console.log(`\nwithout a shared adapter this would be ~${predicted.toFixed(1)}% (1 of ${args.replicas} replicas).`);
      console.log("run again with --noAdapter 1 to measure that baseline directly.");
    } else {
      console.log("\nthis is the pre-fix baseline: each pod broadcast only to its own clients.");
    }
    console.log("──────────────────────────────────────────────────────────\n");

    clients.forEach(({ socket }) => socket.close());
  } finally {
    await stopCluster(nodes);
  }
}

main().catch((err) => {
  console.error("load profile failed:", err.message);
  process.exit(1);
});
