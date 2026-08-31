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

-- Original donor-facing copy remains on projects for backwards compatibility.
-- source_language identifies that immutable language context; approved
-- translations are separate moderated user-content records.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_language TEXT NOT NULL DEFAULT 'en';

CREATE TABLE IF NOT EXISTS project_translations (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  language TEXT NOT NULL CHECK (language IN ('en', 'es', 'ar')),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  location TEXT NOT NULL,
  machine_translated BOOLEAN NOT NULL DEFAULT FALSE,
  impact_claims_reviewed BOOLEAN NOT NULL DEFAULT FALSE,
  moderation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (moderation_status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, language)
);

CREATE INDEX IF NOT EXISTS idx_project_translations_search
  ON project_translations(project_id, language, moderation_status);

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
ALTER TABLE projects ADD COLUMN IF NOT EXISTS verification_expires_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS verification_revoked_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS verification_revocation_reason TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS verification_decision_tx_hash TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS verification_decision_contract_id TEXT;

CREATE TABLE IF NOT EXISTS project_verification_applications (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  submitted_by_wallet TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'wallet_proof_pending'
    CHECK (status IN (
      'wallet_proof_pending',
      'submitted',
      'under_review',
      'community_vote',
      'approved',
      'rejected',
      'revoked',
      'expired'
    )),
  attestation_summary TEXT,
  wallet_challenge TEXT,
  wallet_challenge_expires_at TIMESTAMPTZ,
  wallet_verified_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  community_vote_opens_at TIMESTAMPTZ,
  community_vote_closes_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  decision_tx_hash TEXT,
  decision_contract_id TEXT,
  latest_rationale TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_verification_applications_project
  ON project_verification_applications (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_verification_applications_status
  ON project_verification_applications (status);

CREATE TABLE IF NOT EXISTS project_verification_evidence (
  id UUID PRIMARY KEY,
  application_id UUID NOT NULL REFERENCES project_verification_applications(id) ON DELETE CASCADE,
  evidence_type TEXT NOT NULL
    CHECK (evidence_type IN (
      'wallet_control',
      'legal_identity',
      'project_documentation',
      'impact_evidence',
      'other'
    )),
  attestation_type TEXT NOT NULL
    CHECK (attestation_type IN ('cryptographic_proof', 'human_attestation')),
  document_hash TEXT NOT NULL,
  storage_uri TEXT,
  private BOOLEAN NOT NULL DEFAULT TRUE,
  submitted_by TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_verification_evidence_application
  ON project_verification_evidence (application_id, created_at DESC);

CREATE TABLE IF NOT EXISTS project_verification_events (
  id UUID PRIMARY KEY,
  application_id UUID NOT NULL REFERENCES project_verification_applications(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  actor_type TEXT NOT NULL
    CHECK (actor_type IN ('project_wallet', 'platform_admin', 'dao', 'system')),
  from_status TEXT,
  to_status TEXT NOT NULL,
  rationale TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_verification_events_application
  ON project_verification_events (application_id, created_at ASC);

-- ============================================================
-- Evidence-first environmental impact accounting
-- ============================================================
-- A project's legacy co2_offset_kg column is retained only so old clients and
-- rollback builds can still read the original record.  Donor-facing impact
-- APIs read exclusively from the normalized records below.  In particular,
-- donations are never joined to a project-level quantity to manufacture a
-- donor-level outcome.

CREATE TABLE IF NOT EXISTS impact_methodologies (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  claim_type TEXT NOT NULL
    CHECK (claim_type IN ('avoided_emissions', 'sequestration', 'offset')),
  unit TEXT NOT NULL,
  description TEXT NOT NULL,
  accounting_approach TEXT NOT NULL,
  limitations TEXT NOT NULL,
  comparison_scope TEXT NOT NULL,
  registry_url TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- This methodology does not endorse or verify the historical values.  It is a
-- durable migration label that prevents an unsourced scalar from silently
-- acquiring verified status after the schema upgrade.
INSERT INTO impact_methodologies (
  id, code, name, version, claim_type, unit, description,
  accounting_approach, limitations, comparison_scope, active
) VALUES (
  '00000000-0000-4000-8000-000000000001',
  'legacy-operator-stated-offset',
  'Legacy operator-stated offset',
  '1',
  'offset',
  'kg_co2e',
  'Migration-only label for a project operator figure that predates evidence-first accounting.',
  'No calculation method was recorded. The value is preserved as an operator assertion, not recomputed from donations.',
  'No source, baseline, measurement period, verifier, or uncertainty was supplied with the original value.',
  'legacy-unsourced-values-only',
  FALSE
) ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS impact_claims (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  methodology_id UUID NOT NULL REFERENCES impact_methodologies(id),
  claim_type TEXT NOT NULL
    CHECK (claim_type IN ('avoided_emissions', 'sequestration', 'offset')),
  quantity NUMERIC(30, 6) NOT NULL CHECK (quantity >= 0),
  unit TEXT NOT NULL,
  uncertainty_low NUMERIC(30, 6) NOT NULL CHECK (uncertainty_low >= 0),
  uncertainty_high NUMERIC(30, 6) NOT NULL,
  confidence_percent NUMERIC(5, 2)
    CHECK (confidence_percent IS NULL OR (confidence_percent > 0 AND confidence_percent <= 100)),
  measurement_period_start DATE NOT NULL,
  measurement_period_end DATE NOT NULL,
  vintage_start DATE,
  vintage_end DATE,
  baseline_description TEXT NOT NULL,
  asserting_party TEXT NOT NULL,
  asserting_party_type TEXT NOT NULL DEFAULT 'project_operator'
    CHECK (asserting_party_type IN ('project_operator', 'data_provider', 'platform_migration')),
  status TEXT NOT NULL DEFAULT 'operator_stated'
    CHECK (status IN ('unverified', 'operator_stated', 'verified', 'revoked', 'expired')),
  asserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  supersedes_claim_id UUID REFERENCES impact_claims(id),
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  migrated_from_legacy BOOLEAN NOT NULL DEFAULT FALSE,
  migration_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (uncertainty_low <= quantity AND quantity <= uncertainty_high),
  CHECK (measurement_period_start <= measurement_period_end),
  CHECK (vintage_start IS NULL OR vintage_end IS NULL OR vintage_start <= vintage_end)
);

CREATE INDEX IF NOT EXISTS idx_impact_claims_project
  ON impact_claims (project_id, asserted_at DESC);
CREATE INDEX IF NOT EXISTS idx_impact_claims_comparison
  ON impact_claims (claim_type, methodology_id, unit, status);

CREATE TABLE IF NOT EXISTS impact_evidence (
  id UUID PRIMARY KEY,
  claim_id UUID NOT NULL REFERENCES impact_claims(id) ON DELETE CASCADE,
  evidence_type TEXT NOT NULL
    CHECK (evidence_type IN ('measurement', 'baseline', 'calculation', 'monitoring_report', 'other')),
  source_uri TEXT,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  description TEXT NOT NULL,
  measurement_date DATE,
  submitted_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_impact_evidence_claim
  ON impact_evidence (claim_id, created_at ASC);

-- An assertion and its independent attestation are deliberately separate.
-- canonical_payload is the exact JSON document whose SHA-256 is anchored by
-- the Soroban contract.  Revocation never deletes the row or the old anchor.
CREATE TABLE IF NOT EXISTS impact_attestations (
  id UUID PRIMARY KEY,
  claim_id UUID NOT NULL REFERENCES impact_claims(id) ON DELETE CASCADE,
  verifier_name TEXT NOT NULL,
  verifier_address TEXT NOT NULL,
  canonical_payload JSONB NOT NULL,
  attestation_hash TEXT NOT NULL CHECK (attestation_hash ~ '^[0-9a-f]{64}$'),
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'verified'
    CHECK (status IN ('pending_anchor', 'verified', 'revoked', 'expired')),
  contract_id TEXT,
  anchor_transaction_hash TEXT,
  anchor_ledger INTEGER,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  revocation_transaction_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (claim_id, verifier_address, attestation_hash)
);

CREATE INDEX IF NOT EXISTS idx_impact_attestations_claim
  ON impact_attestations (claim_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_impact_attestations_hash
  ON impact_attestations (attestation_hash);

-- Existing non-zero figures are preserved, visibly, as operator-stated data.
-- A deliberately broad 0..2x uncertainty range communicates that the old
-- scalar arrived without recorded uncertainty; it does not manufacture
-- precision.  ADR-006 records why these rows are neither hidden nor verified.
INSERT INTO impact_claims (
  id, project_id, methodology_id, claim_type, quantity, unit,
  uncertainty_low, uncertainty_high, confidence_percent,
  measurement_period_start, measurement_period_end,
  baseline_description, asserting_party, asserting_party_type, status,
  asserted_at, migrated_from_legacy, migration_note
)
SELECT
  md5('legacy-impact-claim:' || p.id::text)::uuid,
  p.id,
  '00000000-0000-4000-8000-000000000001',
  'offset',
  p.co2_offset_kg,
  'kg_co2e',
  0,
  p.co2_offset_kg * 2,
  NULL,
  p.created_at::date,
  GREATEST(p.created_at::date, p.updated_at::date),
  'No baseline was recorded for this legacy operator assertion.',
  'Project operator (legacy import)',
  'platform_migration',
  'operator_stated',
  p.updated_at,
  TRUE,
  'Imported from projects.co2_offset_kg; unsourced, unverified, and never allocated to donors.'
FROM projects p
WHERE p.co2_offset_kg > 0
ON CONFLICT (id) DO NOTHING;

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

-- ============================================================
-- Donation integrity: behavioural signals, human review, appeals
-- ============================================================
-- Relationships are assertions with provenance, not identity claims. They
-- make exact self-donation detectable while preserving the distinction
-- between a verified relationship and a probabilistic graph signal.
CREATE TABLE IF NOT EXISTS project_wallet_relationships (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  relationship_type TEXT NOT NULL
    CHECK (relationship_type IN (
      'recipient', 'owner', 'operator', 'treasury', 'beneficiary', 'declared_related'
    )),
  source TEXT NOT NULL
    CHECK (source IN ('project_record', 'wallet_proof', 'admin_evidence', 'on_chain_analysis')),
  confidence NUMERIC(5, 4) NOT NULL DEFAULT 1
    CHECK (confidence >= 0 AND confidence <= 1),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until TIMESTAMPTZ,
  recorded_by TEXT NOT NULL DEFAULT 'system',
  evidence JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, wallet_address, relationship_type)
);

CREATE INDEX IF NOT EXISTS idx_project_wallet_relationships_address
  ON project_wallet_relationships (wallet_address, project_id)
  WHERE active = TRUE;

INSERT INTO project_wallet_relationships (
  id, project_id, wallet_address, relationship_type, source,
  confidence, active, recorded_by, evidence
)
SELECT
  md5('project-recipient-wallet:' || p.id::text || ':' || p.wallet_address)::uuid,
  p.id,
  p.wallet_address,
  'recipient',
  'project_record',
  1,
  TRUE,
  'schema_backfill',
  jsonb_build_object('field', 'projects.wallet_address')
FROM projects p
ON CONFLICT (project_id, wallet_address, relationship_type) DO UPDATE
SET active = TRUE,
    confidence = 1,
    updated_at = NOW();

-- Every donation observed by either API or indexer is queued transactionally.
-- Scoring is deliberately outside the donation commit path so a detector
-- outage never blocks or reverses a valid on-chain donation.
CREATE TABLE IF NOT EXISTS donation_integrity_queue (
  transaction_hash TEXT PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  donor_address TEXT NOT NULL,
  destination_address TEXT,
  amount_xlm NUMERIC(20, 7) NOT NULL,
  observed_source TEXT NOT NULL
    CHECK (observed_source IN ('api', 'indexer_horizon', 'indexer_soroban', 'historical_replay')),
  ledger BIGINT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_donation_integrity_queue_ready
  ON donation_integrity_queue (next_attempt_at, observed_at);

CREATE TABLE IF NOT EXISTS donation_integrity_assessments (
  id UUID PRIMARY KEY,
  transaction_hash TEXT NOT NULL UNIQUE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  donor_address TEXT NOT NULL,
  destination_address TEXT,
  amount_xlm NUMERIC(20, 7) NOT NULL,
  observed_source TEXT NOT NULL
    CHECK (observed_source IN ('api', 'indexer_horizon', 'indexer_soroban', 'historical_replay')),
  ledger BIGINT,
  observed_at TIMESTAMPTZ NOT NULL,
  confidence_score NUMERIC(5, 4) NOT NULL DEFAULT 0
    CHECK (confidence_score >= 0 AND confidence_score <= 1),
  review_status TEXT NOT NULL DEFAULT 'monitoring'
    CHECK (review_status IN ('monitoring', 'pending_review', 'confirmed', 'dismissed', 'appealed')),
  exclude_from_leaderboard BOOLEAN NOT NULL DEFAULT FALSE,
  exclude_from_displayed_totals BOOLEAN NOT NULL DEFAULT FALSE,
  exclude_from_impact_figures BOOLEAN NOT NULL DEFAULT FALSE,
  assigned_to TEXT,
  decision_reason TEXT,
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  last_scored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_integrity_assessments_review_queue
  ON donation_integrity_assessments (review_status, confidence_score DESC, observed_at ASC);
CREATE INDEX IF NOT EXISTS idx_integrity_assessments_pair
  ON donation_integrity_assessments (project_id, donor_address, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_integrity_assessments_leaderboard
  ON donation_integrity_assessments (donor_address)
  WHERE review_status = 'confirmed' AND exclude_from_leaderboard = TRUE;
CREATE INDEX IF NOT EXISTS idx_integrity_assessments_project_totals
  ON donation_integrity_assessments (project_id)
  WHERE review_status = 'confirmed' AND exclude_from_displayed_totals = TRUE;

CREATE TABLE IF NOT EXISTS donation_integrity_signals (
  id UUID PRIMARY KEY,
  assessment_id UUID NOT NULL REFERENCES donation_integrity_assessments(id) ON DELETE CASCADE,
  signal_type TEXT NOT NULL
    CHECK (signal_type IN ('self_donation', 'circular_flow', 'rapid_repeat_pair')),
  confidence NUMERIC(5, 4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  fingerprint TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::JSONB,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(assessment_id, signal_type, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_integrity_signals_assessment
  ON donation_integrity_signals (assessment_id, confidence DESC);

-- Only flow edges adjacent to project-controlled or detector-watched wallets
-- are retained. project_id carries the bounded propagation context used by
-- the depth-three recursive cycle check.
CREATE TABLE IF NOT EXISTS donation_integrity_flow_edges (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  transaction_hash TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  source_address TEXT NOT NULL,
  destination_address TEXT NOT NULL,
  amount_xlm NUMERIC(20, 7) NOT NULL,
  ledger BIGINT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '72 hours'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_integrity_flow_edges_graph
  ON donation_integrity_flow_edges (project_id, source_address, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_integrity_flow_edges_destination
  ON donation_integrity_flow_edges (project_id, destination_address, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_integrity_flow_edges_expiry
  ON donation_integrity_flow_edges (expires_at);

CREATE TABLE IF NOT EXISTS donation_integrity_events (
  id UUID PRIMARY KEY,
  assessment_id UUID NOT NULL REFERENCES donation_integrity_assessments(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  actor_type TEXT NOT NULL
    CHECK (actor_type IN ('system', 'reviewer', 'appellant')),
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_integrity_events_assessment
  ON donation_integrity_events (assessment_id, created_at ASC);

CREATE TABLE IF NOT EXISTS donation_integrity_appeal_challenges (
  id UUID PRIMARY KEY,
  assessment_id UUID NOT NULL REFERENCES donation_integrity_assessments(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  challenge TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_integrity_appeal_challenges_open
  ON donation_integrity_appeal_challenges (assessment_id, wallet_address, expires_at)
  WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS donation_integrity_appeals (
  id UUID PRIMARY KEY,
  assessment_id UUID NOT NULL REFERENCES donation_integrity_assessments(id) ON DELETE CASCADE,
  appellant_wallet TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'granted', 'denied')),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by TEXT,
  decision_reason TEXT,
  decided_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_integrity_appeals_one_pending
  ON donation_integrity_appeals (assessment_id)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS donation_integrity_labels (
  assessment_id UUID PRIMARY KEY REFERENCES donation_integrity_assessments(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (label IN ('legitimate', 'confirmed_abuse', 'uncertain')),
  labelled_by TEXT NOT NULL,
  rationale TEXT NOT NULL,
  labelled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS donation_integrity_settings (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  enforcement_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_by TEXT,
  enabled_at TIMESTAMPTZ,
  evaluation_snapshot JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO donation_integrity_settings (id, enforcement_enabled)
VALUES ('global', FALSE)
ON CONFLICT (id) DO NOTHING;

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

ALTER TABLE project_updates ADD COLUMN IF NOT EXISTS source_language TEXT NOT NULL DEFAULT 'en';

-- Existing rows pre-date moderation and were already donor-visible. Mark them
-- published on first migration, then use pending as the default for all future
-- inserts so a route omission can never publish unreviewed content.
ALTER TABLE project_updates ADD COLUMN IF NOT EXISTS moderation_status TEXT NOT NULL DEFAULT 'published';
ALTER TABLE project_updates ADD COLUMN IF NOT EXISTS moderation_reason TEXT;
ALTER TABLE project_updates ADD COLUMN IF NOT EXISTS moderation_actor TEXT;
ALTER TABLE project_updates ADD COLUMN IF NOT EXISTS moderation_updated_at TIMESTAMPTZ;
ALTER TABLE project_updates ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE project_updates ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE project_updates ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
ALTER TABLE project_updates ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;
ALTER TABLE project_updates ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE project_updates ADD COLUMN IF NOT EXISTS email_notified_at TIMESTAMPTZ;
ALTER TABLE project_updates ADD COLUMN IF NOT EXISTS push_notified_at TIMESTAMPTZ;
ALTER TABLE project_updates ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;
ALTER TABLE project_updates ADD COLUMN IF NOT EXISTS removal_email_notified_at TIMESTAMPTZ;
ALTER TABLE project_updates ADD COLUMN IF NOT EXISTS removal_push_notified_at TIMESTAMPTZ;
UPDATE project_updates
SET published_at = COALESCE(published_at, created_at)
WHERE moderation_status = 'published' AND published_at IS NULL;
ALTER TABLE project_updates ALTER COLUMN moderation_status SET DEFAULT 'pending';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'project_updates_moderation_status_check'
  ) THEN
    ALTER TABLE project_updates
      ADD CONSTRAINT project_updates_moderation_status_check
      CHECK (moderation_status IN (
        'pending', 'published_pending_review', 'published', 'rejected', 'removed', 'appealed'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_project_updates_public_feed
  ON project_updates(project_id, created_at DESC, id DESC)
  WHERE moderation_status IN ('published', 'published_pending_review');

CREATE INDEX IF NOT EXISTS idx_project_updates_moderation_queue
  ON project_updates(moderation_status, moderation_updated_at, created_at);

CREATE TABLE IF NOT EXISTS project_update_revisions (
  id UUID PRIMARY KEY,
  update_id UUID NOT NULL REFERENCES project_updates(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source_language TEXT NOT NULL,
  moderation_status TEXT NOT NULL,
  was_public BOOLEAN NOT NULL DEFAULT FALSE,
  content_visible BOOLEAN NOT NULL DEFAULT TRUE,
  edited_by TEXT NOT NULL,
  edit_reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(update_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_project_update_revisions_history
  ON project_update_revisions(update_id, revision DESC);

CREATE TABLE IF NOT EXISTS project_update_moderation_events (
  id UUID PRIMARY KEY,
  update_id UUID NOT NULL REFERENCES project_updates(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('project_admin', 'moderator', 'system')),
  action TEXT NOT NULL CHECK (action IN (
    'created', 'edited', 'approved', 'rejected', 'removed', 'reinstated',
    'appealed', 'appeal_granted', 'appeal_denied'
  )),
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_update_moderation_events_audit
  ON project_update_moderation_events(update_id, created_at ASC);

CREATE TABLE IF NOT EXISTS project_update_reports (
  id UUID PRIMARY KEY,
  update_id UUID NOT NULL REFERENCES project_updates(id) ON DELETE CASCADE,
  reporter_address TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN (
    'fraudulent_claim', 'abuse', 'spam', 'off_topic_solicitation',
    'dangerous_content', 'privacy', 'other'
  )),
  details TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'reviewed', 'dismissed', 'actioned')),
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  resolution TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(update_id, reporter_address)
);

CREATE INDEX IF NOT EXISTS idx_project_update_reports_queue
  ON project_update_reports(status, created_at ASC);

CREATE TABLE IF NOT EXISTS project_update_appeals (
  id UUID PRIMARY KEY,
  update_id UUID NOT NULL REFERENCES project_updates(id) ON DELETE CASCADE,
  filed_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  prior_status TEXT NOT NULL CHECK (prior_status IN ('rejected', 'removed')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'granted', 'denied')),
  decided_by TEXT,
  decision_reason TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_update_appeals_one_pending
  ON project_update_appeals(update_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_project_update_appeals_queue
  ON project_update_appeals(status, created_at ASC);

-- Exact email recipient snapshot for irrevocable update delivery. Corrections
-- use this list rather than today's subscribers, so an unsubscribe after the
-- original message does not prevent a necessary moderation follow-up and a
-- later subscriber never receives a correction for content they did not see.
CREATE TABLE IF NOT EXISTS project_update_email_recipients (
  update_id UUID NOT NULL REFERENCES project_updates(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('en', 'es', 'ar')),
  project_name TEXT NOT NULL,
  update_title TEXT NOT NULL,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  correction_queued_at TIMESTAMPTZ,
  PRIMARY KEY(update_id, email)
);

CREATE INDEX IF NOT EXISTS idx_project_update_email_corrections
  ON project_update_email_recipients(update_id, email)
  WHERE correction_queued_at IS NULL;

CREATE TABLE IF NOT EXISTS project_update_push_recipients (
  update_id UUID NOT NULL REFERENCES project_updates(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  platform TEXT NOT NULL,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  correction_queued_at TIMESTAMPTZ,
  PRIMARY KEY(update_id, token)
);

CREATE INDEX IF NOT EXISTS idx_project_update_push_corrections
  ON project_update_push_recipients(update_id, token)
  WHERE correction_queued_at IS NULL;

CREATE TABLE IF NOT EXISTS project_update_translations (
  id UUID PRIMARY KEY,
  update_id UUID NOT NULL REFERENCES project_updates(id) ON DELETE CASCADE,
  language TEXT NOT NULL CHECK (language IN ('en', 'es', 'ar')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  machine_translated BOOLEAN NOT NULL DEFAULT FALSE,
  impact_claims_reviewed BOOLEAN NOT NULL DEFAULT FALSE,
  moderation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (moderation_status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(update_id, language)
);

CREATE INDEX IF NOT EXISTS idx_project_update_translations_lookup
  ON project_update_translations(update_id, language, moderation_status);

CREATE TABLE IF NOT EXISTS project_subscriptions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  donor_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, email)
);

ALTER TABLE project_subscriptions ADD COLUMN IF NOT EXISTS preferred_language TEXT NOT NULL DEFAULT 'en';

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

-- ============================================================
-- Project search indexes (issue #500)
-- Full-text + trigram for ranked discovery; no leading-wildcard scans.
-- Multilingual: 'simple' config avoids mis-stemming non-English descriptions.
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE OR REPLACE FUNCTION projects_search_vector_update() RETURNS trigger AS $$
BEGIN
  -- English stemming on primary narrative fields; simple tokenization on the
  -- rest so multilingual category/location/tags are not mis-stemmed.
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.category, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.location, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(array_to_string(NEW.tags, ' '), '')), 'C') ||
    setweight(to_tsvector('english', coalesce(NEW.description, '')), 'D') ||
    setweight(to_tsvector('simple', coalesce(NEW.description, '')), 'D');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS projects_search_vector_trigger ON projects;
CREATE TRIGGER projects_search_vector_trigger
  BEFORE INSERT OR UPDATE OF name, description, category, location, tags ON projects
  FOR EACH ROW EXECUTE FUNCTION projects_search_vector_update();

UPDATE projects SET
  search_vector =
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(category, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(location, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(array_to_string(tags, ' '), '')), 'C') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'D') ||
    setweight(to_tsvector('simple', coalesce(description, '')), 'D')
WHERE search_vector IS NULL;

CREATE INDEX IF NOT EXISTS idx_projects_search_vector ON projects USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_projects_name_trgm ON projects USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_projects_location_trgm ON projects USING GIN (location gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_projects_category ON projects (category);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects (status);
CREATE INDEX IF NOT EXISTS idx_projects_verified ON projects (verified);

-- ── Graduated donor onboarding ──────────────────────────────────────────────
-- Tables behind the first-donation paths for donors who arrive without a
-- wallet, without a funded account, or without both. See
-- docs/adr/ADR-005-graduated-non-custodial-donor-onboarding.md.
--
-- Nothing here stores a private key, a seed phrase, or any material that could
-- be used to sign for a donor. The platform's non-custodial guarantee is a
-- property of the schema, not only of the code: there is no column to put a
-- key in.

-- sponsored_accounts: one row per sponsorship request, from the moment
-- treasury capacity is reserved to the moment the reserve comes back.
--
-- reserved_stroops holds capacity that is committed but not yet locked on
-- chain; locked_stroops holds reserve the ledger has actually taken. Keeping
-- them apart is what lets an abandoned or failed request give its capacity back
-- without ever having claimed to hold real reserve.
CREATE TABLE IF NOT EXISTS sponsored_accounts (
  id UUID PRIMARY KEY,
  account_public_key TEXT NOT NULL,
  sponsor_public_key TEXT NOT NULL,
  session_id UUID,
  -- Hashed, never the address itself: enough to rate-limit, not enough to
  -- identify or to be worth stealing.
  ip_hash TEXT,
  user_agent_hash TEXT,
  state TEXT NOT NULL DEFAULT 'requested'
    CHECK (state IN ('requested', 'awaiting_signature', 'submitted', 'active', 'failed', 'abandoned', 'reclaimed')),
  reserved_stroops NUMERIC(20, 0) NOT NULL DEFAULT 0,
  locked_stroops NUMERIC(20, 0) NOT NULL DEFAULT 0,
  network TEXT NOT NULL DEFAULT 'testnet',
  unsigned_xdr TEXT,
  transaction_hash TEXT,
  reclaim_transaction_hash TEXT,
  reclaim_failures INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT,
  upgraded_to TEXT,
  expires_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One live sponsorship per address. A partial index rather than a plain unique
-- constraint, because the same address may legitimately appear again after a
-- previous attempt failed or was abandoned.
CREATE UNIQUE INDEX IF NOT EXISTS sponsored_accounts_live_key
  ON sponsored_accounts (account_public_key)
  WHERE state IN ('requested', 'awaiting_signature', 'submitted', 'active');
CREATE INDEX IF NOT EXISTS idx_sponsored_accounts_state ON sponsored_accounts (state);
CREATE INDEX IF NOT EXISTS idx_sponsored_accounts_ip_hash ON sponsored_accounts (ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sponsored_accounts_session ON sponsored_accounts (session_id);
CREATE INDEX IF NOT EXISTS idx_sponsored_accounts_created ON sponsored_accounts (created_at DESC);

-- onboarding_sessions: one row per donor attempt at a first donation.
-- Holds no IP, no user agent and no cookie — the id is a random value the
-- browser generates. Enough to measure conversion, not enough to profile.
CREATE TABLE IF NOT EXISTS onboarding_sessions (
  id UUID PRIMARY KEY,
  path TEXT CHECK (path IN ('connected_wallet', 'sponsored_account', 'onramp', 'claimable_balance')),
  project_id UUID,
  referrer_kind TEXT NOT NULL DEFAULT 'direct',
  furthest_stage TEXT,
  furthest_stage_index INTEGER NOT NULL DEFAULT -1,
  outcome TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (outcome IN ('completed', 'abandoned', 'failed', 'in_progress')),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_outcome ON onboarding_sessions (outcome, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_path ON onboarding_sessions (path, created_at DESC);

-- onboarding_funnel_events: one row per (session, stage, path).
--
-- path_key exists only so the uniqueness constraint works: a NULL path would
-- make every re-report a fresh row under SQL's NULL comparison rules, which is
-- exactly the double-counting the idempotency is there to prevent.
CREATE TABLE IF NOT EXISTS onboarding_funnel_events (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL,
  stage TEXT NOT NULL,
  stage_index INTEGER NOT NULL,
  path TEXT,
  path_key TEXT GENERATED ALWAYS AS (COALESCE(path, '')) STORED,
  project_id UUID,
  detail JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, stage, path_key)
);
CREATE INDEX IF NOT EXISTS idx_funnel_events_stage ON onboarding_funnel_events (stage_index, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_funnel_events_occurred ON onboarding_funnel_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_funnel_events_session ON onboarding_funnel_events (session_id);

-- account_upgrades: a donor moving from a browser-held starter account to a
-- wallet they properly control. Both addresses sign the same single-use nonce.
CREATE TABLE IF NOT EXISTS account_upgrades (
  id UUID PRIMARY KEY,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  nonce TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'challenged'
    CHECK (state IN ('challenged', 'completed', 'expired', 'rejected')),
  migrated_donations INTEGER NOT NULL DEFAULT 0,
  migrated_amount NUMERIC(20, 7) NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_account_upgrades_from ON account_upgrades (from_address);
CREATE INDEX IF NOT EXISTS idx_account_upgrades_state ON account_upgrades (state, created_at DESC);

-- donor_address_links: the durable result of an upgrade.
--
-- Donations are never rewritten to a new donor_address — the ledger says which
-- address made them and the database must not contradict it. Instead every
-- read path that means "this donor's history" resolves through this table.
-- linked_address is unique so an address can belong to exactly one donor.
CREATE TABLE IF NOT EXISTS donor_address_links (
  id UUID PRIMARY KEY,
  canonical_address TEXT NOT NULL,
  linked_address TEXT NOT NULL UNIQUE,
  upgrade_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_donor_links_canonical ON donor_address_links (canonical_address);
