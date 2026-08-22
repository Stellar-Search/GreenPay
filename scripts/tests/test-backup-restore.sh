#!/bin/bash

# Unit/regression tests for scripts/backup-db.sh and scripts/restore-db.sh.
#
# These are fast, don't touch a real database, and are meant to catch the
# specific class of bug that shipped silently for months: the nightly
# backup workflow calling a shell function before it was defined
# (upload_to_s3 / upload_to_gcs), which fails every run. `bash -n` (syntax
# check) does NOT catch that, because calling an as-yet-undefined function
# is valid bash syntax that only fails at runtime.
#
# The full, real end-to-end restore drill (against actual Postgres
# containers) lives in scripts/db-restore-drill.sh — this file only covers
# what can be checked statically/quickly and is safe to run in CI on every
# push.
#
# Usage: scripts/tests/test-backup-restore.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_SCRIPT="$SCRIPT_DIR/backup-db.sh"
RESTORE_SCRIPT="$SCRIPT_DIR/restore-db.sh"

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "  ok - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  NOT OK - $1"; }

# --- helper: line number of the first *call* to a function (a bare
# `fn` statement, not its `fn() {` definition or a comment mentioning it) ---
first_call_line() {
    local file="$1" fn="$2"
    grep -n -E "^[[:space:]]*${fn}[[:space:]]*\$" "$file" \
        | grep -vE ":\s*${fn}\s*\(\)" \
        | head -n1 \
        | cut -d: -f1
}

first_def_line() {
    local file="$1" fn="$2"
    grep -n -E "^${fn}\s*\(\)\s*\{" "$file" | head -n1 | cut -d: -f1
}

echo "== backup-db.sh: function-ordering regression (the original bug) =="

for fn in upload_to_s3 upload_to_gcs; do
    def_line=$(first_def_line "$BACKUP_SCRIPT" "$fn")
    call_line=$(first_call_line "$BACKUP_SCRIPT" "$fn")
    if [ -z "$def_line" ]; then
        fail "$fn: no definition found in backup-db.sh"
    elif [ -z "$call_line" ]; then
        fail "$fn: no call site found in backup-db.sh"
    elif [ "$def_line" -lt "$call_line" ]; then
        pass "$fn defined (line $def_line) before its first call (line $call_line)"
    else
        fail "$fn defined (line $def_line) AFTER its first call (line $call_line) — this is the bug that broke every nightly backup"
    fi
done

echo "== backup-db.sh: shell syntax =="
if bash -n "$BACKUP_SCRIPT" 2>/tmp/backup-syntax.err; then
    pass "backup-db.sh has valid bash syntax"
else
    fail "backup-db.sh syntax error: $(cat /tmp/backup-syntax.err)"
fi

echo "== restore-db.sh: shell syntax =="
if bash -n "$RESTORE_SCRIPT" 2>/tmp/restore-syntax.err; then
    pass "restore-db.sh has valid bash syntax"
else
    fail "restore-db.sh syntax error: $(cat /tmp/restore-syntax.err)"
fi

echo "== backup-db.sh: rejects unknown STORAGE_TYPE =="
# Stub out pg_dump so this exercises the STORAGE_TYPE dispatch (the actual
# regression surface) without needing a real database.
STUB_BIN=$(mktemp -d)
cat > "$STUB_BIN/pg_dump" <<'EOF'
#!/bin/bash
echo "-- stub dump"
EOF
chmod +x "$STUB_BIN/pg_dump"
OUT=$(PATH="$STUB_BIN:$PATH" STORAGE_TYPE=bogus BACKUP_DIR=/tmp/backup-test-$$ bash "$BACKUP_SCRIPT" 2>&1 || true)
rm -rf /tmp/backup-test-$$ "$STUB_BIN"
if echo "$OUT" | grep -q "Unknown storage type: bogus"; then
    pass "unknown STORAGE_TYPE is rejected with a clear error"
else
    fail "unknown STORAGE_TYPE did not produce the expected error (got: $OUT)"
fi

echo "== backup-db.sh: supports STORAGE_TYPE=local for testing/drills =="
if grep -qE '^\s*local\)\s*$' "$BACKUP_SCRIPT" && grep -q 'upload_to_local' "$BACKUP_SCRIPT"; then
    pass "STORAGE_TYPE=local is wired to upload_to_local()"
else
    fail "STORAGE_TYPE=local is not implemented"
fi

echo "== restore-db.sh: refuses to overwrite an existing DB without REPLACE_EXISTING=true =="
if grep -q 'REPLACE_EXISTING' "$RESTORE_SCRIPT" && grep -q 'already exists' "$RESTORE_SCRIPT"; then
    pass "restore-db.sh guards against clobbering an existing database"
else
    fail "restore-db.sh is missing the REPLACE_EXISTING safety guard"
fi

echo "== restore-db.sh: verifies gzip integrity before restoring =="
if grep -q 'gzip -t' "$RESTORE_SCRIPT"; then
    pass "restore-db.sh checks archive integrity before restoring"
else
    fail "restore-db.sh does not verify backup archive integrity"
fi

echo "== restore-db.sh: fails restore if the resulting schema has zero tables =="
if grep -q 'TABLE_COUNT" -eq 0' "$RESTORE_SCRIPT"; then
    pass "restore-db.sh treats a zero-table restore as a failure"
else
    fail "restore-db.sh does not guard against a silently empty restore"
fi

echo
echo "== $PASS passed, $FAIL failed =="
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
