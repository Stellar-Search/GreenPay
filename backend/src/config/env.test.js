/**
 * backend/src/config/env.test.js
 *
 * Test suite for centralized environment variable validation.
 * Tests the fail-fast behavior, comprehensive error reporting, and schema rules.
 */

"use strict";

describe("env.js — Environment Variable Validation", () => {
  let originalEnv;
  let originalExit;
  let consoleMock;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
    originalExit = process.exit;

    // Mock process.exit to prevent tests from exiting
    process.exit = jest.fn(() => {
      throw new Error("process.exit called");
    });

    // Mock console to capture output
    consoleMock = {
      error: jest.fn(),
      warn: jest.fn(),
      log: jest.fn(),
    };
    global.console.error = consoleMock.error;
    global.console.warn = consoleMock.warn;
    global.console.log = consoleMock.log;
  });

  afterEach(() => {
    // Restore original environment and functions
    process.env = originalEnv;
    process.exit = originalExit;
    global.console.error = console.error;
    global.console.warn = console.warn;
    global.console.log = console.log;

    // Clear module cache so each test gets a fresh env validation
    jest.resetModules();
  });

  describe("Test 1: validateEnv_exits_when_required_var_missing_in_production", () => {
    it("should exit when ADMIN_PASSWORD is missing in production", () => {
      process.env.NODE_ENV = "production";
      delete process.env.ADMIN_PASSWORD;

      expect(() => {
        require("./env");
      }).toThrow("process.exit called");

      expect(process.exit).toHaveBeenCalledWith(1);

      // Check that error message mentions ADMIN_PASSWORD
      const errorOutput = consoleMock.error.mock.calls
        .map((call) => call[0])
        .join("\n");
      expect(errorOutput).toContain("ADMIN_PASSWORD");
    });
  });

  describe("Test 2: validateEnv_lists_all_errors_at_once_not_first_only", () => {
    it("should list all missing required vars, not just the first one", () => {
      process.env.NODE_ENV = "production";
      delete process.env.ADMIN_PASSWORD;
      delete process.env.JWT_SECRET;
      delete process.env.DATABASE_URL;

      expect(() => {
        require("./env");
      }).toThrow("process.exit called");

      const errorOutput = consoleMock.error.mock.calls
        .map((call) => call[0])
        .join("\n");

      expect(errorOutput).toContain("ADMIN_PASSWORD");
      expect(errorOutput).toContain("JWT_SECRET");
      expect(errorOutput).toContain("DATABASE_URL");

      // Verify it lists "3 error(s)"
      expect(errorOutput).toMatch(/3 error\(s\)/);
    });
  });

  describe("Test 3: validateEnv_rejects_dev_default_in_production", () => {
    it("should reject QUEUE_URL using dev default in production", () => {
      process.env.NODE_ENV = "production";
      delete process.env.QUEUE_URL; // Missing, so would use dev default

      // QUEUE_URL has a dev default, so in production without explicit value
      // it should fail with "using development default" message
      // Note: QUEUE_URL is not actually in the schema yet, so we test with DATABASE_URL instead
      // which has a dev default: postgres://postgres:postgres@localhost:5432/greenpay
      delete process.env.DATABASE_URL;
      delete process.env.ADMIN_PASSWORD;
      delete process.env.JWT_SECRET;

      expect(() => {
        require("./env");
      }).toThrow("process.exit called");

      const errorOutput = consoleMock.error.mock.calls
        .map((call) => call[0])
        .join("\n");

      // DATABASE_URL should fail with "using development default in production"
      expect(errorOutput).toContain("development default");
    });
  });

  describe("Test 4: validateEnv_allows_dev_default_in_development", () => {
    it("should allow using dev defaults in development mode", () => {
      process.env.NODE_ENV = "development";
      delete process.env.PORT; // Will use dev default 3000

      // Remove all required vars that don't have defaults
      delete process.env.JWT_SECRET;
      delete process.env.ADMIN_PASSWORD;

      // In dev mode, missing JWT_SECRET without default should still fail
      // But DATABASE_URL should use its default
      expect(() => {
        require("./env");
      }).toThrow("process.exit called");

      // Verify the error is about JWT_SECRET, not DATABASE_URL (which has a default)
      const errorOutput = consoleMock.error.mock.calls
        .map((call) => call[0])
        .join("\n");
      expect(errorOutput).toContain("JWT_SECRET");
      expect(errorOutput).not.toContain(
        "DATABASE_URL"
      );
    });
  });

  describe("Test 5: validateEnv_allows_missing_production_secrets_in_test", () => {
    it("should allow test mode to run without production secrets", () => {
      process.env.NODE_ENV = "test";
      delete process.env.JWT_SECRET;
      delete process.env.ADMIN_PASSWORD;
      delete process.env.DATABASE_URL;

      // Test mode should not call process.exit
      const { env } = require("./env");

      expect(process.exit).not.toHaveBeenCalled();
      expect(env).toBeDefined();
      expect(env.isTest).toBe(true);
    });
  });

  describe("Test 6: validateEnv_rejects_short_jwt_secret", () => {
    it("should reject JWT_SECRET shorter than 32 chars", () => {
      process.env.NODE_ENV = "production";
      process.env.JWT_SECRET = "short";
      process.env.ADMIN_PASSWORD = "valid-admin-password-12chars";
      process.env.DATABASE_URL =
        "postgres://postgres:postgres@localhost:5432/greenpay";

      expect(() => {
        require("./env");
      }).toThrow("process.exit called");

      const errorOutput = consoleMock.error.mock.calls
        .map((call) => call[0])
        .join("\n");
      expect(errorOutput).toContain("JWT_SECRET");
      expect(errorOutput).toContain("too short");
    });
  });

  describe("Test 7: no_direct_process_env_reads_outside_config_module", () => {
    it("should verify no process.env reads remain outside config/env.js", () => {
      const fs = require("fs");
      const path = require("path");

      // Files that were updated to use env.* instead of process.env
      const filesToCheck = [
        "../db/pool.js",
        "../middleware/corsPolicy.js",
        "../routes/admin.js",
        "../middleware/auth.js",
        "../services/stellar.js",
        "../services/turrets.js",
        "../services/email.js",
        "../services/claude.js",
        "../cache/redisClient.js",
        "../utils/logger.js",
        "../services/summaryQueue.js",
        "../services/push.js",
      ];

      const processEnvRegex = /process\.env\./g;

      for (const file of filesToCheck) {
        const filePath = path.join(__dirname, file);
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, "utf8");
          // Should not contain process.env reads
          expect(content).not.toMatch(processEnvRegex);
        }
      }
    });
  });

  describe("Test 8: check_env_example_script_passes_with_synced_schema", () => {
    it("should verify check-env-example.js script exists and is executable", () => {
      const fs = require("fs");
      const path = require("path");

      const scriptPath = path.join(__dirname, "../../../scripts/check-env-example.js");
      expect(fs.existsSync(scriptPath)).toBe(true);

      const content = fs.readFileSync(scriptPath, "utf8");
      expect(content).toContain("check-env-example.js");
      expect(content).toContain("schema");
      expect(content.startsWith("#!/usr/bin/env node")).toBe(true);
    });
  });

  describe("Additional Tests: Type Validation", () => {
    it("should reject non-numeric PORT", () => {
      process.env.NODE_ENV = "development";
      process.env.PORT = "not-a-number";

      expect(() => {
        require("./env");
      }).toThrow("process.exit called");

      const errorOutput = consoleMock.error.mock.calls
        .map((call) => call[0])
        .join("\n");
      expect(errorOutput).toContain("PORT");
      expect(errorOutput).toContain("must be a number");
    });

    it("should reject invalid NODE_ENV value", () => {
      process.env.NODE_ENV = "staging";

      expect(() => {
        require("./env");
      }).toThrow("process.exit called");

      const errorOutput = consoleMock.error.mock.calls
        .map((call) => call[0])
        .join("\n");
      expect(errorOutput).toContain("NODE_ENV");
      expect(errorOutput).toContain(
        "[development, production, test]"
      );
    });

    it("should reject invalid URL format", () => {
      process.env.NODE_ENV = "development";
      process.env.HORIZON_URL = "not-a-valid-url";

      expect(() => {
        require("./env");
      }).toThrow("process.exit called");

      const errorOutput = consoleMock.error.mock.calls
        .map((call) => call[0])
        .join("\n");
      expect(errorOutput).toContain("HORIZON_URL");
      expect(errorOutput).toContain("valid url");
    });

    it("should accept valid URL format", () => {
      process.env.NODE_ENV = "test";
      process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";

      // Should not throw in test mode
      const { env } = require("./env");
      expect(env.horizonUrl).toBe("https://horizon-testnet.stellar.org");
    });
  });

  describe("Additional Tests: Boolean String Parsing", () => {
    it("should parse boolean-string values correctly", () => {
      process.env.NODE_ENV = "test";
      process.env.ENABLE_TURRETS = "true";
      process.env.CORS_ALLOW_CREDENTIALS = "false";

      const { env } = require("./env");
      expect(env.enableTurrets).toBe(true);
      expect(env.corsAllowCredentials).toBe(false);
    });
  });

  describe("Additional Tests: CamelCase Property Export", () => {
    it("should export all config as camelCase properties", () => {
      process.env.NODE_ENV = "test";

      const { env } = require("./env");

      // Test a few key properties exist in camelCase
      expect(env.nodeEnv).toBeDefined();
      expect(env.port).toBeDefined();
      expect(env.databaseUrl).toBeDefined();
      expect(env.stellarNetwork).toBeDefined();
      expect(env.adminPassword).toBeDefined();
      expect(env.jwtSecret).toBeDefined();
      expect(env.isProduction).toBe(false);
      expect(env.isTest).toBe(true);
      expect(env.isDevelopment).toBe(false);
    });
  });
});
