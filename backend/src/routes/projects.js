/**
 * src/routes/projects.js
 */
"use strict";
const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const { randomUUID: uuid } = require("crypto");
const pool = require("../db/pool");
const { adminRequired } = require("../middleware/auth");
const { createLayeredRateLimiter } = require("../middleware/rateLimiter");
const { logAdminAction } = require("../services/audit");
const { mapProjectRow, mapProjectMilestoneRow } = require("../services/store");
const { searchProjects } = require("../services/projectSearch");
const { loadRankingConfig, SEARCH_LATENCY_BUDGET_MS } = require("../config/searchRanking");
const { getOnChainProject } = require("../services/stellar");
const { enqueueAISummary } = require("../services/summaryQueue");
const { validate } = require("../middleware/validate");
const { createApiError } = require("../middleware/apiEnvelope");
const { ProjectStatusUpdateSchema } = require("../schemas/projects");
const { Keypair, StrKey } = require("@stellar/stellar-sdk");
const {
  TRANSLATION_STATUSES,
  requireContentLanguage,
  projectLocalizationSelect,
} = require("../services/contentLanguage");

// Layered rate limiters — see middleware/rateLimiter.js for the dimensions.
// Every project mutation is wallet-identity-tied (adminAddress / matcherAddress)
// or authenticated, so IP alone is never the only thing constraining it.

// Generic admin project writes (campaigns, milestones, matches): a coarse
// per-IP floor plus a per-wallet cap keyed on the acting admin/matcher address.
const projectMutationLimiter = createLayeredRateLimiter({
  name: "project-mutation",
  windowMinutes: 1,
  ip: 60,
  wallet: 20,
});

// On-chain admin ops (register / confirm) hit Horizon RPC per call.
const onChainAdminLimiter = createLayeredRateLimiter({
  name: "project-onchain-admin",
  windowMinutes: 1,
  ip: 30,
  wallet: 10,
});

// AI summary generation spends paid Anthropic API credits, so it gets the
// tightest treatment: an IP floor, a per-wallet cap on the project owner, and
// a global cap that no distributed client (each under its own limits) can
// exceed — the expensive-endpoint backpressure the audit called for.
const aiSummaryLimiter = createLayeredRateLimiter({
  name: "project-summary",
  windowMinutes: 1,
  ip: 10,
  wallet: 2,
  global: 20,
});

// Authenticated platform-admin status changes: per-subject cap keyed on the
// verified JWT subject (set by adminRequired), not on any client-supplied
// address.
const statusLimiter = createLayeredRateLimiter({
  name: "project-status",
  windowMinutes: 1,
  ip: 30,
  subject: 10,
});

/**
 * GET /api/projects/featured
 * Returns the project with the highest donorCount (active projects only).
 * Result is cached in memory for 24 hours.
 */
const featuredCache = new Map();

function requestedLanguage(req) {
  if (req.query.lang === undefined) return null;
  return requireContentLanguage(req.query.lang);
}

function validateTranslatedProject(body) {
  const fields = ["name", "description", "category", "location"];
  const result = {};
  for (const field of fields) {
    if (typeof body?.[field] !== "string" || !body[field].trim()) {
      throw createApiError(400, "TRANSLATION_FIELD_REQUIRED", `${field} is required`);
    }
    result[field] = body[field].trim();
  }
  result.machineTranslated = body.machineTranslated === true;
  return result;
}

const VERIFICATION_APPLICATION_STATUSES = [
  "wallet_proof_pending",
  "submitted",
  "under_review",
  "community_vote",
  "approved",
  "rejected",
  "revoked",
  "expired",
];
const VERIFICATION_EVIDENCE_TYPES = [
  "wallet_control",
  "legal_identity",
  "project_documentation",
  "impact_evidence",
  "other",
];
const VERIFICATION_ATTESTATION_TYPES = ["cryptographic_proof", "human_attestation"];
const VERIFICATION_REVIEW_STATUSES = ["under_review", "community_vote", "rejected", "revoked", "expired"];
const VERIFICATION_TERMINAL_STATUSES = ["approved", "rejected", "revoked", "expired"];

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function normalizeOptionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isPastTimestamp(value) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return date.getTime() <= Date.now();
}

function stroopsToXlm(stroops) {
  if (stroops === null || stroops === undefined) return "0.0000000";
  let value;
  try {
    value = typeof stroops === "bigint" ? stroops : BigInt(stroops);
  } catch {
    return "0.0000000";
  }
  const negative = value < 0n;
  if (negative) value = -value;
  const whole = value / 10000000n;
  const frac = value % 10000000n;
  const fracStr = frac.toString().padStart(7, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fracStr}`;
}

function ensureVerificationStatus(status) {
  if (!VERIFICATION_APPLICATION_STATUSES.includes(status)) {
    throw createApiError(
      400,
      "VERIFICATION_STATUS_INVALID",
      `status must be one of: ${VERIFICATION_APPLICATION_STATUSES.join(", ")}`,
    );
  }
  return status;
}

function ensureReviewStatus(status) {
  if (!VERIFICATION_REVIEW_STATUSES.includes(status)) {
    throw createApiError(
      400,
      "VERIFICATION_REVIEW_STATUS_INVALID",
      `status must be one of: ${VERIFICATION_REVIEW_STATUSES.join(", ")}`,
    );
  }
  return status;
}

function ensureEvidenceType(type) {
  if (!VERIFICATION_EVIDENCE_TYPES.includes(type)) {
    throw createApiError(
      400,
      "VERIFICATION_EVIDENCE_TYPE_INVALID",
      `evidenceType must be one of: ${VERIFICATION_EVIDENCE_TYPES.join(", ")}`,
    );
  }
  return type;
}

function ensureAttestationType(type) {
  if (!VERIFICATION_ATTESTATION_TYPES.includes(type)) {
    throw createApiError(
      400,
      "VERIFICATION_ATTESTATION_TYPE_INVALID",
      `attestationType must be one of: ${VERIFICATION_ATTESTATION_TYPES.join(", ")}`,
    );
  }
  return type;
}

function parseSignature(signature) {
  if (Array.isArray(signature)) {
    const numeric = signature.every((value) => Number.isInteger(value) && value >= 0 && value <= 255);
    if (!numeric) {
      throw createApiError(400, "WALLET_SIGNATURE_INVALID", "signature byte array must contain integers between 0 and 255");
    }
    const parsed = Buffer.from(signature);
    if (parsed.length !== 64) {
      throw createApiError(400, "WALLET_SIGNATURE_INVALID", "signature must be 64 bytes");
    }
    return parsed;
  }

  if (typeof signature !== "string" || !signature.trim()) {
    throw createApiError(400, "WALLET_SIGNATURE_REQUIRED", "signature is required");
  }

  const trimmed = signature.trim();
  const parsed = /^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");

  if (parsed.length !== 64) {
    throw createApiError(400, "WALLET_SIGNATURE_INVALID", "signature must decode to 64 bytes");
  }
  return parsed;
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function buildVerificationChallenge({ projectId, applicationId, walletAddress, expiresAt }) {
  return [
    "GreenPay verification challenge",
    `project:${projectId}`,
    `application:${applicationId}`,
    `wallet:${walletAddress}`,
    `nonce:${crypto.randomUUID()}`,
    `issuedAt:${new Date().toISOString()}`,
    `expiresAt:${expiresAt.toISOString()}`,
  ].join("\n");
}

function mapVerificationApplicationRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    submittedByWallet: row.submitted_by_wallet,
    status: ensureVerificationStatus(row.status),
    attestationSummary: row.attestation_summary || null,
    walletChallengeExpiresAt: toIso(row.wallet_challenge_expires_at),
    walletVerifiedAt: toIso(row.wallet_verified_at),
    submittedAt: toIso(row.submitted_at),
    communityVoteOpensAt: toIso(row.community_vote_opens_at),
    communityVoteClosesAt: toIso(row.community_vote_closes_at),
    approvedAt: toIso(row.approved_at),
    expiresAt: toIso(row.expires_at),
    revokedAt: toIso(row.revoked_at),
    revocationReason: row.revocation_reason || null,
    decisionTxHash: row.decision_tx_hash || null,
    decisionContractId: row.decision_contract_id || null,
    latestRationale: row.latest_rationale || null,
    evidenceCount: Number.parseInt(row.evidence_count, 10) || 0,
    proofCount: Number.parseInt(row.proof_count, 10) || 0,
    attestationCount: Number.parseInt(row.attestation_count, 10) || 0,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapVerificationEventRow(row) {
  return {
    id: row.id,
    applicationId: row.application_id,
    actor: row.actor,
    actorType: row.actor_type,
    fromStatus: row.from_status || null,
    toStatus: row.to_status,
    rationale: row.rationale || null,
    metadata: row.metadata || {},
    createdAt: toIso(row.created_at),
  };
}

function mapVerificationEvidenceRow(row) {
  return {
    id: row.id,
    applicationId: row.application_id,
    evidenceType: row.evidence_type,
    attestationType: row.attestation_type,
    documentHash: row.document_hash,
    storageUri: row.storage_uri || null,
    private: row.private !== false,
    submittedBy: row.submitted_by,
    notes: row.notes || null,
    createdAt: toIso(row.created_at),
  };
}

async function fetchLatestVerificationApplication(projectId) {
  const result = await pool.query(
    `SELECT a.*,
            (SELECT COUNT(*)::int FROM project_verification_evidence e WHERE e.application_id = a.id) AS evidence_count,
            (SELECT COUNT(*)::int FROM project_verification_evidence e WHERE e.application_id = a.id AND e.attestation_type = 'cryptographic_proof') AS proof_count,
            (SELECT COUNT(*)::int FROM project_verification_evidence e WHERE e.application_id = a.id AND e.attestation_type = 'human_attestation') AS attestation_count
       FROM project_verification_applications a
      WHERE a.project_id = $1
      ORDER BY a.created_at DESC
      LIMIT 1`,
    [projectId],
  );
  return mapVerificationApplicationRow(result.rows[0]);
}

async function fetchVerificationTimeline(applicationId) {
  if (!applicationId) return [];
  const result = await pool.query(
    `SELECT id, application_id, actor, actor_type, from_status, to_status, rationale, metadata, created_at
       FROM project_verification_events
      WHERE application_id = $1
      ORDER BY created_at ASC`,
    [applicationId],
  );
  return result.rows.map(mapVerificationEventRow);
}

async function fetchVerificationEvidence(applicationId, { publicOnly = false } = {}) {
  if (!applicationId) return [];
  const values = [applicationId];
  const privacyClause = publicOnly ? " AND private = FALSE" : "";
  const result = await pool.query(
    `SELECT id, application_id, evidence_type, attestation_type, document_hash,
            storage_uri, private, submitted_by, notes, created_at
       FROM project_verification_evidence
      WHERE application_id = $1${privacyClause}
      ORDER BY created_at ASC`,
    values,
  );
  return result.rows.map(mapVerificationEvidenceRow);
}

async function insertVerificationEvent({
  applicationId,
  actor,
  actorType,
  fromStatus,
  toStatus,
  rationale = null,
  metadata = {},
}) {
  await pool.query(
    `INSERT INTO project_verification_events
      (id, application_id, actor, actor_type, from_status, to_status, rationale, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [uuid(), applicationId, actor, actorType, fromStatus, toStatus, rationale, JSON.stringify(metadata)],
  );
}

function deriveVerificationSnapshot(project, latestApplication) {
  const verificationExpiresAt = toIso(project.verification_expires_at) || latestApplication?.expiresAt || null;
  const verificationRevokedAt = toIso(project.verification_revoked_at) || latestApplication?.revokedAt || null;
  const verificationRevocationReason = project.verification_revocation_reason || latestApplication?.revocationReason || null;
  const verificationDecisionTxHash = project.verification_decision_tx_hash || latestApplication?.decisionTxHash || null;
  const verificationDecisionContractId = project.verification_decision_contract_id || latestApplication?.decisionContractId || null;
  const latestStatus = latestApplication?.status || null;
  const activeStatus = latestStatus === "approved" || Boolean(project.verified);
  const revoked = Boolean(verificationRevokedAt) || latestStatus === "revoked";
  const expired = Boolean(verificationExpiresAt) && isPastTimestamp(verificationExpiresAt);
  const onChainVerified = Boolean(project.on_chain_verified) || Boolean(verificationDecisionTxHash && verificationDecisionContractId);
  const verified = activeStatus && !revoked && !expired;

  return {
    verificationExpiresAt,
    verificationRevokedAt,
    verificationRevocationReason,
    verificationDecisionTxHash,
    verificationDecisionContractId,
    verified,
    onChainVerified,
    latestStatus,
    expired,
    revoked,
  };
}

function mapCampaignRow(row) {
  const now = Date.now();
  const goalXLM = Number.parseFloat(row.goal_xlm?.toString() || "0");
  const raisedXLM = Number.parseFloat(row.raised_xlm?.toString() || "0");
  const deadlineMs = new Date(row.deadline).getTime();
  const completed = raisedXLM >= goalXLM || now >= deadlineMs;
  const progressPercent = goalXLM > 0 ? Math.min(Math.round((raisedXLM / goalXLM) * 100), 100) : 0;

  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description || "",
    goalXLM: row.goal_xlm?.toString() || "0",
    raisedXLM: raisedXLM.toFixed(7),
    deadline: new Date(row.deadline).toISOString(),
    progressPercent,
    completed,
    active: !completed,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function fetchCampaignsForProject(projectId) {
  const result = await pool.query(
    `SELECT c.*,
            COALESCE(
              SUM(
                CASE
                  WHEN d.currency = 'XLM' THEN d.amount_xlm
                  ELSE 0
                END
              ),
              0
            ) AS raised_xlm
     FROM project_campaigns c
     LEFT JOIN donations d
       ON d.project_id = c.project_id
      AND d.created_at >= c.created_at
      AND d.created_at <= c.deadline
     WHERE c.project_id = $1
     GROUP BY c.id
     ORDER BY c.created_at DESC`,
    [projectId],
  );
  return result.rows.map(mapCampaignRow);
}

router.get("/featured", async (req, res, next) => {
  try {
    const language = requestedLanguage(req);
    const cacheKey = language || "source";
    const now = Date.now();
    const cached = featuredCache.get(cacheKey);
    if (cached && now < cached.expiresAt) {
      return res.json({ ...cached.project, serverNow: Date.now() });
    }

    const values = [];
    let languageParam = null;
    if (language) {
      values.push(language);
      languageParam = `$${values.length}`;
    }
    const localization = projectLocalizationSelect(languageParam);
    const result = await pool.query(
      `SELECT p.*${localization.columns}${languageParam ? `, ${languageParam}::text AS requested_language` : ""}
       FROM projects p${localization.join}
       WHERE p.status = 'active'
       ORDER BY p.donor_count DESC, p.raised_xlm DESC
       LIMIT 1`,
      values,
    );

    if (!result.rows[0]) {
      throw createApiError(404, "FEATURED_PROJECT_NOT_FOUND", "No featured project found");
    }

    const project = mapProjectRow(result.rows[0]);
    featuredCache.set(cacheKey, { project, expiresAt: now + 24 * 60 * 60 * 1000 });
    res.json({ ...project, serverNow: Date.now() });
  } catch (e) {
    next(e);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const language = requestedLanguage(req);
    const ranking = loadRankingConfig();
    const query = { ...req.query };
    if (language) {
      query.lang = language;
    }
    const { rows, meta } = await searchProjects(pool, query, ranking);

    res.apiMeta({
      ...meta,
      latencyBudgetMs: SEARCH_LATENCY_BUDGET_MS,
    });

    res.json(rows.map(row => ({ ...mapProjectRow(row), serverNow: Date.now() })));
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/projects/:id/verify
 * Reads the project record directly from the Soroban contract.
 */
router.get("/:id/verify", async (req, res) => {
  try {
    const projectId = req.params.id;
    const onChainProject = await getOnChainProject(projectId);

    res.json({
      projectId,
      onChainVerified: Boolean(onChainProject),
      contractRegisteredAt: onChainProject ? Number(onChainProject.registered_at) : null,
      totalRaisedOnChain: onChainProject ? stroopsToXlm(onChainProject.total_raised) : "0.0000000",
    });
  } catch (err) {
    res.json({
      projectId: req.params.id,
      onChainVerified: false,
      contractRegisteredAt: null,
      totalRaisedOnChain: "0.0000000",
    });
  }
});

router.get("/:id/verification", async (req, res, next) => {
  try {
    const projectResult = await pool.query(
      `SELECT id, wallet_address, verified, on_chain_verified,
              verification_expires_at, verification_revoked_at,
              verification_revocation_reason, verification_decision_tx_hash,
              verification_decision_contract_id
         FROM projects
        WHERE id = $1`,
      [req.params.id],
    );
    const project = projectResult.rows[0];
    if (!project) {
      throw createApiError(404, "PROJECT_NOT_FOUND", "Project not found");
    }

    const latestApplication = await fetchLatestVerificationApplication(req.params.id);
    const timeline = await fetchVerificationTimeline(latestApplication?.id || null);
    const publicEvidence = await fetchVerificationEvidence(latestApplication?.id || null, { publicOnly: true });
    const onChainProject = await getOnChainProject(req.params.id).catch(() => null);
    const snapshot = deriveVerificationSnapshot(project, latestApplication);

    res.json({
      projectId: req.params.id,
      walletAddress: project.wallet_address,
      verified: snapshot.verified,
      onChainVerified: snapshot.onChainVerified,
      verificationExpiresAt: snapshot.verificationExpiresAt,
      verificationRevokedAt: snapshot.verificationRevokedAt,
      verificationRevocationReason: snapshot.verificationRevocationReason,
      verificationDecisionTxHash: snapshot.verificationDecisionTxHash,
      verificationDecisionContractId: snapshot.verificationDecisionContractId,
      badgeExpired: snapshot.expired,
      badgeRevoked: snapshot.revoked,
      currentStatus: snapshot.latestStatus,
      contractRegisteredAt: onChainProject ? Number(onChainProject.registered_at) : null,
      totalRaisedOnChain: onChainProject ? stroopsToXlm(onChainProject.total_raised) : "0.0000000",
      latestApplication,
      timeline,
      publicEvidence,
    });
  } catch (e) {
    next(e);
  }
});

router.post("/:id/verification/application", projectMutationLimiter, async (req, res, next) => {
  try {
    const { submittedByWallet, attestationSummary } = req.body || {};
    if (typeof submittedByWallet !== "string" || !submittedByWallet.trim()) {
      throw createApiError(400, "SUBMITTED_BY_WALLET_REQUIRED", "submittedByWallet is required");
    }
    if (!StrKey.isValidEd25519PublicKey(submittedByWallet.trim())) {
      throw createApiError(400, "SUBMITTED_BY_WALLET_INVALID", "submittedByWallet must be a valid Stellar public key");
    }
    if (typeof attestationSummary !== "string" || attestationSummary.trim().length < 20) {
      throw createApiError(400, "ATTESTATION_SUMMARY_INVALID", "attestationSummary must be at least 20 characters");
    }

    const projectResult = await pool.query(
      "SELECT id, wallet_address FROM projects WHERE id = $1",
      [req.params.id],
    );
    const project = projectResult.rows[0];
    if (!project) {
      throw createApiError(404, "PROJECT_NOT_FOUND", "Project not found");
    }
    if (project.wallet_address !== submittedByWallet.trim()) {
      throw createApiError(403, "PROJECT_WALLET_REQUIRED", "Verification applications must be submitted by the project's wallet address");
    }

    const existingResult = await pool.query(
      `SELECT id, project_id, submitted_by_wallet, status, attestation_summary,
              wallet_challenge_expires_at, wallet_verified_at, submitted_at,
              community_vote_opens_at, community_vote_closes_at, approved_at,
              expires_at, revoked_at, revocation_reason, decision_tx_hash,
              decision_contract_id, latest_rationale, created_at, updated_at
         FROM project_verification_applications
        WHERE project_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [req.params.id],
    );
    const existing = existingResult.rows[0];
    if (existing && !VERIFICATION_TERMINAL_STATUSES.includes(existing.status)) {
      throw createApiError(409, "VERIFICATION_APPLICATION_ALREADY_OPEN", "A verification application is already in progress for this project");
    }

    const inserted = await pool.query(
      `INSERT INTO project_verification_applications
        (id, project_id, submitted_by_wallet, status, attestation_summary, submitted_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'wallet_proof_pending', $4, NOW(), NOW(), NOW())
       RETURNING *,
         0::int AS evidence_count,
         0::int AS proof_count,
         0::int AS attestation_count`,
      [uuid(), req.params.id, submittedByWallet.trim(), attestationSummary.trim()],
    );

    await insertVerificationEvent({
      applicationId: inserted.rows[0].id,
      actor: submittedByWallet.trim(),
      actorType: "project_wallet",
      fromStatus: null,
      toStatus: "wallet_proof_pending",
      rationale: "Verification application created",
      metadata: {},
    });

    res.status(201).json(mapVerificationApplicationRow(inserted.rows[0]));
  } catch (e) {
    next(e);
  }
});

router.post("/:id/verification/application/challenge", projectMutationLimiter, async (req, res, next) => {
  try {
    const { applicationId, walletAddress } = req.body || {};
    if (typeof applicationId !== "string" || !applicationId.trim()) {
      throw createApiError(400, "APPLICATION_ID_REQUIRED", "applicationId is required");
    }
    if (typeof walletAddress !== "string" || !StrKey.isValidEd25519PublicKey(walletAddress.trim())) {
      throw createApiError(400, "WALLET_ADDRESS_INVALID", "walletAddress must be a valid Stellar public key");
    }

    const result = await pool.query(
      `SELECT a.id, a.project_id, a.submitted_by_wallet, a.status, p.wallet_address
         FROM project_verification_applications a
         JOIN projects p ON p.id = a.project_id
        WHERE a.id = $1 AND a.project_id = $2`,
      [applicationId.trim(), req.params.id],
    );
    const application = result.rows[0];
    if (!application) {
      throw createApiError(404, "VERIFICATION_APPLICATION_NOT_FOUND", "Verification application not found");
    }
    if (application.wallet_address !== walletAddress.trim() || application.submitted_by_wallet !== walletAddress.trim()) {
      throw createApiError(403, "PROJECT_WALLET_REQUIRED", "Only the project's wallet can request a verification challenge");
    }

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const challenge = buildVerificationChallenge({
      projectId: req.params.id,
      applicationId: application.id,
      walletAddress: walletAddress.trim(),
      expiresAt,
    });

    await pool.query(
      `UPDATE project_verification_applications
          SET wallet_challenge = $1,
              wallet_challenge_expires_at = $2,
              updated_at = NOW()
        WHERE id = $3`,
      [challenge, expiresAt.toISOString(), application.id],
    );

    res.json({
      applicationId: application.id,
      challenge,
      expiresAt: expiresAt.toISOString(),
      signatureEncoding: "base64-or-hex",
    });
  } catch (e) {
    next(e);
  }
});

router.post("/:id/verification/application/wallet-proof", projectMutationLimiter, async (req, res, next) => {
  try {
    const { applicationId, signature } = req.body || {};
    if (typeof applicationId !== "string" || !applicationId.trim()) {
      throw createApiError(400, "APPLICATION_ID_REQUIRED", "applicationId is required");
    }

    const result = await pool.query(
      `SELECT a.id, a.project_id, a.submitted_by_wallet, a.status, a.wallet_challenge,
              a.wallet_challenge_expires_at, p.wallet_address
         FROM project_verification_applications a
         JOIN projects p ON p.id = a.project_id
        WHERE a.id = $1 AND a.project_id = $2`,
      [applicationId.trim(), req.params.id],
    );
    const application = result.rows[0];
    if (!application) {
      throw createApiError(404, "VERIFICATION_APPLICATION_NOT_FOUND", "Verification application not found");
    }
    if (!application.wallet_challenge) {
      throw createApiError(409, "VERIFICATION_CHALLENGE_REQUIRED", "Generate a wallet verification challenge before submitting proof");
    }
    const expiresAt = application.wallet_challenge_expires_at ? new Date(application.wallet_challenge_expires_at) : null;
    if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
      throw createApiError(409, "VERIFICATION_CHALLENGE_EXPIRED", "The wallet verification challenge has expired");
    }

    const signatureBytes = parseSignature(signature);
    let verified = false;
    try {
      verified = Keypair.fromPublicKey(application.wallet_address).verify(
        Buffer.from(application.wallet_challenge, "utf8"),
        signatureBytes,
      );
    } catch {
      verified = false;
    }
    if (!verified) {
      throw createApiError(400, "WALLET_SIGNATURE_INVALID", "signature does not verify against the stored challenge");
    }

    const updated = await pool.query(
      `UPDATE project_verification_applications
          SET status = 'submitted',
              wallet_verified_at = NOW(),
              submitted_at = COALESCE(submitted_at, NOW()),
              wallet_challenge = NULL,
              wallet_challenge_expires_at = NULL,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *,
          (SELECT COUNT(*)::int FROM project_verification_evidence e WHERE e.application_id = project_verification_applications.id) AS evidence_count,
          (SELECT COUNT(*)::int FROM project_verification_evidence e WHERE e.application_id = project_verification_applications.id AND e.attestation_type = 'cryptographic_proof') AS proof_count,
          (SELECT COUNT(*)::int FROM project_verification_evidence e WHERE e.application_id = project_verification_applications.id AND e.attestation_type = 'human_attestation') AS attestation_count`,
      [application.id],
    );

    await pool.query(
      `INSERT INTO project_verification_evidence
        (id, application_id, evidence_type, attestation_type, document_hash, storage_uri, private, submitted_by, notes)
       VALUES ($1, $2, 'wallet_control', 'cryptographic_proof', $3, NULL, TRUE, $4, $5)`,
      [
        uuid(),
        application.id,
        sha256Hex(application.wallet_challenge),
        application.wallet_address,
        "Wallet control proven by signature over the one-time GreenPay verification challenge",
      ],
    );

    await insertVerificationEvent({
      applicationId: application.id,
      actor: application.wallet_address,
      actorType: "project_wallet",
      fromStatus: application.status,
      toStatus: "submitted",
      rationale: "Wallet control cryptographically proven",
      metadata: { challengeHash: sha256Hex(application.wallet_challenge) },
    });

    res.json(mapVerificationApplicationRow(updated.rows[0]));
  } catch (e) {
    next(e);
  }
});

router.post("/:id/verification/application/evidence", projectMutationLimiter, async (req, res, next) => {
  try {
    const {
      applicationId,
      evidenceType,
      attestationType,
      documentHash,
      storageUri = null,
      private: isPrivate = true,
      submittedBy,
      notes = null,
    } = req.body || {};

    if (typeof applicationId !== "string" || !applicationId.trim()) {
      throw createApiError(400, "APPLICATION_ID_REQUIRED", "applicationId is required");
    }
    if (typeof submittedBy !== "string" || !submittedBy.trim()) {
      throw createApiError(400, "SUBMITTED_BY_REQUIRED", "submittedBy is required");
    }
    if (typeof documentHash !== "string" || documentHash.trim().length < 16) {
      throw createApiError(400, "DOCUMENT_HASH_INVALID", "documentHash must be a non-empty hash or commitment");
    }

    const normalizedEvidenceType = ensureEvidenceType(evidenceType);
    const normalizedAttestationType = ensureAttestationType(attestationType);

    const result = await pool.query(
      `SELECT id, project_id, submitted_by_wallet, status, wallet_verified_at
         FROM project_verification_applications
        WHERE id = $1 AND project_id = $2`,
      [applicationId.trim(), req.params.id],
    );
    const application = result.rows[0];
    if (!application) {
      throw createApiError(404, "VERIFICATION_APPLICATION_NOT_FOUND", "Verification application not found");
    }
    if (VERIFICATION_TERMINAL_STATUSES.includes(application.status)) {
      throw createApiError(409, "VERIFICATION_APPLICATION_CLOSED", "Evidence cannot be added to a closed verification application");
    }
    if (!application.wallet_verified_at && normalizedEvidenceType !== "wallet_control") {
      throw createApiError(409, "WALLET_PROOF_REQUIRED", "Prove wallet control before submitting additional verification evidence");
    }

    const inserted = await pool.query(
      `INSERT INTO project_verification_evidence
        (id, application_id, evidence_type, attestation_type, document_hash, storage_uri, private, submitted_by, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        uuid(),
        application.id,
        normalizedEvidenceType,
        normalizedAttestationType,
        documentHash.trim(),
        storageUri,
        isPrivate !== false,
        submittedBy.trim(),
        typeof notes === "string" && notes.trim() ? notes.trim() : null,
      ],
    );

    await insertVerificationEvent({
      applicationId: application.id,
      actor: submittedBy.trim(),
      actorType: submittedBy.trim() === application.submitted_by_wallet ? "project_wallet" : "platform_admin",
      fromStatus: application.status,
      toStatus: application.status,
      rationale: "Verification evidence recorded",
      metadata: {
        evidenceType: normalizedEvidenceType,
        attestationType: normalizedAttestationType,
        private: isPrivate !== false,
      },
    });

    res.status(201).json({
      id: inserted.rows[0].id,
      applicationId: inserted.rows[0].application_id,
      evidenceType: inserted.rows[0].evidence_type,
      attestationType: inserted.rows[0].attestation_type,
      documentHash: inserted.rows[0].document_hash,
      storageUri: inserted.rows[0].storage_uri || null,
      private: inserted.rows[0].private !== false,
      submittedBy: inserted.rows[0].submitted_by,
      notes: inserted.rows[0].notes || null,
      createdAt: toIso(inserted.rows[0].created_at),
    });
  } catch (e) {
    next(e);
  }
});

router.patch("/:id/verification/application/status", adminRequired, statusLimiter, async (req, res, next) => {
  try {
    const {
      applicationId,
      status,
      rationale = null,
      communityVoteOpensAt = null,
      communityVoteClosesAt = null,
      revocationReason = null,
    } = req.body || {};

    if (typeof applicationId !== "string" || !applicationId.trim()) {
      throw createApiError(400, "APPLICATION_ID_REQUIRED", "applicationId is required");
    }
    const nextStatus = ensureReviewStatus(status);
    if (nextStatus === "community_vote") {
      if (!communityVoteOpensAt || !communityVoteClosesAt) {
        throw createApiError(400, "COMMUNITY_VOTE_WINDOW_REQUIRED", "communityVoteOpensAt and communityVoteClosesAt are required for community_vote status");
      }
    }
    if (nextStatus === "revoked" && !(typeof revocationReason === "string" && revocationReason.trim())) {
      throw createApiError(400, "REVOCATION_REASON_REQUIRED", "revocationReason is required when revoking verification");
    }

    const currentResult = await pool.query(
      `SELECT id, project_id, status, community_vote_closes_at
         FROM project_verification_applications
        WHERE id = $1 AND project_id = $2`,
      [applicationId.trim(), req.params.id],
    );
    const current = currentResult.rows[0];
    if (!current) {
      throw createApiError(404, "VERIFICATION_APPLICATION_NOT_FOUND", "Verification application not found");
    }

    const allowedTransitions = {
      wallet_proof_pending: [],
      submitted: ["under_review", "rejected"],
      under_review: ["community_vote", "rejected"],
      community_vote: ["rejected"],
      approved: ["revoked", "expired"],
      rejected: [],
      revoked: [],
      expired: [],
    };
    if (!(allowedTransitions[current.status] || []).includes(nextStatus)) {
      throw createApiError(
        409,
        "VERIFICATION_STATUS_TRANSITION_INVALID",
        `Cannot move verification application from ${current.status} to ${nextStatus}`,
      );
    }

    const updated = await pool.query(
      `UPDATE project_verification_applications
          SET status = $1,
              community_vote_opens_at = CASE WHEN $1 = 'community_vote' THEN $2::timestamptz ELSE community_vote_opens_at END,
              community_vote_closes_at = CASE WHEN $1 = 'community_vote' THEN $3::timestamptz ELSE community_vote_closes_at END,
              revoked_at = CASE WHEN $1 = 'revoked' THEN NOW() ELSE revoked_at END,
              revocation_reason = CASE WHEN $1 = 'revoked' THEN $4 ELSE revocation_reason END,
              latest_rationale = $5,
              updated_at = NOW()
        WHERE id = $6
        RETURNING *,
          (SELECT COUNT(*)::int FROM project_verification_evidence e WHERE e.application_id = project_verification_applications.id) AS evidence_count,
          (SELECT COUNT(*)::int FROM project_verification_evidence e WHERE e.application_id = project_verification_applications.id AND e.attestation_type = 'cryptographic_proof') AS proof_count,
          (SELECT COUNT(*)::int FROM project_verification_evidence e WHERE e.application_id = project_verification_applications.id AND e.attestation_type = 'human_attestation') AS attestation_count`,
      [
        nextStatus,
        communityVoteOpensAt,
        communityVoteClosesAt,
        typeof revocationReason === "string" && revocationReason.trim() ? revocationReason.trim() : null,
        typeof rationale === "string" && rationale.trim() ? rationale.trim() : null,
        current.id,
      ],
    );

    if (nextStatus === "revoked") {
      await pool.query(
        `UPDATE projects
            SET verified = FALSE,
                on_chain_verified = FALSE,
                verification_revoked_at = NOW(),
                verification_revocation_reason = $1,
                updated_at = NOW()
          WHERE id = $2`,
        [
          normalizeOptionalText(revocationReason),
          req.params.id,
        ],
      );
    } else if (nextStatus === "expired") {
      await pool.query(
        `UPDATE projects
            SET verified = FALSE,
                updated_at = NOW()
          WHERE id = $1`,
        [req.params.id],
      );
    }

    await insertVerificationEvent({
      applicationId: current.id,
      actor: req.admin.sub,
      actorType: "platform_admin",
      fromStatus: current.status,
      toStatus: nextStatus,
      rationale: normalizeOptionalText(rationale),
      metadata: {
        communityVoteOpensAt,
        communityVoteClosesAt,
        revocationReason: normalizeOptionalText(revocationReason),
      },
    });

    res.json(mapVerificationApplicationRow(updated.rows[0]));
  } catch (e) {
    next(e);
  }
});

router.post("/:id/verification/application/decision", adminRequired, statusLimiter, async (req, res, next) => {
  try {
    const {
      applicationId,
      decisionTxHash,
      decisionContractId,
      expiresAt,
      rationale = null,
    } = req.body || {};

    if (typeof applicationId !== "string" || !applicationId.trim()) {
      throw createApiError(400, "APPLICATION_ID_REQUIRED", "applicationId is required");
    }
    if (typeof decisionTxHash !== "string" || !decisionTxHash.trim()) {
      throw createApiError(400, "DECISION_TX_HASH_REQUIRED", "decisionTxHash is required");
    }
    if (typeof decisionContractId !== "string" || !decisionContractId.trim()) {
      throw createApiError(400, "DECISION_CONTRACT_ID_REQUIRED", "decisionContractId is required");
    }

    const expiryDate = new Date(expiresAt);
    if (!expiresAt || Number.isNaN(expiryDate.getTime())) {
      throw createApiError(400, "VERIFICATION_EXPIRY_INVALID", "expiresAt must be a valid ISO date string");
    }
    if (expiryDate.getTime() <= Date.now()) {
      throw createApiError(400, "VERIFICATION_EXPIRY_PAST", "expiresAt must be in the future");
    }

    const currentResult = await pool.query(
      `SELECT id, project_id, status, community_vote_closes_at
         FROM project_verification_applications
        WHERE id = $1 AND project_id = $2`,
      [applicationId.trim(), req.params.id],
    );
    const current = currentResult.rows[0];
    if (!current) {
      throw createApiError(404, "VERIFICATION_APPLICATION_NOT_FOUND", "Verification application not found");
    }
    if (current.status !== "community_vote") {
      throw createApiError(
        409,
        "VERIFICATION_COMMUNITY_VOTE_REQUIRED",
        "Only applications in community_vote can be approved with a DAO decision",
      );
    }
    if (!current.community_vote_closes_at) {
      throw createApiError(409, "COMMUNITY_VOTE_WINDOW_REQUIRED", "The application is missing a recorded community vote window");
    }
    if (!isPastTimestamp(current.community_vote_closes_at)) {
      throw createApiError(409, "COMMUNITY_VOTE_STILL_OPEN", "The community vote must close before recording the DAO decision");
    }

    const updated = await pool.query(
      `UPDATE project_verification_applications
          SET status = 'approved',
              approved_at = NOW(),
              expires_at = $1,
              revoked_at = NULL,
              revocation_reason = NULL,
              decision_tx_hash = $2,
              decision_contract_id = $3,
              latest_rationale = $4,
              updated_at = NOW()
        WHERE id = $5
        RETURNING *,
          (SELECT COUNT(*)::int FROM project_verification_evidence e WHERE e.application_id = project_verification_applications.id) AS evidence_count,
          (SELECT COUNT(*)::int FROM project_verification_evidence e WHERE e.application_id = project_verification_applications.id AND e.attestation_type = 'cryptographic_proof') AS proof_count,
          (SELECT COUNT(*)::int FROM project_verification_evidence e WHERE e.application_id = project_verification_applications.id AND e.attestation_type = 'human_attestation') AS attestation_count`,
      [
        expiryDate.toISOString(),
        decisionTxHash.trim(),
        decisionContractId.trim(),
        normalizeOptionalText(rationale),
        current.id,
      ],
    );

    await pool.query(
      `UPDATE projects
          SET verified = TRUE,
              on_chain_verified = TRUE,
              verification_expires_at = $1,
              verification_revoked_at = NULL,
              verification_revocation_reason = NULL,
              verification_decision_tx_hash = $2,
              verification_decision_contract_id = $3,
              updated_at = NOW()
        WHERE id = $4`,
      [
        expiryDate.toISOString(),
        decisionTxHash.trim(),
        decisionContractId.trim(),
        req.params.id,
      ],
    );

    await insertVerificationEvent({
      applicationId: current.id,
      actor: req.admin.sub,
      actorType: "platform_admin",
      fromStatus: current.status,
      toStatus: "approved",
      rationale: normalizeOptionalText(rationale),
      metadata: {
        decisionTxHash: decisionTxHash.trim(),
        decisionContractId: decisionContractId.trim(),
        expiresAt: expiryDate.toISOString(),
      },
    });

    res.json(mapVerificationApplicationRow(updated.rows[0]));
  } catch (e) {
    next(e);
  }
});

router.post("/:id/campaigns", projectMutationLimiter, async (req, res, next) => {
  try {
    const { title, goalXLM, deadline, description } = req.body || {};
    const trimmedTitle = typeof title === "string" ? title.trim() : "";
    const trimmedDescription = typeof description === "string" ? description.trim() : "";
    const goal = Number.parseFloat(goalXLM);
    const deadlineDate = new Date(deadline);

    if (trimmedTitle.length < 3 || trimmedTitle.length > 120) {
      throw createApiError(400, "TITLE_LENGTH_INVALID", "title must be between 3 and 120 characters");
    }
    if (!Number.isFinite(goal) || goal <= 0) {
      throw createApiError(400, "GOAL_XLM_INVALID", "goalXLM must be a positive number");
    }
    if (!deadline || Number.isNaN(deadlineDate.getTime())) {
      throw createApiError(400, "DEADLINE_INVALID", "deadline must be a valid ISO date string");
    }
    if (deadlineDate.getTime() <= Date.now()) {
      throw createApiError(400, "DEADLINE_NOT_FUTURE", "deadline must be in the future");
    }
    if (trimmedDescription.length > 500) {
      throw createApiError(400, "DESCRIPTION_TOO_LONG", "description must be 500 characters or fewer");
    }

    const projectResult = await pool.query("SELECT id FROM projects WHERE id = $1", [req.params.id]);
    if (!projectResult.rows[0]) {
      throw createApiError(404, "PROJECT_NOT_FOUND", "Project not found");
    }

    const result = await pool.query(
      `INSERT INTO project_campaigns (id, project_id, title, description, goal_xlm, deadline, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING *, 0::numeric AS raised_xlm`,
      [uuid(), req.params.id, trimmedTitle, trimmedDescription || null, goal.toFixed(7), deadlineDate.toISOString()],
    );

    logAdminAction({
      actor: req.body?.adminAddress || "unknown",
      action: "project.campaign.create",
      targetType: "project_campaign",
      targetId: result.rows[0].id,
      metadata: { projectId: req.params.id, title: trimmedTitle, goalXLM: goal, deadline },
      ipAddress: req.ip,
    });

    res.status(201).json(mapCampaignRow(result.rows[0]));
  } catch (e) {
    next(e);
  }
});

router.get("/:id/campaigns", async (req, res, next) => {
  try {
    const projectResult = await pool.query("SELECT id FROM projects WHERE id = $1", [req.params.id]);
    if (!projectResult.rows[0]) {
      throw createApiError(404, "PROJECT_NOT_FOUND", "Project not found");
    }
    const campaigns = await fetchCampaignsForProject(req.params.id);
    res.json(campaigns);
  } catch (e) {
    next(e);
  }
});

router.get("/:id/milestones", async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT * FROM project_milestones WHERE project_id = $1 ORDER BY percentage ASC",
      [req.params.id],
    );
    res.json(result.rows.map(mapProjectMilestoneRow));
  } catch (e) {
    next(e);
  }
});

router.post("/:id/milestones", projectMutationLimiter, async (req, res, next) => {
  try {
    const { title, percentage } = req.body;
    if (!title || typeof percentage !== "number") {
      throw createApiError(400, "MILESTONE_FIELDS_REQUIRED", "title and percentage (number) are required");
    }
    const result = await pool.query(
      `INSERT INTO project_milestones (id, project_id, title, percentage)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [uuid(), req.params.id, title, percentage],
    );

    logAdminAction({
      actor: req.body?.adminAddress || "unknown",
      action: "project.milestone.create",
      targetType: "project_milestone",
      targetId: result.rows[0].id,
      metadata: { projectId: req.params.id, title, percentage },
      ipAddress: req.ip,
    });

    res.status(201).json(mapProjectMilestoneRow(result.rows[0]));
  } catch (e) {
    next(e);
  }
});

router.post("/:id/milestones/:milestoneId/reach", projectMutationLimiter, async (req, res, next) => {
  try {
    const { transactionHash } = req.body;
    const result = await pool.query(
      `UPDATE project_milestones
       SET reached_at = NOW(), transaction_hash = $1
       WHERE id = $2 AND project_id = $3
       RETURNING *`,
      [transactionHash || null, req.params.milestoneId, req.params.id],
    );
    if (!result.rows[0]) {
      throw createApiError(404, "MILESTONE_NOT_FOUND", "Milestone not found");
    }

    logAdminAction({
      actor: req.body?.adminAddress || "unknown",
      action: "project.milestone.reach",
      targetType: "project_milestone",
      targetId: req.params.milestoneId,
      metadata: { projectId: req.params.id, transactionHash },
      ipAddress: req.ip,
    });

    res.json(mapProjectMilestoneRow(result.rows[0]));
  } catch (e) {
    next(e);
  }
});

function verificationRetiredError() {
  return createApiError(
    410,
    "PROJECT_VERIFICATION_DAO_REQUIRED",
    "Direct admin verification is retired. Project verification now runs through the DAO-governed on-chain flow.",
  );
}

/**
 * POST /api/projects/admin/register
 * Retired legacy endpoint kept only to fail closed after the DAO cutover.
 */
router.post("/admin/register", adminRequired, onChainAdminLimiter, async (req, res, next) => {
  try {
    const { projectId = null } = req.body || {};
    logAdminAction({
      actor: req.admin.sub,
      action: "project.verification.legacy_register_blocked",
      targetType: "project",
      targetId: projectId,
      metadata: { reason: "dao-governed-verification-required" },
      ipAddress: req.ip,
    });
    throw verificationRetiredError();
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/projects/admin/confirm
 * Retired legacy endpoint kept only to fail closed after the DAO cutover.
 */
router.post("/admin/confirm", adminRequired, onChainAdminLimiter, async (req, res, next) => {
  try {
    const { projectId = null, transactionHash = null } = req.body || {};
    logAdminAction({
      actor: req.admin.sub,
      action: "project.verification.legacy_confirm_blocked",
      targetType: "project",
      targetId: projectId,
      metadata: {
        reason: "dao-governed-verification-required",
        transactionHash,
      },
      ipAddress: req.ip,
    });
    throw verificationRetiredError();
  } catch (err) {
    next(err);
  }
});

router.put("/:id/translations/:language", adminRequired, projectMutationLimiter, async (req, res, next) => {
  try {
    const language = requireContentLanguage(req.params.language);
    const translated = validateTranslatedProject(req.body);
    const projectResult = await pool.query("SELECT id, source_language FROM projects WHERE id = $1", [req.params.id]);
    if (!projectResult.rows[0]) {
      throw createApiError(404, "PROJECT_NOT_FOUND", "Project not found");
    }
    if (language === projectResult.rows[0].source_language) {
      throw createApiError(409, "SOURCE_LANGUAGE_TRANSLATION", "A translation cannot replace the original language");
    }
    const result = await pool.query(
      `INSERT INTO project_translations
        (id, project_id, language, name, description, category, location, machine_translated, moderation_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
       ON CONFLICT (project_id, language) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description,
         category = EXCLUDED.category, location = EXCLUDED.location,
         machine_translated = EXCLUDED.machine_translated,
         impact_claims_reviewed = FALSE, moderation_status = 'pending', updated_at = NOW()
       RETURNING *`,
      [uuid(), req.params.id, language, translated.name, translated.description,
        translated.category, translated.location, translated.machineTranslated],
    );
    featuredCache.clear();
    logAdminAction({
      actor: req.admin.sub,
      action: "project.translation.submitted",
      targetType: "project_translation",
      targetId: result.rows[0].id,
      metadata: { projectId: req.params.id, language },
      ipAddress: req.ip,
    });
    res.status(201).json(result.rows[0]);
  } catch (e) {
    next(e);
  }
});

router.patch("/:id/translations/:language/moderation", adminRequired, statusLimiter, async (req, res, next) => {
  try {
    const language = requireContentLanguage(req.params.language);
    const { status, impactClaimsReviewed = false } = req.body || {};
    if (!TRANSLATION_STATUSES.includes(status)) {
      throw createApiError(400, "TRANSLATION_STATUS_INVALID", `status must be one of: ${TRANSLATION_STATUSES.join(", ")}`);
    }
    const existing = await pool.query(
      "SELECT * FROM project_translations WHERE project_id = $1 AND language = $2",
      [req.params.id, language],
    );
    if (!existing.rows[0]) {
      throw createApiError(404, "PROJECT_TRANSLATION_NOT_FOUND", "Project translation not found");
    }
    if (status === "approved" && existing.rows[0].machine_translated && impactClaimsReviewed !== true) {
      throw createApiError(400, "IMPACT_CLAIMS_REVIEW_REQUIRED", "Machine-translated impact claims require human review before approval");
    }
    const result = await pool.query(
      `UPDATE project_translations SET moderation_status = $1,
         impact_claims_reviewed = $2, updated_at = NOW()
       WHERE project_id = $3 AND language = $4 RETURNING *`,
      [status, impactClaimsReviewed === true, req.params.id, language],
    );
    featuredCache.clear();
    logAdminAction({
      actor: req.admin.sub,
      action: `project.translation.${status}`,
      targetType: "project_translation",
      targetId: result.rows[0].id,
      metadata: { projectId: req.params.id, language, impactClaimsReviewed: impactClaimsReviewed === true },
      ipAddress: req.ip,
    });
    res.json(result.rows[0]);
  } catch (e) {
    next(e);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const language = requestedLanguage(req);
    const values = [req.params.id];
    let languageParam = null;
    if (language) {
      values.push(language);
      languageParam = `$${values.length}`;
    }
    const localization = projectLocalizationSelect(languageParam);
    const projectResult = await pool.query(
      `SELECT p.*${localization.columns}${languageParam ? `, ${languageParam}::text AS requested_language` : ""}
       FROM projects p${localization.join} WHERE p.id = $1`,
      values,
    );
    if (!projectResult.rows[0]) {
      throw createApiError(404, "PROJECT_NOT_FOUND", "Project not found");
    }
    const campaigns = await fetchCampaignsForProject(req.params.id);
    const onChainProject = await getOnChainProject(req.params.id);

    // Fetch average rating
    const ratingResult = await pool.query(
      "SELECT AVG(rating) as avg_rating, COUNT(*) as count FROM project_ratings WHERE project_id = $1",
      [req.params.id],
    );

    // Fetch milestones
    const milestoneResult = await pool.query(
      "SELECT * FROM project_milestones WHERE project_id = $1 ORDER BY percentage ASC",
      [req.params.id],
    );

    const stroopsToXlm = (stroops) => {
      if (stroops === null || stroops === undefined) return "0.0000000";
      let value;
      try {
        value = typeof stroops === "bigint" ? stroops : BigInt(stroops);
      } catch {
        return "0.0000000";
      }
      const negative = value < 0n;
      if (negative) value = -value;
      const whole = value / 10000000n;
      const frac = value % 10000000n;
      const fracStr = frac.toString().padStart(7, "0");
      return `${negative ? "-" : ""}${whole.toString()}.${fracStr}`;
    };

    res.json({
      ...mapProjectRow(projectResult.rows[0]),
      serverNow: Date.now(),
      onChainVerified: Boolean(onChainProject) || Boolean(projectResult.rows[0].on_chain_verified),
      contractRegisteredAt: onChainProject ? Number(onChainProject.registered_at) : null,
      totalRaisedOnChain: onChainProject ? stroopsToXlm(onChainProject.total_raised) : "0.0000000",
      campaigns,
      activeCampaign: campaigns.find((campaign) => campaign.active) || null,
      averageRating: parseFloat(ratingResult.rows[0].avg_rating) || 0,
      ratingCount: parseInt(ratingResult.rows[0].count) || 0,
      milestones: milestoneResult.rows.map(mapProjectMilestoneRow),
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/projects/:id/generate-summary
 *
 * Generates (or regenerates) a 3-sentence donor-facing impact summary using
 * the Claude API and caches it on the project record. Body:
 *
 *   { adminAddress: "G..." }   // must equal projects.wallet_address
 *
 * Mirrors the admin-page convention (`isOwner = publicKey === walletAddress`)
 * so only the project owner can spend Anthropic API credits on their project.
 *
 * Response data: { aiSummary, aiSummaryGeneratedAt, aiSummaryModel,
 *                  aiSummarySourceHash }
 */
router.post("/:id/generate-summary", aiSummaryLimiter, async (req, res, next) => {
  try {
    const { adminAddress } = req.body || {};
    if (!adminAddress || typeof adminAddress !== "string") {
      throw createApiError(400, "ADMIN_ADDRESS_REQUIRED", "adminAddress is required");
    }

    const projectResult = await pool.query(
      "SELECT id, name, category, description, wallet_address FROM projects WHERE id = $1",
      [req.params.id],
    );
    const project = projectResult.rows[0];
    if (!project) {
      throw createApiError(404, "PROJECT_NOT_FOUND", "Project not found");
    }
    if (project.wallet_address !== adminAddress) {
      throw createApiError(403, "PROJECT_OWNER_REQUIRED", "Only the project owner can generate a summary");
    }

    await enqueueAISummary(req.params.id, {
      name: project.name,
      category: project.category,
      description: project.description,
      adminAddress,
    });

    logAdminAction({
      actor: adminAddress,
      action: "project.summary.enqueued",
      targetType: "project",
      targetId: req.params.id,
      metadata: {},
      ipAddress: req.ip,
    });

    res.status(202).json({ status: "queued" });
  } catch (e) {
    next(e);
  }
});

router.post("/:id/matching", projectMutationLimiter, async (req, res, next) => {
  try {
    const { matcherAddress, capXLM, multiplier, expiresAt } = req.body || {};

    if (!matcherAddress || typeof matcherAddress !== "string") {
      throw createApiError(400, "MATCHER_ADDRESS_REQUIRED", "matcherAddress is required");
    }
    if (!capXLM || isNaN(Number.parseFloat(capXLM)) || Number.parseFloat(capXLM) <= 0) {
      throw createApiError(400, "CAP_XLM_INVALID", "capXLM must be a positive number");
    }
    if (!multiplier || typeof multiplier !== "number" || multiplier < 1) {
      throw createApiError(400, "MULTIPLIER_INVALID", "multiplier must be >= 1");
    }
    if (!expiresAt || Number.isNaN(new Date(expiresAt).getTime())) {
      throw createApiError(400, "EXPIRES_AT_INVALID", "expiresAt must be a valid ISO date string");
    }
    if (new Date(expiresAt).getTime() <= Date.now()) {
      throw createApiError(400, "EXPIRES_AT_NOT_FUTURE", "expiresAt must be in the future");
    }

    const projectResult = await pool.query("SELECT id FROM projects WHERE id = $1", [req.params.id]);
    if (!projectResult.rows[0]) {
      throw createApiError(404, "PROJECT_NOT_FOUND", "Project not found");
    }

    const result = await pool.query(
      `INSERT INTO donation_matches (id, project_id, matcher_address, cap_xlm, multiplier, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, project_id, matcher_address, cap_xlm, multiplier, matched_xlm, expires_at, created_at`,
      [uuid(), req.params.id, matcherAddress, Number.parseFloat(capXLM).toFixed(7), multiplier, new Date(expiresAt).toISOString()],
    );

    logAdminAction({
      actor: matcherAddress,
      action: "project.matching.create",
      targetType: "donation_match",
      targetId: result.rows[0].id,
      metadata: { projectId: req.params.id, capXLM, multiplier, expiresAt },
      ipAddress: req.ip,
    });

    const row = result.rows[0];
    res.status(201).json({
      id: row.id,
      projectId: row.project_id,
      matcherAddress: row.matcher_address,
      capXLM: row.cap_xlm?.toString() || "0",
      multiplier: row.multiplier,
      matchedXLM: row.matched_xlm?.toString() || "0",
      expiresAt: new Date(row.expires_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
    });
  } catch (e) {
    next(e);
  }
});

router.get("/:id/matching", async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, project_id, matcher_address, cap_xlm, multiplier, matched_xlm, expires_at, created_at
       FROM donation_matches
       WHERE project_id = $1 AND expires_at > NOW()
       ORDER BY created_at DESC`,
      [req.params.id],
    );

    const matches = result.rows.map(row => ({
      id: row.id,
      projectId: row.project_id,
      matcherAddress: row.matcher_address,
      capXLM: row.cap_xlm?.toString() || "0",
      multiplier: row.multiplier,
      matchedXLM: row.matched_xlm?.toString() || "0",
      remainingXLM: (Number.parseFloat(row.cap_xlm) - Number.parseFloat(row.matched_xlm)).toFixed(7),
      expiresAt: new Date(row.expires_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
    }));

    res.json(matches);
  } catch (e) {
    next(e);
  }
});

/**
 * PATCH /api/projects/:id/status
 * Approve or reject a project. Body: { status: "active" | "rejected", reason?: string }
 * Requires a verified platform-admin JWT (adminRequired) — no client-supplied
 * identity claim is accepted as proof for this action.
 */
router.patch(
  "/:id/status",
  // adminRequired runs before validate so an unauthenticated caller is turned
  // away with a 401 rather than being told, via a 400, whether their body was
  // well-formed. It also sets req.admin so the subject-keyed limiter can
  // constrain the authenticated identity regardless of source address.
  adminRequired,
  statusLimiter,
  validate(ProjectStatusUpdateSchema),
  async (req, res, next) => {
    try {
      const { status, reason } = req.body;

      const projectResult = await pool.query("SELECT * FROM projects WHERE id = $1", [req.params.id]);
      if (!projectResult.rows[0]) {
        throw createApiError(404, "PROJECT_NOT_FOUND", "Project not found");
      }

      const result = await pool.query(
        `UPDATE projects
       SET status = $1,
           rejection_reason = $2,
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
        [status, reason || null, req.params.id],
      );

      logAdminAction({
        // The verified JWT subject, never a client-supplied adminAddress: the
        // request body is attacker-controlled, so trusting it here would let
        // anyone forge who an audited status change is attributed to.
        actor: req.admin.sub,
        action: `project.status.${status}`,
        targetType: "project",
        targetId: req.params.id,
        metadata: { previousStatus: projectResult.rows[0].status, reason },
        ipAddress: req.ip,
      });

      res.json(mapProjectRow(result.rows[0]));
    } catch (e) {
      next(e);
    }
  });

module.exports = router;
