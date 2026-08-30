# Realtime donation feed

The live feed is the platform's most visible claim to transparency: donors watch
contributions arrive as they happen. This document is the contract for how those
events are delivered, what happens when delivery cannot be guaranteed, and how a
client recovers from a gap.

---

## The problem this replaced

Socket.IO keeps its connections in per-process memory. An `io.emit` therefore
reaches only the clients whose sockets that particular process is holding.

The backend autoscales from two to ten replicas (`k8s/hpa.yaml`), so a donation
recorded by one pod was broadcast to that pod's clients and nobody else.

Nothing about this was visible from inside the system. No request errored, no
test failed, and every pod reported itself healthy. Locally, and in every test
harness, there was one process — where per-process delivery is complete by
definition and the feed looks perfect.

Two further faults compounded it. No Ingress rule matched `/socket.io`, so the
handshake never reached the backend at all; in the Helm chart the catch-all `/`
rule sent it to the **frontend** service, which runs no Socket.IO server. And a
client that dropped its connection had no way to discover what it had missed.

### Measured

Both numbers come from `backend/test/harness/loadProfile.js` against real
processes and a real Redis. "Completeness" is the share of connected clients that
received each broadcast; "reaching everyone" counts events that reached all of them.

| Replicas | Clients | | Completeness | Reaching everyone | p50 / p95 / p99 |
| ---: | ---: | :-- | ---: | ---: | ---: |
| 2 | 200 | **before** | 50.00% | 0 / 200 | 2 / 5 / 8 ms |
| 2 | 200 | **after** | 100.00% | 200 / 200 | 5 / 11 / 15 ms |
| 10 | 300 | **before** | 10.00% | 0 / 200 | 2 / 4 / 6 ms |
| 10 | 300 | **after** | 100.00% | 200 / 200 | 12 / 26 / 39 ms |

At ten replicas the feed delivered a tenth of what it promised, and not one event
in two hundred reached every watching donor. The "before" rows are measured, not
predicted — reproduce them with `--noAdapter 1`, which starts the instances with
no shared store, exactly the pre-fix behaviour.

The cost of correctness is a Redis round trip per broadcast: single-digit
milliseconds at the median, tens at the tail. Reproduce with:

```bash
node backend/test/harness/loadProfile.js --replicas 10 --clients 300 --events 200
node backend/test/harness/loadProfile.js --replicas 10 --clients 300 --events 200 --noAdapter 1
```

---

## How delivery works now

Every pod attaches `@socket.io/redis-adapter`, backed by the Redis in
`k8s/redis.yaml`. A broadcast is published to Redis and every pod delivers it to
its own clients, so one `emit` reaches every connected donor regardless of which
pod is holding them.

Application code never calls `io.emit` directly. It calls `publish()` from
`backend/src/realtime/`, which records the event in the replay log, attaches the
resulting cursor, and then broadcasts. That order matters: a client that receives
cursor `C` and later asks for "everything after `C`" must never name an event the
log has not yet stored.

### Modes

| Mode | When | Delivery scope |
| :-- | :-- | :-- |
| `single-process` | `REDIS_URL` unset | This instance's clients |
| `redis-adapter` | `REDIS_URL` set and reachable | Every instance's clients (`global`) |
| `redis-adapter`, degraded | `REDIS_URL` set, Redis unreachable | This instance's clients, reported |

`single-process` is a supported mode, not a fallback. Local development runs one
process, where per-process delivery is already complete, so it is **not** reported
as degraded. Behaviour there is unchanged from before this work.

---

## Transport and session affinity

Socket.IO opens with HTTP long-polling and upgrades to WebSocket afterwards.
Every request in that handshake — including the POST carrying the session id —
must reach the pod that issued the session, or the client is told its session is
unknown and restarts the handshake, forever.

**Decision: session affinity, not WebSocket-only.**

`k8s/backend.yaml` (`backend-socket-ingress`) and
`helm/greenpay/templates/ingress.yaml` (`greenpay-realtime-ingress`) pin clients
with an nginx cookie scoped to `/socket.io`.

The alternative — `transports: ["websocket"]` on the client — removes the need
for affinity entirely, since a WebSocket is a single connection with no
multi-request handshake to keep together. It was rejected because it also removes
the fallback that keeps the feed working for donors behind corporate proxies and
TLS-terminating middleboxes that strip or mishandle the `Upgrade` header. For
those users the feed would not degrade; it would never connect. Donation
transparency is a public-facing promise, and silently excluding restricted
networks is a worse trade than a cookie.

Consequences accepted:

- **Affinity applies to `/socket.io` only.** It lives on its own Ingress
  resource because these annotations apply to every path on the resource
  carrying them, and pinning the stateless REST API would undo the load
  balancing that multiple replicas exist to provide.
- **Uneven connection distribution.** Pinning is per-client and long-lived, so
  pods that have been up longer accumulate connections. `session-cookie-change-on-failure`
  releases clients when their pod goes away.
- **`proxy-read-timeout` is raised to 3600s.** A live feed is idle between
  donations; nginx's 60s default would tear down healthy connections and
  manufacture the reconnect churn this feature exists to avoid.

---

## Reconnect recovery

Socket delivery is best-effort. A client disconnected by a closed laptop, a
network blip, or a rolling deploy does not receive what was broadcast while it
was away.

Every live event carries a `cursor`. Clients remember the last one they saw and
present it on reconnect:

```
GET /api/v1/realtime/replay?cursor=<cursor>&limit=<n>
```

The log is a Redis stream capped at 10,000 events, so **any** replica can answer
— which is what makes this work when a reconnect lands the client on a different
pod. `frontend/hooks/useDonationSocket.ts` does this automatically.

### `reset` is the important field

`reset: true` means the server **cannot prove the reply is complete**. The client
must refetch current state from the REST resources rather than stitch a partial
replay into its timeline.

This exists because `events: []` alone is ambiguous — it reads identically as
"you missed nothing" and "your cursor is unusable". Conflating those is how a gap
becomes silent, which is the failure mode this whole document is about.

| `reason` | Meaning |
| :-- | :-- |
| `NO_CURSOR` | Client has no timeline yet; it starts from now. Not a gap. |
| `INVALID_CURSOR` | Not a cursor this service issued. |
| `CURSOR_FOREIGN` | Issued by a pod running without a shared store, or before a restart. |
| `CURSOR_EXPIRED` | Aged out of the 10,000-event window; refetch is cheaper than replay. |
| `STORE_UNAVAILABLE` | The replay log is unreachable. Completeness cannot be established. |

`reset: false` with an empty `events` array is the unambiguous "you are up to
date" answer.

---

## When Redis is unavailable

**Decision: degrade loudly, keep serving.**

1. **Events still reach the emitting pod's clients.** Partial delivery beats
   none.
2. **The instance reports itself degraded** — logged at error level, exposed on
   `GET /api/v1/realtime/status`, and pushed to connected clients as a
   `realtime:status` event with `delivery: "instance"`. A client that learns its
   feed is partial can fall back to polling REST; one told nothing cannot.
3. **Replay refuses to guess.** It answers `reset: true` with
   `STORE_UNAVAILABLE` rather than an empty list a client would read as "nothing
   happened".
4. **Readiness deliberately still passes.** `/health` backs the readiness probe;
   failing it on a Redis outage would pull every pod from rotation and turn a
   degraded feature into a total API outage.
5. **It recovers by itself.** The clients keep reconnecting; the instance is
   promoted back to `global` only once *all* connections are healthy, because
   one recovered client does not restore fan-out.

### The pod must not die

The adapter's own Redis connections are configured never to reject a command
(`maxRetriesPerRequest: null`, offline queue on). `@socket.io/redis-adapter`
issues every `publish` and `psubscribe` without awaiting or catching it, so a
rejection there becomes an unhandled rejection and, on Node 18+, kills the
process. A Redis outage would then stop being a degraded feed and start being a
crash-looping deployment — strictly worse than the bug being fixed.

The replay log therefore uses a **separate** connection with the opposite
settings — bounded by a retry limit and a 2s command timeout — because its calls
*are* awaited, by the donation request handler, where a command must fail fast
rather than queue behind an unreachable server. Every one of those call sites
catches.

---

## Observability

`GET /api/v1/realtime/status` reports **per instance**, and that is the point.
The original bug was invisible to aggregate metrics: "300 clients connected"
looks identical whether one pod holds all 300 or ten pods hold thirty each and
only one ever receives a broadcast.

| Field | Meaning |
| :-- | :-- |
| `instanceId` | Identifies the pod. Changes on restart. |
| `delivery` | `global` or `instance` — the delivery guarantee right now. |
| `currentConnections` / `peakConnections` | Sockets held by this pod. |
| `eventsPublished` | Broadcasts originated here. |
| `fanoutObserved` | Broadcasts received from *other* pods. |
| `publishFailures` | Broadcasts that could not be sent. |
| `replayRequests` / `replayResets` | Reconnect recoveries, and how many hit a gap. |

**The signature to alert on:** a pod with connections held and `fanoutObserved`
flat at zero while other pods report `eventsPublished` climbing. That is
cross-replica delivery broken, and it is exactly what nothing detected before.
A rising `replayResets` rate means clients are falling outside the replay window.

---

## Testing

`backend/test/realtime.multiInstance.test.js` spawns **genuinely separate node
processes** and connects real Socket.IO clients to them, because the bug is
invisible in a single process and an in-process double would only prove the
double works. It asserts distinct pids before asserting anything about delivery.

The suite skips itself when no Redis is reachable, so `npm test` still works on a
machine without one. In CI that skip would quietly retire the only test proving
cross-replica delivery, so `scripts/assert-multi-instance-coverage.js` fails the
build if the suite did not actually run — a guarantee that can silently stop
being checked is not a guarantee.

---

## Operating notes

- `REDIS_URL` is required in any deployment running more than one replica.
  Without it the feed silently reaches a fraction of donors.
- The Redis in `k8s/redis.yaml` is deliberately ephemeral — no PVC, persistence
  off. The replay stream is a capped catch-up buffer whose authoritative source
  is Postgres, and pub/sub state is meaningless across a restart. A restart costs
  a brief degraded window, which the backend reports rather than hides.
- It runs **one** replica on purpose. A second, unsynchronised instance would
  split the fan-out and reintroduce this bug in a harder-to-see form. Scaling it
  means Sentinel or Cluster, which is a change of its own.
- `maxmemory-policy noeviction` is deliberate: streams and pub/sub backlog are
  not idle cache entries an LRU policy can safely reclaim, and evicting them
  silently would corrupt replay. Refusing writes surfaces as an error the backend
  already degrades on.
- `k8s/network-policy.yaml` must allow backend → Redis on 6379. The namespace
  default-denies ingress, and because the backend degrades rather than crashing,
  a missing policy presents as a quietly partial feed rather than an outage.
