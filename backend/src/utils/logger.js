/**
 * src/utils/logger.js
 *
 * Thin structured-logging utility for GreenPay.
 *
 * Design goals
 * ────────────
 * • Zero external dependencies — serialises to newline-delimited JSON via
 *   process.stdout / process.stderr (Node ≥ 18).
 * • Reads the current correlation identifier automatically from
 *   AsyncLocalStorage so callers never have to thread it through every
 *   function signature.
 * • Redacts Stellar private keys and suspiciously large strings before
 *   they can reach log sinks (guard against accidental key logging).
 *
 * Usage
 * ─────
 *   const logger = require('./utils/logger');
 *
 *   logger.info({ msg: 'Donation recorded', donationId, amountXlm });
 *   logger.warn({ msg: 'Retrying Horizon submission', attempt: 2 });
 *   logger.error({ msg: 'Command failed', err: error });
 *
 *   // Bind extra fields for a sub-component:
 *   const jobLogger = logger.child({ service: 'summary-queue', jobId });
 *   jobLogger.info({ msg: 'Job started' });
 */
"use strict";

const { AsyncLocalStorage } = require("async_hooks");

// ── Shared storage ──────────────────────────────────────────────────────────
// One singleton per process; the correlation-ID middleware calls
// als.run({ correlationId }, next) for every incoming request, and any
// code that runs within that async context (awaited calls, callbacks,
// pg-boss workers that re-enter the context) can read it with
// als.getStore().
const als = new AsyncLocalStorage();

// ── Redaction rules ─────────────────────────────────────────────────────────
// DSA: linear scan over a small, fixed-length sentinel list — O(k) where
// k is the number of patterns, k << n.

/** Stellar secret-key pattern: S followed by 55 uppercase base-32 chars. */
const STELLAR_PRIVATE_KEY_RE = /\bS[A-Z2-7]{55}\b/;

/**
 * Maximum byte length allowed for a single string field value before it is
 * assumed to be a signed transaction envelope or other bulk material and
 * is redacted.  2 048 bytes covers any ordinary string; a minimal signed
 * Stellar XDR envelope is ~300 bytes base-64 but a full multi-op envelope
 * is larger — 2 kB is a safe, conservative threshold.
 */
const MAX_FIELD_BYTES = 2048;

const REDACTED = "[REDACTED]";

/**
 * Redact a single scalar value.
 *
 * @param {unknown} value
 * @returns {unknown} The value, or "[REDACTED]" when key material is detected.
 */
function redactValue(value) {
  if (typeof value !== "string") return value;
  // Guard: private key pattern
  if (STELLAR_PRIVATE_KEY_RE.test(value)) return REDACTED;
  // Guard: oversized string (signed envelope heuristic)
  if (Buffer.byteLength(value, "utf8") > MAX_FIELD_BYTES) return REDACTED;
  return value;
}

/**
 * Walk an object shallowly and redact any field value that contains key
 * material.  Shallow scan is sufficient because DomainEvent payloads and
 * job data are flat-ish; deep recursion would risk hiding the source of a
 * future leak.
 *
 * @param {Record<string, unknown>} obj
 * @returns {Record<string, unknown>} New object with redacted values.
 */
function redactFields(obj) {
  // DSA: hash-map iteration — O(n) where n = number of fields in obj.
  const out = {};
  for (const [key, val] of Object.entries(obj)) {
    out[key] = redactValue(val);
  }
  return out;
}

// ── Core emit ────────────────────────────────────────────────────────────────

const SERVICE = process.env.SERVICE_NAME || "greenpay-backend";

/**
 * Serialise and emit one log record.
 *
 * @param {"debug"|"info"|"warn"|"error"} level
 * @param {Record<string, unknown>} fields   Caller-supplied context.
 * @param {Record<string, unknown>} [bound]  Pre-bound fields from child().
 */
function emit(level, fields, bound = {}) {
  const store = als.getStore() || {};
  const correlationId = store.correlationId || undefined;

  // Merge order: built-ins < bound < caller fields (caller wins).
  const merged = redactFields({
    ...bound,
    ...fields,
  });

  const record = {
    level,
    time: new Date().toISOString(),
    service: SERVICE,
    ...(correlationId !== undefined && { correlationId }),
    ...merged,
  };

  // Errors and warnings → stderr; info/debug → stdout.
  const line = JSON.stringify(record) + "\n";
  if (level === "error" || level === "warn") {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * @typedef {object} Logger
 * @property {function(Record<string,unknown>): void} debug
 * @property {function(Record<string,unknown>): void} info
 * @property {function(Record<string,unknown>): void} warn
 * @property {function(Record<string,unknown>): void} error
 * @property {function(Record<string,unknown>): Logger} child
 */

/**
 * Create a logger, optionally pre-binding a set of fields.
 *
 * @param {Record<string, unknown>} [bound] Fields to attach to every record.
 * @returns {Logger}
 */
function createLogger(bound = {}) {
  return {
    debug: (fields) => emit("debug", fields, bound),
    info:  (fields) => emit("info",  fields, bound),
    warn:  (fields) => emit("warn",  fields, bound),
    error: (fields) => emit("error", fields, bound),
    /** Return a new logger with extra pre-bound fields (immutable parent). */
    child: (extra) => createLogger({ ...bound, ...extra }),
  };
}

/** The default root logger — imported by every module that needs to log. */
const logger = createLogger();

// ── AsyncLocalStorage helpers ─────────────────────────────────────────────────

/**
 * Run `fn` inside an async context that carries `correlationId`.
 * Used by the correlation-ID middleware and by background job workers that
 * need to re-enter the correlation context after crossing an async boundary.
 *
 * @param {string} correlationId
 * @param {function(): unknown} fn
 * @returns {unknown} Whatever `fn` returns.
 */
function runWithCorrelationId(correlationId, fn) {
  // Merge with any existing store so nested calls do not clobber other keys.
  const parent = als.getStore() || {};
  return als.run({ ...parent, correlationId }, fn);
}

/**
 * Read the correlation id from the current async context, or `undefined`
 * when no context has been established (e.g. startup code, tests).
 *
 * @returns {string|undefined}
 */
function getCorrelationId() {
  return (als.getStore() || {}).correlationId;
}

module.exports = {
  logger,
  createLogger,
  runWithCorrelationId,
  getCorrelationId,
  als,
  // Exported for testing
  redactValue,
  redactFields,
  REDACTED,
  STELLAR_PRIVATE_KEY_RE,
  MAX_FIELD_BYTES,
};
