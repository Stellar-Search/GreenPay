# Live donation feed: cross-replica delivery, reconnect recovery, and per-pod visibility

## Summary

The live donation feed was silently broken in production for most viewers.

Socket.IO keeps its connections in per-process memory, so `io.emit` reached only
the clients held by the pod that handled the donation. The backend runs a minimum
of two replicas and scales to ten (`k8s/hpa.yaml`), so roughly half of watching
donors never saw a donation arrive — ninety percent at ten replicas.

Nothing errored, no request failed, and every pod reported itself healthy. Locally
and in every test harness there is one process, where per-process delivery is
complete by definition and the feed looks perfect.

This PR attaches a shared Redis adapter so one broadcast reaches every connected
donor regardless of which pod holds them, makes reconnect gaps recoverable, makes
the failure visible per pod, and proves all of it with genuinely multi-process
tests.

## Type

- [x] Bug fix
- [x] New feature
- [ ] Documentation
- [ ] Refactor
- [ ] Smart contract change

## Related Issue

Closes the "Real-time donation feed working in production" issue.

Complements #375 (untyped event contract) and #134 (no reconnect backfill): this
PR is about delivery across replicas, those are about payload shape and client
recovery. The cursor introduced here is the mechanism #134 would build on.

---

## Measured

Both "before" rows are **measured, not predicted** — `backend/test/harness/loadProfile.js`
runs the same profile with `--noAdapter 1`, which starts the instances with no
shared store: exactly the pre-fix behaviour.

| Replicas | Clients | | Completeness | Events reaching everyone | p50 / p95 / p99 |
| ---: | ---: | :-- | ---: | ---: | ---: |
| 2 | 200 | **before** | 50.00% | 0 / 200 | 2 / 5 / 8 ms |
| 2 | 200 | **after** | 100.00% | 200 / 200 | 5 / 11 / 15 ms |
| 10 | 300 | **before** | 10.00% | 0 / 200 | 2 / 4 / 6 ms |
| 10 | 300 | **after** | 100.00% | 200 / 200 | 12 / 26 / 39 ms |

At ten replicas the feed delivered a tenth of what it promised, and **not one
event in two hundred** reached every watching donor. The cost of correctness is a
Redis round trip per broadcast: single-digit milliseconds at the median, tens at
the tail.

```bash
node backend/test/harness/loadProfile.js --replicas 10 --clients 300 --events 200
node backend/test/harness/loadProfile.js --replicas 10 --clients 300 --events 200 --noAdapter 1
```

---

## Two further faults were in the way

Neither was in the issue, both blocked the feature outright:

1. **`/socket.io` was routed nowhere.** Every Ingress rule matches `/api`, and the
   Socket.IO client connects to `/socket.io/`. In the Helm chart it was worse than
   a 404 — the catch-all `/` rule sent the handshake to the **frontend** service,
   which runs no Socket.IO server. Cross-replica delivery was the second problem;
   the feed could not connect at all.

2. **Redis needed its own NetworkPolicy.** The namespace default-denies ingress.
   Because the backend is built to degrade rather than crash when its store is
   unreachable, a missing rule would have presented as a quietly partial feed —
   the same bug, reintroduced by infrastructure.

---

## Key changes

### Cross-replica delivery — `backend/src/realtime/`

Every pod attaches `@socket.io/redis-adapter`. Application code no longer calls
`io.emit`; it calls `publish()`, which records the event in a capped Redis stream,
attaches the resulting cursor, and then broadcasts.

That order is deliberate: a client receiving cursor `C` and later asking for
"everything after `C`" must never be told about an event the log has not yet stored.

Call sites converted: `routes/donations.js`, `services/indexerService.js`,
`services/summaryQueue.js`.

### Session affinity — `k8s/backend.yaml`, `helm/greenpay/templates/ingress.yaml`

Socket.IO opens with HTTP long-polling and upgrades afterwards; every request in
that handshake must reach the pod that issued the session, or the client loops
reconnecting forever.

**Decision: affinity, not WebSocket-only.** Forcing `transports: ["websocket"]`
would remove the need for affinity entirely — and also the fallback that keeps the
feed working for donors behind corporate proxies and TLS-terminating middleboxes
that break the `Upgrade` header. For those users the feed would not degrade; it
would never connect. Donation transparency is a public promise, and silently
excluding restricted networks is a worse trade than a cookie.

Affinity lives on its **own Ingress resource**, because these annotations apply to
every path on the resource carrying them — pinning the stateless REST API would
undo the load balancing that multiple replicas exist to provide.

### Reconnect recovery — `GET /api/v1/realtime/replay`

Every event carries a `cursor`. Clients present the last one they saw on reconnect
and receive what they missed. **Any replica can answer**, because the log is
shared — which is what makes recovery work when a reconnect lands the client on a
different pod. `frontend/hooks/useDonationSocket.ts` does this automatically.

When the server cannot prove the reply is complete it returns `reset: true` with a
reason (`CURSOR_EXPIRED`, `CURSOR_FOREIGN`, `STORE_UNAVAILABLE`, …). This matters
because an empty `events` array reads identically as *"you missed nothing"* and
*"your cursor is unusable"* — conflating those is exactly how a gap becomes silent.

### Degradation policy

A Redis outage degrades **loudly** and never takes the pod with it:

- Events still reach the emitting pod's clients — partial delivery beats none.
- The instance reports `delivery: "instance"`, logs at error level, and pushes a
  `realtime:status` event to connected clients so they can fall back to REST.
- Replay refuses to guess, answering `reset: true` rather than an empty list.
- **Readiness deliberately still passes.** `/health` backs the readiness probe;
  failing it would pull every pod from rotation over a feature that is not the API.
- It recovers on its own, and is promoted back to `global` only once *all*
  connections are healthy.

### Observability — `GET /api/v1/realtime/status`

Reported **per instance, not aggregated**. An aggregate looks identical whether one
pod holds every client or ten pods hold a tenth each and only one ever receives a
broadcast — which is precisely why this survived so long.

`fanoutObserved` counts broadcasts received from *other* pods. Flat at zero on a
pod holding connections, while other pods publish, is the failure signature.
`docs/runbooks/realtime-feed-degraded.md` alerts on it.

### Infrastructure

`k8s/redis.yaml` (deliberately ephemeral — no PVC, persistence off, one replica,
`maxmemory-policy noeviction`), plus `REDIS_URL` in the configmap, the
`allow-redis` NetworkPolicy, and a Redis service in `docker-compose.yml`.

---

## Testing

- [x] Tested locally on Testnet
- [x] No TypeScript / Rust errors
- [x] Docs updated if needed

`backend/test/realtime.multiInstance.test.js` spawns **genuinely separate node
processes** and connects real Socket.IO clients to them. It asserts distinct pids
*before* asserting anything about delivery — the bug is invisible in a single
process, and an in-process double would only prove the double works.

The suite skips itself without a reachable Redis so `npm test` still works on any
machine. In CI that skip would quietly retire the only test proving cross-replica
delivery, so `scripts/assert-multi-instance-coverage.js` fails the build if it did
not actually run. Verified: it exits 1 when pointed at a dead Redis.

Every fix in this PR was verified by reverting it and watching the relevant test
fail — including the adapter itself, and the `fanoutObserved` instrumentation.

| Check | Result |
| :-- | :-- |
| Backend lint | 0 errors |
| Backend `npm test` | 424 passed, 3 skipped (49 suites) |
| Redis-scoped suites | 13 passed |
| Multi-instance coverage guard | 11 passed, 0 skipped, ≥2 processes proven |
| Frontend type-check / lint / build | clean |
| Frontend tests | 181 passed (17 suites) |
| `docs` job scripts (all five) | pass |
| Helm lint (testnet + mainnet) | pass |
| Helm release guards (3 renders) | pass |

---

## Infra / Docs Sync

- [x] Infrastructure changes verified against the manifests

`docs/realtime.md` is the delivery contract — modes, transport trade-off,
reconnect semantics, degradation policy, measurements.
`docs/runbooks/realtime-feed-degraded.md` is the incident runbook, indexed in
`docs/runbooks/README.md`. `docs/openapi.yml` documents both new endpoints.

CI (`.github/workflows/ci.yml`) gains a Redis service on the backend job.

---

## Two pre-existing bugs this surfaced

Both were dormant on `main` because nothing set `REDIS_URL`. This PR is the first
thing that does, so both had to be fixed for it to be safe:

1. **Redis-backed rate limiting had never worked.** `rate-limit-redis@4` exports an
   ESM/CJS interop namespace, so `new RedisStore()` threw
   `TypeError: RedisStore is not a constructor`. It would have thrown on the first
   rate-limited request in any deployment that configured Redis. The suite written
   to prove the shared store works had been skipping itself — its own docblock says
   it was waiting for exactly this change.

2. **The shared Redis client connected at import time.** Every route file pulls it
   in transitively, so merely requiring a route left a live handle holding the event
   loop open and `jest` would finish its run and then hang forever. Now lazy.

Related: pointing the *whole* suite at a live Redis makes it stateful across runs —
rate-limit counters outlive the process, so a second run sees an already-throttled
account. CI therefore scopes Redis to the two suites that own their connection
lifecycle. Verified idempotent across repeated runs.

---

## Notes for the reviewer

- **Local development is unchanged.** No `REDIS_URL` is a *supported* mode, not a
  fallback, and is not reported as degraded — one process delivering to its own
  clients is complete delivery.
- **The adapter's Redis clients are configured so a command can never reject.**
  `@socket.io/redis-adapter` issues every `publish` and `psubscribe` without
  awaiting or catching it, so a rejection becomes an unhandled rejection and, on
  Node 18+, kills the process. A Redis outage would then stop being a degraded feed
  and start being a crash-looping deployment. The replay log uses a **separate**
  connection with the opposite, fail-fast settings, because its calls *are* awaited
  by the donation request handler.
- **Redis runs one replica on purpose.** A second, unsynchronised instance would
  split the fan-out and reintroduce this bug in a harder-to-see form. Scaling it
  means Sentinel or Cluster, which is a change of its own.

### Out of scope, flagged

`frontend/lib/__tests__/graphPicking.bench.test.ts` asserts wall-clock times
(`elapsed < 200ms`, logging ~124ms). It failed once under CPU contention and passed
7/7 in isolation. Pre-existing and unrelated to this PR, but a real CI flake risk —
happy to convert it to relative assertions in a follow-up.
..