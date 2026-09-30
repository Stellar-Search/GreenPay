#!/bin/bash

# Database Restore Verification Script
# Verifies the integrity and completeness of a restored PostgreSQL database.
# Checks:
#   - Schema completeness (all expected tables present)
#   - Row counts for critical tables
#   - Event-stream contiguity (no gaps in sequence)
#   - Monetary totals reconciliation (donation amounts match sum of rows)
#   - Projection cursor consistency (CQRS read models are aligned)
#
# Usage:
#   verify-restore.sh -h <host> -p <port> -u <user> -d <database> [-o <output-json>]
#
# Exit codes:
#   0  = all verifications passed
#   1  = verification failed (schema, data, or contiguity issue)
#   2  = usage error or missing prerequisites

set -euo pipefail

# Configuration
DB_HOST=""
DB_PORT="5432"
DB_USER="postgres"
DB_NAME=""
OUTPUT_JSON=""
VERIFICATION_START=$(date +%s.%N)

# Logging
log_info() {
    echo "[VERIFY] $(date '+%Y-%m-%d %H:%M:%S') [INFO] $1"
}

log_warn() {
    echo "[VERIFY] $(date '+%Y-%m-%d %H:%M:%S') [WARN] $1" >&2
}

log_error() {
    echo "[VERIFY] $(date '+%Y-%m-%d %H:%M:%S') [ERROR] $1" >&2
}

log_debug() {
    if [ "${DEBUG:-false}" = "true" ]; then
        echo "[VERIFY] $(date '+%Y-%m-%d %H:%M:%S') [DEBUG] $1"
    fi
}

show_usage() {
    cat >&2 <<EOF
Usage: verify-restore.sh -h <host> -p <port> -u <user> -d <database> [-o <output-json>]

Options:
  -h HOST            PostgreSQL host (required)
  -p PORT            PostgreSQL port (default: 5432)
  -u USER            PostgreSQL user (default: postgres)
  -d DATABASE        Database name to verify (required)
  -o FILE            Write JSON verification report to FILE (optional)
  --help             Show this message

Environment:
  PGPASSWORD         PostgreSQL password (if needed)
  DEBUG              Set to 'true' for verbose output
EOF
    exit 2
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        -h) DB_HOST="$2"; shift 2 ;;
        -p) DB_PORT="$2"; shift 2 ;;
        -u) DB_USER="$2"; shift 2 ;;
        -d) DB_NAME="$2"; shift 2 ;;
        -o) OUTPUT_JSON="$2"; shift 2 ;;
        --help) show_usage ;;
        *) 
            log_error "Unknown option: $1"
            show_usage
            ;;
    esac
done

# Validate required arguments
if [ -z "$DB_HOST" ] || [ -z "$DB_NAME" ]; then
    log_error "Missing required arguments: -h (host) and -d (database) are required"
    show_usage
fi

# Export password if needed
if [ -n "${PGPASSWORD:-}" ]; then
    export PGPASSWORD
fi

# Test connection
log_info "Connecting to $DB_HOST:$DB_PORT / $DB_NAME (user: $DB_USER)..."
if ! psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password -d "$DB_NAME" -c "SELECT 1" > /dev/null 2>&1; then
    log_error "Failed to connect to database"
    exit 1
fi
log_info "Connection successful"

# ============================================================
# VERIFICATION 1: Schema Completeness
# ============================================================
log_info "=== Verification 1: Schema Completeness ==="

EXPECTED_TABLES=(
    "projects"
    "donations"
    "profiles"
    "project_updates"
    "project_subscriptions"
    "jobs"
    "project_campaigns"
    "project_milestones"
    "project_ratings"
    "donation_matches"
    "device_tokens"
    "admin_audit_log"
    "project_follows"
    "donor_stats"
    "match_state"
    "event_stream"
    "event_store_migration_state"
    "ai_summary_job_failures"
    "indexer_state"
)

ACTUAL_TABLES=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password -d "$DB_NAME" -tAc \
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;")

SCHEMA_OK=true
MISSING_TABLES=()

for table in "${EXPECTED_TABLES[@]}"; do
    if echo "$ACTUAL_TABLES" | grep -q "^${table}$"; then
        log_debug "✓ Table $table present"
    else
        log_warn "✗ MISSING TABLE: $table"
        MISSING_TABLES+=("$table")
        SCHEMA_OK=false
    fi
done

ACTUAL_TABLE_COUNT=$(echo "$ACTUAL_TABLES" | wc -l)
EXPECTED_TABLE_COUNT=${#EXPECTED_TABLES[@]}

log_info "Schema tables: $ACTUAL_TABLE_COUNT present (expected $EXPECTED_TABLE_COUNT)"
if [ "$SCHEMA_OK" = "false" ]; then
    log_error "Schema incomplete: missing ${#MISSING_TABLES[@]} table(s): ${MISSING_TABLES[*]}"
fi

# ============================================================
# VERIFICATION 2: Table Row Counts
# ============================================================
log_info "=== Verification 2: Table Row Counts ==="

declare -A TABLE_COUNTS
TABLE_COUNTS["projects"]=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM projects;" 2>/dev/null || echo "0")
TABLE_COUNTS["donations"]=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM donations;" 2>/dev/null || echo "0")
TABLE_COUNTS["profiles"]=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM profiles;" 2>/dev/null || echo "0")
TABLE_COUNTS["event_stream"]=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM event_stream;" 2>/dev/null || echo "0")
TABLE_COUNTS["admin_audit_log"]=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM admin_audit_log;" 2>/dev/null || echo "0")

for table in projects donations profiles event_stream admin_audit_log; do
    count="${TABLE_COUNTS[$table]:-0}"
    log_info "  $table: $count rows"
done

# Verify no critical table is empty (unless expected to be)
if [ "${TABLE_COUNTS[projects]}" -eq 0 ] && [ "${TABLE_COUNTS[donations]}" -gt 0 ]; then
    log_warn "⚠ Donations present but no projects: data may be corrupted or orphaned"
fi

if [ "${TABLE_COUNTS[event_stream]}" -eq 0 ] && [ "${TABLE_COUNTS[donations]}" -gt 0 ]; then
    log_warn "⚠ Donations present but event_stream is empty: CQRS state may be out of sync"
fi

# ============================================================
# VERIFICATION 3: Event-Stream Contiguity
# ============================================================
log_info "=== Verification 3: Event-Stream Contiguity ==="

EVENT_STREAM_OK=true
EVENT_STREAM_COUNT="${TABLE_COUNTS[event_stream]}"

if [ "$EVENT_STREAM_COUNT" -gt 0 ]; then
    log_info "Checking event stream ($EVENT_STREAM_COUNT events)..."
    
    # Check for gaps in (stream_id, version) pairs
    GAPS=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password -d "$DB_NAME" -tAc <<'SQL'
WITH event_versions AS (
  SELECT
    stream_id,
    version,
    LAG(version) OVER (PARTITION BY stream_id ORDER BY version) as prev_version
  FROM event_stream
  WHERE stream_id IS NOT NULL
)
SELECT COUNT(*) FROM event_versions
WHERE prev_version IS NOT NULL AND version != prev_version + 1;
SQL
    )
    
    if [ "$GAPS" -gt 0 ]; then
        log_error "Event stream has $GAPS gap(s) in version sequences — restore may be incomplete or corrupted"
        EVENT_STREAM_OK=false
        
        # Show which streams have gaps for debugging
        AFFECTED_STREAMS=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password -d "$DB_NAME" -tAc <<'SQL'
WITH event_versions AS (
  SELECT
    stream_id,
    version,
    LAG(version) OVER (PARTITION BY stream_id ORDER BY version) as prev_version
  FROM event_stream
  WHERE stream_id IS NOT NULL
)
SELECT DISTINCT stream_id FROM event_versions
WHERE prev_version IS NOT NULL AND version != prev_version + 1
LIMIT 5;
SQL
        )
        log_error "Affected streams (first 5): $AFFECTED_STREAMS"
    else
        log_info "✓ Event stream contiguity verified: no gaps in version sequences"
    fi
    
    # Check for duplicate (stream_id, version) pairs (should be impossible due to unique constraint)
    DUPLICATES=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password -d "$DB_NAME" -tAc \
        "SELECT COUNT(*) FROM (SELECT stream_id, version FROM event_stream GROUP BY stream_id, version HAVING COUNT(*) > 1) x;")
    
    if [ "$DUPLICATES" -gt 0 ]; then
        log_error "Event stream has $DUPLICATES duplicate (stream_id, version) pairs — data integrity compromised"
        EVENT_STREAM_OK=false
    fi
    
    # Check for NULL stream_id (should never happen in production events)
    NULL_STREAMS=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password -d "$DB_NAME" -tAc \
        "SELECT COUNT(*) FROM event_stream WHERE stream_id IS NULL;")
    
    if [ "$NULL_STREAMS" -gt 0 ]; then
        log_warn "Event stream has $NULL_STREAMS events with NULL stream_id — may indicate incomplete restore"
    fi
else
    log_info "Event stream is empty; skipping contiguity check"
fi

# ============================================================
# VERIFICATION 4: Monetary Totals Reconciliation
# ============================================================
log_info "=== Verification 4: Monetary Totals Reconciliation ==="

MONETARY_OK=true

if [ "${TABLE_COUNTS[donations]}" -gt 0 ]; then
    # Sum donations by currency
    DONATION_TOTALS=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password -d "$DB_NAME" -tAc <<'SQL'
SELECT
  currency,
  COUNT(*) as count,
  SUM(amount) as total_amount,
  SUM(amount_xlm) as total_xlm
FROM donations
WHERE status IN ('committed', 'prepared')
GROUP BY currency
ORDER BY currency;
SQL
    )
    
    echo "$DONATION_TOTALS" | while IFS='|' read -r currency count total_amount total_xlm; do
        if [ -n "$currency" ]; then
            log_info "  Donations in $currency: $count records, total: $total_amount $currency (XLM: $total_xlm)"
        fi
    done
    
    # Check for negative or NULL amounts (data corruption)
    INVALID_AMOUNTS=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password -d "$DB_NAME" -tAc \
        "SELECT COUNT(*) FROM donations WHERE amount < 0 OR amount IS NULL OR amount_xlm < 0;")
    
    if [ "$INVALID_AMOUNTS" -gt 0 ]; then
        log_error "Found $INVALID_AMOUNTS donations with invalid amounts (negative or NULL)"
        MONETARY_OK=false
    else
        log_info "✓ All donation amounts are valid (non-negative, non-NULL)"
    fi
    
    # Check for mismatches between raised_xlm in projects and sum of donations
    PROJECT_MISMATCHES=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password -d "$DB_NAME" -tAc <<'SQL'
SELECT COUNT(*)
FROM projects p
WHERE EXISTS (
  SELECT 1 FROM (
    SELECT
      project_id,
      SUM(amount_xlm) as donated_sum
    FROM donations
    WHERE status IN ('committed', 'prepared')
    GROUP BY project_id
  ) d
  WHERE d.project_id = p.id
    AND d.donated_sum > p.raised_xlm * 1.001  -- Allow 0.1% float rounding
)
LIMIT 10;
SQL
    )
    
    if [ "$PROJECT_MISMATCHES" -gt 0 ]; then
        log_warn "Found $PROJECT_MISMATCHES projects where donated amount exceeds raised_xlm (possible data sync issue)"
    fi
else
    log_info "No donations to verify; skipping monetary reconciliation"
fi

# ============================================================
# VERIFICATION 5: CQRS Projection Cursor Consistency
# ============================================================
log_info "=== Verification 5: CQRS Projection Cursor Consistency ==="

CQRS_OK=true

# Check that projection cursors are not ahead of the event stream
MAX_EVENT_ID=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password -d "$DB_NAME" -tAc \
    "SELECT COALESCE(MAX(CAST(ROW_NUMBER() OVER (ORDER BY created_at, event_id) as BIGINT)), 0) FROM event_stream;")

log_info "Max event stream ID: $MAX_EVENT_ID"

PROJECTION_CURSORS=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password -d "$DB_NAME" -tAc <<'SQL'
SELECT
  'projects' as table_name,
  COALESCE(MAX(projection_cursor), 0) as cursor
FROM projects
UNION ALL
SELECT 'donor_stats', COALESCE(MAX(projection_cursor), 0) FROM donor_stats
UNION ALL
SELECT 'match_state', COALESCE(MAX(projection_cursor), 0) FROM match_state
UNION ALL
SELECT 'jobs', COALESCE(MAX(projection_cursor), 0) FROM jobs
UNION ALL
SELECT 'project_milestones', COALESCE(MAX(projection_cursor), 0) FROM project_milestones
ORDER BY table_name;
SQL
    )

echo "$PROJECTION_CURSORS" | while IFS='|' read -r table_name cursor; do
    if [ -n "$table_name" ]; then
        if [ "$cursor" -gt "$MAX_EVENT_ID" ]; then
            log_warn "⚠ $table_name projection_cursor ($cursor) is ahead of max event stream ID ($MAX_EVENT_ID)"
            CQRS_OK=false
        else
            log_debug "$table_name projection_cursor: $cursor / $MAX_EVENT_ID"
        fi
    fi
done

# ============================================================
# VERIFICATION 6: Key Constraints and Indexes
# ============================================================
log_info "=== Verification 6: Key Constraints and Indexes ==="

CONSTRAINTS_OK=true

# Verify event_stream unique constraint
UNIQUE_CONSTRAINT=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password -d "$DB_NAME" -tAc \
    "SELECT COUNT(*) FROM information_schema.constraint_table_usage WHERE table_name = 'event_stream' AND constraint_name LIKE 'ux_%';")

if [ "$UNIQUE_CONSTRAINT" -gt 0 ]; then
    log_debug "✓ Event stream unique constraints present"
else
    log_warn "⚠ Event stream unique constraints may be missing"
    CONSTRAINTS_OK=false
fi

# Verify foreign keys are intact
BROKEN_FOREIGN_KEYS=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password -d "$DB_NAME" -tAc <<'SQL'
WITH fk_check AS (
  SELECT
    'donations' as table_name,
    COUNT(*) as orphaned_count
  FROM donations d
  LEFT JOIN projects p ON d.project_id = p.id
  WHERE d.project_id IS NOT NULL AND p.id IS NULL
)
SELECT SUM(orphaned_count) FROM fk_check;
SQL
    )

if [ "$BROKEN_FOREIGN_KEYS" -gt 0 ] && [ "$BROKEN_FOREIGN_KEYS" != "0" ]; then
    log_error "Found $BROKEN_FOREIGN_KEYS orphaned donation rows (missing projects)"
    CONSTRAINTS_OK=false
fi

# ============================================================
# VERIFICATION 7: Temporal Consistency
# ============================================================
log_info "=== Verification 7: Temporal Consistency ==="

TEMPORAL_OK=true

# Check that created_at <= updated_at for tables that have both
TEMPORAL_ISSUES=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --no-password -d "$DB_NAME" -tAc <<'SQL'
SELECT
  (SELECT COUNT(*) FROM donations WHERE created_at > updated_at) +
  (SELECT COUNT(*) FROM projects WHERE created_at > updated_at) +
  (SELECT COUNT(*) FROM profiles WHERE created_at > COALESCE(updated_at, created_at))
as issues;
SQL
    )

if [ "$TEMPORAL_ISSUES" -gt 0 ]; then
    log_error "Found $TEMPORAL_ISSUES records with created_at > updated_at (temporal inconsistency)"
    TEMPORAL_OK=false
else
    log_debug "✓ Temporal consistency verified (created_at <= updated_at)"
fi

# ============================================================
# Final Report
# ============================================================
VERIFICATION_END=$(date +%s.%N)
VERIFICATION_SECONDS=$(awk -v a="$VERIFICATION_START" -v b="$VERIFICATION_END" 'BEGIN { printf "%.2f", b - a }')

ALL_OK=true
[ "$SCHEMA_OK" = "true" ] || ALL_OK=false
[ "$EVENT_STREAM_OK" = "true" ] || ALL_OK=false
[ "$MONETARY_OK" = "true" ] || ALL_OK=false
[ "$CQRS_OK" = "true" ] || ALL_OK=false
[ "$CONSTRAINTS_OK" = "true" ] || ALL_OK=false
[ "$TEMPORAL_OK" = "true" ] || ALL_OK=false

OVERALL_STATUS="PASSED"
[ "$ALL_OK" = "true" ] || OVERALL_STATUS="FAILED"

log_info "=== Verification Summary ==="
log_info "Status: $OVERALL_STATUS"
log_info "Time: ${VERIFICATION_SECONDS}s"
log_info "Schema: $([ "$SCHEMA_OK" = "true" ] && echo "✓ PASS" || echo "✗ FAIL")"
log_info "Event Stream Contiguity: $([ "$EVENT_STREAM_OK" = "true" ] && echo "✓ PASS" || echo "✗ FAIL")"
log_info "Monetary Reconciliation: $([ "$MONETARY_OK" = "true" ] && echo "✓ PASS" || echo "✗ FAIL")"
log_info "CQRS Projections: $([ "$CQRS_OK" = "true" ] && echo "✓ PASS" || echo "✗ FAIL")"
log_info "Constraints: $([ "$CONSTRAINTS_OK" = "true" ] && echo "✓ PASS" || echo "✗ FAIL")"
log_info "Temporal: $([ "$TEMPORAL_OK" = "true" ] && echo "✓ PASS" || echo "✗ FAIL")"

# Write JSON report if requested
if [ -n "$OUTPUT_JSON" ]; then
    cat > "$OUTPUT_JSON" <<EOF
{
  "verification_timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "database": "$DB_NAME",
  "host": "$DB_HOST:$DB_PORT",
  "verification_seconds": ${VERIFICATION_SECONDS},
  "overall_status": "${OVERALL_STATUS}",
  "checks": {
    "schema_completeness": {
      "status": "$([ "$SCHEMA_OK" = "true" ] && echo "PASS" || echo "FAIL")",
      "expected_tables": ${EXPECTED_TABLE_COUNT},
      "actual_tables": ${ACTUAL_TABLE_COUNT},
      "missing_tables": $(printf '%s\n' "${MISSING_TABLES[@]}" | jq -sR 'split("\n")[:-1]')
    },
    "table_row_counts": {
      "projects": ${TABLE_COUNTS[projects]:-0},
      "donations": ${TABLE_COUNTS[donations]:-0},
      "profiles": ${TABLE_COUNTS[profiles]:-0},
      "event_stream": ${TABLE_COUNTS[event_stream]:-0},
      "admin_audit_log": ${TABLE_COUNTS[admin_audit_log]:-0}
    },
    "event_stream_contiguity": {
      "status": "$([ "$EVENT_STREAM_OK" = "true" ] && echo "PASS" || echo "FAIL")",
      "total_events": ${EVENT_STREAM_COUNT},
      "gaps_detected": $([[ "$EVENT_STREAM_OK" = "true" ]] && echo "0" || echo "1")
    },
    "monetary_reconciliation": {
      "status": "$([ "$MONETARY_OK" = "true" ] && echo "PASS" || echo "FAIL")",
      "invalid_amounts_found": $([[ "$MONETARY_OK" = "true" ]] && echo "0" || echo "1")
    },
    "cqrs_projections": {
      "status": "$([ "$CQRS_OK" = "true" ] && echo "PASS" || echo "FAIL")",
      "max_event_id": ${MAX_EVENT_ID}
    },
    "constraints_and_indexes": {
      "status": "$([ "$CONSTRAINTS_OK" = "true" ] && echo "PASS" || echo "FAIL")"
    },
    "temporal_consistency": {
      "status": "$([ "$TEMPORAL_OK" = "true" ] && echo "PASS" || echo "FAIL")",
      "temporal_issues": ${TEMPORAL_ISSUES:-0}
    }
  }
}
EOF
    log_info "Verification report written to $OUTPUT_JSON"
fi

# Exit with appropriate code
if [ "$ALL_OK" = "true" ]; then
    log_info "✓ All verifications passed"
    exit 0
else
    log_error "✗ Verification failed — see details above"
    exit 1
fi
