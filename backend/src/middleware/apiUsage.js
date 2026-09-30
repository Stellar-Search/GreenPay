/**
 * Low-cardinality API usage telemetry.
 *
 * Every completed API response increments a process-local operational view and
 * emits the same dimensions as a structured log. The log stream is the durable
 * source for deprecation decisions; the snapshot is for immediate inspection.
 */
"use strict";

const { logger } = require("../utils/logger");
const { apiVersionForPath } = require("../versioning/lifecycle");

const MAX_DIMENSION_LENGTH = 64;
const MAX_SERIES = 1000;
const startedAt = new Date().toISOString();
const counters = new Map();

function cleanDimension(value, fallback = "unknown") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized.length > MAX_DIMENSION_LENGTH) return fallback;
  return /^[a-z0-9][a-z0-9._+-]*$/.test(normalized) ? normalized : fallback;
}

function routeTemplate(req, originalPath = req.path) {
  if (req.route && typeof req.route.path === "string") {
    const base = String(req.baseUrl || "").replace(/\/$/, "");
    const route = req.route.path === "/" ? "" : req.route.path;
    return `${base}${route}` || req.path;
  }

  return String(originalPath || "")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id")
    .replace(/\b[GC][A-Z2-7]{55}\b/g, ":publicKey")
    .replace(/\b[0-9a-f]{64}\b/gi, ":hash")
    .replace(/\/\d+(?=\/|$)/g, "/:id");
}

function usageDimensions(req, res, request = {}) {
  const requestedVersion = request.requestedVersion ?? apiVersionForPath(req.path);
  return {
    apiVersion: requestedVersion === "legacy"
      ? "v1"
      : requestedVersion === "neutral" ? null : requestedVersion,
    requestedVersion,
    clientName: cleanDimension(req.get("X-Client-Name")),
    clientVersion: cleanDimension(req.get("X-Client-Version")),
    clientApiVersion: cleanDimension(req.get("X-Client-API-Version")),
    method: req.method,
    endpoint: routeTemplate(req, request.originalPath),
    statusCode: res.statusCode,
    deprecated: requestedVersion === "legacy",
  };
}

function seriesKey(dimensions) {
  return JSON.stringify(dimensions);
}

function recordUsage(dimensions, log = (fields) => logger.info(fields)) {
  const key = seriesKey(dimensions);
  const existing = counters.get(key);

  if (existing) {
    existing.count += 1;
    existing.lastSeenAt = new Date().toISOString();
  } else if (counters.size < MAX_SERIES) {
    counters.set(key, {
      ...dimensions,
      count: 1,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    });
  } else {
    log({
      msg: "api usage series limit reached",
      event: "api_usage_overflow",
      maximumSeries: MAX_SERIES,
    });
  }

  log({ msg: "api usage", event: "api_request", ...dimensions, count: 1 });
}

function createApiUsageMiddleware(options = {}) {
  const log = options.log || ((fields) => logger.info(fields));
  return (req, res, next) => {
    const request = {
      originalPath: req.path,
      requestedVersion: apiVersionForPath(req.path),
    };
    if (!request.requestedVersion) return next();

    res.once("finish", () => recordUsage(usageDimensions(req, res, request), log));
    next();
  };
}

function getUsageSnapshot() {
  return {
    scope: "process",
    startedAt,
    generatedAt: new Date().toISOString(),
    durableSource: "structured logs where event=api_request",
    series: [...counters.values()].sort((a, b) => b.count - a.count),
  };
}

function resetUsageForTests() {
  counters.clear();
}

module.exports = {
  MAX_SERIES,
  cleanDimension,
  createApiUsageMiddleware,
  getUsageSnapshot,
  recordUsage,
  resetUsageForTests,
  routeTemplate,
  usageDimensions,
};
