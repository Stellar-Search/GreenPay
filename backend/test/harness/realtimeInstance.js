/**
 * test/harness/realtimeInstance.js
 *
 * Boots a minimal backend instance in its OWN process.
 *
 * Separate processes are the entire point. The bug being guarded against —
 * Socket.IO holding connections in per-process memory — cannot be reproduced by
 * two `new Server()` objects inside one Jest worker, because they share a heap
 * and, more importantly, because any in-process fake of the adapter would be
 * testing the fake. Only real processes talking over real Redis prove the fan-out.
 *
 * Run as: node realtimeInstance.js
 * Configured by env: PORT (0 for ephemeral), REDIS_URL (absent = single-process).
 * Control messages go to stdout prefixed with a sentinel, because the app's
 * structured logger writes JSON to the same stream — without the prefix the
 * parent cannot tell a log line from a reply.
 * Accepts one line of JSON per command on stdin:
 *   {"cmd":"publish","name":"donation_event","payload":{...}}
 *   {"cmd":"status"}
 *   {"cmd":"shutdown"}
 */
"use strict";

const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

// The realtime module reads config through env.js, which refuses to boot
// without these. Set before requiring anything that pulls it in.
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "harness-secret-not-a-real-key";

const realtime = require("../../src/realtime");

async function main() {
  const app = express();
  app.use(express.json());

  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: "*" } });

  // Mirrors the replay endpoint so a client can recover a gap without the whole
  // route stack (and its database) being present.
  app.get("/replay", async (req, res) => {
    const result = await realtime.getEventLog().replay(req.query.cursor || null, req.query.limit);
    res.json(result);
  });
  app.get("/status", (req, res) => {
    res.json({ ...realtime.describeStatus(), metrics: realtime.metrics.snapshot() });
  });

  const redisUrl = process.env.REDIS_URL || null;
  const result = await realtime.initializeRealtime(io, { redisUrl });

  await new Promise((resolve) => server.listen(Number(process.env.PORT) || 0, resolve));
  const { port } = server.address();

  send({ ready: true, port, mode: result.mode, degraded: result.degraded, instanceId: realtime.INSTANCE_ID });

  let buffer = "";
  process.stdin.on("data", async (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      await handle(JSON.parse(line), { server, io });
    }
  });
}

async function handle(message, { server, io }) {
  switch (message.cmd) {
  case "publish": {
    const published = await realtime.publish(message.name, message.payload);
    send({ id: message.id, published: true, cursor: published.cursor, degraded: published.degraded });
    break;
  }
  case "status": {
    send({ id: message.id, status: realtime.describeStatus(), metrics: realtime.metrics.snapshot() });
    break;
  }
  case "shutdown": {
    send({ id: message.id, shuttingDown: true });
    await realtime.shutdownRealtime();
    io.close();
    server.close(() => process.exit(0));
    // The adapter's Redis sockets can outlive close() if Redis is wedged;
    // this bounds the harness rather than hanging a CI job.
    setTimeout(() => process.exit(0), 2000).unref();
    break;
  }
  default:
    send({ id: message.id, error: `unknown command ${message.cmd}` });
  }
}

const CONTROL_PREFIX = "@@realtime-harness@@ ";

function send(object) {
  process.stdout.write(`${CONTROL_PREFIX}${JSON.stringify(object)}\n`);
}

main().catch((err) => {
  send({ ready: false, error: err.message });
  process.exit(1);
});
