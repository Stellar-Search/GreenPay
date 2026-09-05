# Live donation feed degraded or split across replicas

**Trigger:** donors report the live feed is quiet, incomplete, or that donations
appear for some viewers and not others; or `delivery` reports `instance` on any
backend pod.

**Severity:** Medium — no data is lost. Every donation is recorded in Postgres
and served by the REST API; the feed is a presentation layer over it. What is
lost is the platform's most visible transparency claim, and the failure is
**silent by design of the old system**: nothing errors and no pod looks
unhealthy.

Background and design rationale: [docs/realtime.md](../realtime.md).

---

## The failure this exists to catch

Socket.IO keeps connections in per-process memory. Without a shared adapter, a
broadcast from one pod reaches only that pod's clients — 50% of donors at two
replicas, 10% at ten. Measured, before the shared adapter: 10.00% delivery
completeness at ten replicas, and **zero** of two hundred events reaching every
connected client.

Nothing about that state throws. Aggregate dashboards look normal. This runbook
is how you see it.

---

## 1. Establish the scope

Ask every replica, not the service — a load-balanced request answers from one
random pod and will happily report health while its neighbours are silent.

```bash
for pod in $(kubectl -n greenpay get pods -l app=backend -o name); do
  echo "── $pod"
  kubectl -n greenpay exec "$pod" -c backend -- \
    wget -qO- http://127.0.0.1:4000/api/v1/realtime/status \
    | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]; m=d["metrics"]; print(f"  delivery={d[\"delivery\"]} degraded={d[\"degraded\"]} reason={d[\"reason\"]}"); print(f"  conns={m[\"currentConnections\"]} published={m[\"eventsPublished\"]} fanoutObserved={m[\"fanoutObserved\"]}")'
done
```

Read the result:

| Observation | Meaning | Go to |
|---|---|---|
| `delivery=global` on every pod, `fanoutObserved` climbing everywhere | Delivery is healthy. The problem is elsewhere — check the ingress (§3) or the client. | §3 |
| `delivery=instance`, `degraded=true`, reason mentions Redis | Pods cannot reach Redis. | §2 |
| `delivery=global` but one pod's `fanoutObserved` is flat at zero while others publish | That pod is subscribed to nothing. Restart it. | §2.3 |
| `mode=single-process` on a production pod | `REDIS_URL` is not set. This is the original bug. | §2.1 |

---

## 2. Restore cross-replica delivery

### 2.1 `REDIS_URL` missing

```bash
kubectl -n greenpay get configmap greenpay-config -o jsonpath='{.data.REDIS_URL}'
```

Expect `redis://redis-svc:6379`. If empty, the pods are running single-process
and every donor is seeing at most one pod's traffic. Restore it from
`k8s/configmap.yaml` and restart the backend:

```bash
kubectl -n greenpay apply -f k8s/configmap.yaml
kubectl -n greenpay rollout restart rollout/backend
```

### 2.2 Redis unreachable

```bash
kubectl -n greenpay get pods -l app=redis
kubectl -n greenpay exec deploy/redis -- redis-cli ping          # expect PONG
kubectl -n greenpay exec deploy/redis -- redis-cli info memory | grep used_memory_human
```

- **Not running / CrashLoopBackOff** — `kubectl -n greenpay describe pod -l app=redis`.
  Check for OOMKill; the container limit (384Mi) sits above `maxmemory` (256mb)
  so Redis enforces its own ceiling first.
- **Running but unreachable from the backend** — almost always the NetworkPolicy.
  The namespace default-denies ingress, and because the backend degrades rather
  than crashing, a missing rule looks like a quiet feed rather than an outage:
  ```bash
  kubectl -n greenpay get networkpolicy allow-redis || kubectl -n greenpay apply -f k8s/network-policy.yaml
  ```
- **Writes rejected (OOM command not allowed)** — `maxmemory-policy noeviction`
  is deliberate; evicting stream entries would silently corrupt replay. Raise
  `maxmemory` in `k8s/redis.yaml`, or accept the degraded window.

**No restart of the backend is required once Redis returns.** The clients
reconnect on their own and each instance promotes itself back to `global` only
when every connection is healthy. Re-run §1 to confirm.

### 2.3 One pod stuck while its peers are healthy

A pod whose `fanoutObserved` stays at zero is not subscribed. Delete it and let
the Rollout replace it:

```bash
kubectl -n greenpay delete pod <pod-name>
```

---

## 3. Feed never connects at all

If clients never receive anything and `currentConnections` is zero across all
pods, the handshake is not reaching the backend. Socket.IO connects to
`/socket.io/`, which needs its own Ingress rule — a catch-all `/` rule sends it
to the **frontend**, which runs no Socket.IO server.

```bash
kubectl -n greenpay get ingress
kubectl -n greenpay get ingress backend-socket-ingress -o yaml | grep -A3 'path:'
```

Expect an Ingress serving `/socket.io` and pointing at the backend service.
Check the affinity annotations survive, too — without them the long-polling
handshake is load-balanced across pods mid-sequence and the client loops
forever, reconnecting:

```bash
kubectl -n greenpay get ingress backend-socket-ingress \
  -o jsonpath='{.metadata.annotations}' | tr ',' '\n' | grep -E 'affinity|session-cookie'
```

Symptom of missing affinity: clients connect and disconnect in a tight loop,
`connectionsOpened` climbs fast while `currentConnections` stays near zero.

---

## 4. Donors report missing donations after a reconnect

Expected and recoverable. Clients replay from their last cursor on reconnect
(`GET /api/v1/realtime/replay`). A rising `replayResets` means clients are
falling outside the retention window and are being told to refetch from REST —
correct behaviour, but if it is common the window is too small for the event
rate. Raise `MAX_RETAINED_EVENTS` in `backend/src/realtime/eventLog.js`.

Confirm no donation was actually lost — the feed is a view, not the record:

```bash
kubectl -n greenpay exec deploy/postgres -- \
  psql -U postgres -d greenpay -c \
  "SELECT count(*) FROM donations WHERE created_at > now() - interval '1 hour';"
```

If that count matches Horizon, nothing was lost; only the live view lagged.

---

## 5. Verify recovery

```bash
# Every pod should report global delivery.
for pod in $(kubectl -n greenpay get pods -l app=backend -o name); do
  kubectl -n greenpay exec "$pod" -c backend -- \
    wget -qO- http://127.0.0.1:4000/api/v1/realtime/status \
    | grep -o '"delivery":"[a-z]*"'
done
```

Then watch a real donation arrive in a browser on the live site, and confirm
`fanoutObserved` increments on the pods that did **not** publish it. That last
check is the one that actually proves cross-replica delivery; every other signal
here was green while the feed was broken.

---

## Alerting

Alert on these, per pod:

| Condition | Meaning |
|---|---|
| `delivery == "instance"` for > 2 min on any pod | Cross-replica delivery is broken. |
| `currentConnections > 0` and `fanoutObserved` unchanged for > 10 min while another pod's `eventsPublished` rises | That pod is receiving nothing. The original bug. |
| `publishFailures` rising | Broadcasts are being dropped. |
| `replayResets / replayRequests > 0.2` | Clients routinely fall outside the replay window. |
