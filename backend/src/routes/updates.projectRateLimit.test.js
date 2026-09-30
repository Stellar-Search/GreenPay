"use strict";

const express = require("express");
const request = require("supertest");
const { apiEnvelope, errorHandler } = require("../middleware/apiEnvelope");
const { signToken } = require("../middleware/auth");

jest.mock("../db/pool", () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock("../services/updateNotifications", () => ({
  dispatchPublicationNotifications: jest.fn().mockResolvedValue(undefined),
  dispatchRemovalNotifications: jest.fn().mockResolvedValue(undefined),
}));

const pool = require("../db/pool");

const PROJECT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_B = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use("/api/updates", require("./updates"));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  let serial = 0;
  pool.connect.mockImplementation(async () => ({
    release: jest.fn(),
    query: jest.fn(async (sql, params) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (sql.includes("FROM projects WHERE")) {
        return { rows: [{ id: params[0], name: "Project", verified: false, on_chain_verified: false }] };
      }
      if (sql.includes("INSERT INTO project_updates (")) {
        serial += 1;
        return { rows: [{
          id: `00000000-0000-0000-0000-${String(serial).padStart(12, "0")}`,
          project_id: params[1],
          title: params[2],
          body: params[3],
          source_language: "en",
          moderation_status: "pending",
          revision: 1,
          created_at: "2026-08-28T10:00:00.000Z",
        }] };
      }
      return { rows: [] };
    }),
  }));
});

it("limits creation per project even when another project still has capacity", async () => {
  const app = buildApp();
  const token = signToken({ role: "admin", sub: "rate-limit-admin" }, "1h");
  const post = (projectId) => request(app)
    .post("/api/updates")
    .set("Authorization", `Bearer ${token}`)
    .send({ projectId, title: "Progress", body: "A bounded project update" });

  expect((await post(PROJECT_A)).status).toBe(201);
  expect((await post(PROJECT_A)).status).toBe(201);
  expect((await post(PROJECT_A)).status).toBe(201);
  const limited = await post(PROJECT_A);
  expect(limited.status).toBe(429);
  expect(limited.body.error.code).toBe("RATE_LIMITED");

  expect((await post(PROJECT_B)).status).toBe(201);
});
