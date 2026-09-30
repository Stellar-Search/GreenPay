"use strict";

const crypto = require("crypto");

const CLAIM_TYPES = ["avoided_emissions", "sequestration", "offset"];
const CLAIM_STATUSES = ["unverified", "operator_stated", "verified", "revoked", "expired"];
const EVIDENCE_TYPES = ["measurement", "baseline", "calculation", "monitoring_report", "other"];

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function toDate(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return new Date(value).toISOString().slice(0, 10);
}

function numberString(value) {
  return value === null || value === undefined ? null : value.toString();
}

function attestationIsCurrent(row, now = Date.now()) {
  if (!row.attestation_id || row.attestation_status !== "verified") return false;
  if (!row.attestation_expires_at) return false;
  return new Date(row.attestation_expires_at).getTime() > now;
}

function publicClaimStatus(row, now = Date.now()) {
  if (row.claim_status === "revoked" || row.revoked_at) return "revoked";
  if (row.attestation_id && row.attestation_status === "revoked") return "revoked";
  if (row.claim_status === "expired" || (row.expires_at && new Date(row.expires_at).getTime() <= now)) {
    return "expired";
  }
  if (row.attestation_id && row.attestation_status === "verified"
      && row.attestation_expires_at && new Date(row.attestation_expires_at).getTime() <= now) {
    return "expired";
  }
  if (attestationIsCurrent(row, now)) return "verified";
  if (row.claim_status === "operator_stated" || row.migrated_from_legacy) return "operator_stated";
  return "unverified";
}

function statusLabel(status) {
  return {
    verified: "Independently verified",
    operator_stated: "Operator-stated",
    unverified: "Unverified",
    revoked: "Withdrawn",
    expired: "Expired",
  }[status] || "Unverified";
}

function mapEvidence(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    id: item.id,
    type: item.evidenceType,
    sourceUri: item.sourceUri || null,
    contentHash: item.contentHash,
    description: item.description,
    measurementDate: item.measurementDate || null,
    submittedBy: item.submittedBy,
    createdAt: toIso(item.createdAt),
  }));
}

function mapClaimRow(row, now = Date.now()) {
  const status = publicClaimStatus(row, now);
  const evidence = mapEvidence(row.evidence);
  const attestation = row.attestation_id ? {
    id: row.attestation_id,
    verifierName: row.verifier_name,
    verifierAddress: row.verifier_address,
    attestationHash: row.attestation_hash,
    evidenceDigest: row.evidence_digest,
    status: row.attestation_status,
    contractId: row.contract_id || null,
    transactionHash: row.anchor_transaction_hash || null,
    ledger: row.anchor_ledger === null || row.anchor_ledger === undefined
      ? null
      : Number(row.anchor_ledger),
    issuedAt: toIso(row.attestation_issued_at),
    expiresAt: toIso(row.attestation_expires_at),
    revokedAt: toIso(row.attestation_revoked_at),
    revocationReason: row.attestation_revocation_reason || null,
    revocationTransactionHash: row.revocation_transaction_hash || null,
  } : null;

  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name || null,
    category: row.category || null,
    claimType: row.claim_type,
    quantity: {
      value: numberString(row.quantity),
      lowerBound: numberString(row.uncertainty_low),
      upperBound: numberString(row.uncertainty_high),
      unit: row.unit,
    },
    uncertainty: {
      lowerBound: numberString(row.uncertainty_low),
      upperBound: numberString(row.uncertainty_high),
      confidencePercent: row.confidence_percent === null || row.confidence_percent === undefined
        ? null
        : Number(row.confidence_percent),
    },
    methodology: {
      id: row.methodology_id,
      code: row.methodology_code,
      name: row.methodology_name,
      version: row.methodology_version,
      description: row.methodology_description,
      accountingApproach: row.accounting_approach,
      limitations: row.methodology_limitations,
      comparisonScope: row.comparison_scope,
      registryUrl: row.registry_url || null,
    },
    measurementPeriod: {
      start: toDate(row.measurement_period_start),
      end: toDate(row.measurement_period_end),
    },
    vintage: row.vintage_start || row.vintage_end ? {
      start: toDate(row.vintage_start),
      end: toDate(row.vintage_end),
    } : null,
    baseline: row.baseline_description,
    evidence,
    provenance: {
      status,
      label: statusLabel(status),
      assertedBy: row.asserting_party,
      assertingPartyType: row.asserting_party_type,
      assertedAt: toIso(row.asserted_at),
      expiresAt: toIso(row.expires_at),
      revokedAt: toIso(row.revoked_at),
      revocationReason: row.revocation_reason || null,
      migratedFromLegacy: Boolean(row.migrated_from_legacy),
      migrationNote: row.migration_note || null,
      attestation,
    },
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((result, key) => {
      if (value[key] !== undefined) result[key] = canonicalize(value[key]);
      return result;
    }, {});
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function buildAttestationPayload(claim) {
  return canonicalize({
    schema: "greenpay-impact-attestation/v1",
    claimId: claim.id,
    projectId: claim.projectId,
    claimType: claim.claimType,
    quantity: claim.quantity,
    methodology: {
      code: claim.methodology.code,
      version: claim.methodology.version,
    },
    measurementPeriod: claim.measurementPeriod,
    vintage: claim.vintage,
    baseline: claim.baseline,
    assertedBy: claim.provenance.assertedBy,
    assertedAt: claim.provenance.assertedAt,
    evidence: claim.evidence.map((item) => ({
      contentHash: item.contentHash,
      evidenceType: item.type,
    })).sort((a, b) => `${a.evidenceType}:${a.contentHash}`.localeCompare(`${b.evidenceType}:${b.contentHash}`)),
  });
}

function hashAttestationPayload(payload) {
  return sha256(canonicalJson(payload));
}

function evidenceDigest(evidence) {
  const hashes = evidence.map((item) => item.contentHash).sort();
  return sha256(hashes.join("\n"));
}

function claimSummary(claims) {
  const summary = {
    total: claims.length,
    verified: 0,
    operatorStated: 0,
    unverified: 0,
    revoked: 0,
    expired: 0,
  };
  for (const claim of claims) {
    if (claim.provenance.status === "operator_stated") summary.operatorStated += 1;
    else if (Object.prototype.hasOwnProperty.call(summary, claim.provenance.status)) {
      summary[claim.provenance.status] += 1;
    }
  }
  return summary;
}

function groupComparableClaims(claims) {
  const groups = new Map();
  for (const claim of claims) {
    const key = [claim.claimType, claim.methodology.code, claim.methodology.version, claim.quantity.unit].join("|");
    if (!groups.has(key)) {
      groups.set(key, {
        claimType: claim.claimType,
        unit: claim.quantity.unit,
        methodology: claim.methodology,
        claims: [],
      });
    }
    groups.get(key).claims.push(claim);
  }
  return Array.from(groups.values()).map((group) => ({
    ...group,
    claimCount: group.claims.length,
    verifiedClaimCount: group.claims.filter((claim) => claim.provenance.status === "verified").length,
    range: {
      lowerBound: group.claims.reduce((total, claim) => total + Number(claim.quantity.lowerBound || 0), 0).toString(),
      upperBound: group.claims.reduce((total, claim) => total + Number(claim.quantity.upperBound || 0), 0).toString(),
      unit: group.unit,
    },
  }));
}

module.exports = {
  CLAIM_TYPES,
  CLAIM_STATUSES,
  EVIDENCE_TYPES,
  buildAttestationPayload,
  canonicalJson,
  claimSummary,
  evidenceDigest,
  groupComparableClaims,
  hashAttestationPayload,
  mapClaimRow,
  publicClaimStatus,
};
