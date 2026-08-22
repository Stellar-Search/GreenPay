const rateLimit = require("express-rate-limit");
const RedisStore = require("rate-limit-redis");
const redisClient = require("../cache/redisClient");
const { createApiError } = require("./apiEnvelope");

/**
 * Factory function to create reusable rate limiters
 * @param {number} maxRequests - max requests allowed
 * @param {number} windowMinutes - time window in minutes
 * @param {string} name - unique id for this limiter, used as its Redis key
 *   prefix so counters don't collide with other limiters sharing the same
 *   store (every limiter otherwise keys on the same client IP)
 */
const createRateLimiter = (maxRequests, windowMinutes, name) => {
  if (!name) {
    throw new Error("createRateLimiter requires a unique `name` for its store key prefix");
  }

  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    max: maxRequests,
    standardHeaders: true,
    legacyHeaders: false,
    // Falls back to express-rate-limit's default in-memory store when Redis
    // isn't configured (REDIS_URL unset), e.g. in local dev.
    store: redisClient
      ? new RedisStore({
        prefix: `rl:${name}:`,
        sendCommand: (...args) => redisClient.call(...args),
      })
      : undefined,
    handler: (req, res, next) => {
      res.set("Retry-After", Math.ceil(windowMinutes * 60));
      return next(createApiError(429, "RATE_LIMITED", "Too many requests. Try again later."));
    },
  });
};

module.exports = { createRateLimiter };
