"use strict";
/**
 * middleware/progressiveDelay.js
 *
 * Per-account progressive delay for sensitive endpoints (admin login).
 *
 * The layered rate limiter keys on IP, wallet, or subject buckets, but a
 * distributed attacker rotating source addresses never trips an IP bucket.
 * This middleware keys on the *account* (e.g. the username being attempted) so
 * that throttling follows the identity no matter which address the request
 * arrives from:
 *
 *   - below `threshold` failed attempts: no delay;
 *   - from `threshold` onwards every attempt (successful or not) is delayed by
 *     `baseDelayMs * factor^(failures - threshold)`, capped at `maxDelayMs`;
 *   - once `maxFailures` is reached the account is hard-blocked with 429.
 *
 * The failure counter resets after `windowMs` of inactivity, and a successful
 * authentication clears it immediately.
 *
 * The store is in-memory per process. That is consistent with the rest of the
 * rate limiting stack (the app falls back to express-rate-limit's in-memory
 * store when REDIS_URL is unset) and acceptable for a single-admin surface;
 * swap createFailureStore for a Redis-backed store if replicas grow.
 */

const { createApiError } = require("./apiEnvelope");
const { logger } = require("../utils/logger");

const DEFAULT_OPTIONS = Object.freeze({
  // Extracts the account identity from the request; falsy → middleware no-ops
  // (the IP-level limiters still apply).
  keyFromRequest: (req) => req.body?.username,
  // Delays begin after this many failed attempts on the account.
  threshold: 5,
  // First delay applied when failures === threshold.
  baseDelayMs: 1000,
  // Delay grows by this factor per additional failure.
  factor: 2,
  // Hard upper bound on the per-attempt delay.
  maxDelayMs: 30 * 1000,
  // Hard-block the account (HTTP 429) beyond this many failures.
  maxFailures: 20,
  // Failure counter for an account resets after this long without activity.
  windowMs: 15 * 60 * 1000,
  // How a delay is applied; injectable for tests. Defaults to a real wait.
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

/**
 * In-memory store of per-account failure counts with expiry.
 * @param {Object} [options]
 * @param {number} [options.windowMs] - entries expire this long after the
 *   first recorded failure.
 */
function createFailureStore({ windowMs } = {}) {
  const expiryMs = windowMs || DEFAULT_OPTIONS.windowMs;
  // key -> { count, firstFailureAt }
  const entries = new Map();

  const prune = (key) => {
    const entry = entries.get(key);
    if (entry && Date.now() - entry.firstFailureAt > expiryMs) {
      entries.delete(key);
    }
  };

  return {
    get(key) {
      prune(key);
      return entries.get(key) || null;
    },
    recordFailure(key) {
      prune(key);
      const entry = entries.get(key);
      if (entry) {
        entry.count += 1;
      } else {
        entries.set(key, { count: 1, firstFailureAt: Date.now() });
      }
    },
    reset(key) {
      entries.delete(key);
    },
    size() {
      return entries.size;
    },
  };
}

/**
 * Compute the delay (ms) to apply for an account with `failures` recorded
 * failures, given the limiter options. Exported for direct testing.
 */
function computeDelayMs(failures, options = {}) {
  const threshold = options.threshold ?? DEFAULT_OPTIONS.threshold;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_OPTIONS.baseDelayMs;
  const factor = options.factor ?? DEFAULT_OPTIONS.factor;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_OPTIONS.maxDelayMs;

  if (failures < threshold) return 0;
  return Math.min(baseDelayMs * Math.pow(factor, failures - threshold), maxDelayMs);
}

/**
 * Middleware factory: applies progressive per-account delay.
 * @param {Object} [options] - overrides for DEFAULT_OPTIONS; `store` may be
 *   injected for tests.
 */
function createProgressiveDelay(options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const store = opts.store || createFailureStore(opts);

  return (req, res, next) => {
    const key = opts.keyFromRequest(req);
    if (!key) return next();

    // Observe the outcome of every attempt for this account — including ones
    // that were already delayed — so failures keep counting up.
    res.on("finish", () => {
      if (res.statusCode === 401) {
        store.recordFailure(key);
      } else if (res.statusCode >= 200 && res.statusCode < 400) {
        store.reset(key);
      }
    });

    const entry = store.get(key);
    if (entry && entry.count >= opts.maxFailures) {
      return next(createApiError(
        429,
        "ACCOUNT_THROTTLED",
        "Too many failed attempts for this account. Try again later."
      ));
    }

    const delayMs = computeDelayMs(entry ? entry.count : 0, opts);
    if (delayMs > 0) {
      res.set("Retry-After", Math.ceil(delayMs / 1000));
      logger.warn({
        msg: "progressive delay applied to account",
        account: key,
        failures: entry.count,
        delayMs,
      });
      // `delay` is injectable for tests; it defaults to a wall-clock wait.
      return opts.delay(delayMs).then(() => next(), next);
    }

    return next();
  };
}

module.exports = {
  createProgressiveDelay,
  createFailureStore,
  computeDelayMs,
  DEFAULT_PROGRESSIVE_DELAY_OPTIONS: DEFAULT_OPTIONS,
};
