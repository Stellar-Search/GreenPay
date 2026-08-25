"use strict";

/**
 * Runs before any test module is loaded.
 *
 * src/config/env.js validates and freezes the environment the first time it is
 * required, and it is now pulled in transitively by middleware such as auth and
 * corsPolicy. A test file that assigns process.env below its own require block
 * therefore sets those values too late to be seen. Setting them here removes
 * that ordering trap for every suite.
 *
 * Individual tests may still override any of these; config/env re-reads
 * process.env whenever validateEnv() is called directly.
 */
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-jest";
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "testpass";
