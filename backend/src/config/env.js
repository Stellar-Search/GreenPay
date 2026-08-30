/**
 * backend/src/config/env.js
 *
 * Centralized environment variable validation.
 * Called once at startup — fails fast with ALL missing/invalid vars listed.
 *
 * Rules:
 * - Required vars missing in production → process.exit(1)
 * - Development-only defaults cannot silently apply in production
 * - Every process.env read in the backend must go through this module
 */

"use strict";

const isProduction = process.env.NODE_ENV === "production";
const isTest = process.env.NODE_ENV === "test";

// ── Schema ────────────────────────────────────────────────────────────────────
/**
 * Environment schema defines all configuration variables.
 *
 * Fields:
 * - required: Must exist in all environments (unless overridden by other flags)
 * - productionRequired: When true, must exist in production (can have dev default)
 * - type: Type validation ('number', 'url', 'enum', etc.)
 * - default: Development-only default (rejected in production if not explicitly set)
 * - minLength: For secrets, enforce minimum length
 * - values: Allowed enum values
 * - description: What the variable controls
 */
const schema = {
  // ── Server & Framework ────────────────────────────────────────────────────

  NODE_ENV: {
    required: true,
    values: ["development", "production", "test"],
    description: "Execution environment (development, production, or test)",
  },

  PORT: {
    required: true,
    type: "number",
    default: "3000",
    description: "Express server listening port",
  },

  SHUTDOWN_TIMEOUT_MS: {
    required: false,
    type: "number",
    default: "25000",
    description:
      "Grace period for server shutdown before forcing exit (ms); must align with Kubernetes pod terminationGracePeriodSeconds",
  },

  // When the app sits behind the nginx ingress controller or a cloud load
  // balancer, Express must trust the proxy chain before it will honour the
  // X-Forwarded-For header — otherwise req.ip (and every IP-keyed rate-limit
  // bucket) collapses to the proxy's address and all clients share one bucket.
  // Kept OFF by default so a misconfigured dev box can't be spoofed; deploy
  // manifests set it explicitly (see helm/greenpay/templates/configmap.yaml).
  TRUST_PROXY: {
    required: false,
    type: "boolean-string",
    default: "false",
    description:
      "Trust X-Forwarded-* headers from the proxy in front of the app (true when deployed behind nginx ingress or a load balancer)",
  },

  TRUST_PROXY_HOPS: {
    required: false,
    type: "number",
    default: "1",
    description:
      "Number of proxy hops between the app and the internet when TRUST_PROXY=true (1 for a single nginx ingress; 2 if a cloud LB fronts the ingress, etc.)",
  },

  // ── Database ──────────────────────────────────────────────────────────────

  DATABASE_URL: {
    required: true,
    type: "url",
    productionRequired: true,
    default: "postgres://postgres:postgres@localhost:5432/greenpay",
    description: "PostgreSQL connection string",
  },

  DATABASE_SSL: {
    required: false,
    type: "boolean-string",
    description:
      "Enable/disable SSL for PostgreSQL (auto-enabled in production for remote hosts if not explicitly set)",
  },

  DATABASE_URL_PREVIOUS: {
    required: false,
    type: "url",
    description:
      "Previous PostgreSQL connection string for zero-downtime credential rotation overlap window",
  },

  POSTGRES_PASSWORD_PREVIOUS: {
    required: false,
    description:
      "Previous PostgreSQL password for zero-downtime credential rotation overlap window",
  },

  CREDENTIAL_ISSUED_AT_POSTGRES: {
    required: false,
    description: "Timestamp (ISO 8601) when PostgreSQL password was issued or rotated",
  },

  CREDENTIAL_ISSUED_AT_ADMIN: {
    required: false,
    description: "Timestamp (ISO 8601) when Admin credentials were issued or rotated",
  },

  CREDENTIAL_ISSUED_AT_MATCHER: {
    required: false,
    description: "Timestamp (ISO 8601) when Matcher Stellar secret key was issued or rotated",
  },

  CREDENTIAL_MAX_AGE_DAYS: {
    required: false,
    type: "number",
    default: "90",
    description: "Maximum allowed age in days before a credential is flagged as overdue",
  },

  // ── Stellar Network ───────────────────────────────────────────────────────

  STELLAR_NETWORK: {
    required: false,
    values: ["testnet", "mainnet"],
    default: "testnet",
    description: "Stellar network (testnet or mainnet) for contract interactions",
  },

  HORIZON_URL: {
    required: false,
    type: "url",
    default: "https://horizon-testnet.stellar.org",
    description: "Stellar Horizon API endpoint for account/transaction queries",
  },

  SOROBAN_RPC_URL: {
    required: false,
    type: "url",
    default: "https://soroban-testnet.stellar.org",
    description: "Soroban RPC endpoint for contract simulation and execution",
  },

  CONTRACT_ID: {
    required: false,
    description:
      "Soroban smart contract identifier for on-chain project data and matching; feature disabled when empty",
  },

  MATCHER_SECRET_KEY: {
    required: false,
    productionRequired: false,
    minLength: 56, // Stellar secret keys are 56 chars (S + base32)
    description:
      "Stellar secret key for the donation matcher account (Turrets signing); matching disabled when unset",
  },

  // ── Donor Onboarding: Sponsored Reserves ─────────────────────────────────
  // A sponsored account lets a donor who has never held XLM own a Stellar
  // account without first funding it past the base reserve. The platform locks
  // its own XLM behind that account; it never holds the donor's key. Leaving
  // SPONSOR_SECRET_KEY unset disables the whole path, and every other flow —
  // including today's connected-wallet donation — is unaffected.

  SPONSOR_SECRET_KEY: {
    required: false,
    productionRequired: false,
    minLength: 56, // Stellar secret keys are 56 chars (S + base32)
    description:
      "Stellar secret key for the account that sponsors donor base reserves; sponsored account creation disabled when unset",
  },

  SPONSORSHIP_PER_IP_DAILY: {
    required: false,
    type: "number",
    default: "3",
    description:
      "Maximum sponsored accounts one source address may request per rolling 24 hours",
  },

  SPONSORSHIP_PER_SESSION_TOTAL: {
    required: false,
    type: "number",
    default: "1",
    description: "Maximum sponsored accounts one onboarding session may request",
  },

  SPONSORSHIP_GLOBAL_DAILY: {
    required: false,
    type: "number",
    default: "500",
    description: "Platform-wide cap on sponsored accounts created per rolling 24 hours",
  },

  SPONSORSHIP_GLOBAL_HOURLY: {
    required: false,
    type: "number",
    default: "60",
    description:
      "Platform-wide cap on sponsored accounts created per rolling hour; contains bursts before the daily cap notices",
  },

  SPONSORSHIP_TREASURY_FLOOR_ACCOUNTS: {
    required: false,
    type: "number",
    default: "20",
    description:
      "Stop sponsoring while fewer than this many sponsorships' worth of lockable balance remain, so the treasury can always afford to reclaim what it locked",
  },

  SPONSORSHIP_MAX_DONATION_XLM: {
    required: false,
    type: "number",
    default: "250",
    description:
      "Largest single donation a sponsored account may make before the donor must bring a self-funded wallet",
  },

  SPONSORSHIP_MAX_LIFETIME_XLM: {
    required: false,
    type: "number",
    default: "1000",
    description: "Total value one sponsored account may move before it must be upgraded",
  },

  SPONSORSHIP_RECLAIM_IDLE_DAYS: {
    required: false,
    type: "number",
    default: "30",
    description:
      "Days a sponsored account may sit without donating before its reserve is reclaimed",
  },

  ONBOARDING_IP_HASH_SALT: {
    required: false,
    productionRequired: false,
    minLength: 16,
    description:
      "Salt for hashing source addresses in onboarding rate-limit records; a per-deployment random value keeps the hashes non-reversible",
  },

  // ── Donor Onboarding: Fiat On-Ramp ───────────────────────────────────────
  // GreenPay never takes fiat. These point at a licensed SEP-24 anchor that
  // does; see docs/onramp-compliance.md for the obligation split.

  ONRAMP_ANCHOR_URL: {
    required: false,
    type: "url",
    description:
      "SEP-24 anchor transfer server URL for the fiat on-ramp handoff; the fiat path is not offered when unset",
  },

  ONRAMP_ANCHOR_HOME_DOMAIN: {
    required: false,
    description: "Home domain of the SEP-24 anchor, used to fetch its stellar.toml",
  },

  // ── CORS & Security ──────────────────────────────────────────────────────

  ALLOWED_ORIGINS: {
    required: false,
    description:
      "CORS allowed origins (comma-separated); uses hardcoded defaults if not set",
  },

  CORS_ALLOW_CREDENTIALS: {
    required: false,
    type: "boolean-string",
    description:
      "Enable CORS credentials (cookies, auth headers); disabled by default",
  },

  // ── Authentication & Secrets ──────────────────────────────────────────────

  JWT_SECRET: {
    required: true,
    productionRequired: true,
    minLength: 32,
    description:
      "Secret key for JWT signing/verification (admin authentication); generate with: openssl rand -hex 32",
  },

  ADMIN_USERNAME: {
    required: false,
    default: "admin",
    description: "Admin login username for POST /api/v1/admin/login",
  },

  ADMIN_PASSWORD: {
    required: false,
    productionRequired: true,
    minLength: 12,
    description:
      "Admin login password; admin login disabled (503) if not configured",
  },

  // ── Redis & Caching ──────────────────────────────────────────────────────

  REDIS_URL: {
    required: false,
    type: "url",
    description:
      "Redis connection string for distributed rate-limiting and cross-replica realtime delivery; unset runs single-process (correct locally, silently partial at 2+ replicas)",
  },

  CACHE_MAX_ENTRIES: {
    required: false,
    type: "number",
    default: "500",
    description:
      "Maximum entries kept in the process-local response cache before LRU eviction kicks in",
  },

  CACHE_SWEEP_INTERVAL_MS: {
    required: false,
    type: "number",
    default: "60000",
    description:
      "How often (ms) the process-local response cache sweeps expired entries",
  },

  // ── Email & Notifications ────────────────────────────────────────────────

  RESEND_API_KEY: {
    required: false,
    productionRequired: false,
    description:
      "Resend.com API key for transactional email; email notifications skipped when unset",
  },

  EMAIL_FROM: {
    required: false,
    type: "email",
    default: "GreenPay <updates@greenpay.app>",
    description: "Sender email address for outbound transactional emails",
  },

  APP_URL: {
    required: false,
    type: "url",
    default: "http://localhost:3000",
    description: "Frontend base URL embedded in email notification links",
  },

  // ── AI & Summaries ───────────────────────────────────────────────────────

  ANTHROPIC_API_KEY: {
    required: false,
    productionRequired: false,
    description:
      "Anthropic Claude API key for AI project summary generation; feature disabled when unset",
  },

  CLAUDE_SUMMARY_MODEL: {
    required: false,
    default: "claude-opus-4-7",
    description: "Claude model for project summaries",
  },

  SUMMARY_FAILURE_ALERT_WEBHOOK_URL: {
    required: false,
    type: "url",
    description:
      "Webhook URL for alerting on permanent AI summary generation failures; alerting disabled when unset",
  },

  // ── Turrets Matching Service ─────────────────────────────────────────────

  ENABLE_TURRETS: {
    required: false,
    type: "boolean-string",
    description:
      "Enable the Turrets matching service on startup; disabled by default",
  },

  TURRETS_PORT: {
    required: false,
    type: "number",
    default: "3001",
    description: "TCP port for the Turrets matching server",
  },

  // ── Observability ────────────────────────────────────────────────────────

  SERVICE_NAME: {
    required: false,
    default: "greenpay-backend",
    description: "Service identifier included in all structured log output",
  },

  // ── Event Sourcing (Optional) ────────────────────────────────────────────

  EVENT_STORE_BATCH_SIZE: {
    required: false,
    type: "number",
    default: "200",
    description: "Initial batch size for event stream processing",
  },

  EVENT_STORE_MAX_BATCH_SIZE: {
    required: false,
    type: "number",
    default: "2000",
    description: "Maximum adaptive batch size for event stream",
  },

  EVENT_STORE_POLL_INTERVAL_MS: {
    required: false,
    type: "number",
    default: "500",
    description: "Poll interval (ms) when event stream is idle",
  },

  EVENT_STORE_CATCHUP_INTERVAL_MS: {
    required: false,
    type: "number",
    default: "10",
    description: "Interval (ms) between batches during catch-up",
  },

  EVENT_STORE_ADAPTIVE_BATCH: {
    required: false,
    type: "boolean-string",
    default: "true",
    description: "Whether batch size adapts dynamically to backlog",
  },
};

// Export schema for test/CI access
const schemaKeys = Object.keys(schema);

// ── Validation Logic ──────────────────────────────────────────────────────────

/**
 * Validates all environment variables according to the schema.
 * Fails fast with comprehensive error list if any validation fails.
 * @returns {Object} Validated config object with all vars as properties
 * @throws {Error} Logs errors and calls process.exit(1) in production
 */
function validateEnv() {
  if (isTest) {
    // Allow test suite to run without enforcing all production secrets
    return buildConfig(true);
  }

  const errors = [];

  for (const [key, rule] of Object.entries(schema)) {
    const value = process.env[key];

    // Determine if this var is required in the current environment
    const isRequired = rule.required || (isProduction && rule.productionRequired);

    // ── Missing Required Variable ────────────────────────────────────────

    if (!value && isRequired && !rule.default) {
      errors.push(`Missing required env var: ${key}`);
      continue;
    }

    // ── Production Rejection of Development Defaults ──────────────────────
    // Production must never silently use a development default
    if (isProduction && rule.productionRequired && !value && rule.default) {
      errors.push(
        `${key} is using a development default in production — set it explicitly`
      );
      continue;
    }

    // Skip format validation if value is absent (optional var)
    if (!value) continue;

    // ── Type Validation ──────────────────────────────────────────────────

    if (rule.type === "number") {
      if (isNaN(Number(value))) {
        errors.push(
          `${key} must be a number, got: "${value}"`
        );
      }
    }

    if (rule.type === "boolean-string") {
      if (!["true", "false"].includes(value.toLowerCase())) {
        errors.push(
          `${key} must be "true" or "false", got: "${value}"`
        );
      }
    }

    if (rule.type === "url" || rule.type === "email") {
      try {
        if (rule.type === "url") {
          new URL(value);
        } else if (rule.type === "email") {
          // Simple email regex validation
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+/.test(value)) {
            throw new Error("Invalid email format");
          }
        }
      } catch {
        errors.push(
          `${key} is not a valid ${rule.type}: "${value}"`
        );
      }
    }

    // ── Enum Validation ──────────────────────────────────────────────────

    if (rule.values && !rule.values.includes(value)) {
      errors.push(
        `${key} must be one of [${rule.values.join(", ")}], got: "${value}"`
      );
    }

    // ── Minimum Length (for secrets) ──────────────────────────────────────

    if (rule.minLength && value.length < rule.minLength) {
      errors.push(
        `${key} is too short (${value.length} chars, minimum ${rule.minLength})`
      );
    }
  }

  if (errors.length > 0) {
    console.error("\n[config] Boot aborted — environment errors:\n");
    errors.forEach((e) => console.error(`  ✗ ${e}`));
    console.error(`\n${errors.length} error(s). Fix before starting.\n`);
    process.exit(1);
  }

  return buildConfig(false);
}

/**
 * Builds the final config object with all variables.
 * Applies defaults for missing optional vars.
 * @param {boolean} isTestMode Whether running in test environment
 * @returns {Object} Validated configuration object
 */
function buildConfig(isTestMode) {
  const get = (key) => {
    const rule = schema[key] || {};
    const value = process.env[key];

    // Apply development defaults only in dev/test, never in production
    if (!value && rule.default && !isProduction) {
      return rule.default;
    }

    return value ?? null;
  };

  // Parse boolean-string values
  const parseBoolean = (value) => {
    if (!value) return false;
    return value.toLowerCase() === "true";
  };

  // Export config object with camelCase properties
  return {
    // Server & Framework
    nodeEnv: get("NODE_ENV"),
    port: Number(get("PORT")),
    shutdownTimeoutMs: Number(get("SHUTDOWN_TIMEOUT_MS")),
    trustProxy: parseBoolean(get("TRUST_PROXY")),
    trustProxyHops: Number(get("TRUST_PROXY_HOPS")),

    // Database
    databaseUrl: get("DATABASE_URL"),
    databaseUrlPrevious: get("DATABASE_URL_PREVIOUS"),
    postgresPasswordPrevious: get("POSTGRES_PASSWORD_PREVIOUS"),
    credentialIssuedAtPostgres: get("CREDENTIAL_ISSUED_AT_POSTGRES"),
    credentialIssuedAtAdmin: get("CREDENTIAL_ISSUED_AT_ADMIN"),
    credentialIssuedAtMatcher: get("CREDENTIAL_ISSUED_AT_MATCHER"),
    credentialMaxAgeDays: Number(get("CREDENTIAL_MAX_AGE_DAYS")),
    databaseSsl: get("DATABASE_SSL"),

    // Stellar Network
    stellarNetwork: get("STELLAR_NETWORK"),
    horizonUrl: get("HORIZON_URL"),
    sorobanRpcUrl: get("SOROBAN_RPC_URL"),
    contractId: get("CONTRACT_ID"),
    matcherSecretKey: get("MATCHER_SECRET_KEY"),

    // Donor Onboarding
    sponsorSecretKey: get("SPONSOR_SECRET_KEY"),
    sponsorshipPerIpDaily: Number(get("SPONSORSHIP_PER_IP_DAILY")),
    sponsorshipPerSessionTotal: Number(get("SPONSORSHIP_PER_SESSION_TOTAL")),
    sponsorshipGlobalDaily: Number(get("SPONSORSHIP_GLOBAL_DAILY")),
    sponsorshipGlobalHourly: Number(get("SPONSORSHIP_GLOBAL_HOURLY")),
    sponsorshipTreasuryFloorAccounts: Number(get("SPONSORSHIP_TREASURY_FLOOR_ACCOUNTS")),
    sponsorshipMaxDonationXlm: Number(get("SPONSORSHIP_MAX_DONATION_XLM")),
    sponsorshipMaxLifetimeXlm: Number(get("SPONSORSHIP_MAX_LIFETIME_XLM")),
    sponsorshipReclaimIdleDays: Number(get("SPONSORSHIP_RECLAIM_IDLE_DAYS")),
    onboardingIpHashSalt: get("ONBOARDING_IP_HASH_SALT"),
    onrampAnchorUrl: get("ONRAMP_ANCHOR_URL"),
    onrampAnchorHomeDomain: get("ONRAMP_ANCHOR_HOME_DOMAIN"),

    // CORS & Security
    allowedOrigins: get("ALLOWED_ORIGINS"),
    corsAllowCredentials: parseBoolean(get("CORS_ALLOW_CREDENTIALS")),

    // Authentication & Secrets
    jwtSecret: get("JWT_SECRET"),
    adminUsername: get("ADMIN_USERNAME"),
    adminPassword: get("ADMIN_PASSWORD"),

    // Redis & Caching
    redisUrl: get("REDIS_URL"),
    cacheMaxEntries: Number(get("CACHE_MAX_ENTRIES")),
    cacheSweepIntervalMs: Number(get("CACHE_SWEEP_INTERVAL_MS")),

    // Email & Notifications
    resendApiKey: get("RESEND_API_KEY"),
    emailFrom: get("EMAIL_FROM"),
    appUrl: get("APP_URL"),

    // AI & Summaries
    anthropicApiKey: get("ANTHROPIC_API_KEY"),
    claudeSummaryModel: get("CLAUDE_SUMMARY_MODEL"),
    summaryFailureAlertWebhookUrl: get("SUMMARY_FAILURE_ALERT_WEBHOOK_URL"),

    // Turrets Matching Service
    enableTurrets: parseBoolean(get("ENABLE_TURRETS")),
    turretsPort: Number(get("TURRETS_PORT")),

    // Observability
    serviceName: get("SERVICE_NAME"),

    // Event Sourcing
    eventStoreBatchSize: Number(get("EVENT_STORE_BATCH_SIZE")),
    eventStoreMaxBatchSize: Number(get("EVENT_STORE_MAX_BATCH_SIZE")),
    eventStorePollIntervalMs: Number(get("EVENT_STORE_POLL_INTERVAL_MS")),
    eventStoreCatchupIntervalMs: Number(get("EVENT_STORE_CATCHUP_INTERVAL_MS")),
    eventStoreAdaptiveBatch: parseBoolean(get("EVENT_STORE_ADAPTIVE_BATCH")),

    // Flags
    isProduction,
    isTest: isTestMode,
    isDevelopment: !isProduction && !isTestMode,
  };
}

// Validate and export — called once at startup
const env = validateEnv();

module.exports = {
  env,
  schema,
  schemaKeys,
  validateEnv, // Export for testing purposes
};
