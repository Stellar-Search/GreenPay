# Runbook: Database disaster-recovery restore (game day and incident)

**Severity:** High — validates the last line of defense for donation and
transaction history. This runbook is run proactively on a quarterly schedule
(first day of Jan, Apr, Jul, Oct at 03:00 UTC), and as a reference for real
incidents.

**Owner:** Backend / DevOps on call.

**Time Estimate:** ~30 minutes for a timed, monitored drill; depends on
backup size and restore destination for a real incident.

## Quick Reference

For a real incident where you need to restore **right now**:

1. **Identify the right backup:**
   ```bash
   aws s3 ls s3://YOUR_BUCKET/backups/ | grep greenpay_backup_
   ```

2. **Restore to a new database (never clobber production):**
   ```bash
   DB_HOST=PROD_HOST DB_PORT=5432 DB_USER=postgres DB_PASSWORD=YOUR_PW \
     STORAGE_TYPE=s3 S3_BUCKET=YOUR_BUCKET BACKUP_FILE=greenpay_backup_YYYYMMDD_HHMMSS.sql.gz \
     TARGET_DB_NAME=greenpay_verified \
     bash scripts/restore-db.sh
   ```

3. **Verify the restore (comprehensive checks):**
   ```bash
   PGPASSWORD=YOUR_PW bash scripts/verify-restore.sh \
     -h PROD_HOST -p 5432 -u postgres -d greenpay_verified \
     -o /tmp/verify-report.json
   ```

4. **Spot-check critical data:**
   ```bash
   psql -h PROD_HOST -U postgres -d greenpay_verified -c \
     "SELECT COUNT(*) FROM donations; SELECT COUNT(*) FROM projects;"
   ```

5. **Cut over** (after verification passes):
   - Update the application's `DB_NAME` to point to `greenpay_verified`, or
   - Rename databases:
     ```bash
     ALTER DATABASE greenpay RENAME TO greenpay_pre_incident;
     ALTER DATABASE greenpay_verified RENAME TO greenpay;
     ```

---

## Overview

GreenPay takes a nightly `pg_dump` backup of the production PostgreSQL
database via `.github/workflows/database-backup.yml` running
`scripts/backup-db.sh` at 02:00 UTC. This runbook provides both:

1. The **documented, human-runnable restore procedure** for a real incident
   (with step-by-step guidance written for pressure situations).
2. The **quarterly automated game-day drill** (`.github/workflows/db-restore-drill.yml`)
   that re-proves the procedure still works, automatically.

Both use the same real backup and restore scripts:
`scripts/backup-db.sh`, `scripts/restore-db.sh`, and `scripts/verify-restore.sh`.

## RTO / RPO (measured, not estimated)

These numbers come from actual timed drill runs against real PostgreSQL
16 instances and real backups produced by `scripts/backup-db.sh` — see
[`docs/runbooks/drills/`](drills/) for the raw report of every drill run.

| | Value | Notes |
|---|---|---|
| **RTO** (Recovery Time Objective) | **~12–25s** on small test data (10 projects / 50 donations); scales with database size. | Measured from provisioning a fresh Postgres instance through a fully restored + verified database. Before trusting RTO for a real incident, re-measure against production-sized data. See drill reports for current baseline. |
| **RPO** (Recovery Point Objective) | **Up to ~24 hours** of donations/updates since the last successful nightly backup can be lost. | `.github/workflows/database-backup.yml` runs at 02:00 UTC. The drill verifies the RPO boundary is clean: pre-backup data is preserved exactly, post-backup data is cleanly absent (not partially/corruptly captured). |

### Regressions

The drill tracks RTO/RPO regressions across runs. Baseline metrics are stored
in `docs/runbooks/drills/.baseline-rto-rpo.json`. If RTO or backup time
exceed the baseline by more than 20%, the drill fails and opens an issue. This
catches performance degradation before it matters in a real incident.

### WAL Archiving and Point-in-Time Recovery (PITR)

PITR is **not currently deployed** in production (see ADR-004 in
`docs/adr/` for the HA/managed DB decision). If tighter RPO is needed:

- WAL archiving must be configured on the PostgreSQL instance (`wal_level =
  replica`, `archive_mode = on`, `archive_command` to S3/GCS). See
  `docs/database.md` for configuration.
- WAL files from backup through recovery target time must be available in the
  archive.
- Use `RECOVERY_TARGET_TIME='2026-08-22T10:30:00Z' scripts/restore-db.sh` to
  restore to a specific point in time.

Until PITR is deployed, recovery granularity is limited to the nightly
snapshot.

## 1. Automated Quarterly Drill (Game Day)

`.github/workflows/db-restore-drill.yml` runs `scripts/db-restore-drill.sh`
on the first day of January, April, July, and October at 03:00 UTC (and on
demand via `workflow_dispatch`).

### What the drill does

The drill executes a real, end-to-end restore against throwaway infrastructure:

1. **Provision source database:** Start a PostgreSQL 16 container seeded with
   representative `projects`/`donations`/event-stream rows.
2. **Back up:** Run the real `scripts/backup-db.sh` against it (same script
   used in production).
3. **Simulate post-backup activity:** Insert donations after the backup,
   simulating transactions that a nightly backup cannot capture. This defines
   the RPO boundary.
4. **Provision fresh replacement:** Start a second PostgreSQL 16 container
   (standing in for a freshly-provisioned replacement node/instance).
5. **Restore:** Run the real `scripts/restore-db.sh`, timing from container
   start through a fully verified database. **This is the RTO measurement.**
6. **Comprehensive verification:** Run `scripts/verify-restore.sh` to check:
   - **Schema completeness:** All 19 expected tables are present
   - **Table row counts:** Projects, donations, event stream, etc. counted
   - **Event-stream contiguity:** No gaps in `(stream_id, version)` sequences
   - **Monetary reconciliation:** All donation amounts valid and summed correctly
   - **CQRS projection cursors:** Read-model cursors not ahead of event stream
   - **Foreign keys and constraints:** No orphaned rows, indexes present
   - **Temporal consistency:** `created_at ≤ updated_at` for all records
7. **Data integrity:** Compare checksums and row counts between pre-backup
   source and restored target. Assert that post-backup donations are cleanly
   absent (not partially/corruptly captured).
8. **Regression detection:** Compare RTO/RPO metrics against baseline. If
   either exceeds baseline by 20%, fail the drill. Baseline stored in
   `docs/runbooks/drills/.baseline-rto-rpo.json` and updated after each run.
9. **Report:** Write dated markdown and JSON reports to
   `docs/runbooks/drills/<drill-id>-restore-drill.{md,json}`. Upload as
   workflow artifact.
10. **Notify:** On failure, open a GitHub issue labeled `bug`, `devops`,
    `backup` so a broken restore path doesn't go unnoticed for another
    quarter.

### Running the drill locally

To run the same drill on your machine (requires Docker, local PostgreSQL
client, jq):

```bash
scripts/db-restore-drill.sh
```

Set `KEEP_CONTAINERS=true` to leave the drill's Postgres containers running
for manual inspection:

```bash
KEEP_CONTAINERS=true scripts/db-restore-drill.sh
```

Set `DEBUG=true` for verbose output:

```bash
DEBUG=true scripts/db-restore-drill.sh
```

### Interpreting drill results

- **Status: PASSED** — All verifications passed. The backup mechanism works
  and is restorable.
- **Status: FAILED** — One or more verifications failed. See the detailed
  report in `docs/runbooks/drills/` for which check(s) failed.
  - If schema completeness failed, the restore is incomplete.
  - If event-stream contiguity failed, **treat this as critical** — read
    models cannot be correctly rebuilt.
  - If monetary reconciliation failed, donations were corrupted or lost.
  - If RTO/RPO regression detected, performance has degraded — investigate
    before the next real incident.

### Drill reports

Every drill run produces a report:
- **Human-readable:** `docs/runbooks/drills/<YYYYMMDD_HHMMSS>-restore-drill.md`
- **Machine-readable:** `docs/runbooks/drills/<YYYYMMDD_HHMMSS>-restore-drill.json`

Reports include:
- Measured RTO/RPO numbers
- Data integrity verification results
- Schema completeness and row counts
- Event-stream contiguity status
- Monetary reconciliation results
- Regression detection status

## 2. Manual Restore (Real Incident)

Use this when you need to restore production data. Follow each step **in order**. This procedure is written to be executable by someone who has never done it, under pressure, with clear decision points.

### Prerequisites (check before starting)

- [ ] You have shell access to a machine with `psql`, `pg_dump`, `gzip` installed
- [ ] You have `aws` CLI or `gsutil` (for cloud backup retrieval)
- [ ] You have credentials for the target PostgreSQL instance (host, port, username, password)
- [ ] You have credentials for the cloud storage where backups are stored (S3/GCS)
- [ ] You have confirmed the issue is real and escalated to your team lead / incident commander
- [ ] You have a clear **recovery target**: restore the latest backup, or restore to a specific time?

### Step 0: Declare the incident (write it down, timeline starts now)

Open a document and record:

```
INCIDENT START TIME: [current UTC time]
ISSUE: [what is wrong?]
RECOVERY TARGET: [latest backup / specific time]
RESTORE START TIME: [about to start]
```

This becomes part of post-incident review.

### Step 1: Confirm the problem is real

Before restoring, be certain:

```bash
# Can you connect to the current (broken) database?
psql -h PROD_HOST -U postgres -d greenpay -c "SELECT COUNT(*) FROM donations;"

# If it's not accessible, note that in your incident doc.
# If it's accessible but corrupted, see "Spot-check data" below.
```

**Decision point:** Is the current database genuinely unrecoverable (corrupted,
disk full, accidentally dropped tables), or is the application failing for
another reason (network, application bug)? If unsure, consult your team lead
before proceeding.

### Step 2: List available backups

**S3:**
```bash
aws s3 ls s3://YOUR_BUCKET/backups/ | grep greenpay_backup_
# Output: 2026-08-22 02:15:42          0 greenpay_backup_20260822_021504.sql.gz
#         2026-08-21 02:15:29          0 greenpay_backup_20260821_021504.sql.gz
```

**Google Cloud Storage:**
```bash
gsutil ls gs://YOUR_BUCKET/backups/ | grep greenpay_backup_
```

Choose the most recent backup **before** the known issue occurred, or the
latest backup if the time of corruption is unknown. Write down the backup
filename.

### Step 3: Set up environment variables

These control the restore. Be precise, especially with passwords (don't typo
them).

```bash
# Source database backup location
export STORAGE_TYPE=s3          # or 'gcs' or 'local'
export S3_BUCKET=greenpay-backups
export BACKUP_FILE=greenpay_backup_20260822_021504.sql.gz

# Target database (the one you're restoring INTO)
export DB_HOST=prod-postgres.example.com
export DB_PORT=5432
export DB_USER=postgres
export DB_PASSWORD=your_postgres_password

# Name of the restored database (create it as a new DB first, verify, then cut over)
export TARGET_DB_NAME=greenpay_restored

# Point-in-time recovery (optional, requires WAL archiving)
# Leave empty to restore the full backup, or set to recover to a specific time:
# export RECOVERY_TARGET_TIME='2026-08-22T10:30:00Z'

# Allow the script to replace an existing DB if it exists
export REPLACE_EXISTING=true

# Output file for verification results
export TIMING_FILE=/tmp/restore-timing.json
```

### Step 4: Run the restore

```bash
bash scripts/restore-db.sh
```

**Watch the output.** It will:

1. Download/locate the backup file
2. Verify the gzip integrity (`gunzip -t`)
3. Check for known incompatibilities (PostgreSQL version GUCs)
4. Drop the old database if `REPLACE_EXISTING=true` (be sure you meant that)
5. Create a fresh database
6. Restore the dump
7. Report table counts

This takes ~5–30s depending on database size. The script reports progress as
it goes. If it fails, see Troubleshooting below.

**Expected output:**
```
[INFO] Starting database restore...
[INFO] Target database: greenpay_restored on prod-postgres.example.com:5432
[INFO] Downloading s3://greenpay-backups/backups/greenpay_backup_20260822_021504.sql.gz
[INFO] Verifying backup integrity: /tmp/backups/greenpay_backup_20260822_021504.sql.gz
[INFO] Restoring dump into 'greenpay_restored'...
[INFO] Restore completed in 18.45s
[INFO] Verifying restored data...
[INFO] Restored schema has 19 tables
[INFO] donations rows restored: 5432
[INFO] projects rows restored: 89
[INFO] Database restore completed successfully
```

**If it fails:** See "Troubleshooting" section below before re-running.

### Step 5: Comprehensive verification

Run the verification script to check schema, data integrity, event stream,
monetary reconciliation, and constraints:

```bash
bash scripts/verify-restore.sh \
  -h prod-postgres.example.com \
  -p 5432 \
  -u postgres \
  -d greenpay_restored \
  -o /tmp/verify-report.json
```

This generates both console output and a JSON report.

**Expected output:**
```
[VERIFY] Connecting to prod-postgres.example.com:5432 / greenpay_restored...
[VERIFY] Connection successful
[VERIFY] === Verification 1: Schema Completeness ===
[VERIFY] Schema tables: 19 present (expected 19)
[VERIFY] === Verification 2: Table Row Counts ===
[VERIFY]   projects: 89 rows
[VERIFY]   donations: 5432 rows
[VERIFY]   event_stream: 5521 rows
[VERIFY] === Verification 3: Event-Stream Contiguity ===
[VERIFY] ✓ Event stream contiguity verified: no gaps in version sequences
[VERIFY] === Verification 4: Monetary Totals Reconciliation ===
[VERIFY] ✓ All donation amounts are valid (non-negative, non-NULL)
[VERIFY] === Verification 5: CQRS Projection Cursor Consistency ===
[VERIFY] === Verification Summary ===
[VERIFY] Status: PASSED
[VERIFY] ✓ All verifications passed
```

**If verification FAILS:** Do **not** cut over. See "Troubleshooting" section.

**If verification PASSES:** Record the pass in your incident document:
```
VERIFICATION: PASSED at [time]
  - Schema: 19 tables present
  - Donations: 5432 rows
  - Event stream: contiguous, no gaps
  - Monetary: reconciled
```

### Step 6: Spot-check critical data

Spot-check a few recent transactions to confirm the restore captured real
data, not corruption:

```bash
psql -h prod-postgres.example.com -U postgres -d greenpay_restored -c \
  "SELECT id, project_id, amount, status, created_at FROM donations \
   ORDER BY created_at DESC LIMIT 10;"

psql -h prod-postgres.example.com -U postgres -d greenpay_restored -c \
  "SELECT id, name, raised_xlm, donor_count FROM projects \
   ORDER BY updated_at DESC LIMIT 5;"
```

If the dates look right and the numbers match what you expect from on-chain
records or other sources, the restore is good.

### Step 7: Decide on cut-over

**Option A: Rename databases (minimal downtime)**

If you're confident the restore is correct:

```bash
psql -h prod-postgres.example.com -U postgres -c \
  "ALTER DATABASE greenpay RENAME TO greenpay_pre_incident;"
psql -h prod-postgres.example.com -U postgres -c \
  "ALTER DATABASE greenpay_restored RENAME TO greenpay;"
```

The application's connection string stays the same. Downtime: ~1 second
(connections are briefly dropped while the rename happens).

**Option B: Update connection string**

If you want to keep the old database for forensics, update the application's
database connection to point to `greenpay_restored` instead of `greenpay`:

- Update `DB_NAME` in Kubernetes secrets / ConfigMap / environment
- Restart application pods
- Verify application reconnects successfully

**Option C: Keep running on the old broken DB (not recommended)**

If the issue is not what you thought (corruption was elsewhere), you can keep
the old database and investigate further. But document this in the incident
record.

### Step 8: Verify application is working

After cut-over (whichever option):

```bash
# Check application logs for connection errors
kubectl logs -l app=backend --tail=50

# Hit the API and verify it works
curl https://greenpay.example.com/api/health

# Check a known endpoint
curl https://greenpay.example.com/api/projects | jq .
```

If the application is still failing, the database wasn't the issue. Investigate
further.

### Step 9: Document the incident

Update your incident document:

```
RESTORE END TIME: [current UTC time]
DATA LOSS WINDOW: [time between last backup and disaster]
RECOVERY TIME: [minutes from start to application online]
ACTIONS TAKEN:
  - [list what you did]
VERIFICATION:
  - [schema, row counts, checksums]
ROOT CAUSE: [what caused the disaster?]
POST-INCIDENT: [see https://example.com/incidents/YYYY-MM-DD for full RCA]
```

File a post-incident review. Link the drill reports and incident report to
track real vs. drill metrics.

---

### Troubleshooting

#### Restore fails with "Database 'X' already exists"

The target database already exists. Either:

1. Use a different `TARGET_DB_NAME`:
   ```bash
   TARGET_DB_NAME=greenpay_restored_v2 bash scripts/restore-db.sh
   ```
2. Or allow the script to drop and recreate it (careful!):
   ```bash
   REPLACE_EXISTING=true bash scripts/restore-db.sh
   ```

#### Restore fails with gzip integrity error

The backup file is corrupted:

```bash
gunzip -t /path/to/backup.sql.gz
# If this fails, the file is corrupt
```

Try an older backup or check the backup workflow logs to see if backups have been
failing.

#### Verification fails with "Event stream has gaps"

**This is critical.** Gaps in the event stream mean read models (donations,
projects, profiles) may not be correctly rebuilt. Do **not** cut over until
this is resolved:

1. Check the `docs/runbooks/drills/*.json` reports to see if the drill detected
   this before the incident.
2. If the drill has been passing but the incident restore has gaps, the restore
   itself is broken. Try an older backup.
3. If all backups have gaps, the event stream in production was already
   corrupted. Escalate to your team lead immediately.

#### Verification fails with "Donations checksum mismatch"

Donations were lost or corrupted during restore. Do **not** cut over:

1. Try an earlier backup:
   ```bash
   # Go back to Step 2, choose an older backup file
   ```
2. If multiple backups show the same mismatch, the corruption is in production
   backups (not the restore mechanism). Escalate.

#### Can't connect to target database

Check credentials and network:

```bash
# Test the connection
psql -h YOUR_HOST -p 5432 -U postgres -c "SELECT version();"

# If it times out, the host is unreachable
# If it says "password authentication failed", credentials are wrong
# If it says "role 'postgres' does not exist", the database setup is broken
```

#### Restore takes longer than RTO baseline

This is normal if the database is much larger than the seed dataset the drill
used. The drill's RTO is measured on ~10 projects / 50 donations. Production
will be larger. If restore takes >1 minute, check:

- Database size: `du -sh /var/lib/postgresql/data/`
- Disk I/O: `iostat -x 1` (watch %util)
- CPU: `top` (PostgreSQL process consuming CPU?)

Large databases may take several minutes to restore. This is expected.

#### Temporal consistency check fails (created_at > updated_at)

Data corruption in the original database. The restore is a faithful copy of
corrupted data. Escalate to investigate the original corruption's source.

---

## 3. Point-in-Time Recovery (PITR)

**Status: Not yet deployed in production.** See `docs/adr/ADR-004-managed-postgres-vs-self-hosted-ha.md` for the decision to evaluate managed PostgreSQL or HA clustering.

When PITR is deployed (with WAL archiving configured):

### Prerequisites for PITR

- PostgreSQL instance configured with:
  ```ini
  wal_level = replica
  archive_mode = on
  archive_command = 'aws s3 cp %p s3://greenpay-wal-backups/wal/%f'
  archive_timeout = 300
  ```
- WAL files archived to S3/GCS from backup time through recovery target time
- `restore-db.sh` script version that supports `RECOVERY_TARGET_TIME`

### Recovering to a specific point in time

If you need to recover to a time **after** the nightly backup but **before**
the disaster:

```bash
# Restore to just before the corruption
RECOVERY_TARGET_TIME='2026-08-22T09:45:00Z' \
DB_HOST=prod-postgres.example.com \
DB_PORT=5432 \
DB_USER=postgres \
DB_PASSWORD=your_pw \
STORAGE_TYPE=s3 \
S3_BUCKET=greenpay-backups \
BACKUP_FILE=greenpay_backup_20260822_021504.sql.gz \
TARGET_DB_NAME=greenpay_restored \
bash scripts/restore-db.sh
```

The script will:

1. Restore the full backup (taken at 02:15:04 UTC)
2. Replay WAL files from backup time through 09:45:00 UTC
3. Stop at exactly that timestamp

This recovers transactions from between the backup and 09:45:00, losing only
transactions from 09:45:00 onward (instead of losing up to 24 hours if
restricted to the nightly backup).

---

## Related

- Backup script: [scripts/backup-db.sh](../../scripts/backup-db.sh)
- Restore script: [scripts/restore-db.sh](../../scripts/restore-db.sh)
- Drill script: [scripts/db-restore-drill.sh](../../scripts/db-restore-drill.sh)
- Backup workflow: [.github/workflows/database-backup.yml](../../.github/workflows/database-backup.yml)
- Drill workflow: [.github/workflows/db-restore-drill.yml](../../.github/workflows/db-restore-drill.yml)
- Backup/restore reference docs: [docs/database.md](../database.md)
- Drill history: [docs/runbooks/drills/](drills/)
