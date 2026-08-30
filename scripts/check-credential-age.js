#!/usr/bin/env node

/**
 * scripts/check-credential-age.js
 *
 * Credential age tracking and overdue credential alert tool.
 *
 * Checks issuance timestamps for configured credentials against policy max age (default: 90 days).
 * Outputs structured health report and surfaces any overdue credentials.
 *
 * Usage:
 *   node scripts/check-credential-age.js
 *   node scripts/check-credential-age.js --max-age-days 60
 */

"use strict";

const { env } = require("../backend/src/config/env");

const DEFAULT_MAX_AGE_DAYS = env.credentialMaxAgeDays || 90;
const DAY_IN_MS = 86400000;

function evaluateCredentialAge(name, issuedAtStr, maxAgeDays = DEFAULT_MAX_AGE_DAYS, now = new Date()) {
  if (!issuedAtStr) {
    return {
      name,
      status: "UNKNOWN",
      ageDays: null,
      maxAgeDays,
      overdue: false,
      message: "No issuance timestamp tracked (untracked)",
    };
  }

  const issuedDate = new Date(issuedAtStr);
  if (isNaN(issuedDate.getTime())) {
    return {
      name,
      status: "INVALID",
      ageDays: null,
      maxAgeDays,
      overdue: true,
      message: `Invalid ISO timestamp: "${issuedAtStr}"`,
    };
  }

  const ageMs = now.getTime() - issuedDate.getTime();
  const ageDays = Math.floor(ageMs / DAY_IN_MS);
  const overdue = ageDays > maxAgeDays;

  return {
    name,
    status: overdue ? "OVERDUE" : "HEALTHY",
    issuedAt: issuedDate.toISOString(),
    ageDays,
    maxAgeDays,
    overdue,
    message: overdue
      ? `Credential age (${ageDays} days) exceeds policy limit (${maxAgeDays} days)`
      : `Credential is within policy limit (${ageDays}/${maxAgeDays} days)`,
  };
}

function auditAllCredentials(customConfig = {}) {
  const cfg = { ...env, ...customConfig };
  const maxAge = cfg.credentialMaxAgeDays || DEFAULT_MAX_AGE_DAYS;
  const now = customConfig.now || new Date();

  const results = [
    evaluateCredentialAge("PostgreSQL Password", cfg.credentialIssuedAtPostgres, maxAge, now),
    evaluateCredentialAge("Admin API Key / Password", cfg.credentialIssuedAtAdmin, maxAge, now),
    evaluateCredentialAge("Matcher Secret Key", cfg.credentialIssuedAtMatcher, maxAge, now),
  ];

  const overdueCount = results.filter((r) => r.overdue).length;
  const healthy = overdueCount === 0;

  return {
    timestamp: now.toISOString(),
    healthy,
    overdueCount,
    totalTracked: results.filter((r) => r.ageDays !== null).length,
    credentials: results,
  };
}

function runCli() {
  console.log("=================================================");
  console.log(" GreenPay Credential Age Audit & Monitoring");
  console.log("=================================================");

  const report = auditAllCredentials();

  console.log(`Audit Timestamp: ${report.timestamp}`);
  console.log(`Policy Max Age:  ${DEFAULT_MAX_AGE_DAYS} days\n`);

  console.log("Credential Status:");
  report.credentials.forEach((c) => {
    const icon = c.status === "HEALTHY" ? "✅" : c.status === "OVERDUE" ? "⚠️ OVERDUE" : "ℹ️ UNKNOWN";
    const ageStr = c.ageDays !== null ? `${c.ageDays} days old` : "Not tracked";
    console.log(`  ${icon} [${c.name}] - ${ageStr}: ${c.message}`);
  });

  console.log("\nSummary:");
  if (report.overdueCount > 0) {
    console.warn(`❌ ${report.overdueCount} credential(s) are OVERDUE for rotation!`);
    process.exit(1);
  } else {
    console.log("✅ All tracked credentials are within compliance policy limits.");
    process.exit(0);
  }
}

if (require.main === module) {
  runCli();
}

module.exports = {
  evaluateCredentialAge,
  auditAllCredentials,
};
