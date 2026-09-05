/**
 * test/harness/cluster.js
 *
 * Spawns and drives N real backend instances for the multi-replica tests.
 */
"use strict";

const path = require("path");
const { spawn } = require("child_process");

const INSTANCE_SCRIPT = path.join(__dirname, "realtimeInstance.js");

// The child shares stdout with the application's structured logger, so control
// replies are prefixed and every other line is ignored.
const CONTROL_PREFIX = "@@realtime-harness@@ ";

function parseControlLine(line) {
  if (!line.startsWith(CONTROL_PREFIX)) return null;
  try {
    return JSON.parse(line.slice(CONTROL_PREFIX.length));
  } catch {
    return null;
  }
}
const START_TIMEOUT_MS = 20000;

class Instance {
  constructor(child, info) {
    this.child = child;
    this.port = info.port;
    this.mode = info.mode;
    this.instanceId = info.instanceId;
    this.degraded = info.degraded;
    this.url = `http://127.0.0.1:${info.port}`;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";

    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk.toString(); });
  }

  consume(chunk) {
    this.buffer = (this.buffer || "") + chunk.toString();
    let newline;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = parseControlLine(line);
      if (!message) continue; // a log line, not a reply
      const resolver = this.pending.get(message.id);
      if (resolver) {
        this.pending.delete(message.id);
        resolver(message);
      }
    }
  }

  request(command) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`instance ${this.port} did not answer ${command.cmd}`)),
        10000,
      );
      this.pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  publish(name, payload) {
    return this.request({ cmd: "publish", name, payload });
  }

  status() {
    return this.request({ cmd: "status" });
  }

  async stop() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    try {
      await this.request({ cmd: "shutdown" });
    } catch {
      // Already gone or wedged; the kill below is the backstop.
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => { this.child.kill("SIGKILL"); resolve(); }, 5000);
      this.child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

/**
 * Start one instance and wait until it reports itself listening.
 * @param {{redisUrl?: string|null, env?: object}} [options]
 * @returns {Promise<Instance>}
 */
function startInstance(options = {}) {
  const env = {
    ...process.env,
    NODE_ENV: "test",
    JWT_SECRET: process.env.JWT_SECRET || "harness-secret-not-a-real-key",
    PORT: "0",
    ...options.env,
  };
  if (options.redisUrl) env.REDIS_URL = options.redisUrl;
  else delete env.REDIS_URL;

  const child = spawn(process.execPath, [INSTANCE_SCRIPT], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  return new Promise((resolve, reject) => {
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(
      () => reject(new Error(`instance did not start within ${START_TIMEOUT_MS}ms. stderr: ${stderr}`)),
      START_TIMEOUT_MS,
    );

    const onData = (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        const message = parseControlLine(line);
        if (!message || message.ready === undefined) continue;

        clearTimeout(timer);
        child.stdout.removeListener("data", onData);
        if (!message.ready) {
          reject(new Error(`instance failed to start: ${message.error}`));
          return;
        }
        resolve(new Instance(child, message));
        return;
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (err) => { clearTimeout(timer); reject(err); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`instance exited early with code ${code}. stderr: ${stderr}`));
    });
  });
}

/**
 * Start `count` instances concurrently, cleaning up any that did start if one
 * fails — otherwise a partial failure leaks node processes into the CI runner.
 */
async function startCluster(count, options = {}) {
  const settled = await Promise.allSettled(
    Array.from({ length: count }, () => startInstance(options)),
  );
  const started = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const failed = settled.find((r) => r.status === "rejected");
  if (failed) {
    await Promise.all(started.map((instance) => instance.stop()));
    throw failed.reason;
  }
  return started;
}

async function stopCluster(instances) {
  await Promise.all((instances || []).map((instance) => instance.stop()));
}

module.exports = { startInstance, startCluster, stopCluster, Instance };
