/**
 * src/middleware/correlationId.js
 *
 * Express middleware — correlation identifier propagation.
 *
 * Behaviour
 * ─────────
 * 1. If the incoming request carries an `X-Correlation-ID` header, that
 *    value is adopted as the correlation identifier.  This allows a client
 *    (mobile app, browser extension, or another service) to generate the id
 *    and have it tracked end-to-end.
 *
 * 2. If no header is present, a fresh UUID v4 is generated.  This covers
 *    curl calls and internal health-checks.
 *
 * 3. The id is:
 *    • Stored on `req.correlationId` for inline route use.
 *    • Written to the `X-Correlation-ID` response header so clients can
 *      include it in failure reports.
 *    • Injected into AsyncLocalStorage via `runWithCorrelationId()` so every
 *      `await`ed code path that handles this request — event store dispatch,
 *      job enqueueing — automatically picks it up without parameter threading.
 *
 * Input validation
 * ────────────────
 * The header value is clamped to 128 characters and stripped of whitespace
 * to prevent log injection.  Any value that fails this check is silently
 * replaced by a fresh UUID.
 *
 * DSA note
 * ────────
 * The AsyncLocalStorage lookup is O(1) (hash map keyed by async context id).
 * The linear scan for sanitisation is O(k) where k ≤ 128 — effectively
 * constant.
 */
"use strict";

const { v4: uuid } = require("uuid");
const { runWithCorrelationId } = require("../utils/logger");

/** Maximum character length accepted from the X-Correlation-ID header. */
const MAX_CORRELATION_ID_LENGTH = 128;

/**
 * Sanitise a raw header value.  Returns `null` when the value is absent or
 * unsafe so the caller generates a fresh id.
 *
 * @param {string|string[]|undefined} raw
 * @returns {string|null}
 */
function sanitiseCorrelationId(raw) {
  if (!raw) return null;
  // express may give an array for duplicate headers — take the first.
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_CORRELATION_ID_LENGTH) return null;

  // Allow only printable ASCII (excludes newlines, carriage returns, NUL —
  // characters that could break structured log lines or inject extra records).
  // DSA: linear scan O(k), k ≤ MAX_CORRELATION_ID_LENGTH.
  if (/[^\x20-\x7E]/.test(trimmed)) return null;

  return trimmed;
}

/**
 * Express middleware.
 *
 * Reads or generates the correlation id, exposes it on the request object,
 * echoes it in the response header, and runs `next()` inside an
 * AsyncLocalStorage context so all downstream code sees the id.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function correlationIdMiddleware(req, res, next) {
  const correlationId =
    sanitiseCorrelationId(req.headers["x-correlation-id"]) || uuid();

  req.correlationId = correlationId;
  res.setHeader("X-Correlation-ID", correlationId);

  // Run the rest of the request pipeline inside the ALS context so that
  // any code awaited from here (route handlers, command bus, job enqueue)
  // automatically inherits the correlation id.
  runWithCorrelationId(correlationId, next);
}

module.exports = {
  correlationIdMiddleware,
  sanitiseCorrelationId,
  MAX_CORRELATION_ID_LENGTH,
};
