/**
 * src/services/cache.js
 * Tiny in-memory TTL cache (process-local), bounded by entry count with
 * LRU eviction so a stream of distinct cache keys can't grow the heap
 * without limit. A periodic sweep also reclaims entries that expired but
 * were never read again (reads alone can't be relied on to bound memory —
 * nothing guarantees a stale key is ever looked up).
 */
"use strict";

const { env } = require("../config/env");

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * Creates an independent bounded TTL cache instance. Exposed mainly so
 * tests can exercise eviction/sweep behavior without touching the
 * process-wide singleton below.
 */
function createCache({ maxEntries = DEFAULT_MAX_ENTRIES, sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS } = {}) {
  // Map iteration order is insertion order, so re-inserting a key on every
  // read/write turns it into a cheap LRU ordering: the oldest (least
  // recently used) entry is always whatever `store.keys().next()` yields.
  const store = new Map();

  function nowMs() {
    return Date.now();
  }

  function isExpired(entry) {
    return entry.expiresAt <= nowMs();
  }

  function get(key) {
    const entry = store.get(key);
    if (!entry) return null;
    if (isExpired(entry)) {
      store.delete(key);
      return null;
    }
    store.delete(key);
    store.set(key, entry);
    return entry.value;
  }

  function set(key, value, ttlMs) {
    store.delete(key);
    store.set(key, { value, expiresAt: nowMs() + ttlMs });
    while (store.size > maxEntries) {
      const oldestKey = store.keys().next().value;
      store.delete(oldestKey);
    }
    return value;
  }

  function sweep() {
    for (const [key, entry] of store) {
      if (isExpired(entry)) store.delete(key);
    }
  }

  function clear() {
    store.clear();
  }

  let sweepTimer = null;
  function startSweep() {
    if (sweepTimer) return;
    sweepTimer = setInterval(sweep, sweepIntervalMs);
    // Don't hold the process open just to sweep an idle cache.
    if (sweepTimer.unref) sweepTimer.unref();
  }

  function stopSweep() {
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  startSweep();

  return {
    get,
    set,
    sweep,
    clear,
    stopSweep,
    size: () => store.size,
  };
}

const defaultCache = createCache({
  maxEntries: env.cacheMaxEntries,
  sweepIntervalMs: env.cacheSweepIntervalMs,
});

/**
 * Get a value from the in-memory TTL cache.
 *
 * @param {string} key - Cache key.
 * @returns {any|null} The cached value or null if missing/expired.
 */
function get(key) {
  return defaultCache.get(key);
}

/**
 * Set a value in the in-memory TTL cache. Evicts the least-recently-used
 * entry once the cache exceeds its configured maximum size.
 *
 * @param {string} key - Cache key.
 * @param {any} value - Value to cache.
 * @param {number} ttlMs - Time-to-live in milliseconds.
 * @returns {any} The value that was stored.
 */
function set(key, value, ttlMs) {
  return defaultCache.set(key, value, ttlMs);
}

module.exports = {
  get,
  set,
  sweep: defaultCache.sweep,
  clear: defaultCache.clear,
  stopSweep: defaultCache.stopSweep,
  size: defaultCache.size,
  createCache,
};
