"use strict";
const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const { Keypair } = require("@stellar/stellar-sdk");
const { signToken } = require("../middleware/auth");
const { apiEnvelope, errorHandler } = require("../middleware/apiEnvelope");

process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "testpass";
process.env.JWT_SECRET = "test-secret-for-jest";

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const WALLET_ADDRESS = Keypair.random().publicKey();

function makeProjectRow(overrides = {}) {
  return {
    id: PROJECT_ID,
    name: "Reforest the Delta",
    description: "desc",
    category: "Reforestation",
    location: "Delta",
    wallet_address: WALLET_ADDRESS,
    goal_xlm: "1000",
    raised_xlm: "0",
    donor_count: 0,
    co2_offset_kg: 0,
    status: "paused",
    rejection_reason: null,
    verified: false,
    on_chain_verified: false,
    verification_expires_at: null,
    verification_revoked_at: null,
    verification_revocation_reason: null,
    verification_decision_tx_hash: null,
    verification_decision_contract_id: null,
    tags: [],
    ai_summary: null,
    ai_summary_generated_at: null,
    ai_summary_model: null,
    ai_summary_source_hash: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeVerificationApplicationRow(overrides = {}) {
  return {
    id: "application-1",
    project_id: PROJECT_ID,
    submitted_by_wallet: WALLET_ADDRESS,
    status: "wallet_proof_pending",
    attestation_summary: "Independent climate documentation and wallet ownership attested for review.",
    wallet_challenge_expires_at: null,
    wallet_verified_at: null,
    submitted_at: new Date().toISOString(),
    community_vote_opens_at: null,
    community_vote_closes_at: null,
    approved_at: null,
    expires_at: null,
    revoked_at: null,
    revocation_reason: null,
    decision_tx_hash: null,
    decision_contract_id: null,
    latest_rationale: null,
    evidence_count: 0,
    proof_count: 0,
    attestation_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/** searchProjects issues one listing query plus six facet aggregations. */
function mockProjectListingQueries(listingRows) {
  pool.query
    .mockResolvedValueOnce({ rows: listingRows })
    .mockResolvedValueOnce({ rows: [{ count: listingRows.length }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] });
}

jest.mock("../services/audit", () => ({
  logAdminAction: jest.fn(),
}));

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

jest.mock("../services/stellar", () => ({
  getOnChainProject: jest.fn(),
}));

const pool = require("../db/pool");
const { logAdminAction } = require("../services/audit");
const { getOnChainProject } = require("../services/stellar");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use("/api/projects", require("./projects"));
  app.use(errorHandler);
  return app;
}

describe("PATCH /api/projects/:id/status", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    pool.query.mockReset();
    logAdminAction.mockReset();
    getOnChainProject.mockReset();
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes("SELECT * FROM projects")) {
        return { rows: [makeProjectRow()] };
      }
      if (sql.includes("UPDATE projects")) {
        return { rows: [makeProjectRow({ status: "active" })] };
      }
      return { rows: [] };
    });
  });

  it("rejects a request with no Authorization header and no adminAddress at all", async () => {
    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}/status`)
      .send({ status: "active" });

    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("rejects a request with no Authorization header and an arbitrary spoofed adminAddress", async () => {
    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}/status`)
      .send({ status: "active", adminAddress: Keypair.random().publicKey() });

    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("rejects a request whose adminAddress exactly matches the project's public wallet_address, absent a real token", async () => {
    // wallet_address is public (shown on the project's own page), so an attacker
    // can always supply this exact value. It must not grant anything on its own.
    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}/status`)
      .send({ status: "active", adminAddress: WALLET_ADDRESS });

    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("rejects a well-formed but unsigned-by-us token", async () => {
    const forgedToken = jwt.sign({ role: "admin", sub: "admin" }, "some-other-secret", { expiresIn: "1h" });

    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}/status`)
      .set("Authorization", `Bearer ${forgedToken}`)
      .send({ status: "active", adminAddress: WALLET_ADDRESS });

    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("rejects an expired admin token", async () => {
    const expired = signToken({ role: "admin", sub: "admin" }, "0s");
    await new Promise((r) => setTimeout(r, 100));

    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}/status`)
      .set("Authorization", `Bearer ${expired}`)
      .send({ status: "active" });

    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("allows a valid admin JWT to change status, and records the verified admin as actor rather than any client-supplied adminAddress", async () => {
    const token = signToken({ role: "admin", sub: "admin" }, "1h");
    const fakeAdmin = Keypair.random().publicKey();

    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "active", adminAddress: fakeAdmin });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("active");

    expect(logAdminAction).toHaveBeenCalledTimes(1);
    const call = logAdminAction.mock.calls[0][0];
    expect(call.actor).toBe("admin");
    expect(call.actor).not.toBe(fakeAdmin);
  });

  it("still validates the status enum for an authenticated admin", async () => {
    const token = signToken({ role: "admin", sub: "admin" }, "1h");

    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "not-a-real-status" });

    expect(res.status).toBe(400);
  });
});

describe("legacy on-chain verification endpoints", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    pool.query.mockReset();
    logAdminAction.mockReset();
    getOnChainProject.mockReset();
  });

  it("rejects unauthenticated access to the retired register endpoint", async () => {
    const res = await request(app)
      .post("/api/projects/admin/register")
      .send({
        projectId: PROJECT_ID,
        name: "Reforest the Delta",
        wallet: WALLET_ADDRESS,
        co2PerXLM: 100,
        adminAddress: WALLET_ADDRESS,
      });

    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
    expect(logAdminAction).not.toHaveBeenCalled();
  });

  it("fails closed on the retired register endpoint even for an authenticated admin", async () => {
    const token = signToken({ role: "admin", sub: "admin-reviewer" }, "1h");

    const res = await request(app)
      .post("/api/projects/admin/register")
      .set("Authorization", `Bearer ${token}`)
      .send({
        projectId: PROJECT_ID,
        name: "Reforest the Delta",
        wallet: WALLET_ADDRESS,
        co2PerXLM: 100,
        adminAddress: Keypair.random().publicKey(),
      });

    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe("PROJECT_VERIFICATION_DAO_REQUIRED");
    expect(pool.query).not.toHaveBeenCalled();
    expect(logAdminAction).toHaveBeenCalledTimes(1);
    expect(logAdminAction.mock.calls[0][0]).toMatchObject({
      actor: "admin-reviewer",
      targetId: PROJECT_ID,
      action: "project.verification.legacy_register_blocked",
    });
  });

  it("fails closed on the retired confirm endpoint and never flips verification flags", async () => {
    const token = signToken({ role: "admin", sub: "admin-reviewer" }, "1h");

    const res = await request(app)
      .post("/api/projects/admin/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({
        projectId: PROJECT_ID,
        transactionHash: "a".repeat(64),
      });

    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe("PROJECT_VERIFICATION_DAO_REQUIRED");
    expect(pool.query).not.toHaveBeenCalled();
    expect(logAdminAction).toHaveBeenCalledTimes(1);
    expect(logAdminAction.mock.calls[0][0]).toMatchObject({
      actor: "admin-reviewer",
      targetId: PROJECT_ID,
      action: "project.verification.legacy_confirm_blocked",
      metadata: expect.objectContaining({
        transactionHash: "a".repeat(64),
      }),
    });
  });
});

describe("project verification lifecycle foundation", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    pool.query.mockReset();
    logAdminAction.mockReset();
    getOnChainProject.mockReset();
    getOnChainProject.mockResolvedValue(null);
  });

  it("creates a verification application that starts in wallet-proof-pending state", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: PROJECT_ID, wallet_address: WALLET_ADDRESS }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [makeVerificationApplicationRow()] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/verification/application`)
      .send({
        submittedByWallet: WALLET_ADDRESS,
        attestationSummary: "Independent climate documentation and wallet ownership attested for review.",
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      projectId: PROJECT_ID,
      submittedByWallet: WALLET_ADDRESS,
      status: "wallet_proof_pending",
      proofCount: 0,
      attestationCount: 0,
    });
  });

  it("issues a one-time wallet verification challenge for the open application", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: "application-1",
          project_id: PROJECT_ID,
          submitted_by_wallet: WALLET_ADDRESS,
          status: "wallet_proof_pending",
          wallet_address: WALLET_ADDRESS,
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/verification/application/challenge`)
      .send({
        applicationId: "application-1",
        walletAddress: WALLET_ADDRESS,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.applicationId).toBe("application-1");
    expect(res.body.data.challenge).toContain(`project:${PROJECT_ID}`);
    expect(res.body.data.challenge).toContain(`wallet:${WALLET_ADDRESS}`);
    expect(res.body.data.signatureEncoding).toBe("base64-or-hex");
  });

  it("verifies wallet control cryptographically and advances the application to submitted", async () => {
    const signer = Keypair.random();
    const futureExpiry = new Date(Date.now() + (15 * 60 * 1000)).toISOString();
    const challenge = [
      "GreenPay verification challenge",
      `project:${PROJECT_ID}`,
      "application:application-1",
      `wallet:${signer.publicKey()}`,
      "nonce:test-nonce",
      "issuedAt:2026-08-26T12:00:00.000Z",
      `expiresAt:${futureExpiry}`,
    ].join("\n");
    const signature = signer.sign(Buffer.from(challenge, "utf8")).toString("base64");

    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: "application-1",
          project_id: PROJECT_ID,
          submitted_by_wallet: signer.publicKey(),
          status: "wallet_proof_pending",
          wallet_challenge: challenge,
          wallet_challenge_expires_at: futureExpiry,
          wallet_address: signer.publicKey(),
        }],
      })
      .mockResolvedValueOnce({
        rows: [makeVerificationApplicationRow({
          submitted_by_wallet: signer.publicKey(),
          status: "submitted",
          wallet_verified_at: "2026-08-26T12:01:00.000Z",
        })],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/verification/application/wallet-proof`)
      .send({
        applicationId: "application-1",
        signature,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      projectId: PROJECT_ID,
      submittedByWallet: signer.publicKey(),
      status: "submitted",
    });
    expect(res.body.data.walletVerifiedAt).toBe("2026-08-26T12:01:00.000Z");
  });

  it("returns the public verification timeline and latest application summary", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: PROJECT_ID,
          wallet_address: WALLET_ADDRESS,
          verified: false,
          on_chain_verified: false,
          verification_expires_at: null,
          verification_revoked_at: null,
          verification_revocation_reason: null,
          verification_decision_tx_hash: null,
          verification_decision_contract_id: null,
        }],
      })
      .mockResolvedValueOnce({
        rows: [makeVerificationApplicationRow({
          status: "community_vote",
          wallet_verified_at: "2026-08-26T12:01:00.000Z",
          proof_count: 1,
          attestation_count: 2,
          evidence_count: 3,
          community_vote_opens_at: "2026-08-26T13:00:00.000Z",
          community_vote_closes_at: "2026-08-27T13:00:00.000Z",
        })],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: "event-1",
          application_id: "application-1",
          actor: WALLET_ADDRESS,
          actor_type: "project_wallet",
          from_status: null,
          to_status: "wallet_proof_pending",
          rationale: "Verification application created",
          metadata: {},
          created_at: "2026-08-26T11:59:00.000Z",
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/verification`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.latestApplication).toMatchObject({
      status: "community_vote",
      evidenceCount: 3,
      proofCount: 1,
      attestationCount: 2,
    });
    expect(res.body.data.timeline).toHaveLength(1);
    expect(res.body.data.walletAddress).toBe(WALLET_ADDRESS);
  });

  it("does not treat plain contract registration as an active verified badge", async () => {
    getOnChainProject.mockResolvedValue({
      registered_at: 42,
      total_raised: "25000000",
    });

    pool.query
      .mockResolvedValueOnce({
        rows: [makeProjectRow()],
      })
      .mockResolvedValueOnce({
        rows: [makeVerificationApplicationRow({
          status: "submitted",
          wallet_verified_at: "2026-08-26T12:01:00.000Z",
          proof_count: 1,
          evidence_count: 1,
        })],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/verification`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.verified).toBe(false);
    expect(res.body.data.onChainVerified).toBe(false);
    expect(res.body.data.contractRegisteredAt).toBe(42);
    expect(res.body.data.totalRaisedOnChain).toBe("2.5000000");
  });

  it("records the DAO decision, marks the application approved, and anchors the project badge metadata", async () => {
    const token = signToken({ role: "admin", sub: "admin" }, "1h");
    const expiry = "2026-09-26T12:00:00.000Z";

    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: "application-1",
          project_id: PROJECT_ID,
          status: "community_vote",
          community_vote_closes_at: "2026-08-25T12:00:00.000Z",
        }],
      })
      .mockResolvedValueOnce({
        rows: [makeVerificationApplicationRow({
          status: "approved",
          approved_at: "2026-08-26T12:30:00.000Z",
          expires_at: expiry,
          decision_tx_hash: "tx-greenpay-123",
          decision_contract_id: "contract-greenpay-1",
          latest_rationale: "DAO quorum reached and the donor-weighted vote approved the badge.",
          proof_count: 1,
          attestation_count: 2,
          evidence_count: 3,
        })],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/verification/application/decision`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        applicationId: "application-1",
        decisionTxHash: "tx-greenpay-123",
        decisionContractId: "contract-greenpay-1",
        expiresAt: expiry,
        rationale: "DAO quorum reached and the donor-weighted vote approved the badge.",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      id: "application-1",
      status: "approved",
      decisionTxHash: "tx-greenpay-123",
      decisionContractId: "contract-greenpay-1",
      expiresAt: expiry,
      evidenceCount: 3,
    });

    const projectUpdateCall = pool.query.mock.calls[2];
    expect(projectUpdateCall[0]).toContain("UPDATE projects");
    expect(projectUpdateCall[1]).toEqual([
      expiry,
      "tx-greenpay-123",
      "contract-greenpay-1",
      PROJECT_ID,
    ]);
  });
});

describe("GET /api/projects multilingual content", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    pool.query.mockReset();
    getOnChainProject.mockReset();
  });

  it("selects approved requested-language content and searches every approved translation", async () => {
    mockProjectListingQueries([makeProjectRow({
      localized_name: "Reforestar el delta",
      localized_description: "Descripción en español",
      localized_category: "Reforestación",
      localized_location: "Delta",
      localized_language: "es",
      localized_machine_translated: true,
      source_language: "en",
      requested_language: "es",
    })]);

    const res = await request(app).get("/api/projects?lang=es&search=bosque");

    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      name: "Reforestar el delta",
      sourceLanguage: "en",
      contentLanguage: "es",
      usedFallback: false,
      machineTranslated: true,
    });
    expect(pool.query.mock.calls[0][0]).toContain("FROM project_translations search_translation");
    expect(pool.query.mock.calls[0][0]).toContain("moderation_status = 'approved'");
  });

  it("keeps the original fields and explicitly labels fallback", async () => {
    mockProjectListingQueries([makeProjectRow({
      source_language: "en",
      requested_language: "ar",
    })]);

    const res = await request(app).get("/api/projects?lang=ar");

    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      name: "Reforest the Delta",
      sourceLanguage: "en",
      contentLanguage: "en",
      requestedLanguage: "ar",
      usedFallback: true,
      machineTranslated: false,
    });
  });

  it("rejects an unsupported language instead of silently mislabelling content", async () => {
    const res = await request(app).get("/api/projects?lang=fr");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CONTENT_LANGUAGE_INVALID");
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe("project translation moderation", () => {
  let app;
  const token = () => signToken({ role: "admin", sub: "reviewer" }, "1h");

  beforeEach(() => {
    app = buildApp();
    pool.query.mockReset();
    logAdminAction.mockReset();
  });

  it("stores a translation separately in pending moderation", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: PROJECT_ID, source_language: "en" }] })
      .mockResolvedValueOnce({ rows: [{ id: "translation-1", moderation_status: "pending" }] });

    const res = await request(app)
      .put(`/api/projects/${PROJECT_ID}/translations/es`)
      .set("Authorization", `Bearer ${token()}`)
      .send({
        name: "Reforestar el delta",
        description: "Descripción",
        category: "Reforestación",
        location: "Delta",
        machineTranslated: true,
      });

    expect(res.status).toBe(201);
    expect(pool.query.mock.calls[1][0]).toContain("INSERT INTO project_translations");
    expect(pool.query.mock.calls[1][0]).not.toContain("UPDATE projects SET");
  });

  it("blocks machine-translated impact claims until a human reviewer confirms them", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: "translation-1", machine_translated: true }] });
    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}/translations/es/moderation`)
      .set("Authorization", `Bearer ${token()}`)
      .send({ status: "approved" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IMPACT_CLAIMS_REVIEW_REQUIRED");
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("publishes a reviewed translation through the authenticated moderation path", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: "translation-1", machine_translated: true }] })
      .mockResolvedValueOnce({ rows: [{ id: "translation-1", moderation_status: "approved" }] });
    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}/translations/es/moderation`)
      .set("Authorization", `Bearer ${token()}`)
      .send({ status: "approved", impactClaimsReviewed: true });

    expect(res.status).toBe(200);
    expect(logAdminAction).toHaveBeenCalledWith(expect.objectContaining({
      actor: "reviewer",
      action: "project.translation.approved",
    }));
  });
});
