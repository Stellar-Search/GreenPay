/**
 * API lifecycle configuration and mounting helpers.
 *
 * Version-specific HTTP concerns stay here while route modules continue to
 * own domain behaviour. A new major version can either mount a parallel
 * router or adapt a prior version at an explicit route boundary.
 */
"use strict";

const express = require("express");

const API_V1 = "/api/v1";
const API_V2 = "/api/v2";
const LEGACY_API = "/api";
const LEGACY_SUNSET_ISO = "2030-12-31T23:59:59.000Z";
const LEGACY_SUNSET_HTTP = new Date(LEGACY_SUNSET_ISO).toUTCString();
const CHANGELOG_PATH = "/api/versions/changelog";

const VERSION_CATALOG = Object.freeze([
  Object.freeze({
    version: "v1",
    status: "stable",
    basePath: API_V1,
    introducedAt: "2025-01-01",
    deprecated: false,
    sunset: null,
  }),
  Object.freeze({
    version: "v2",
    status: "experimental",
    basePath: API_V2,
    introducedAt: "2026-08-28",
    deprecated: false,
    sunset: null,
    scope: ["GET /api/v2/meta"],
  }),
]);

const CHANGELOG = Object.freeze([
  Object.freeze({
    date: "2026-08-28",
    version: "v1",
    kind: "compatible",
    summary: "Published the API lifecycle policy, client usage telemetry, and version discovery endpoint.",
  }),
  Object.freeze({
    date: "2026-08-28",
    version: "v2",
    kind: "preview",
    summary: "Added GET /api/v2/meta as the worked concurrent-version adapter example.",
  }),
  Object.freeze({
    date: "2026-08-28",
    version: "legacy",
    kind: "deprecation",
    summary: "Committed to the unversioned compatibility redirect through at least 2030-12-31 and until its observed-usage removal gates pass.",
  }),
]);

function assertRouteDefinition(definition) {
  if (!definition || typeof definition.path !== "string" || !definition.path.startsWith("/")) {
    throw new TypeError("Versioned route definitions need an absolute path");
  }
  if (typeof definition.router !== "function") {
    throw new TypeError(`Versioned route ${definition.path} needs an Express router`);
  }
  if (definition.transform !== undefined && typeof definition.transform !== "function") {
    throw new TypeError(`Versioned route ${definition.path} transform must be a function`);
  }
}

function transformJson(transform) {
  return (_req, res, next) => {
    const sendJson = res.json.bind(res);
    res.json = (body) => sendJson(transform(body));
    next();
  };
}

/**
 * Mount every route belonging to one major version. An optional transform is
 * deliberately scoped to one mount so a v2 representation cannot leak into
 * v1 when both versions reuse the same domain router.
 */
function mountApiVersion(app, version, definitions) {
  if (!/^v[1-9][0-9]*$/.test(version)) {
    throw new TypeError(`Invalid API version: ${version}`);
  }

  const prefix = `/api/${version}`;
  for (const definition of definitions) {
    assertRouteDefinition(definition);
    const middleware = definition.transform
      ? [transformJson(definition.transform), definition.router]
      : [definition.router];
    app.use(`${prefix}${definition.path}`, ...middleware);
  }
}

function apiVersionForPath(requestPath) {
  if (requestPath === "/api/versions" || String(requestPath || "").startsWith("/api/versions/")) {
    return "neutral";
  }
  const match = String(requestPath || "").match(/^\/api\/(v[1-9][0-9]*)(?:\/|$)/);
  if (match) return match[1];
  if (requestPath === LEGACY_API || String(requestPath || "").startsWith(`${LEGACY_API}/`)) {
    return "legacy";
  }
  return null;
}

function apiVersionHeaders(req, res, next) {
  const version = apiVersionForPath(req.path);
  if (version && /^v[1-9][0-9]*$/.test(version)) {
    res.set("X-API-Version", version.slice(1));
  }
  next();
}

function lifecycleDocument() {
  return {
    current: "v1",
    policy: "/docs/api-versioning-policy.md",
    changelog: CHANGELOG_PATH,
    versions: VERSION_CATALOG,
    legacy: {
      basePath: LEGACY_API,
      status: "deprecated",
      successor: API_V1,
      sunset: LEGACY_SUNSET_ISO,
      commitment: "The redirect remains available through the stated date and longer unless every usage gate passes.",
      removalGates: {
        observationDays: 90,
        maximumRequestSharePercent: 0.1,
        activeOfficialClientVersions: 0,
        minimumNoticeDaysAfterDecision: 180,
      },
    },
    clientIdentification: {
      nameHeader: "X-Client-Name",
      versionHeader: "X-Client-Version",
      supportedApiHeader: "X-Client-API-Version",
    },
  };
}

function createLifecycleRouter() {
  const router = express.Router();

  router.get("/", (_req, res) => {
    res.set("Cache-Control", "public, max-age=300");
    res.json(lifecycleDocument());
  });

  router.get("/changelog", (_req, res) => {
    res.set("Cache-Control", "public, max-age=300");
    res.json({ entries: CHANGELOG });
  });

  return router;
}

function setLegacyDeprecationHeaders(res) {
  res.set("Deprecation", "true");
  res.set("Sunset", LEGACY_SUNSET_HTTP);
  res.set("X-API-Version", "1");
  res.set(
    "Link",
    `<${API_V1}>; rel="successor-version", <${CHANGELOG_PATH}>; rel="deprecation"; type="application/json"`,
  );
}

function legacyRedirect(req, res, next) {
  if (req.path === "/v1" || req.path.startsWith("/v1/") ||
      req.path === "/v2" || req.path.startsWith("/v2/") ||
      req.path === "/docs" || req.path.startsWith("/docs/") ||
      req.path === "/versions" || req.path.startsWith("/versions/")) {
    return next();
  }

  setLegacyDeprecationHeaders(res);
  return res.redirect(308, `${API_V1}${req.url}`);
}

module.exports = {
  API_V1,
  API_V2,
  CHANGELOG,
  CHANGELOG_PATH,
  LEGACY_API,
  LEGACY_SUNSET_HTTP,
  LEGACY_SUNSET_ISO,
  VERSION_CATALOG,
  apiVersionForPath,
  apiVersionHeaders,
  createLifecycleRouter,
  legacyRedirect,
  lifecycleDocument,
  mountApiVersion,
  setLegacyDeprecationHeaders,
  transformJson,
};
