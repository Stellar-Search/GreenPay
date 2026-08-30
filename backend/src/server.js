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
const { createApiUsageMiddleware } = require("./middleware/apiUsage");
const {
  API_V1,
  apiVersionHeaders,
  createLifecycleRouter,
  legacyRedirect,
  mountApiVersion,
} = require("./versioning/lifecycle");
const { metaV1ToV2 } = require("./versioning/metaV2");

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
app.use(apiVersionHeaders);
app.use(createApiUsageMiddleware());

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

// Redirect the legacy surface before CSRF validation. The 308 does not mutate
// state, and doing it here lets an old POST client reach v1 first and then use
// the v1 CSRF flow instead of receiving an unrelated 403 with no lifecycle
// headers.
app.use("/api", legacyRedirect);

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
// Cross-replica delivery is attached in startServer(), once the process is
// actually serving. Until then `io.emit` reaches only this instance's clients
// — see src/realtime/index.js for why that matters at two or more replicas.
// Removed generic app-wide rate limiter — each mutating endpoint now has
// a dedicated limiter appropriate to its abuse profile (see individual route files).

// ── API versioning ───────────────────────────────────────────────────────────
// Stable routes are served under `/api/v1`; isolated previews can be mounted
// concurrently under a later major prefix. Legacy unversioned `/api/*`
// requests redirect to v1 with full lifecycle signalling. See docs/api.md.
app.get(`${API_V1}/csrf-token`, (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});

app.get("/livez", (req, res) => res.json({ status: "ok" }));
app.use("/health",                  require("./routes/health"));
const metaRouter = require("./routes/meta");

mountApiVersion(app, "v1", [
  { path: "/projects", router: require("./routes/projects") },
  { path: "/donations", router: require("./routes/donations") },
  { path: "/profiles", router: require("./routes/profiles") },
  { path: "/leaderboard", router: require("./routes/leaderboard") },
  { path: "/updates", router: require("./routes/updates") },
  { path: "/subscriptions", router: require("./routes/subscriptions") },
  { path: "/jobs", router: require("./routes/jobs") },
  { path: "/stats", router: require("./routes/stats") },
  { path: "/impact", router: require("./routes/impact") },
  { path: "/integrity", router: require("./routes/integrity") },
  { path: "/ratings", router: require("./routes/ratings") },
  { path: "/notifications", router: require("./routes/notifications") },
  { path: "/admin", router: require("./routes/admin") },
  { path: "/network", router: require("./routes/network") },
  { path: "/meta", router: metaRouter },
  { path: "/realtime", router: require("./routes/realtime") },
  { path: "/onboarding", router: require("./routes/onboarding") },
]);

// A deliberately small v2 preview proves that two representations can run at
// once. It reuses v1 domain data and adapts only the external metadata shape.
mountApiVersion(app, "v2", [
  { path: "/meta", router: metaRouter, transform: metaV1ToV2 },
]);

// Version-neutral discovery remains stable even while major versions change.
app.use("/api/versions", createLifecycleRouter());

app.use(notFoundHandler);
app.use(errorHandler);

async function startServer() {
  await runMigrations();

  await initializeEventSourcing();

  // Before anything can emit: the indexer and the donation route both
  // broadcast, and a broadcast made before the adapter is attached would reach
  // only this pod's clients.
  const { initializeRealtime } = require("./realtime");
  await initializeRealtime(io);

  const { start: startSummaryQueue } = require("./services/summaryQueue");
  await startSummaryQueue(io);

  const { start: startPushReceiptQueue } = require("./services/push");
  await startPushReceiptQueue();

  const { start: startEmailNotifyQueue } = require("./services/email");
  await startEmailNotifyQueue();

  startIndexer(io).catch(err =>
    logger.error({ msg: "indexer startup error", error: err.message })
  );

  // Onboarding housekeeping: sponsorship offers that were never co-signed hold
  // treasury capacity, and funnel sessions left open forever inflate the
  // conversion rate by counting people who left as still deciding. Both sweeps
  // are idempotent and cheap, so a missed tick costs nothing.
  const { startOnboardingMaintenance } = require("./services/onboarding/maintenance");
  startOnboardingMaintenance();

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
  shutdownRealtime: () => require("./realtime").shutdownRealtime(),
  stopOnboardingMaintenance: () => require("./services/onboarding/maintenance").stopOnboardingMaintenance(),
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
