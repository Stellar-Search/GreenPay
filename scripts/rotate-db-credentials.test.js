"use strict";

const { generateSecurePassword, parseArgs, runRotation } = require("./rotate-db-credentials");

describe("rotate-db-credentials.js", () => {
  it("should generate a secure random password of specified length", () => {
    const pwd1 = generateSecurePassword(32);
    const pwd2 = generateSecurePassword(32);
    expect(pwd1.length).toBe(32);
    expect(pwd2.length).toBe(32);
    expect(pwd1).not.toEqual(pwd2);
  });

  it("should parse CLI arguments correctly", () => {
    const originalArgv = process.argv;
    process.argv = ["node", "rotate-db-credentials.js", "--rehearse", "--namespace", "test-ns"];
    
    const opts = parseArgs();
    expect(opts.rehearse).toBe(true);
    expect(opts.namespace).toBe("test-ns");

    process.argv = originalArgv;
  });

  it("should execute rotation rehearsal without errors", async () => {
    const result = await runRotation({
      rehearse: true,
      phase: "all",
      namespace: "greenpay",
      newPassword: "TestPassword123!",
    });
    expect(result.success).toBe(true);
    expect(result.rehearsed).toBe(true);
  });
});
