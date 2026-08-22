#!/bin/bash

# Disaster-recovery game-day drill.
#
# Runs the *actual* production backup script (scripts/backup-db.sh) and
# restore script (scripts/restore-db.sh) end-to-end against two throwaway
# PostgreSQL containers:
#   - a "source" instance seeded with representative donation/project data
#   - a "target" instance standing in for a freshly-provisioned replacement
#
# It measures real wall-clock restore time (RTO), demonstrates the data-loss
# boundary a nightly backup implies (RPO), and verifies row-level integrity
# of the restored data against what was actually backed up. A machine- and
# human-readable report is written to docs/runbooks/drills/.
#
# Usage: scripts/db-restore-drill.sh
# Env:
#   REPORT_DIR      Where to write the drill report (default: docs/runbooks/drills)
#   KEEP_CONTAINERS Set 'true' to leave the drill containers running for debugging
#
# See docs/runbooks/db-restore-drill.md for the full runbook this automates.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

REPORT_DIR="${REPORT_DIR:-$REPO_ROOT/docs/runbooks/drills}"
KEEP_CONTAINERS="${KEEP_CONTAINERS:-false}"

DRILL_ID="$(date -u +%Y%m%d_%H%M%S)"
WORK_DIR="/tmp/greenpay-restore-drill-${DRILL_ID}"
SOURCE_CONTAINER="greenpay-drill-source-${DRILL_ID}"
TARGET_CONTAINER="greenpay-drill-target-${DRILL_ID}"
SOURCE_PORT=55432
TARGET_PORT=55433
DB_USER="postgres"
DB_PASSWORD="drill-password"
DB_NAME="greenpay"

log() { echo "[DRILL] $(date '+%Y-%m-%d %H:%M:%S') $1"; }
fail() { echo "[DRILL][FAIL] $(date '+%Y-%m-%d %H:%M:%S') $1" >&2; exit 1; }

cleanup() {
    if [ "$KEEP_CONTAINERS" = "true" ]; then
        log "KEEP_CONTAINERS=true: leaving $SOURCE_CONTAINER / $TARGET_CONTAINER running"
        return
    fi
    log "Cleaning up drill containers..."
    docker rm -f "$SOURCE_CONTAINER" "$TARGET_CONTAINER" > /dev/null 2>&1 || true
}
trap cleanup EXIT

mkdir -p "$WORK_DIR" "$REPORT_DIR"

wait_for_postgres() {
    local port="$1"
    local tries=0
    until PGPASSWORD="$DB_PASSWORD" psql -h localhost -p "$port" -U "$DB_USER" -d postgres -c "SELECT 1" > /dev/null 2>&1; do
        tries=$((tries + 1))
        if [ "$tries" -gt 60 ]; then
            fail "Postgres on port $port did not become ready in time"
        fi
        sleep 1
    done
}

log "=== GreenPay disaster-recovery game-day drill ($DRILL_ID) ==="

# --- 1. Bring up the "source" instance (stands in for production) ---
log "Starting source Postgres container ($SOURCE_CONTAINER)..."
docker run -d --name "$SOURCE_CONTAINER" \
    -e POSTGRES_PASSWORD="$DB_PASSWORD" \
    -e POSTGRES_DB="$DB_NAME" \
    -p "${SOURCE_PORT}:5432" \
    postgres:16-alpine > /dev/null
wait_for_postgres "$SOURCE_PORT"
log "Source instance ready on port $SOURCE_PORT"

log "Loading schema..."
PGPASSWORD="$DB_PASSWORD" psql -h localhost -p "$SOURCE_PORT" -U "$DB_USER" -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 -f "$REPO_ROOT/backend/src/db/schema.sql" > /dev/null

log "Seeding representative donation/project data..."
PGPASSWORD="$DB_PASSWORD" psql -h localhost -p "$SOURCE_PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q <<'SQL' > /dev/null
INSERT INTO projects (id, name, description, category, location, wallet_address, goal_xlm, raised_xlm, donor_count, co2_offset_kg, verified, on_chain_verified)
SELECT
  gen_random_uuid(),
  'Drill Project ' || i,
  'Seed project for restore drill verification',
  'reforestation',
  'Test Location',
  'GDRILL' || lpad(i::text, 50, '0'),
  10000, 2500, 5, 100, true, true
FROM generate_series(1, 10) AS i;

INSERT INTO donations (id, project_id, donor_address, amount_xlm, amount, currency, transaction_hash, idempotency_key, status)
SELECT
  gen_random_uuid(),
  p.id,
  'GDONOR' || lpad(row_number() over ()::text, 50, '0'),
  25.5, 25.5, 'XLM',
  'predrill_tx_' || row_number() over (),
  'predrill_tx_' || row_number() over (),
  'committed'
FROM projects p, generate_series(1, 5) AS n;
SQL

PRE_BACKUP_PROJECTS=$(PGPASSWORD="$DB_PASSWORD" psql -h localhost -p "$SOURCE_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM projects;")
PRE_BACKUP_DONATIONS=$(PGPASSWORD="$DB_PASSWORD" psql -h localhost -p "$SOURCE_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM donations;")
PRE_BACKUP_CHECKSUM=$(PGPASSWORD="$DB_PASSWORD" psql -h localhost -p "$SOURCE_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc \
    "SELECT md5(string_agg(transaction_hash, ',' ORDER BY transaction_hash)) FROM donations;")
log "Seeded ${PRE_BACKUP_PROJECTS} projects / ${PRE_BACKUP_DONATIONS} donations before backup"

# --- 2. Run the real, production backup-db.sh against the source instance ---
BACKUP_DIR="$WORK_DIR/backups"
mkdir -p "$BACKUP_DIR"

T_BACKUP_START=$(date +%s.%N)
DB_HOST=localhost DB_PORT="$SOURCE_PORT" DB_USER="$DB_USER" DB_PASSWORD="$DB_PASSWORD" \
    DB_NAME="$DB_NAME" BACKUP_DIR="$BACKUP_DIR" STORAGE_TYPE=local RETENTION_DAYS=30 \
    bash "$SCRIPT_DIR/backup-db.sh" | tee "$WORK_DIR/backup.log"
T_BACKUP_END=$(date +%s.%N)
BACKUP_SECONDS=$(awk -v a="$T_BACKUP_START" -v b="$T_BACKUP_END" 'BEGIN { printf "%.2f", b - a }')

BACKUP_FILE_PATH=$(find "$BACKUP_DIR" -name 'greenpay_backup_*.sql.gz' | sort | tail -n1)
[ -n "$BACKUP_FILE_PATH" ] || fail "backup-db.sh did not produce a backup file"
log "Real backup produced by scripts/backup-db.sh in ${BACKUP_SECONDS}s: $(basename "$BACKUP_FILE_PATH")"
T_BACKUP_WALLCLOCK=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# --- 3. Simulate donations that arrive AFTER the backup but BEFORE the disaster ---
# This is the data a nightly backup, by design, cannot capture — it defines
# the recovery point objective (RPO).
PGPASSWORD="$DB_PASSWORD" psql -h localhost -p "$SOURCE_PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q <<'SQL' > /dev/null
INSERT INTO donations (id, project_id, donor_address, amount_xlm, amount, currency, transaction_hash, idempotency_key, status)
SELECT
  gen_random_uuid(),
  (SELECT id FROM projects ORDER BY id LIMIT 1),
  'GPOSTBACKUP' || lpad(n::text, 44, '0'),
  50, 50, 'XLM',
  'postbackup_tx_' || n,
  'postbackup_tx_' || n,
  'committed'
FROM generate_series(1, 3) AS n;
SQL
POST_BACKUP_DONATIONS=$(PGPASSWORD="$DB_PASSWORD" psql -h localhost -p "$SOURCE_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc \
    "SELECT COUNT(*) FROM donations WHERE transaction_hash LIKE 'postbackup_tx_%';")
T_DISASTER_WALLCLOCK=$(date -u +%Y-%m-%dT%H:%M:%SZ)
log "Simulated ${POST_BACKUP_DONATIONS} donations arriving after the backup, then 'disaster' at ${T_DISASTER_WALLCLOCK}"

# --- 4. Provision a fresh "replacement" instance and restore onto it ---
log "Starting target (fresh replacement) Postgres container ($TARGET_CONTAINER)..."
T_RTO_START=$(date +%s.%N)
docker run -d --name "$TARGET_CONTAINER" \
    -e POSTGRES_PASSWORD="$DB_PASSWORD" \
    -p "${TARGET_PORT}:5432" \
    postgres:16-alpine > /dev/null
wait_for_postgres "$TARGET_PORT"
log "Target instance ready on port $TARGET_PORT"

TIMING_FILE="$WORK_DIR/restore-timing.json"
DB_HOST=localhost DB_PORT="$TARGET_PORT" DB_USER="$DB_USER" DB_PASSWORD="$DB_PASSWORD" \
    STORAGE_TYPE=local LOCAL_BACKUP_PATH="$BACKUP_FILE_PATH" \
    TARGET_DB_NAME="$DB_NAME" REPLACE_EXISTING=true TIMING_FILE="$TIMING_FILE" \
    bash "$SCRIPT_DIR/restore-db.sh" | tee "$WORK_DIR/restore.log"
T_RTO_END=$(date +%s.%N)
RTO_SECONDS=$(awk -v a="$T_RTO_START" -v b="$T_RTO_END" 'BEGIN { printf "%.2f", b - a }')
log "End-to-end RTO (fresh instance provisioned -> restore verified): ${RTO_SECONDS}s"

# --- 5. Verify integrity: restored data must exactly match what was backed up ---
POST_PROJECTS=$(PGPASSWORD="$DB_PASSWORD" psql -h localhost -p "$TARGET_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM projects;")
POST_DONATIONS=$(PGPASSWORD="$DB_PASSWORD" psql -h localhost -p "$TARGET_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM donations;")
POST_CHECKSUM=$(PGPASSWORD="$DB_PASSWORD" psql -h localhost -p "$TARGET_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc \
    "SELECT md5(string_agg(transaction_hash, ',' ORDER BY transaction_hash)) FROM donations;")
POST_BACKUP_ROWS_PRESENT=$(PGPASSWORD="$DB_PASSWORD" psql -h localhost -p "$TARGET_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc \
    "SELECT COUNT(*) FROM donations WHERE transaction_hash LIKE 'postbackup_tx_%';")

INTEGRITY_OK=true
[ "$POST_PROJECTS" = "$PRE_BACKUP_PROJECTS" ] || { INTEGRITY_OK=false; log "MISMATCH: projects $PRE_BACKUP_PROJECTS -> $POST_PROJECTS"; }
[ "$POST_DONATIONS" = "$PRE_BACKUP_DONATIONS" ] || { INTEGRITY_OK=false; log "MISMATCH: donations $PRE_BACKUP_DONATIONS -> $POST_DONATIONS"; }
[ "$POST_CHECKSUM" = "$PRE_BACKUP_CHECKSUM" ] || { INTEGRITY_OK=false; log "MISMATCH: donations checksum differs"; }
[ "$POST_BACKUP_ROWS_PRESENT" = "0" ] || { INTEGRITY_OK=false; log "MISMATCH: post-backup donations leaked into restore (expected 0, got $POST_BACKUP_ROWS_PRESENT)"; }

if [ "$INTEGRITY_OK" = "true" ]; then
    log "Integrity check PASSED: restored ${POST_PROJECTS} projects / ${POST_DONATIONS} donations exactly match the backup, and the ${POST_BACKUP_DONATIONS} post-backup donations are correctly absent."
else
    log "Integrity check FAILED — see mismatches above"
fi

RPO_DRILL_WINDOW_SECONDS=$(awk -v a="$T_BACKUP_START" -v b="$(date +%s.%N)" 'BEGIN { printf "%.0f", b - a }')

# --- 6. Write the drill report ---
REPORT_MD="$REPORT_DIR/${DRILL_ID}-restore-drill.md"
REPORT_JSON="$REPORT_DIR/${DRILL_ID}-restore-drill.json"

STATUS="PASSED"
[ "$INTEGRITY_OK" = "true" ] || STATUS="FAILED"

cat > "$REPORT_JSON" <<EOF
{
  "drill_id": "${DRILL_ID}",
  "status": "${STATUS}",
  "backup_seconds": ${BACKUP_SECONDS},
  "rto_seconds": ${RTO_SECONDS},
  "backup_completed_at": "${T_BACKUP_WALLCLOCK}",
  "simulated_disaster_at": "${T_DISASTER_WALLCLOCK}",
  "pre_backup_projects": ${PRE_BACKUP_PROJECTS},
  "pre_backup_donations": ${PRE_BACKUP_DONATIONS},
  "post_restore_projects": ${POST_PROJECTS},
  "post_restore_donations": ${POST_DONATIONS},
  "post_backup_donations_simulated": ${POST_BACKUP_DONATIONS},
  "post_backup_donations_leaked_into_restore": ${POST_BACKUP_ROWS_PRESENT},
  "donations_checksum_match": $([ "$POST_CHECKSUM" = "$PRE_BACKUP_CHECKSUM" ] && echo true || echo false)
}
EOF

cat > "$REPORT_MD" <<EOF
# Restore drill report — ${DRILL_ID}

**Status:** ${STATUS}
**Run by:** automated (\`scripts/db-restore-drill.sh\`)
**Backup script:** \`scripts/backup-db.sh\` (real pg_dump + gzip, STORAGE_TYPE=local)
**Restore script:** \`scripts/restore-db.sh\`

## Timings (measured, not estimated)

| Metric | Value | Definition |
|---|---|---|
| Backup duration | ${BACKUP_SECONDS}s | \`pg_dump\` + gzip on a ${PRE_BACKUP_PROJECTS}-project / ${PRE_BACKUP_DONATIONS}-donation seed dataset |
| **RTO** | **${RTO_SECONDS}s** | From provisioning a fresh Postgres instance through a fully restored + verified database |
| RPO boundary | ≤ backup interval | Donations inserted after the backup (simulated: ${POST_BACKUP_DONATIONS}) are correctly absent from the restore — see "RPO in production" below |

## Data integrity

| | Pre-backup (source) | Post-restore (target) | Match |
|---|---|---|---|
| Projects | ${PRE_BACKUP_PROJECTS} | ${POST_PROJECTS} | $([ "$POST_PROJECTS" = "$PRE_BACKUP_PROJECTS" ] && echo yes || echo NO) |
| Donations | ${PRE_BACKUP_DONATIONS} | ${POST_DONATIONS} | $([ "$POST_DONATIONS" = "$PRE_BACKUP_DONATIONS" ] && echo yes || echo NO) |
| Donations checksum (md5 of sorted transaction_hash) | \`${PRE_BACKUP_CHECKSUM}\` | \`${POST_CHECKSUM}\` | $([ "$POST_CHECKSUM" = "$PRE_BACKUP_CHECKSUM" ] && echo yes || echo NO) |
| Post-backup donations leaked into restore | — | ${POST_BACKUP_ROWS_PRESENT} (expected 0) | $([ "$POST_BACKUP_ROWS_PRESENT" = "0" ] && echo yes || echo NO) |

## RPO in production

This drill uses a local, on-demand backup to isolate the restore mechanics, so
the simulated gap between "backup" and "disaster" above is seconds, not
representative of production. In production, \`.github/workflows/database-backup.yml\`
runs \`scripts/backup-db.sh\` once nightly at 02:00 UTC, so the **actual RPO is
bounded by that cadence: up to ~24 hours of donations/updates since the last
successful nightly run can be lost in a restore.** What this drill *does*
validate for real is the mechanism that RPO depends on: data written before
the backup is preserved exactly (checksum match above), and data written
after it is cleanly excluded rather than partially/corruptly captured.

## Procedure executed

See [docs/runbooks/db-restore-drill.md](../db-restore-drill.md) for the full,
human-runnable version of this procedure.

1. Seeded a source PostgreSQL 16 instance with representative \`projects\`/\`donations\` rows.
2. Ran the real \`scripts/backup-db.sh\` against it (\`STORAGE_TYPE=local\`).
3. Inserted additional donations to simulate activity after the backup.
4. Provisioned a fresh PostgreSQL 16 instance (standing in for a replacement).
5. Ran the real \`scripts/restore-db.sh\` against the backup produced in step 2, timing the full provision-through-verified-restore window.
6. Compared row counts and a checksum of \`donations.transaction_hash\` between the pre-backup source and the restored target.
EOF

log "Report written to $REPORT_MD"

if [ "$INTEGRITY_OK" != "true" ]; then
    fail "Restore drill FAILED integrity verification"
fi

log "=== Drill ${DRILL_ID} PASSED ==="
