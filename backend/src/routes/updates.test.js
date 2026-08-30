"use strict";

const express = require("express");
const request = require("supertest");
const { apiEnvelope, errorHandler } = require("../middleware/apiEnvelope");
const { signToken } = require("../middleware/auth");

jest.mock("../db/pool", () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock("../middleware/rateLimiter", () => ({
  createRateLimiter: () => (req, res, next) => next(),
  createLayeredRateLimiter: () => (req, res, next) => next(),
}));
jest.mock("../services/updateNotifications", () => ({
  dispatchPublicationNotifications: jest.fn().mockResolvedValue(undefined),
  dispatchRemovalNotifications: jest.fn().mockResolvedValue(undefined),
}));

const pool = require("../db/pool");
const {
  dispatchPublicationNotifications,
  dispatchRemovalNotifications,
} = require("../services/updateNotifications");

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const UPDATE_ID = "22222222-2222-2222-2222-222222222222";
const APPEAL_ID = "33333333-3333-3333-3333-333333333333";
const { Keypair } = require("@stellar/stellar-sdk");
const DONOR = Keypair.random().publicKey();
const NOW = "2026-08-28T10:00:00.000Z";

const projectRow = {
  id: PROJECT_ID,
  name: "Reef Cleanup",
  verified: false,
  on_chain_verified: false,
};
const updateRow = {
  id: UPDATE_ID,
  project_id: PROJECT_ID,
  title: "New photos",
  body: "Great progress this month",
  source_language: "en",
  moderation_status: "pending",
  revision: 1,
  created_at: NOW,
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use("/api/updates", require("./updates"));
  app.use(errorHandler);
  return app;
}

function adminToken(subject = "moderator-a") {
  return signToken({ role: "admin", sub: subject }, "1h");
}

function mockTransaction(handler) {
  const client = {
    query: jest.fn(async (sql, params) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      return handler(sql, params);
    }),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValue(client);
  return client;
}

describe("project update moderation lifecycle", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockReset();
    pool.connect.mockReset();
    app = buildApp();
  });

  it("holds a standard project's new update for pre-publication review", async () => {
    const client = mockTransaction(async (sql) => {
      if (sql.includes("FROM projects WHERE")) return { rows: [projectRow] };
      if (sql.includes("INSERT INTO project_updates (")) return { rows: [updateRow] };
      if (sql.includes("INSERT INTO project_update_moderation_events")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });

    const response = await request(app)
      .post("/api/updates")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ projectId: PROJECT_ID, title: "New photos", body: "Great progress this month" });

    expect(response.status).toBe(201);
    expect(response.body.data.moderationStatus).toBe("pending");
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO project_update_moderation_events"),
      expect.arrayContaining(["moderator-a", "project_admin", "created", null, "pending"]),
    );
    expect(dispatchPublicationNotifications).not.toHaveBeenCalled();
  });

  it("shows a fully verified project's update during review but still holds notifications", async () => {
    const trustedRow = { ...projectRow, verified: true, on_chain_verified: true };
    const pendingReview = {
      ...updateRow,
      moderation_status: "published_pending_review",
      published_at: NOW,
    };
    mockTransaction(async (sql) => {
      if (sql.includes("FROM projects WHERE")) return { rows: [trustedRow] };
      if (sql.includes("INSERT INTO project_updates (")) return { rows: [pendingReview] };
      return { rows: [] };
    });

    const response = await request(app)
      .post("/api/updates")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ projectId: PROJECT_ID, title: "New photos", body: "Great progress this month" });

    expect(response.status).toBe(201);
    expect(response.body.data).toEqual(expect.objectContaining({
      moderationStatus: "published_pending_review",
      underReview: true,
    }));
    expect(dispatchPublicationNotifications).not.toHaveBeenCalled();
  });

  it("approves a pending update atomically and queues notifications after commit", async () => {
    const joined = {
      ...updateRow,
      project_name: projectRow.name,
      project_verified: false,
      project_on_chain_verified: false,
    };
    const published = { ...updateRow, moderation_status: "published", published_at: NOW };
    const client = mockTransaction(async (sql) => {
      if (sql.includes("FROM project_updates u JOIN projects")) return { rows: [joined] };
      if (sql.includes("UPDATE project_updates") && sql.includes("RETURNING")) return { rows: [published] };
      return { rows: [] };
    });

    const response = await request(app)
      .post(`/api/updates/${UPDATE_ID}/moderation`)
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ action: "approve", reason: "Claims and supporting evidence were reviewed" });

    expect(response.status).toBe(200);
    expect(response.body.data.moderationStatus).toBe("published");
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining([
      expect.stringContaining("project_update_moderation_events"),
      expect.stringContaining("project_update_reports"),
    ]));
    expect(dispatchPublicationNotifications).toHaveBeenCalledWith({
      project: expect.objectContaining({ id: PROJECT_ID }),
      update: expect.objectContaining({ id: UPDATE_ID }),
    });
  });

  it("queues a correction when a published update is removed", async () => {
    const published = {
      ...updateRow,
      moderation_status: "published",
      published_at: NOW,
      project_name: projectRow.name,
      project_verified: true,
      project_on_chain_verified: true,
    };
    const removed = { ...published, moderation_status: "removed", removed_at: NOW };
    mockTransaction(async (sql) => {
      if (sql.includes("FROM project_updates u JOIN projects")) return { rows: [published] };
      if (sql.includes("UPDATE project_updates") && sql.includes("RETURNING")) return { rows: [removed] };
      return { rows: [] };
    });

    const response = await request(app)
      .post(`/api/updates/${UPDATE_ID}/moderation`)
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ action: "remove", reason: "The material impact claim could not be substantiated" });

    expect(response.status).toBe(200);
    expect(dispatchRemovalNotifications).toHaveBeenCalledWith({
      project: expect.objectContaining({ id: PROJECT_ID }),
      update: expect.objectContaining({ moderationStatus: "removed" }),
      reason: "The material impact claim could not be substantiated",
    });
  });

  it("stores the previous public revision and marks an edit as under review", async () => {
    const current = { ...updateRow, moderation_status: "published", published_at: NOW, revision: 2 };
    const edited = {
      ...current,
      title: "Corrected photos",
      revision: 3,
      edited_at: NOW,
      moderation_status: "published_pending_review",
    };
    const client = mockTransaction(async (sql) => {
      if (sql.includes("SELECT * FROM project_updates")) return { rows: [current] };
      if (sql.includes("UPDATE project_updates") && sql.includes("RETURNING")) return { rows: [edited] };
      return { rows: [] };
    });

    const response = await request(app)
      .patch(`/api/updates/${UPDATE_ID}`)
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ title: "Corrected photos", editReason: "Corrected the field visit date" });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(expect.objectContaining({
      revision: 3,
      isEdited: true,
      underReview: true,
    }));
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO project_update_revisions"),
      expect.arrayContaining([UPDATE_ID, 2, true, "moderator-a"]),
    );
  });

  it("accepts one report from a project donor and does not auto-remove content", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: UPDATE_ID, is_donor: true }] })
      .mockResolvedValueOnce({ rows: [{ id: "report-1", status: "open", created_at: NOW }] });

    const response = await request(app)
      .post(`/api/updates/${UPDATE_ID}/reports`)
      .send({ donorAddress: DONOR, reason: "fraudulent_claim", details: "The reported total conflicts with the public ledger" });

    expect(response.status).toBe(201);
    expect(response.body.data.status).toBe("open");
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[1][0]).toContain("ON CONFLICT (update_id, reporter_address) DO NOTHING");
  });

  it("rejects reports from accounts with no committed donation to the project", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: UPDATE_ID, is_donor: false }] });
    const response = await request(app)
      .post(`/api/updates/${UPDATE_ID}/reports`)
      .send({ donorAddress: DONOR, reason: "spam" });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("DONOR_REQUIRED");
  });

  it("requires a different moderator to decide an appeal", async () => {
    mockTransaction(async (sql) => {
      if (sql.includes("FROM project_update_appeals a")) {
        return { rows: [{
          appeal_id: APPEAL_ID,
          update_id: UPDATE_ID,
          filed_by: "moderator-a",
          prior_status: "removed",
          appeal_status: "pending",
          ...updateRow,
          project_name: projectRow.name,
          project_verified: false,
          project_on_chain_verified: false,
        }] };
      }
      return { rows: [] };
    });
    const response = await request(app)
      .post(`/api/updates/appeals/${APPEAL_ID}/decision`)
      .set("Authorization", `Bearer ${adminToken("moderator-a")}`)
      .send({ outcome: "granted", reason: "A second review found the evidence sufficient" });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("INDEPENDENT_REVIEW_REQUIRED");
  });

  it("filters the donor feed to published and published-under-review states", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{
      ...updateRow,
      moderation_status: "published_pending_review",
      published_at: NOW,
    }] });
    const response = await request(app).get(`/api/updates/${PROJECT_ID}`);
    expect(response.status).toBe(200);
    expect(pool.query.mock.calls[0][0]).toContain("u.moderation_status = ANY($2::text[])");
    expect(pool.query.mock.calls[0][1][1]).toEqual(["published", "published_pending_review"]);
    expect(response.body.data[0].underReview).toBe(true);
  });
});
