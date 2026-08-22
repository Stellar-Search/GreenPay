#!/bin/bash

# Database Restore Script
# Restores a PostgreSQL database from a backup produced by scripts/backup-db.sh
# Supports fetching the backup from AWS S3, Google Cloud Storage, or a local
# file, and can restore into a fresh/new database (recommended for drills)
# or replace an existing one.
#
# This is the script exercised by scripts/db-restore-drill.sh and the
# quarterly .github/workflows/db-restore-drill.yml game day. See
# docs/runbooks/db-restore-drill.md for the full runbook.

set -euo pipefail

# Configuration
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-postgres}"
DB_PASSWORD="${DB_PASSWORD:-}"
TARGET_DB_NAME="${TARGET_DB_NAME:-greenpay_restored}"
BACKUP_DIR="${BACKUP_DIR:-/tmp/backups}"
STORAGE_TYPE="${STORAGE_TYPE:-local}"  # 's3', 'gcs', or 'local'
S3_BUCKET="${S3_BUCKET:-}"
GCS_BUCKET="${GCS_BUCKET:-}"
BACKUP_FILE="${BACKUP_FILE:-}"          # object key / filename, e.g. greenpay_backup_20260101_020000.sql.gz
LOCAL_BACKUP_PATH="${LOCAL_BACKUP_PATH:-}"  # explicit path to a local .sql.gz, overrides BACKUP_DIR/BACKUP_FILE
REPLACE_EXISTING="${REPLACE_EXISTING:-false}"  # 'true' to drop/recreate TARGET_DB_NAME if it exists
TIMING_FILE="${TIMING_FILE:-}"          # optional path to write machine-readable timing/verification JSON

# Logging
log_info() {
    echo "[INFO] $(date '+%Y-%m-%d %H:%M:%S') $1"
}

log_error() {
    echo "[ERROR] $(date '+%Y-%m-%d %H:%M:%S') $1" >&2
}

now_epoch() {
    date +%s.%N
}

fetch_from_s3() {
    if [ -z "$S3_BUCKET" ] || [ -z "$BACKUP_FILE" ]; then
        log_error "S3_BUCKET and BACKUP_FILE must be set to restore from S3"
        return 1
    fi
    if ! command -v aws &> /dev/null; then
        log_error "AWS CLI is not installed"
        return 1
    fi

    mkdir -p "$BACKUP_DIR"
    local remote_path="s3://${S3_BUCKET}/${S3_PREFIX:-backups/}${BACKUP_FILE}"
    log_info "Downloading $remote_path"
    aws s3 cp "$remote_path" "${BACKUP_DIR}/${BACKUP_FILE}"
    DOWNLOADED_PATH="${BACKUP_DIR}/${BACKUP_FILE}"
}

fetch_from_gcs() {
    if [ -z "$GCS_BUCKET" ] || [ -z "$BACKUP_FILE" ]; then
        log_error "GCS_BUCKET and BACKUP_FILE must be set to restore from GCS"
        return 1
    fi
    if ! command -v gsutil &> /dev/null; then
        log_error "gsutil (Google Cloud SDK) is not installed"
        return 1
    fi

    mkdir -p "$BACKUP_DIR"
    local remote_path="gs://${GCS_BUCKET}/${GCS_PREFIX:-backups/}${BACKUP_FILE}"
    log_info "Downloading $remote_path"
    gsutil cp "$remote_path" "${BACKUP_DIR}/${BACKUP_FILE}"
    DOWNLOADED_PATH="${BACKUP_DIR}/${BACKUP_FILE}"
}

fetch_from_local() {
    if [ -n "$LOCAL_BACKUP_PATH" ]; then
        DOWNLOADED_PATH="$LOCAL_BACKUP_PATH"
    elif [ -n "$BACKUP_FILE" ]; then
        DOWNLOADED_PATH="${BACKUP_DIR}/${BACKUP_FILE}"
    else
        log_error "Set LOCAL_BACKUP_PATH or BACKUP_FILE to restore from a local file"
        return 1
    fi

    if [ ! -f "$DOWNLOADED_PATH" ]; then
        log_error "Backup file not found: $DOWNLOADED_PATH"
        return 1
    fi
}

# Export password if provided
if [ -n "$DB_PASSWORD" ]; then
    export PGPASSWORD="$DB_PASSWORD"
fi

log_info "Starting database restore..."
log_info "Target database: $TARGET_DB_NAME on $DB_HOST:$DB_PORT (storage: $STORAGE_TYPE)"

RESTORE_START=$(now_epoch)

DOWNLOADED_PATH=""
case "$STORAGE_TYPE" in
    s3)
        fetch_from_s3
        ;;
    gcs)
        fetch_from_gcs
        ;;
    local)
        fetch_from_local
        ;;
    *)
        log_error "Unknown storage type: $STORAGE_TYPE"
        exit 1
        ;;
esac

if [ -z "$DOWNLOADED_PATH" ] || [ ! -f "$DOWNLOADED_PATH" ]; then
    log_error "No backup file available to restore"
    exit 1
fi

# Verify the archive isn't truncated/corrupted before touching any database
log_info "Verifying backup integrity: $DOWNLOADED_PATH"
if ! gzip -t "$DOWNLOADED_PATH"; then
    log_error "Backup file failed gzip integrity check: $DOWNLOADED_PATH"
    exit 1
fi

SQL_PATH="${DOWNLOADED_PATH%.gz}"
gunzip -k -f "$DOWNLOADED_PATH"

# pg_dump >=17 unconditionally emits `SET transaction_timeout = 0;` in the
# dump preamble. That GUC does not exist on PostgreSQL <17 servers (our
# production target is 16 — see docs/database.md) and aborts the whole
# restore even though it has zero effect on the data being restored. This
# was discovered by an actual restore drill run with a newer local pg_dump
# than the target server (see docs/runbooks/db-restore-drill.md) rather than
# assumed, so strip it defensively here.
if grep -q '^SET transaction_timeout' "$SQL_PATH"; then
    log_info "Stripping PG17+-only 'SET transaction_timeout' preamble line (unsupported on PostgreSQL <17 servers, has no effect on restored data)"
    sed -i '/^SET transaction_timeout/d' "$SQL_PATH"
fi

# Refuse to clobber an existing database unless explicitly told to
EXISTS=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password -tAc \
    "SELECT 1 FROM pg_database WHERE datname='${TARGET_DB_NAME}'")

if [ "$EXISTS" = "1" ]; then
    if [ "$REPLACE_EXISTING" != "true" ]; then
        log_error "Database '$TARGET_DB_NAME' already exists. Set REPLACE_EXISTING=true to drop and recreate it, or choose a different TARGET_DB_NAME."
        exit 1
    fi
    log_info "REPLACE_EXISTING=true: dropping existing database '$TARGET_DB_NAME'"
    dropdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password "$TARGET_DB_NAME"
fi

log_info "Creating database '$TARGET_DB_NAME'"
createdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password "$TARGET_DB_NAME"

log_info "Restoring dump into '$TARGET_DB_NAME'..."
if ! psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password \
    -v ON_ERROR_STOP=1 \
    -d "$TARGET_DB_NAME" \
    -f "$SQL_PATH" \
    > /tmp/restore-db-last-run.log 2>&1; then
    log_error "Restore failed. See /tmp/restore-db-last-run.log for details."
    exit 1
fi

RESTORE_END=$(now_epoch)
RESTORE_SECONDS=$(awk -v a="$RESTORE_START" -v b="$RESTORE_END" 'BEGIN { printf "%.2f", b - a }')

log_info "Restore completed in ${RESTORE_SECONDS}s"

# Verification: table count + row counts for the tables that hold real
# financial/donation records, so a restore that "succeeds" but silently
# drops data is caught here rather than discovered during an incident.
log_info "Verifying restored data..."
TABLE_COUNT=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password -d "$TARGET_DB_NAME" -tAc \
    "SELECT COUNT(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema');")
log_info "Restored schema has ${TABLE_COUNT} tables"

if [ "$TABLE_COUNT" -eq 0 ]; then
    log_error "Restored database has zero tables — treat this restore as failed"
    exit 1
fi

DONATIONS_COUNT="n/a"
PROJECTS_COUNT="n/a"
if psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password -d "$TARGET_DB_NAME" -tAc \
    "SELECT to_regclass('public.donations')" | grep -q donations; then
    DONATIONS_COUNT=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password -d "$TARGET_DB_NAME" -tAc \
        "SELECT COUNT(*) FROM donations;")
    log_info "donations rows restored: ${DONATIONS_COUNT}"
fi
if psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password -d "$TARGET_DB_NAME" -tAc \
    "SELECT to_regclass('public.projects')" | grep -q projects; then
    PROJECTS_COUNT=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password -d "$TARGET_DB_NAME" -tAc \
        "SELECT COUNT(*) FROM projects;")
    log_info "projects rows restored: ${PROJECTS_COUNT}"
fi

if [ -n "$TIMING_FILE" ]; then
    cat > "$TIMING_FILE" <<EOF
{
  "target_db": "${TARGET_DB_NAME}",
  "backup_file": "$(basename "$DOWNLOADED_PATH")",
  "restore_seconds": ${RESTORE_SECONDS},
  "table_count": ${TABLE_COUNT},
  "donations_count": "${DONATIONS_COUNT}",
  "projects_count": "${PROJECTS_COUNT}"
}
EOF
    log_info "Wrote timing/verification data to $TIMING_FILE"
fi

log_info "Database restore completed successfully"
