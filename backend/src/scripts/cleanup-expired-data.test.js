"use strict";

const { describe, it, expect } = require("@jest/globals");
const {
  DEVICE_TOKEN_MAX_AGE_DAYS,
  AUDIT_LOG_IP_REDACT_AGE_DAYS,
  AUDIT_LOG_DELETE_AGE_DAYS,
} = require("./cleanup-expired-data");

describe("cleanup-expired-data constants", () => {
  it("should define device token max age as 90 days", () => {
    expect(DEVICE_TOKEN_MAX_AGE_DAYS).toBe(90);
  });

  it("should define audit log IP redaction age as 365 days", () => {
    expect(AUDIT_LOG_IP_REDACT_AGE_DAYS).toBe(365);
  });

  it("should define audit log deletion age as 730 days (2 years)", () => {
    expect(AUDIT_LOG_DELETE_AGE_DAYS).toBe(730);
  });
});
