# Runbook: Indexer has fallen behind or missed a downtime window

**Severity:** High — missed donations are not recorded and the leaderboard,
badges, and donation feed go stale.

**Owner:** Backend / DevOps on call.

## Summary

The indexer (`backend/src/services/indexerService.js`) streams Horizon
operations over SSE and records native XLM payments to tracked project wallets as
donations. Its cursor is a **module-level in-memory variable**
(`lastProcessedLedger`); it is **not persisted**, and there is **no automatic
backfill or reconciliation**. On a process restart or a stream drop it resumes
from `"now"`, so donations that landed while it was down are silently missed.
See `docs/indexer.md` for the full failure-mode analysis.

## 1. Detect

- **Lag alert / manual check** — compare the indexer's last processed ledger
  against Horizon's latest ledger:
  ```bash
  curl -s http://<backend>/health
  # → { "status": "ok", "indexer": { "isRunning": true, "lastProcessedLedger": 12345678, "projectWalletsCount": 15, "timestamp": "..." } }
  ```
  ```bash
  curl -s https://horizon-testnet.stellar.org/ | jq '.core_latest_ledger, .ledger.version'
  ```
  A large gap between `lastProcessedLedger` and Horizon's latest ledger (or
  `lastProcessedLedger == 0`) means the indexer is behind or never started.
- `isRunning: false` in `/health`, or indexer errors in the backend logs
  (`[Indexer Error] ...`).
- Users report donations missing from the leaderboard/feed for a project wallet
  that had on-chain activity during a known downtime window.

## 2. Assess the gap

1. Determine the downtime window (from deployment history, incident reports, or
   pod restarts): `kubectl -n greenpay get pods -l app=backend`.
2. Identify the affected wallets (tracked project wallets). The set is the same
   the indexer caches at startup:
   ```sql
   SELECT id, name, wallet_address FROM projects WHERE status = 'active';
   ```
3. Confirm which of those wallets actually received XLM during the window, using
   Horizon history per wallet (note exact `transaction_hash`, `amount`, `to`):
   ```bash
   curl -s "https://horizon-testnet.stellar.org/accounts/<wallet>/payments?order=asc&limit=200&cursor=<start-cursor>"
   ```

## 3. Backfill missed donations

> There is no automated backfill yet (tracked enhancement — persist the cursor,
> add a reconciliation job). Until then, replay is manual and must be idempotent.
> The `donations.transaction_hash` column is `UNIQUE`, so re-inserting an
> already-processed hash is safe to skip.

1. **Verify the indexer is running** so it won't double-process while you
   replay:
   ```bash
   curl -s http://<backend>/health   # isRunning must be true
   ```
2. **Gather candidate donations** — for each affected wallet, pull Horizon
   payments in the downtime window (see step 2.3).
3. **Filter out already-recorded hashes**:
   ```sql
   SELECT transaction_hash FROM donations
   WHERE project_id IN (
     SELECT id FROM projects WHERE status = 'active'
   )
   AND transaction_hash = ANY(ARRAY['<hash1>','<hash2>', ...]);
   ```
   Only the hashes **not** returned need to be inserted.
4. **Insert each missing donation through the standard pipeline** so all
   side-effects happen exactly as the live stream would (donation row, project
   `raised_xlm`/`donor_count`, donor profile/badge, WebSocket event). The live
   path is `handleDonation()` in `backend/src/services/indexerService.js`; a
   reconciliation script should reuse that same function rather than issuing raw
   INSERTs, so bookkeeping stays consistent.
5. **Validate the backfill**:
   ```sql
   SELECT project_id, COUNT(*), SUM(amount)
   FROM donations
   WHERE created_at >= '<downtime-start>' AND created_at <= NOW()
   GROUP BY project_id;
   ```
   Compare against the on-chain payments observed in step 2.3.

## 4. Restart the indexer cleanly

The cursor is in-memory, so a restart starts from `"now"`. To minimize the next
gap:

```bash
kubectl -n greenpay rollout restart deploy/backend
kubectl -n greenpay rollout status deploy/backend --timeout=120s
curl -s http://<backend>/health   # confirm isRunning true and lastProcessedLedger advancing
```

## 5. Prevent recurrence

- **Add monitoring** for indexer health: alert when
  `lastProcessedLedger` is older than a threshold (e.g. 10 ledgers behind
  Horizon's latest) or when `/health` reports `isRunning: false`.
- **Track the persistence fix**: the indexer should persist its cursor and run a
  periodic reconciliation job so downtime windows self-heal. See the
  "Reconciliation" section of `docs/indexer.md`.
- Re-run this runbook's detection check after every backend deployment to
  confirm the indexer comes back healthy.

## References

- `backend/src/services/indexerService.js` — stream, `lastProcessedLedger`, `handleDonation`.
- `backend/src/routes/health.js` — exposes `getStatus()`.
- `docs/indexer.md` — architecture and failure-mode analysis.
- `backend/src/db/schema.sql` — `donations` (unique `transaction_hash`).
- [Runbooks index](README.md)