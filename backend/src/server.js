/**
 * src/server.js — Stellar GreenPay API
 */
"use strict";

const express   = require("express");
const cookieParser = require("cookie-parser");
const csurf     = require("csurf");
const helmet    = require("helmet");
const morgan    = require("morgan");
require("dotenv").config();
const { runMigrations } = require("./db/migrate");
const { startTurretsServer } = require("./services/turrets");
const http = require("http");
const { Server } = require("socket.io");
const { startIndexer, stopIndexer } = require("./services/indexerService");
const { createCorsMiddleware, getAllowedOrigins } = require("./middleware/corsPolicy");
const { initializeEventSourcing, shutdownEventSourcing } = require("./eventSourcing");
const pool = require("./db/pool");
const { createShutdownHandler } = require("./shutdown");

const app  = express();
const PORT = process.env.PORT || 4000;
const server = http.createServer(app);
// Kubernetes sends SIGTERM (not SIGINT) to terminate pods during rolling
// deploys, HPA scale-down, or node drains — keep this below the pod's
// terminationGracePeriodSeconds (see k8s/backend.yaml) so the process has
// time to exit on its own before the kubelet sends SIGKILL.
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 25000;

// ── Swagger UI (development) ─────────────────────────────────────────────────
if (process.env.NODE_ENV !== "production") {
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
app.use(morgan("dev"));
app.use(express.json({ limit: "20kb" }));
app.use(cookieParser());

// CORS must run before CSRF validation so that a CSRF rejection still carries
// Access-Control-Allow-Origin — otherwise browsers report a same-origin-looking
// 403 as an opaque "blocked by CORS policy" failure instead of the real error.
const origins = getAllowedOrigins();
app.use(...createCorsMiddleware(origins));

app.use(csurf({
  cookie: {
    httpOnly: true,
    // SameSite=None requires Secure, or browsers drop the cookie outright.
    // Only production serves over HTTPS, so keep them tied together —
    // otherwise every CSRF-protected request silently fails everywhere else.
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
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
  res.json({ success: true, csrfToken: req.csrfToken() });
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

app.use((req, res) => res.status(404).json({ error: `${req.method} ${req.path} not found` }));
app.use((err, req, res, next) => {
  void next;
  console.error("[Error]", err.message);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

async function startServer() {
  await runMigrations();

  await initializeEventSourcing();

  const { start: startSummaryQueue } = require("./services/summaryQueue");
  await startSummaryQueue(io);

  const { start: startPushReceiptQueue } = require("./services/push");
  await startPushReceiptQueue();

  startIndexer(io).catch(err => console.error("[Indexer Error]", err.message));

  server.listen(PORT, () => {
    console.log(`\n  🌱 Stellar GreenPay API\n  🚀 Running at http://localhost:${PORT}\n  🌐 Network: ${process.env.STELLAR_NETWORK || "testnet"}\n`);
  });

  if (process.env.ENABLE_TURRETS === "true") {
    const turretsPort = process.env.TURRETS_PORT || 3001;
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
    console.error("[Startup Error]", err.message);
    process.exit(1);
  });

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
}

module.exports = app;
module.exports.gracefulShutdown = gracefulShutdown;
