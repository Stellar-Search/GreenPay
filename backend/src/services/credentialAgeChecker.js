"use strict";

/**
 * backend/src/services/credentialAgeChecker.js
 *
 * Credential age tracking service and Prometheus metrics adapter.
 */

const { evaluateCredentialAge, auditAllCredentials } = require("../../../scripts/check-credential-age");

function getCredentialAgeMetrics(customConfig = {}) {
  const audit = auditAllCredentials(customConfig);
  
  return {
    healthy: audit.healthy,
    overdueCount: audit.overdueCount,
    totalTracked: audit.totalTracked,
    metrics: audit.credentials.map((c) => ({
      name: c.name,
      status: c.status,
      ageDays: c.ageDays !== null ? c.ageDays : -1,
      overdue: c.overdue ? 1 : 0,
    })),
  };
}

module.exports = {
  evaluateCredentialAge,
  auditAllCredentials,
  getCredentialAgeMetrics,
};
