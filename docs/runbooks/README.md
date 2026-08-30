# Incident Response Runbooks

Runbooks for the highest-severity operational failures of the GreenPay platform.
Treat these as the source of truth during an incident; keep them in sync with the
backend code and `k8s/` manifests when either changes (see
[.github/PULL_REQUEST_TEMPLATE.md](../../.github/PULL_REQUEST_TEMPLATE.md)).

| Runbook | Trigger | Severity |
|---|---|---|
| [Matcher hot wallet key compromised](matcher-key-compromise.md) | The donation-matching account's secret key (`MATCHER_SECRET_KEY`) may be exposed or misused. | Critical — live funds |
| [Indexer behind / missed donations](indexer-lag.md) | The indexer is lagging Horizon's latest ledger, stopped, or missed a downtime window. | High — data loss |
| [Database restore drill (game day)](db-restore-drill.md) | Scheduled quarterly, or a real incident requiring restore from the nightly backup. | High — data loss |
| [Live donation feed degraded](realtime-feed-degraded.md) | Donors see an incomplete live feed, or a backend pod reports `delivery: instance`. | Medium — no data loss, but silent by default |
