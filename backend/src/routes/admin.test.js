"use strict";
const express = require("express");
const request = require("supertest");
const { signToken, adminRequired } = require("../middleware/auth");
const { apiEnvelope, errorHandler } = require("../middleware/apiEnvelope");

jest.mock("../middleware/rateLimiter", () => ({
  createRateLimiter: () => (req, res, next) => next(),
  createLayeredRateLimiter: () => (req, res, next) => next(),
}));

jest.mock("../middleware/progressiveDelay", () => ({
  createProgressiveDelay: () => (req, res, next) => next(),
}));

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

jest.mock("../services/summaryQueue", () => ({
  enqueueAISummary: jest.fn().mockResolvedValue("job-id"),
}));

process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "testpass";
process.env.JWT_SECRET = "test-secret-for-jest";

const pool = require("../db/pool");
const { enqueueAISummary } = require("../services/summaryQueue");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use("/api/admin", require("./admin"));
  app.use(errorHandler);
  return app;
}

function adminToken() {
  return signToken({ role: "admin", sub: "admin" }, "1h");
}

describe("GET /api/admin/api-usage", () => {
  it("requires an admin session and returns bounded adoption series metadata", async () => {
    await request(buildApp()).get("/api/admin/api-usage").expect(401);

    const response = await request(buildApp())
      .get("/api/admin/api-usage")
      .set("Authorization", `Bearer ${adminToken()}`)
      .expect(200);

    expect(response.body.data).toEqual(expect.objectContaining({
      scope: "process",
      startedAt: expect.any(String),
      generatedAt: expect.any(String),
      durableSource: "structured logs where event=api_request",
      series: expect.any(Array),
    }));
  });
});

describe("POST /api/admin/login", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  it("returns 400 when no credentials are sent (schema validation)", async () => {
    const res = await request(app).post("/api/admin/login").send({});
    expect(res.status).toBe(400);
  });

  it("returns 401 for wrong username", async () => {
    const res = await request(app).post("/api/admin/login").send({ username: "wrong", password: "testpass" });
    expect(res.status).toBe(401);
  });

  it("returns 401 for wrong password", async () => {
    const res = await request(app).post("/api/admin/login").send({ username: "admin", password: "wrongpass" });
    expect(res.status).toBe(401);
  });

  it("returns a token and refreshToken for valid credentials", async () => {
    const res = await request(app).post("/api/admin/login").send({ username: "admin", password: "testpass" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.refreshToken).toBeDefined();
    expect(res.body.data.expiresIn).toBe(3600);
  });

  it("returns 503 when ADMIN_PASSWORD is not configured", async () => {
    const saved = process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_PASSWORD;

    // config/env validates and freezes the environment the first time it is
    // required, so clearing the variable on an already-built router has no
    // effect. Rebuild it in a fresh module registry to observe the change.
    let unconfiguredApp;
    jest.isolateModules(() => {
      const { apiEnvelope: envelope, errorHandler: handler } = require("../middleware/apiEnvelope");
      unconfiguredApp = express();
      unconfiguredApp.use(express.json());
      unconfiguredApp.use(envelope);
      unconfiguredApp.use("/api/admin", require("./admin"));
      unconfiguredApp.use(handler);
    });

    const res = await request(unconfiguredApp)
      .post("/api/admin/login")
      .send({ username: "admin", password: "testpass" });
    expect(res.status).toBe(503);

    process.env.ADMIN_PASSWORD = saved;
  });
});

describe("POST /api/admin/refresh", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  it("returns 400 when no refreshToken is sent", async () => {
    const res = await request(app).post("/api/admin/refresh").send({});
    expect(res.status).toBe(400);
  });

  it("returns 401 for invalid refresh token", async () => {
    const res = await request(app).post("/api/admin/refresh").send({ refreshToken: "bogus" });
    expect(res.status).toBe(401);
  });

  it("returns a new token for a valid refresh token", async () => {
    const loginRes = await request(app).post("/api/admin/login").send({ username: "admin", password: "testpass" });
    const refreshToken = loginRes.body.data.refreshToken;

    const res = await request(app).post("/api/admin/refresh").send({ refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.expiresIn).toBe(3600);
  });
});

describe("GET /api/admin/me", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  it("returns 401 without Authorization header", async () => {
    const res = await request(app).get("/api/admin/me");
    expect(res.status).toBe(401);
  });

  it("returns 401 with malformed Authorization header", async () => {
    const res = await request(app).get("/api/admin/me").set("Authorization", "NotBearer token");
    expect(res.status).toBe(401);
  });

  it("returns 401 with expired token", async () => {
    const expired = signToken({ role: "admin" }, "0s");
    await new Promise((r) => setTimeout(r, 100));
    const res = await request(app).get("/api/admin/me").set("Authorization", `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it("returns admin info with valid token", async () => {
    const loginRes = await request(app).post("/api/admin/login").send({ username: "admin", password: "testpass" });
    const token = loginRes.body.data.token;

    const res = await request(app).get("/api/admin/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.username).toBe("admin");
    expect(res.body.data.role).toBe("admin");
  });
});

describe("GET /api/admin/ai-summary-failures", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it("returns 401 without a valid admin token", async () => {
    const res = await request(app).get("/api/admin/ai-summary-failures");
    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("returns the paginated list of failed jobs for an authorized admin", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "failure-1",
            project_id: "project-1",
            payload: { name: "Reef Cleanup" },
            error_message: "content policy rejection",
            error_stack: "Error: content policy rejection",
            status: "failed",
            created_at: new Date("2026-01-01T00:00:00Z"),
            resolved_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ total: "1" }] });

    const res = await request(app)
      .get("/api/admin/ai-summary-failures")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      id: "failure-1",
      projectId: "project-1",
      errorMessage: "content policy rejection",
      status: "failed",
    });
    expect(res.body.meta.pagination.total).toBe(1);
  });
});

describe("POST /api/admin/ai-summary-failures/:id/retry", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it("returns 401 without a valid admin token", async () => {
    const res = await request(app).post("/api/admin/ai-summary-failures/failure-1/retry");
    expect(res.status).toBe(401);
    expect(enqueueAISummary).not.toHaveBeenCalled();
  });

  it("returns 404 when the failure record does not exist", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/api/admin/ai-summary-failures/missing/retry")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(404);
    expect(enqueueAISummary).not.toHaveBeenCalled();
  });

  it("re-enqueues via enqueueAISummary and marks the failure retried for an authorized admin", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: "failure-1", project_id: "project-1", payload: { name: "Reef Cleanup" }, status: "failed" }],
      })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE ... SET status = 'retried'

    const res = await request(app)
      .post("/api/admin/ai-summary-failures/failure-1/retry")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(enqueueAISummary).toHaveBeenCalledWith("project-1", { name: "Reef Cleanup" });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'retried'"),
      ["failure-1"],
    );
  });

  it("rejects retrying a failure that was already retried", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "failure-1", project_id: "project-1", payload: {}, status: "retried" }],
    });

    const res = await request(app)
      .post("/api/admin/ai-summary-failures/failure-1/retry")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(409);
    expect(enqueueAISummary).not.toHaveBeenCalled();
  });
});

describe("adminRequired middleware", () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(apiEnvelope);
    app.get("/protected", adminRequired, (req, res) => res.json({ ok: true, user: req.admin }));
    app.use(errorHandler);
  });

  it("allows requests with valid token", async () => {
    const token = signToken({ role: "admin", sub: "admin" }, "1h");
    const res = await request(app).get("/protected").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe("GET /api/admin/audit pagination", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it("counts the filtered set, not what remains after the cursor", async () => {
    const { encodeCursor } = require("../utils/pagination");
    const cursor = encodeCursor({
      createdAt: "2026-01-02T00:00:00.000Z",
      id: "11111111-1111-1111-1111-111111111111",
    });

    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "500" }] });

    const res = await request(app)
      .get("/api/admin/audit")
      .query({ actor: "admin", cursor })
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);

    const [dataSql, dataValues] = pool.query.mock.calls[0];
    const [countSql, countValues] = pool.query.mock.calls[1];

    // The page query seeks past the cursor.
    expect(dataSql).toMatch(/\(created_at, id\) < \(\$2::timestamptz, \$3::uuid\)/);
    expect(dataValues).toEqual(["admin", "2026-01-02T00:00:00.000Z", "11111111-1111-1111-1111-111111111111", 51]);

    // The count must not, or `total` would shrink on every page fetched.
    expect(countSql).not.toMatch(/created_at/);
    expect(countSql).toMatch(/WHERE actor = \$1/);
    expect(countValues).toEqual(["admin"]);
    expect(res.body.meta.pagination.total).toBe(500);
  });

  it("keeps the count stable across successive cursor pages", async () => {
    const { encodeCursor } = require("../utils/pagination");

    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "500" }] });

    const first = await request(app)
      .get("/api/admin/audit")
      .set("Authorization", `Bearer ${adminToken()}`);

    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "500" }] });

    const second = await request(app)
      .get("/api/admin/audit")
      .query({
        cursor: encodeCursor({
          createdAt: "2026-01-02T00:00:00.000Z",
          id: "11111111-1111-1111-1111-111111111111",
        }),
      })
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(first.body.meta.pagination.total).toBe(500);
    expect(second.body.meta.pagination.total).toBe(500);
    expect(pool.query.mock.calls[3][0]).toBe(pool.query.mock.calls[1][0]);
  });
});
