import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/integration.spec.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 45_000,
  reporter: process.env.CI ? "github" : "list",

  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: [
    {
      command: "npm run start",
      cwd: "../backend",
      url: "http://localhost:4000/health",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PORT: "4000",
        NODE_ENV: "development",
        DATABASE_URL: process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/greenpay",
        STELLAR_NETWORK: "testnet",
        HORIZON_URL: "https://horizon-testnet.stellar.org",
        ALLOWED_ORIGINS: "http://localhost:3000",
        CORS_ALLOW_CREDENTIALS: "true",
        // Fixture credentials for the E2E admin-login step (backend/src/routes/admin.js).
        // Not secrets — this backend only ever talks to the ephemeral CI/local Postgres instance.
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "e2e-test-admin-password",
        // Must be at least 32 characters to satisfy the backend env validator.
        JWT_SECRET: "e2e-test-jwt-secret-not-a-real-credential",
      },
    },
    {
      command: "npm run start",
      url: "http://localhost:3000",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        NEXT_PUBLIC_STELLAR_NETWORK: "testnet",
        NEXT_PUBLIC_API_URL: "http://localhost:4000",
      },
    },
  ],
});
