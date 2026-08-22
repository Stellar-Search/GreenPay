# Runbook: Database disaster-recovery restore drill (game day)

**Severity:** High — validates the last line of defense for donation and
transaction history. This runbook is run proactively on a schedule, not just
during an incident.

**Owner:** Backend / DevOps on call.

## Summary

GreenPay takes a nightly `pg_dump` backup of the production PostgreSQL
database via `.github/workflows/database-backup.yml` running
`scripts/backup-db.sh` at 02:00 UTC. Until this runbook existed, "a backup
exists" and "a backup can be restored" were different, unverified claims —
the backup script itself had a function-ordering bug that made every nightly
run fail from the day it was introduced (functions were called before they
were defined; `bash -n` doesn't catch this because calling an
as-yet-undefined shell function is valid syntax that only fails at runtime).
That bug is now fixed and covered by
`scripts/tests/test-backup-restore.sh`, but the fix alone doesn't prove a
backup is restorable — only actually restoring one does.

This runbook is both:

1. The **documented, human-runnable restore procedure** for a real incident.
2. The **quarterly game-day drill** (`.github/workflows/db-restore-drill.yml`)
   that re-proves the procedure still works, automatically.

Both use the same two scripts real backups/restores use:
`scripts/backup-db.sh` and `scripts/restore-db.sh`.

## RTO / RPO (measured, not estimated)

These numbers come from an actual timed drill run against real PostgreSQL
16 instances and a real backup produced by `scripts/backup-db.sh` — see
[`docs/runbooks/drills/`](drills/) for the raw report of every drill run.

| | Value | Source |
|---|---|---|
| **RTO** (provision replacement instance → verified restore) | **~12–25s** on a small seed dataset (10 projects / 50 donations); scales with database size — re-measure on production-sized data before trusting this for a real incident. | Timed in `scripts/db-restore-drill.sh`, reported in `docs/runbooks/drills/*.json` (`rto_seconds`) |
| **RPO** | Bounded by backup cadence: **up to ~24 hours** of donations/updates since the last successful nightly backup can be lost. | `.github/workflows/database-backup.yml` cron (`0 2 * * *`); the drill verifies the boundary is clean (pre-backup data is preserved exactly, post-backup data is cleanly absent — not partially/corruptly captured) |

If RTO/RPO targets need to be tighter than this, see
[Point-in-Time Recovery](../database.md#point-in-time-recovery-pitr) in
`docs/database.md` for what continuous WAL archiving would require — it is
not implemented today, so recovery granularity is limited to the nightly
snapshot.

## 1. Automated quarterly drill

`.github/workflows/db-restore-drill.yml` runs `scripts/db-restore-drill.sh`
on the first day of January, April, July, and October (and on demand via
`workflow_dispatch`). It:

1. Starts a throwaway PostgreSQL 16 container and seeds it with
   representative `projects`/`donations` rows.
2. Runs the **real** `scripts/backup-db.sh` against it.
3. Inserts more donations, simulating activity after the backup.
4. Provisions a **second**, fresh PostgreSQL 16 container (standing in for a
   freshly-provisioned replacement) and times how long it takes to go from
   that provisioning to a fully restored, verified database — this is the
   RTO measurement.
5. Verifies the restore: table count, row counts, and an md5 checksum of
   `donations.transaction_hash` compared between the pre-backup source and
   the restored target. Also asserts the post-backup donations (step 3) are
   correctly **absent** from the restore — proving the RPO boundary behaves
   as expected rather than silently including or corrupting near-boundary
   data.
6. Writes a dated report to `docs/runbooks/drills/<drill-id>-restore-drill.{md,json}`
   and uploads it as a workflow artifact.
7. On failure, opens a GitHub issue (same pattern as the backup workflow's
   failure notification) so a broken restore path doesn't go unnoticed for
   another quarter.

To run the same drill locally:

```bash
scripts/db-restore-drill.sh
```

Requires Docker and local `psql`/`pg_dump`. Set `KEEP_CONTAINERS=true` to
leave the drill's Postgres containers running for manual inspection
afterward.

## 2. Manual restore procedure (real incident)

Use this when a real restore is needed — production data loss, a corrupted
database, or standing up a fresh environment from a known-good backup.

### Prerequisites

- `psql`, `pg_dump`/`gzip` available, and `aws`/`gsutil` if restoring from
  cloud storage.
- Credentials for the target PostgreSQL instance with database-creation
  privileges.
- The backup file (from S3, GCS, or a local path).

### Steps

1. **Identify the backup to restore.** List available backups:
   ```bash
   aws s3 ls s3://<bucket>/backups/            # S3
   gsutil ls gs://<bucket>/backups/            # GCS
   ```
   Backups are named `greenpay_backup_YYYYMMDD_HHMMSS.sql.gz`; pick the most
   recent one before the incident (or before the corruption, if known).

2. **Restore to a new database first** (never restore directly over a live
   database in an incident — always verify in a side-by-side database, then
   cut over):
   ```bash
   DB_HOST=<target-host> DB_PORT=5432 DB_USER=postgres DB_PASSWORD=<pw> \
     STORAGE_TYPE=s3 S3_BUCKET=<bucket> BACKUP_FILE=greenpay_backup_YYYYMMDD_HHMMSS.sql.gz \
     TARGET_DB_NAME=greenpay_restored \
     scripts/restore-db.sh
   ```
   Use `STORAGE_TYPE=gcs` with `GCS_BUCKET` for GCS, or `STORAGE_TYPE=local`
   with `LOCAL_BACKUP_PATH=/path/to/file.sql.gz` for an already-downloaded
   file. `restore-db.sh` verifies the archive's gzip integrity, restores
   with `ON_ERROR_STOP=1`, and refuses to proceed if the resulting schema
   has zero tables — a restore that "succeeds" but silently produces an
   empty database is treated as a failure, not a success.

3. **Verify the restored data** against what's expected (row counts,
   spot-check recent donations, compare against on-chain history if
   reconciling from an incident):
   ```bash
   psql -h <target-host> -U postgres -d greenpay_restored -c \
     "SELECT COUNT(*) FROM donations; SELECT COUNT(*) FROM projects;"
   ```

4. **Cut over.** Once verified, either:
   - Point the application at `greenpay_restored` (update `DB_NAME` /
     connection string in `k8s/backend.yaml` or the relevant secret), or
   - Rename databases: `ALTER DATABASE greenpay RENAME TO greenpay_pre_incident;`
     then `ALTER DATABASE greenpay_restored RENAME TO greenpay;`

5. **Record the incident**: actual data-loss window (RPO realized), time
   from decision-to-restore to service restored (RTO realized), and file a
   drill report under `docs/runbooks/drills/` alongside the scheduled ones
   so real-incident numbers are tracked the same way as drill numbers.

### Known compatibility note

If the machine running the restore has a newer PostgreSQL client than the
target server's major version (e.g. `pg_dump`/`psql` 17+ against a
PostgreSQL 16 target), `pg_dump` emits `SET transaction_timeout = 0;` in the
dump preamble — a GUC that doesn't exist before PostgreSQL 17 and otherwise
aborts the restore outright. `scripts/restore-db.sh` strips this line
automatically (it has no effect on the restored data) and logs when it does
so. This was discovered by running the actual drill with a newer local
client, not assumed — see the drill reports for the run it surfaced in.

## Related

- Backup script: [scripts/backup-db.sh](../../scripts/backup-db.sh)
- Restore script: [scripts/restore-db.sh](../../scripts/restore-db.sh)
- Drill script: [scripts/db-restore-drill.sh](../../scripts/db-restore-drill.sh)
- Backup workflow: [.github/workflows/database-backup.yml](../../.github/workflows/database-backup.yml)
- Drill workflow: [.github/workflows/db-restore-drill.yml](../../.github/workflows/db-restore-drill.yml)
- Backup/restore reference docs: [docs/database.md](../database.md)
- Drill history: [docs/runbooks/drills/](drills/)
