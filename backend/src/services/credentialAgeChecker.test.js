"use strict";

const { evaluateCredentialAge, auditAllCredentials, getCredentialAgeMetrics } = require("./credentialAgeChecker");

describe("credentialAgeChecker service", () => {
  const now = new Date("2026-08-30T10:00:00Z");

  it("should evaluate healthy credential issued 30 days ago", () => {
    const issuedAt = new Date("2026-07-31T10:00:00Z").toISOString(); // 30 days ago
    const res = evaluateCredentialAge("DB Password", issuedAt, 90, now);
    
    expect(res.status).toBe("HEALTHY");
    expect(res.overdue).toBe(false);
    expect(res.ageDays).toBe(30);
  });

  it("should evaluate overdue credential issued 100 days ago", () => {
    const issuedAt = new Date("2026-05-22T10:00:00Z").toISOString(); // ~100 days ago
    const res = evaluateCredentialAge("DB Password", issuedAt, 90, now);

    expect(res.status).toBe("OVERDUE");
    expect(res.overdue).toBe(true);
    expect(res.ageDays).toBe(100);
  });

  it("should generate system audit metrics report correctly", () => {
    const sixtyDaysAgo = new Date("2026-06-30T10:00:00Z").toISOString();
    const metrics = getCredentialAgeMetrics({
      credentialIssuedAtPostgres: sixtyDaysAgo,
      credentialMaxAgeDays: 90,
      now,
    });

    expect(metrics.healthy).toBe(true);
    expect(metrics.overdueCount).toBe(0);
    expect(metrics.totalTracked).toBe(1);
    expect(metrics.metrics[0].name).toBe("PostgreSQL Password");
    expect(metrics.metrics[0].ageDays).toBe(61);
  });
});
