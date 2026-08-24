"use strict";

const Redis = require("ioredis");
const { env } = require("../config/env");

// Falls back to null (and, in rateLimiter.js, to the in-memory store) when
// REDIS_URL isn't configured — lets the app run without Redis in
// environments where the shared store hasn't been provisioned yet.
const redisClient = env.redisUrl ? new Redis(env.redisUrl) : null;

if (redisClient) {
  redisClient.on("error", (err) => {
    console.error("[Redis] Unexpected client error:", err.message);
  });
}

module.exports = redisClient;
