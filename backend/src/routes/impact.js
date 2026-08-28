/**
 * Evidence-first impact routes.
 *
 * Donation totals and environmental outcome claims deliberately travel beside
 * one another. A donation is never multiplied by a project-authored rate and
 * no API allocates a project-level outcome to an individual donor.
 */
"use strict";

const express = require("express");
const { v4: uuid } = require("uuid");
const router = express.Router();
const pool = require("../db/pool");
const cache = require("../services/cache");
const { UUID } = require("../schemas/common");
const { adminRequired } = require("../middleware/auth");
const { createApiError } = require("../middleware/apiEnvelope");
const { isValidStellarAddress } = require("../../../shared/validators/stellarValidator");
const {
  CLAIM_TYPES,
  EVIDENCE_TYPES,
  buildAttestationPayload,
  claimSummary,
  evidenceDigest,
  groupComparableClaims,
  hashAttestationPayload,
  mapClaimRow,
} = require("../services/impactClaims");
const { observedDonationsCte } = require("../services/donationIntegrity");

const CACHE_TTL_MS = 5 * 60 * 1000;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const PARTY_TYPES = ["project_operator", "data_provider"];

function validateKey(key) {
  if (!key || !isValidStellarAddress(key)) {
    throw createApiError(400, "INVALID_PUBLIC_KEY", "Invalid Stellar public key");
  }
}

function validateId(id, code = "INVALID_ID", label = "id") {
  if (!id || !UUID.test(id)) {
    throw createApiError(400, code, `Invalid ${label}`);
  }
}

function requiredText(value, field, minLength = 1) {
  if (typeof value !== "string" || value.trim().length < minLength) {
    throw createApiError(400, "IMPACT_FIELD_INVALID", `${field} is required`);
  }
  return value.trim();
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nonNegativeNumber(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw createApiError(400, "IMPACT_NUMBER_INVALID", `${field} must be a non-negative number`);
  }
  return parsed;
}

function dateOnly(value, field) {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime())) {
    throw createApiError(400, "IMPACT_DATE_INVALID", `${field} must be a valid date`);
  }
  return parsed.toISOString().slice(0, 10);
}

function timestamp(value, field) {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime())) {
    throw createApiError(400, "IMPACT_DATE_INVALID", `${field} must be a valid timestamp`);
  }
  return parsed.toISOString();
}

function normalizeHash(value, field) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!HASH_PATTERN.test(normalized)) {
    throw createApiError(400, "IMPACT_HASH_INVALID", `${field} must be a 64-character SHA-256 hex digest`);
  }
  return normalized;
}

function projectCacheKey(id) {
  return `impact:project:${id}`;
}

function globalCacheKey() {
  return "impact:global";
}

function donorCacheKey(publicKey) {
  return `impact:donor:${publicKey}`;
}

function sendCached(res, key, payload) {
  cache.set(key, payload, CACHE_TTL_MS);
  res.set("Cache-Control", "public, max-age=300");
  return res.json(payload);
}

function clearImpactCache() {
  cache.clear();
}

const PUBLIC_CLAIMS_QUERY = `WITH ${observedDonationsCte("impactFigures")}
  SELECT
    c.*,
    c.status AS claim_status,
    p.name AS project_name,
    p.category,
    m.code AS methodology_code,
    m.name AS methodology_name,
    m.version AS methodology_version,
    m.description AS methodology_description,
    m.accounting_approach,
    m.limitations AS methodology_limitations,
    m.comparison_scope,
    m.registry_url,
    a.id AS attestation_id,
    a.verifier_name,
    a.verifier_address,
    a.attestation_hash,
    a.evidence_digest,
    a.status AS attestation_status,
    a.contract_id,
    a.anchor_transaction_hash,
    a.anchor_ledger,
    a.issued_at AS attestation_issued_at,
    a.expires_at AS attestation_expires_at,
    a.revoked_at AS attestation_revoked_at,
    a.revocation_reason AS attestation_revocation_reason,
    a.revocation_transaction_hash,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', e.id,
        'evidenceType', e.evidence_type,
        'sourceUri', e.source_uri,
        'contentHash', e.content_hash,
        'description', e.description,
        'measurementDate', e.measurement_date,
        'submittedBy', e.submitted_by,
        'createdAt', e.created_at
      ) ORDER BY e.created_at ASC)
      FROM impact_evidence e
      WHERE e.claim_id = c.id
    ), '[]'::jsonb) AS evidence
  FROM impact_claims c
  JOIN projects p ON p.id = c.project_id
  JOIN impact_methodologies m ON m.id = c.methodology_id
  LEFT JOIN LATERAL (
    SELECT ia.*
    FROM impact_attestations ia
    WHERE ia.claim_id = c.id
    ORDER BY ia.issued_at DESC, ia.created_at DESC
    LIMIT 1
  ) a ON TRUE
  WHERE ($1::uuid IS NULL OR c.project_id = $1::uuid)
    AND ($2::text IS NULL OR EXISTS (
      SELECT 1
      FROM surface_donations d
      WHERE d.project_id = c.project_id
        AND d.donor_address = $2::text
    ))
    AND ($3::uuid IS NULL OR c.id = $3::uuid)
  ORDER BY c.asserted_at DESC, c.id ASC`;

async function fetchClaims({ projectId = null, donorAddress = null, claimId = null } = {}) {
  const result = await pool.query(PUBLIC_CLAIMS_QUERY, [projectId, donorAddress, claimId]);
  return result.rows.map((row) => mapClaimRow(row));
}

// GET /api/impact/methodologies
router.get("/methodologies", async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, code, name, version, claim_type, unit, description,
              accounting_approach, limitations, comparison_scope,
              registry_url, active, created_at, updated_at
         FROM impact_methodologies
        ORDER BY active DESC, name ASC, version DESC`,
    );
    res.json(result.rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      version: row.version,
      claimType: row.claim_type,
      unit: row.unit,
      description: row.description,
      accountingApproach: row.accounting_approach,
      limitations: row.limitations,
      comparisonScope: row.comparison_scope,
      registryUrl: row.registry_url || null,
      active: row.active,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    })));
  } catch (error) {
    next(error);
  }
});

// POST /api/impact/methodologies — explicit registry administration.
router.post("/methodologies", adminRequired, async (req, res, next) => {
  try {
    const claimType = requiredText(req.body?.claimType, "claimType");
    if (!CLAIM_TYPES.includes(claimType)) {
      throw createApiError(400, "IMPACT_CLAIM_TYPE_INVALID", `claimType must be one of: ${CLAIM_TYPES.join(", ")}`);
    }
    const values = [
      uuid(),
      requiredText(req.body?.code, "code"),
      requiredText(req.body?.name, "name"),
      requiredText(req.body?.version, "version"),
      claimType,
      requiredText(req.body?.unit, "unit"),
      requiredText(req.body?.description, "description", 20),
      requiredText(req.body?.accountingApproach, "accountingApproach", 20),
      requiredText(req.body?.limitations, "limitations", 20),
      requiredText(req.body?.comparisonScope, "comparisonScope"),
      optionalText(req.body?.registryUrl),
    ];
    const result = await pool.query(
      `INSERT INTO impact_methodologies
        (id, code, name, version, claim_type, unit, description,
         accounting_approach, limitations, comparison_scope, registry_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      values,
    );
    clearImpactCache();
    res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

// GET /api/impact/project/:id
router.get("/project/:id", async (req, res, next) => {
  try {
    validateId(req.params.id, "INVALID_PROJECT_ID", "project id");
    const key = projectCacheKey(req.params.id);
    const hit = cache.get(key);
    if (hit) return res.json(hit);

    const projectResult = await pool.query(
      "SELECT id, name, category FROM projects WHERE id = $1",
      [req.params.id],
    );
    if (!projectResult.rows[0]) {
      throw createApiError(404, "PROJECT_NOT_FOUND", "Project not found");
    }
    const donationsResult = await pool.query(
      `WITH ${observedDonationsCte("displayedTotals")}
       SELECT COALESCE(SUM(d.amount_xlm), 0) AS "totalDonationsXLM",
              COUNT(DISTINCT d.donor_address)::int AS "donorCount"
         FROM surface_donations d
        WHERE d.project_id = $1
          AND (d.currency = 'XLM' OR d.currency IS NULL)`,
      [req.params.id],
    );
    const claims = await fetchClaims({ projectId: req.params.id });
    const donationRow = donationsResult.rows[0] || {};

    return sendCached(res, key, {
      totalDonationsXLM: Number(donationRow.totalDonationsXLM || 0).toFixed(7),
      donorCount: Number(donationRow.donorCount || 0),
      claims,
      claimSummary: claimSummary(claims),
      comparableImpactGroups: groupComparableClaims(claims),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/impact/global
router.get("/global", async (_req, res, next) => {
  try {
    const key = globalCacheKey();
    const hit = cache.get(key);
    if (hit) return res.json(hit);

    const totalsResult = await pool.query(
      `WITH ${observedDonationsCte("displayedTotals")}
       SELECT COALESCE(SUM(d.amount_xlm), 0) AS "totalDonationsXLM",
              COUNT(DISTINCT d.donor_address)::int AS "donorCount"
         FROM surface_donations d
        WHERE (d.currency = 'XLM' OR d.currency IS NULL)`,
    );
    const breakdownResult = await pool.query(
      `WITH ${observedDonationsCte("displayedTotals")}
       SELECT p.category,
              COALESCE(SUM(d.amount_xlm), 0) AS "totalDonationsXLM",
              COUNT(DISTINCT d.donor_address)::int AS "donorCount"
         FROM surface_donations d
         JOIN projects p ON p.id = d.project_id
        WHERE (d.currency = 'XLM' OR d.currency IS NULL)
        GROUP BY p.category
        ORDER BY "totalDonationsXLM" DESC, p.category ASC`,
    );
    const claims = await fetchClaims();
    const totals = totalsResult.rows[0] || {};
    const categoryClaimCounts = claims.reduce((counts, claim) => {
      const category = claim.category || "Uncategorised";
      const current = counts.get(category) || { total: 0, verified: 0 };
      current.total += 1;
      if (claim.provenance.status === "verified") current.verified += 1;
      counts.set(category, current);
      return counts;
    }, new Map());

    return sendCached(res, key, {
      totalDonationsXLM: Number(totals.totalDonationsXLM || 0).toFixed(7),
      donorCount: Number(totals.donorCount || 0),
      claimSummary: claimSummary(claims),
      comparableImpactGroups: groupComparableClaims(claims),
      breakdownByCategory: breakdownResult.rows.map((row) => ({
        category: row.category,
        totalDonationsXLM: Number(row.totalDonationsXLM || 0).toFixed(7),
        donorCount: Number(row.donorCount || 0),
        claimCount: categoryClaimCounts.get(row.category)?.total || 0,
        verifiedClaimCount: categoryClaimCounts.get(row.category)?.verified || 0,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/impact/donor/:publicKey
router.get("/donor/:publicKey", async (req, res, next) => {
  try {
    validateKey(req.params.publicKey);
    const key = donorCacheKey(req.params.publicKey);
    const hit = cache.get(key);
    if (hit) return res.json(hit);

    const totalsResult = await pool.query(
      `WITH ${observedDonationsCte("impactFigures")}
       SELECT COALESCE(SUM(d.amount_xlm), 0) AS "totalDonatedXLM",
              COUNT(DISTINCT d.project_id)::int AS "projectsSupported"
         FROM surface_donations d
        WHERE d.donor_address = $1
          AND (d.currency = 'XLM' OR d.currency IS NULL)`,
      [req.params.publicKey],
    );
    const topCategoryResult = await pool.query(
      `WITH ${observedDonationsCte("impactFigures")}
       SELECT p.category, COALESCE(SUM(d.amount_xlm), 0) AS total
         FROM surface_donations d
         JOIN projects p ON p.id = d.project_id
        WHERE d.donor_address = $1
          AND (d.currency = 'XLM' OR d.currency IS NULL)
        GROUP BY p.category
        ORDER BY total DESC
        LIMIT 1`,
      [req.params.publicKey],
    );
    const supportedProjectClaims = await fetchClaims({ donorAddress: req.params.publicKey });
    const totals = totalsResult.rows[0] || {};

    return sendCached(res, key, {
      totalDonatedXLM: Number(totals.totalDonatedXLM || 0).toFixed(7),
      projectsSupported: Number(totals.projectsSupported || 0),
      topCategory: topCategoryResult.rows[0]?.category || null,
      supportedProjectClaims,
      claimSummary: claimSummary(supportedProjectClaims),
      attributionNotice: "These are project-level outcomes. GreenPay does not allocate them to this donor in proportion to XLM donated.",
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/impact/project/:id/claims — operator assertion intake.
router.post("/project/:id/claims", adminRequired, async (req, res, next) => {
  try {
    validateId(req.params.id, "INVALID_PROJECT_ID", "project id");
    const claimType = requiredText(req.body?.claimType, "claimType");
    if (!CLAIM_TYPES.includes(claimType)) {
      throw createApiError(400, "IMPACT_CLAIM_TYPE_INVALID", `claimType must be one of: ${CLAIM_TYPES.join(", ")}`);
    }
    const assertingPartyType = req.body?.assertingPartyType || "project_operator";
    if (!PARTY_TYPES.includes(assertingPartyType)) {
      throw createApiError(400, "IMPACT_PARTY_TYPE_INVALID", `assertingPartyType must be one of: ${PARTY_TYPES.join(", ")}`);
    }
    validateId(req.body?.methodologyId, "IMPACT_METHODOLOGY_INVALID", "methodology id");
    const quantity = nonNegativeNumber(req.body?.quantity, "quantity");
    const low = nonNegativeNumber(req.body?.uncertainty?.lowerBound, "uncertainty.lowerBound");
    const high = nonNegativeNumber(req.body?.uncertainty?.upperBound, "uncertainty.upperBound");
    if (low > quantity || quantity > high) {
      throw createApiError(400, "IMPACT_UNCERTAINTY_INVALID", "quantity must fall inside the uncertainty range");
    }
    const confidence = req.body?.uncertainty?.confidencePercent === null || req.body?.uncertainty?.confidencePercent === undefined
      ? null
      : nonNegativeNumber(req.body.uncertainty.confidencePercent, "uncertainty.confidencePercent");
    if (confidence !== null && (confidence <= 0 || confidence > 100)) {
      throw createApiError(400, "IMPACT_CONFIDENCE_INVALID", "confidencePercent must be greater than 0 and at most 100");
    }
    const start = dateOnly(req.body?.measurementPeriod?.start, "measurementPeriod.start");
    const end = dateOnly(req.body?.measurementPeriod?.end, "measurementPeriod.end");
    if (start > end) {
      throw createApiError(400, "IMPACT_PERIOD_INVALID", "measurementPeriod.start must be on or before measurementPeriod.end");
    }
    const vintageStart = req.body?.vintage?.start ? dateOnly(req.body.vintage.start, "vintage.start") : null;
    const vintageEnd = req.body?.vintage?.end ? dateOnly(req.body.vintage.end, "vintage.end") : null;
    if (vintageStart && vintageEnd && vintageStart > vintageEnd) {
      throw createApiError(400, "IMPACT_VINTAGE_INVALID", "vintage.start must be on or before vintage.end");
    }
    const expiresAt = req.body?.expiresAt ? timestamp(req.body.expiresAt, "expiresAt") : null;

    const projectResult = await pool.query("SELECT id FROM projects WHERE id = $1", [req.params.id]);
    if (!projectResult.rows[0]) {
      throw createApiError(404, "PROJECT_NOT_FOUND", "Project not found");
    }
    const methodologyResult = await pool.query(
      "SELECT id, claim_type, unit, active FROM impact_methodologies WHERE id = $1",
      [req.body.methodologyId],
    );
    const methodology = methodologyResult.rows[0];
    if (!methodology || !methodology.active) {
      throw createApiError(400, "IMPACT_METHODOLOGY_INACTIVE", "methodology must exist and be active");
    }
    const unit = requiredText(req.body?.unit, "unit");
    if (methodology.claim_type !== claimType || methodology.unit !== unit) {
      throw createApiError(400, "IMPACT_METHODOLOGY_MISMATCH", "claim type and unit must match the registered methodology");
    }

    const claimId = uuid();
    await pool.query(
      `INSERT INTO impact_claims (
        id, project_id, methodology_id, claim_type, quantity, unit,
        uncertainty_low, uncertainty_high, confidence_percent,
        measurement_period_start, measurement_period_end, vintage_start, vintage_end,
        baseline_description, asserting_party, asserting_party_type, status, expires_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16, 'operator_stated', $17
      )`,
      [
        claimId, req.params.id, req.body.methodologyId, claimType, quantity, unit,
        low, high, confidence, start, end, vintageStart, vintageEnd,
        requiredText(req.body?.baseline, "baseline", 10),
        requiredText(req.body?.assertedBy, "assertedBy"), assertingPartyType, expiresAt,
      ],
    );
    clearImpactCache();
    const claims = await fetchClaims({ claimId });
    res.status(201).json(claims[0]);
  } catch (error) {
    next(error);
  }
});

// POST /api/impact/claims/:id/evidence
router.post("/claims/:id/evidence", adminRequired, async (req, res, next) => {
  try {
    validateId(req.params.id, "INVALID_IMPACT_CLAIM_ID", "impact claim id");
    const evidenceType = requiredText(req.body?.evidenceType, "evidenceType");
    if (!EVIDENCE_TYPES.includes(evidenceType)) {
      throw createApiError(400, "IMPACT_EVIDENCE_TYPE_INVALID", `evidenceType must be one of: ${EVIDENCE_TYPES.join(", ")}`);
    }
    const claimResult = await pool.query(
      `SELECT c.id,
              EXISTS (SELECT 1 FROM impact_attestations a WHERE a.claim_id = c.id) AS attested
         FROM impact_claims c
        WHERE c.id = $1`,
      [req.params.id],
    );
    if (!claimResult.rows[0]) {
      throw createApiError(404, "IMPACT_CLAIM_NOT_FOUND", "Impact claim not found");
    }
    if (claimResult.rows[0].attested) {
      throw createApiError(409, "IMPACT_CLAIM_IMMUTABLE", "Evidence is immutable after attestation; publish a superseding claim instead");
    }
    const result = await pool.query(
      `INSERT INTO impact_evidence
        (id, claim_id, evidence_type, source_uri, content_hash, description, measurement_date, submitted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        uuid(), req.params.id, evidenceType, optionalText(req.body?.sourceUri),
        normalizeHash(req.body?.contentHash, "contentHash"),
        requiredText(req.body?.description, "description", 10),
        req.body?.measurementDate ? dateOnly(req.body.measurementDate, "measurementDate") : null,
        requiredText(req.body?.submittedBy, "submittedBy"),
      ],
    );
    clearImpactCache();
    res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

// POST /api/impact/claims/:id/attestations
router.post("/claims/:id/attestations", adminRequired, async (req, res, next) => {
  try {
    validateId(req.params.id, "INVALID_IMPACT_CLAIM_ID", "impact claim id");
    const claims = await fetchClaims({ claimId: req.params.id });
    const claim = claims[0];
    if (!claim) {
      throw createApiError(404, "IMPACT_CLAIM_NOT_FOUND", "Impact claim not found");
    }
    if (["revoked", "expired"].includes(claim.provenance.status)) {
      throw createApiError(409, "IMPACT_CLAIM_INACTIVE", "A withdrawn or expired claim cannot be attested");
    }
    const payload = buildAttestationPayload(claim);
    const expectedHash = hashAttestationPayload(payload);
    if (req.body?.attestationHash && normalizeHash(req.body.attestationHash, "attestationHash") !== expectedHash) {
      throw createApiError(400, "ATTESTATION_HASH_MISMATCH", "attestationHash does not match the canonical claim payload");
    }
    const expectedEvidenceDigest = evidenceDigest(claim.evidence);
    if (req.body?.evidenceDigest && normalizeHash(req.body.evidenceDigest, "evidenceDigest") !== expectedEvidenceDigest) {
      throw createApiError(400, "EVIDENCE_DIGEST_MISMATCH", "evidenceDigest does not match the claim evidence set");
    }
    const expiresAt = timestamp(req.body?.expiresAt, "expiresAt");
    if (new Date(expiresAt).getTime() <= Date.now()) {
      throw createApiError(400, "ATTESTATION_EXPIRY_INVALID", "expiresAt must be in the future");
    }
    const contractId = optionalText(req.body?.contractId);
    const transactionHash = optionalText(req.body?.transactionHash);
    const anchorLedger = req.body?.anchorLedger === undefined || req.body?.anchorLedger === null
      ? null
      : nonNegativeNumber(req.body.anchorLedger, "anchorLedger");
    const anchored = Boolean(contractId && transactionHash && anchorLedger !== null);
    const attestationId = uuid();
    await pool.query(
      `INSERT INTO impact_attestations (
        id, claim_id, verifier_name, verifier_address, canonical_payload,
        attestation_hash, evidence_digest, status, contract_id,
        anchor_transaction_hash, anchor_ledger, expires_at
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12)`,
      [
        attestationId, claim.id,
        requiredText(req.body?.verifierName, "verifierName"),
        requiredText(req.body?.verifierAddress, "verifierAddress"),
        JSON.stringify(payload), expectedHash, expectedEvidenceDigest,
        anchored ? "verified" : "pending_anchor",
        contractId, transactionHash, anchorLedger, expiresAt,
      ],
    );
    if (anchored) {
      await pool.query("UPDATE impact_claims SET status = 'verified', updated_at = NOW() WHERE id = $1", [claim.id]);
    }
    clearImpactCache();
    res.status(201).json({
      id: attestationId,
      claimId: claim.id,
      canonicalPayload: payload,
      attestationHash: expectedHash,
      evidenceDigest: expectedEvidenceDigest,
      status: anchored ? "verified" : "pending_anchor",
      anchor: anchored ? { contractId, transactionHash, ledger: anchorLedger } : null,
      expiresAt,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/impact/attestations/:id/anchor — confirm the Soroban receipt.
router.post("/attestations/:id/anchor", adminRequired, async (req, res, next) => {
  try {
    validateId(req.params.id, "INVALID_ATTESTATION_ID", "attestation id");
    const result = await pool.query(
      `UPDATE impact_attestations
          SET status = 'verified', contract_id = $2,
              anchor_transaction_hash = $3, anchor_ledger = $4, updated_at = NOW()
        WHERE id = $1 AND status = 'pending_anchor'
        RETURNING claim_id, attestation_hash, expires_at`,
      [
        req.params.id,
        requiredText(req.body?.contractId, "contractId"),
        requiredText(req.body?.transactionHash, "transactionHash"),
        nonNegativeNumber(req.body?.anchorLedger, "anchorLedger"),
      ],
    );
    if (!result.rows[0]) {
      throw createApiError(404, "PENDING_ATTESTATION_NOT_FOUND", "Pending attestation not found");
    }
    await pool.query("UPDATE impact_claims SET status = 'verified', updated_at = NOW() WHERE id = $1", [result.rows[0].claim_id]);
    clearImpactCache();
    res.json({
      id: req.params.id,
      claimId: result.rows[0].claim_id,
      attestationHash: result.rows[0].attestation_hash,
      status: "verified",
      expiresAt: new Date(result.rows[0].expires_at).toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/impact/attestations/:id/revoke — historical row remains visible.
router.post("/attestations/:id/revoke", adminRequired, async (req, res, next) => {
  try {
    validateId(req.params.id, "INVALID_ATTESTATION_ID", "attestation id");
    const result = await pool.query(
      `UPDATE impact_attestations
          SET status = 'revoked', revoked_at = NOW(), revocation_reason = $2,
              revocation_transaction_hash = $3, updated_at = NOW()
        WHERE id = $1 AND status IN ('verified', 'pending_anchor')
        RETURNING claim_id, revoked_at`,
      [
        req.params.id,
        requiredText(req.body?.reason, "reason", 10),
        requiredText(req.body?.transactionHash, "transactionHash"),
      ],
    );
    if (!result.rows[0]) {
      throw createApiError(404, "ACTIVE_ATTESTATION_NOT_FOUND", "Active attestation not found");
    }
    await pool.query(
      `UPDATE impact_claims
          SET status = 'operator_stated', updated_at = NOW()
        WHERE id = $1 AND status = 'verified'`,
      [result.rows[0].claim_id],
    );
    clearImpactCache();
    res.json({
      id: req.params.id,
      claimId: result.rows[0].claim_id,
      status: "revoked",
      revokedAt: new Date(result.rows[0].revoked_at).toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/impact/claims/:id/revoke — operator withdrawal, also anchored.
router.post("/claims/:id/revoke", adminRequired, async (req, res, next) => {
  try {
    validateId(req.params.id, "INVALID_IMPACT_CLAIM_ID", "impact claim id");
    const reason = requiredText(req.body?.reason, "reason", 10);
    const transactionHash = requiredText(req.body?.transactionHash, "transactionHash");
    const result = await pool.query(
      `UPDATE impact_claims
          SET status = 'revoked', revoked_at = NOW(), revocation_reason = $2,
              updated_at = NOW()
        WHERE id = $1 AND status NOT IN ('revoked', 'expired')
        RETURNING id, revoked_at`,
      [req.params.id, reason],
    );
    if (!result.rows[0]) {
      throw createApiError(404, "ACTIVE_IMPACT_CLAIM_NOT_FOUND", "Active impact claim not found");
    }
    await pool.query(
      `UPDATE impact_attestations
          SET status = 'revoked', revoked_at = NOW(), revocation_reason = $2,
              revocation_transaction_hash = $3, updated_at = NOW()
        WHERE claim_id = $1 AND status IN ('verified', 'pending_anchor')`,
      [req.params.id, reason, transactionHash],
    );
    clearImpactCache();
    res.json({
      id: result.rows[0].id,
      status: "revoked",
      revokedAt: new Date(result.rows[0].revoked_at).toISOString(),
      behavior: "Existing certificates retain this claim id and resolve to the current withdrawn status.",
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/impact/claims/:id/verification — independent donor check material.
router.get("/claims/:id/verification", async (req, res, next) => {
  try {
    validateId(req.params.id, "INVALID_IMPACT_CLAIM_ID", "impact claim id");
    const claims = await fetchClaims({ claimId: req.params.id });
    const claim = claims[0];
    if (!claim) {
      throw createApiError(404, "IMPACT_CLAIM_NOT_FOUND", "Impact claim not found");
    }
    const payload = buildAttestationPayload(claim);
    const computedHash = hashAttestationPayload(payload);
    const attestation = claim.provenance.attestation;
    res.json({
      claimId: claim.id,
      currentStatus: claim.provenance.status,
      canonicalPayload: payload,
      computedHash,
      recordedHash: attestation?.attestationHash || null,
      payloadMatchesAttestation: Boolean(attestation && computedHash === attestation.attestationHash),
      anchor: attestation ? {
        contractId: attestation.contractId,
        transactionHash: attestation.transactionHash,
        ledger: attestation.ledger,
        verifierAddress: attestation.verifierAddress,
      } : null,
      revocation: attestation?.status === "revoked" || claim.provenance.status === "revoked" ? {
        revokedAt: attestation?.revokedAt || claim.provenance.revokedAt,
        reason: attestation?.revocationReason || claim.provenance.revocationReason,
        transactionHash: attestation?.revocationTransactionHash || null,
      } : null,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
