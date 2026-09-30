const rateLimit = require("express-rate-limit");
// Destructured, not the bare module: rate-limit-redis v4 ships an ESM/CJS
// interop namespace ({ RedisStore, default }), so `require(...)` returns the
// namespace object and `new RedisStore()` throws "is not a constructor". The
// branch below only runs when REDIS_URL is set, so this never fired locally or
// in a test run without Redis — it would have thrown on the first rate-limited
// request in any deployment that configured one.
const { RedisStore } = require("rate-limit-redis");
const redisClient = require("../cache/redisClient");
const { createApiError } = require("./apiEnvelope");
const { STELLAR_PUBLIC_KEY } = require("../schemas/common");

/**
 * Key dimensions used by createRateLimiter / createLayeredRateLimiter.
 * Every dimension maps to an independent bucket so abuse on one axis cannot
 * starve legitimate traffic on another (shared-NAT clients share an IP bucket
 * but keep separate wallet buckets, etc.).
 *
 * - "ip":       coarse per-client floor, keyed on the (proxy-corrected) IP.
 * - "wallet":   per-wallet-address limit for identity-tied actions.
 * - "subject":  per-authenticated-subject limit for actions behind a token.
 * - "global":   one shared bucket for every client — a backpressure cap on
 *               expensive endpoints that bounds distributed attempts.
 */
const KEY_DIMENSIONS = ["ip", "wallet", "subject", "global"];

// Fallback used when the intended identity is missing from a request: without
// it, a malformed body would skip the bucket entirely. Falling back to the IP
// keeps the request constrained on at least the coarse floor.
const FALLBACK_KEY = "unknown";

/** Single shared bucket for every client on a global-capped endpoint. */
const GLOBAL_KEY = "__global__";

// Body/query fields that carry a wallet address on identity-tied routes.
// adminAddress / matcherAddress are the project-owner and matching identities
// used by the admin/project mutation endpoints.
const WALLET_FIELDS = ["donorAddress", "walletAddress", "publicKey", "adminAddress", "matcherAddress"];

function ipKey(req) {
  return req.ip || FALLBACK_KEY;
}

function walletKey(req) {
  for (const field of WALLET_FIELDS) {
    const value = req.body?.[field] ?? req.query?.[field];
    if (typeof value === "string" && STELLAR_PUBLIC_KEY.test(value)) {
      return `wallet:${value}`;
    }
  }
  return ipKey(req);
}

function subjectKey(req) {
  const sub = req.admin?.sub;
  if (typeof sub === "string" && sub.length > 0 && sub.length <= 256) {
    return `subject:${sub}`;
  }
  return ipKey(req);
}

/**
 * Resolve the keyGenerator for a limiter.
 * @param {string | function} keyBy - one of KEY_DIMENSIONS, or a custom
 *   `(req) => string` function. Returns null for "ip" so the library's own
 *   key generator is used — it validates req.ip and fails closed when the
 *   proxy setup is wrong (permissive trust proxy, or a forged X-Forwarded-For
 *   reaching an untrusted app), guardrails we don't want to disable.
 */
function resolveKeyGenerator(keyBy) {
  if (typeof keyBy === "function") return keyBy;
  if (!KEY_DIMENSIONS.includes(keyBy)) {
    // Fail loudly at construction time rather than silently keying on IP when
    // a route author meant a specific dimension (a misspelled `keyBy` would
    // otherwise weaken the limiter to IP-only).
    throw new Error(
      `createRateLimiter: unknown keyBy "${keyBy}" — expected one of ${KEY_DIMENSIONS.join(", ")} or a custom function`
    );
  }
  if (keyBy === "wallet") return walletKey;
  if (keyBy === "subject") return subjectKey;
  if (keyBy === "global") return () => GLOBAL_KEY;
  return null; // "ip"
}

/**
 * Factory function to create reusable rate limiters.
 *
 * @param {number} maxRequests - max requests allowed in the window
 * @param {number} windowMinutes - time window in minutes
 * @param {string} name - unique id for this limiter, used as its Redis key
 *   prefix so counters don't collide with other limiters sharing the same
 *   store.
 * @param {Object} [options]
 * @param {string | function} [options.keyBy] - which bucket dimension to key
 *   on: "ip" (default), "wallet", "subject", "global", or a custom
 *   `(req) => string` function.
 */
const createRateLimiter = (maxRequests, windowMinutes, name, options = {}) => {
  if (!name) {
    throw new Error("createRateLimiter requires a unique `name` for its store key prefix");
  }

  const keyGenerator = resolveKeyGenerator(options.keyBy || "ip");

  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    max: maxRequests,
    standardHeaders: true,
    legacyHeaders: false,
    // null → library default key generator (validated req.ip); only override
    // for the identity dimensions.
    ...(keyGenerator ? { keyGenerator } : {}),
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

/**
 * Compose several per-dimension limiters into a single middleware so one route
 * can be constrained along independent axes at once: a coarse per-IP floor,
 * per-wallet / per-subject limits for identity-tied actions, and an optional
 * global cap on expensive endpoints.
 *
 * A request must pass every configured layer; each layer has its own store
 * prefix (`${name}-${dimension}`) so a hit on one bucket does not poison the
 * others. This is what lets shared-NAT clients stop starving each other (their
 * IP floor is shared but their wallet buckets are separate) while a
 * distributed attempt remains bounded (the global cap counts all of them).
 *
 * @param {Object} layers
 * @param {string} layers.name - unique limiter name (store key prefix)
 * @param {number} layers.windowMinutes - time window in minutes for all layers
 * @param {number} [layers.ip] - per-IP coarse floor
 * @param {number} [layers.wallet] - per-wallet limit
 * @param {number} [layers.subject] - per-authenticated-subject limit
 * @param {number} [layers.global] - global cap shared by every client
 * @returns {Function} express middleware running each configured layer in sequence
 */
const createLayeredRateLimiter = ({ name, windowMinutes, ip, wallet, subject, global: globalLimit }) => {
  if (!name) {
    throw new Error("createLayeredRateLimiter requires a unique `name` for its store key prefix");
  }
  if (!windowMinutes || windowMinutes <= 0) {
    throw new Error("createLayeredRateLimiter requires a positive `windowMinutes`");
  }

  const layers = [];
  if (ip !== undefined) layers.push(createRateLimiter(ip, windowMinutes, `${name}-ip`, { keyBy: "ip" }));
  if (wallet !== undefined) layers.push(createRateLimiter(wallet, windowMinutes, `${name}-wallet`, { keyBy: "wallet" }));
  if (subject !== undefined) layers.push(createRateLimiter(subject, windowMinutes, `${name}-subject`, { keyBy: "subject" }));
  if (globalLimit !== undefined) layers.push(createRateLimiter(globalLimit, windowMinutes, `${name}-global`, { keyBy: "global" }));

  if (layers.length === 0) {
    throw new Error("createLayeredRateLimiter requires at least one of: ip, wallet, subject, global");
  }

  // Run the layers in sequence: each express-rate-limit middleware either
  // rejects (next(err)) or passes through (next()), which advances to the next
  // layer until all have allowed the request. Built with reduceRight so no
  // layer is ever skipped and the outermost middleware receives every error.
  const passthrough = (req, res, next) => next();
  const composed = layers.reduceRight(
    (nextLayer, layer) => (req, res, next) =>
      layer(req, res, (err) => (err ? next(err) : nextLayer(req, res, next))),
    passthrough,
  );
  return composed;
};

module.exports = { createRateLimiter, createLayeredRateLimiter };
