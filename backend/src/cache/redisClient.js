"use strict";

const Redis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL;

// Falls back to null (and, in rateLimiter.js, to the in-memory store) when
// REDIS_URL isn't configured — lets the app run without Redis in
// environments where the shared store hasn't been provisioned yet.
const redisClient = REDIS_URL ? new Redis(REDIS_URL) : null;

if (redisClient) {
  redisClient.on("error", (err) => {
    console.error("[Redis] Unexpected client error:", err.message);
  });
}

module.exports = redisClient;
