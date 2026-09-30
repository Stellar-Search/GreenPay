"use strict";

const Redis = require("ioredis");
const { env } = require("../config/env");

// Falls back to null (and, in rateLimiter.js, to the in-memory store) when
// REDIS_URL isn't configured — lets the app run without Redis in
// environments where the shared store hasn't been provisioned yet.
// lazyConnect: importing this module must not open a socket. Every route file
// that builds a rate limiter pulls this in transitively, so an eager connection
// meant that merely requiring a route — which is all most test files do — left a
// live handle holding the event loop open, and `jest` would finish its run and
// then hang forever. Connecting on first command instead costs nothing in
// production, where the first rate-limited request arrives within milliseconds
// of boot, and the error handler below still reports an unreachable server.
const redisClient = env.redisUrl ? new Redis(env.redisUrl, { lazyConnect: true }) : null;

if (redisClient) {
  redisClient.on("error", (err) => {
    console.error("[Redis] Unexpected client error:", err.message);
  });
}

module.exports = redisClient;
