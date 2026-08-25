CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  location TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  goal_xlm NUMERIC(20, 7) NOT NULL DEFAULT 0,
  raised_xlm NUMERIC(20, 7) NOT NULL DEFAULT 0,
  donor_count INTEGER NOT NULL DEFAULT 0,
  co2_offset_kg INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  on_chain_verified BOOLEAN NOT NULL DEFAULT FALSE,
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- AI summary cache: filled on demand by POST /api/projects/:id/generate-summary,
-- read by GET /api/projects/:id and rendered as a highlighted card on the
-- project detail page. ai_summary_source_hash stores a SHA-256 of the
-- description that produced the summary so the UI can show a "needs refresh"
-- hint when the description has been edited since.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ai_summary             TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ai_summary_generated_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ai_summary_model        TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ai_summary_source_hash  TEXT;

-- Set by PATCH /api/projects/:id/status when an admin rejects a project;
-- read back by store.js's mapProjectRow as rejectionReason.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS rejection_reason        TEXT;

CREATE TABLE IF NOT EXISTS donations (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  donor_address TEXT NOT NULL,
  amount_xlm NUMERIC(20, 7),
  amount NUMERIC(20, 7) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'XLM',
  message TEXT,
  transaction_hash TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'committed' CHECK (status IN ('prepared', 'committed', 'compensated', 'failed')),
  saga_step TEXT NOT NULL DEFAULT 'donation_recorded',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (idempotency_key)
);

ALTER TABLE donations ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
UPDATE donations SET idempotency_key = transaction_hash WHERE idempotency_key IS NULL;
ALTER TABLE donations ALTER COLUMN idempotency_key SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS donations_idempotency_key_unique ON donations(idempotency_key);
ALTER TABLE donations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'committed';
ALTER TABLE donations ADD COLUMN IF NOT EXISTS saga_step TEXT NOT NULL DEFAULT 'donation_recorded';
ALTER TABLE donations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Speeds up the leaderboard's period=month/year donor aggregation, which
-- joins donations onto profiles by donor_address (donor_stats has no
-- per-donation timestamp, so that path can't read from the aggregate table).
CREATE INDEX IF NOT EXISTS idx_donations_donor_address ON donations(donor_address);

CREATE TABLE IF NOT EXISTS profiles (
  public_key TEXT PRIMARY KEY,
  display_name TEXT,
  bio TEXT,
  total_donated_xlm NUMERIC(20, 7) NOT NULL DEFAULT 0,
  projects_supported INTEGER NOT NULL DEFAULT 0,
  badges JSONB NOT NULL DEFAULT '[]'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS project_updates (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_subscriptions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  donor_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, email)
);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  client_public_key TEXT NOT NULL,
  freelancer_public_key TEXT NOT NULL,
  amount_escrow_xlm NUMERIC(20, 7) NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_escrow',
  release_transaction_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_campaigns (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  goal_xlm NUMERIC(20, 7) NOT NULL,
  deadline TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_milestones (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  percentage INTEGER NOT NULL,
  title TEXT NOT NULL,
  reached_at TIMESTAMPTZ,
  transaction_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_ratings (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  donor_address TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  review TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, donor_address)
);

CREATE TABLE IF NOT EXISTS donation_matches (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  matcher_address TEXT NOT NULL,
  cap_xlm NUMERIC(20, 7) NOT NULL,
  multiplier INTEGER NOT NULL DEFAULT 1,
  expires_at TIMESTAMPTZ NOT NULL,
  matched_xlm NUMERIC(20, 7) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE TABLE IF NOT EXISTS device_tokens (
  id UUID PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  wallet_address TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id UUID PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at
  ON admin_audit_log (created_at);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action
  ON admin_audit_log (action);

CREATE TABLE IF NOT EXISTS project_follows (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  device_token_id UUID NOT NULL REFERENCES device_tokens(id) ON DELETE CASCADE,
  wallet_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, device_token_id)
);

-- CQRS Read-Model Tables
-- donor_stats: materialized donor profile aggregates (updated by projection, not direct writes)
CREATE TABLE IF NOT EXISTS donor_stats (
  public_key TEXT PRIMARY KEY REFERENCES profiles(public_key) ON DELETE CASCADE,
  total_donated_xlm NUMERIC(20, 7) NOT NULL DEFAULT 0,
  projects_supported INTEGER NOT NULL DEFAULT 0,
  badges JSONB NOT NULL DEFAULT '[]'::JSONB,
  projection_cursor BIGINT NOT NULL DEFAULT 0
);

-- match_state: materialized match status (updated by projection, not direct writes)
CREATE TABLE IF NOT EXISTS match_state (
  match_id UUID PRIMARY KEY REFERENCES donation_matches(id) ON DELETE CASCADE,
  matched_xlm NUMERIC(20, 7) NOT NULL DEFAULT 0,
  cap_xlm NUMERIC(20, 7) NOT NULL,
  multiplier INTEGER NOT NULL DEFAULT 1,
  projection_cursor BIGINT NOT NULL DEFAULT 0
);

-- ============================================================
-- Event Stream (Event Sourcing write store)
-- Append-only log; immutable once written (no DELETE/UPDATE).
-- Unique constraint on (stream_id, version) enforces aggregate
-- version ordering; partial unique index on tx_hash ensures
-- idempotent donation replay without double-counting.
-- ============================================================
CREATE TABLE IF NOT EXISTS event_stream (
  event_id           UUID            PRIMARY KEY,
  stream_id          TEXT            NOT NULL,
  aggregate_type     TEXT            NOT NULL,
  aggregate_id       TEXT            NOT NULL,
  event_type         TEXT            NOT NULL,
  version            INTEGER         NOT NULL,
  aggregate_version  INTEGER         NOT NULL,
  payload            JSONB           NOT NULL,
  actor              TEXT            NOT NULL DEFAULT 'system',
  occurred_at        TIMESTAMPTZ     NOT NULL,
  created_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  processed          BOOLEAN         NOT NULL DEFAULT false,
  processed_at       TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_event_stream_stream_version
  ON event_stream (stream_id, version);

CREATE INDEX IF NOT EXISTS idx_event_stream_aggregate
  ON event_stream (aggregate_type, aggregate_id);

CREATE INDEX IF NOT EXISTS idx_event_stream_occurred
  ON event_stream (occurred_at);

CREATE INDEX IF NOT EXISTS idx_event_stream_processed
  ON event_stream (processed, occurred_at);

-- Idempotency guard: at most one DonationRecorded per transaction hash
CREATE UNIQUE INDEX IF NOT EXISTS ux_donation_tx_hash
  ON event_stream ((payload->'data'->>'transactionHash'))
  WHERE event_type = 'DonationRecorded';

-- CQRS Read-Model Cursor Columns
ALTER TABLE projects ADD COLUMN IF NOT EXISTS projection_cursor BIGINT DEFAULT 0;
ALTER TABLE donor_stats ADD COLUMN IF NOT EXISTS projection_cursor BIGINT DEFAULT 0;
ALTER TABLE match_state ADD COLUMN IF NOT EXISTS projection_cursor BIGINT DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS projection_cursor BIGINT DEFAULT 0;
ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS projection_cursor BIGINT DEFAULT 0;

CREATE TABLE IF NOT EXISTS event_store_migration_state (
  id          TEXT       PRIMARY KEY DEFAULT 'legacy',
  migrated_at TIMESTAMPTZ,
  event_count BIGINT     NOT NULL DEFAULT 0
);

-- Permanently-failed AI summary generation jobs (pg-boss retries exhausted).
-- Populated from the "ai-summary-dlq" dead-letter queue so a failure is
-- distinctly visible from a job still retrying in pg-boss's own tables.
CREATE TABLE IF NOT EXISTS ai_summary_job_failures (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  error_message TEXT,
  error_stack TEXT,
  status TEXT NOT NULL DEFAULT 'failed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_summary_job_failures_status
  ON ai_summary_job_failures (status);

CREATE INDEX IF NOT EXISTS idx_ai_summary_job_failures_created_at
  ON ai_summary_job_failures (created_at);

-- Permanently-failed update-notification batches (pg-boss retries exhausted
-- on either the email or push fan-out queue). Populated from each queue's
-- dead-letter queue so a batch that never got delivered is distinctly
-- visible instead of silently swallowed by a fire-and-forget .catch().
CREATE TABLE IF NOT EXISTS notification_job_failures (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  update_id UUID REFERENCES project_updates(id) ON DELETE CASCADE,
  channel TEXT NOT NULL, -- 'email' | 'push'
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  error_message TEXT,
  error_stack TEXT,
  status TEXT NOT NULL DEFAULT 'failed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notification_job_failures_status
  ON notification_job_failures (status);

CREATE INDEX IF NOT EXISTS idx_notification_job_failures_created_at
  ON notification_job_failures (created_at);

-- Indexer cursor: durable resume point so the Horizon operations stream
-- can pick up where it left off after a deploy, crash, or restart.
CREATE TABLE IF NOT EXISTS indexer_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Turrets matching idempotency fence
-- Records every (original_tx_hash, match_id) pair whose
-- matching payment has been successfully submitted.  The
-- UNIQUE constraint is the hard guarantee: even when the
-- application-level pre-check races with a concurrent retry,
-- only one row can ever be inserted for a given pair, making
-- matchDonationTxFunction a provable no-op on any subsequent
-- call for the same transaction_hash + match_id.
-- ============================================================
CREATE TABLE IF NOT EXISTS matching_processed_donations (
  id               UUID        PRIMARY KEY,
  original_tx_hash TEXT        NOT NULL,
  match_id         UUID        NOT NULL REFERENCES donation_matches(id) ON DELETE CASCADE,
  matching_tx_hash TEXT        NOT NULL,
  match_amount_xlm NUMERIC(20, 7) NOT NULL,
  processed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (original_tx_hash, match_id)
);

CREATE INDEX IF NOT EXISTS idx_matching_processed_donations_tx_hash
  ON matching_processed_donations (original_tx_hash);
