/**
 * src/server.js — Stellar GreenPay API
 */
"use strict";

const express = require("express");
const cookieParser = require("cookie-parser");
const csurf = require("csurf");
const helmet = require("helmet");
require("dotenv").config();

// MUST be first: validate all environment variables or exit
const { env } = require("./config/env");

const { runMigrations } = require("./db/migrate");
const { startTurretsServer } = require("./services/turrets");
const http = require("http");
const { Server } = require("socket.io");
const { startIndexer, stopIndexer } = require("./services/indexerService");
const { createCorsMiddleware, getAllowedOrigins } = require("./middleware/corsPolicy");
const { correlationIdMiddleware } = require("./middleware/correlationId");
const { apiEnvelope, errorHandler, notFoundHandler } = require("./middleware/apiEnvelope");
const { initializeEventSourcing, shutdownEventSourcing } = require("./eventSourcing");
const pool = require("./db/pool");
const { createShutdownHandler } = require("./shutdown");
const { logger } = require("./utils/logger");

const app = express();
const server = http.createServer(app);

// Behind the nginx ingress controller (or any proxy) Express must be told to
// trust the proxy chain before req.ip reflects the real client: X-Forwarded-For
// is ignored otherwise, every request looks like it comes from the proxy, and
// every IP-keyed rate-limit bucket collapses to one shared counter. Kept off by
// default so local dev can't spoof headers; deployments set TRUST_PROXY=true
// and TRUST_PROXY_HOPS to match their topology (see helm configmap). A number
// of hops (not `true`) is deliberate — see express-rate-limit's
// ERR_ERL_PERMISSIVE_TRUST_PROXY.
app.set("trust proxy", env.trustProxy ? env.trustProxyHops : false);
// Kubernetes sends SIGTERM (not SIGINT) to terminate pods during rolling
// deploys, HPA scale-down, or node drains — keep this below the pod's
// terminationGracePeriodSeconds (see k8s/backend.yaml) so the process has
// time to exit on its own before the kubelet sends SIGKILL.
const SHUTDOWN_TIMEOUT_MS = env.shutdownTimeoutMs;

// ── Swagger UI (development) ─────────────────────────────────────────────────
if (!env.isProduction) {
  try {
    const swaggerUi = require("swagger-ui-express");
    const yaml = require("js-yaml");
    const fs = require("fs");
    const path = require("path");
    const openApiPath = path.join(__dirname, "../../docs/openapi.yml");
    if (fs.existsSync(openApiPath)) {
      const swaggerDoc = yaml.load(fs.readFileSync(openApiPath, "utf8"));
      app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(swaggerDoc));
    }
  } catch (err) {
    console.warn("[Swagger UI] Skipping Swagger UI initialization:", err.message);
  }
}

app.use(helmet());

// Correlation-ID must be the first custom middleware so that the
// AsyncLocalStorage context is established before any route handler,
// including the structured access log below, executes.
app.use(correlationIdMiddleware);

// Structured access log — replaces morgan("dev") so every request
// record carries the same JSON shape as all other log output.
app.use((req, _res, next) => {
  logger.info({ msg: "request", method: req.method, path: req.path });
  next();
});

app.use(express.json({ limit: "20kb" }));
app.use(cookieParser());

// CORS must run before CSRF validation so that a CSRF rejection still carries
// Access-Control-Allow-Origin — otherwise browsers report a same-origin-looking
// 403 as an opaque "blocked by CORS policy" failure instead of the real error.
const origins = getAllowedOrigins();
app.use(apiEnvelope);
app.use(...createCorsMiddleware(origins));

app.use(csurf({
  cookie: {
    httpOnly: true,
    // SameSite=None requires Secure, or browsers drop the cookie outright.
    // Only production serves over HTTPS, so keep them tied together —
    // otherwise every CSRF-protected request silently fails everywhere else.
    secure: env.isProduction,
    sameSite: env.isProduction ? "none" : "lax",
    path: "/",
  },
  ignoreMethods: ["GET", "HEAD", "OPTIONS"],
}));

const io = new Server(server, {
  cors: {
    origin: origins,
    methods: ["GET", "POST"],
    credentials: false,
  }
});
app.set("io", io);
// Removed generic app-wide rate limiter — each mutating endpoint now has
// a dedicated limiter appropriate to its abuse profile (see individual route files).

// ── API versioning ───────────────────────────────────────────────────────────
// All routes are served under the `/api/v1` prefix. Legacy unversioned `/api/*`
// requests are redirected to their `/api/v1/*` equivalent with a `Deprecation`
// header so existing clients keep working. See docs/api.md for the policy.
const API_V1 = "/api/v1";

app.get(`${API_V1}/csrf-token`, (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});

app.get("/livez", (req, res) => res.json({ status: "ok" }));
app.use("/health",                  require("./routes/health"));
app.use(`${API_V1}/projects`,       require("./routes/projects"));
app.use(`${API_V1}/donations`,      require("./routes/donations"));
app.use(`${API_V1}/profiles`,       require("./routes/profiles"));
app.use(`${API_V1}/leaderboard`,    require("./routes/leaderboard"));
app.use(`${API_V1}/updates`,        require("./routes/updates"));
app.use(`${API_V1}/subscriptions`,  require("./routes/subscriptions"));
app.use(`${API_V1}/jobs`,           require("./routes/jobs"));
app.use(`${API_V1}/stats`,          require("./routes/stats"));
app.use(`${API_V1}/impact`,         require("./routes/impact"));
app.use(`${API_V1}/ratings`,        require("./routes/ratings"));
app.use(`${API_V1}/notifications`,  require("./routes/notifications"));
app.use(`${API_V1}/admin`,          require("./routes/admin"));
app.use(`${API_V1}/network`,        require("./routes/network"));
app.use(`${API_V1}/meta`,           require("./routes/meta"));

// Legacy unversioned routes → redirect to /api/v1 with a deprecation notice.
app.use("/api", (req, res, next) => {
  // Already-versioned and Swagger UI requests are handled elsewhere.
  if (req.path === "/v1" || req.path.startsWith("/v1/") ||
      req.path === "/docs" || req.path.startsWith("/docs/")) {
    return next();
  }
  res.set("Deprecation", "true");
  res.set("Link", `<${API_V1}>; rel="successor-version"`);
  // 308 preserves the request method and body for non-GET clients.
  // req.url is relative to the "/api" mount and retains the query string.
  return res.redirect(308, `${API_V1}${req.url}`);
});

app.use(notFoundHandler);
app.use(errorHandler);

async function startServer() {
  await runMigrations();

  await initializeEventSourcing();

  const { start: startSummaryQueue } = require("./services/summaryQueue");
  await startSummaryQueue(io);

  const { start: startPushReceiptQueue } = require("./services/push");
  await startPushReceiptQueue();

  startIndexer(io).catch(err =>
    logger.error({ msg: "indexer startup error", error: err.message })
  );

  server.listen(env.port, () => {
    logger.info({
      msg: "server started",
      port: env.port,
      network: env.stellarNetwork,
    });
  });

  if (env.enableTurrets) {
    const turretsPort = env.turretsPort;
    startTurretsServer(turretsPort);
  }
}

const gracefulShutdown = createShutdownHandler({
  server,
  pool,
  shutdownEventSourcing,
  stopIndexer,
  timeoutMs: SHUTDOWN_TIMEOUT_MS,
});

if (require.main === module) {
  startServer().catch((err) => {
    logger.error({ msg: "startup error", error: err.message });
    process.exit(1);
  });

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
}

module.exports = app;
module.exports.gracefulShutdown = gracefulShutdown;
