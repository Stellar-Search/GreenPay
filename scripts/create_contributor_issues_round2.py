#!/usr/bin/env python3
"""
create_contributor_issues_round2.py — Second batch of complex contribution issues.

Same machinery as create_contributor_issues.py, with a fresh issue set drawn
from a re-audit of the codebase *after* the first batch was largely
implemented. Much of this round targets gaps left behind by that new code.

It is safe to re-run: an issue whose exact title already exists (open OR
closed) is skipped, so a partial run can simply be repeated and nothing in the
existing tracker is touched or duplicated.

Usage:
    export GITHUB_TOKEN=ghp_...          # needs 'repo' scope (issues: write)
    python3 create_contributor_issues_round2.py --dry-run
    python3 create_contributor_issues_round2.py
    python3 create_contributor_issues_round2.py --start 40 --end 60
"""

import argparse
import os
import sys
import time

import requests

REPO = "Stellar-Search/GreenPay"
API = f"https://api.github.com/repos/{REPO}"

TOKEN = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
if not TOKEN:
    try:
        import subprocess

        TOKEN = subprocess.check_output(["gh", "auth", "token"], text=True).strip()
    except Exception:
        pass

if not TOKEN:
    print("ERROR: no GitHub token found. Set GITHUB_TOKEN or run `gh auth login`.", file=sys.stderr)
    sys.exit(1)

SESSION = requests.Session()
SESSION.headers.update(
    {
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
)

LABELS = [
    ("area: frontend", "1D76DB", "Next.js web app"),
    ("area: backend", "0E8A16", "Node/Express API + event sourcing"),
    ("area: contracts", "5319E7", "Soroban/Rust smart contracts"),
    ("area: mobile", "FBCA04", "Expo/React Native app"),
    ("area: extension", "B60205", "Browser extension"),
    ("area: scheduler", "006B75", "Go k8s scheduler plugin"),
    ("area: infra", "C5DEF5", "K8s, Helm, CI/CD, deployment"),
    ("area: cross-cutting", "BFD4F2", "Spans multiple subsystems"),
    ("complexity: high", "D93F0B", "Substantial design/implementation work, not a quick fix"),
    ("security", "E11D21", "Security-relevant"),
]

AREA_LABEL = {
    "Frontend": "area: frontend",
    "Backend": "area: backend",
    "Contracts": "area: contracts",
    "Mobile": "area: mobile",
    "Extension": "area: extension",
    "Scheduler": "area: scheduler",
    "Infra": "area: infra",
    "Cross-cutting": "area: cross-cutting",
}


def ensure_labels():
    resp = SESSION.get(f"{API}/labels", params={"per_page": 100})
    resp.raise_for_status()
    existing = {l["name"] for l in resp.json()}
    for name, color, description in LABELS:
        if name in existing:
            continue
        r = SESSION.post(f"{API}/labels", json={"name": name, "color": color, "description": description})
        print(f"  label {'ready' if r.status_code in (201, 422) else 'FAILED'}: {name}")
        time.sleep(0.3)


def build_body(issue: dict) -> str:
    lines = [f"## Summary\n{issue['summary']}\n", f"## Details\n{issue['details']}\n"]
    if issue.get("approach"):
        lines.append(f"## Suggested Approach\n{issue['approach']}\n")
    lines.append("## Acceptance Criteria")
    for item in issue["acceptance"]:
        lines.append(f"- [ ] {item}")
    lines.append("")
    if issue.get("files"):
        lines.append("## Relevant Files")
        for f in issue["files"]:
            lines.append(f"- `{f}`")
        lines.append("")
    lines.append(
        "---\n*Filed from a second codebase-wide audit, run after the first round of "
        "issues was largely implemented. Every issue here is grounded in a specific, "
        "verified gap in the code as it stands today — a good number of them in the "
        "newer code itself. If anything no longer matches, please comment and we'll "
        "correct or close it.*"
    )
    return "\n".join(lines)


def existing_titles() -> set:
    titles, page = set(), 1
    while True:
        r = SESSION.get(f"{API}/issues", params={"state": "all", "per_page": 100, "page": page})
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        for it in batch:
            if "pull_request" not in it:
                titles.add(it["title"])
        if len(batch) < 100:
            break
        page += 1
    return titles


def create_issue(issue: dict, dry_run: bool = False) -> None:
    labels = ["complexity: high", AREA_LABEL[issue["area"]]]
    if issue.get("security"):
        labels.append("security")
    title = f"{issue['area']}: {issue['title']}"

    if dry_run:
        print(f"    [dry-run] {title}  {labels}")
        return

    resp = SESSION.post(f"{API}/issues", json={"title": title, "body": build_body(issue), "labels": labels})
    if resp.status_code == 201:
        print(f"    created #{resp.json()['number']}")
    else:
        print(f"    FAILED ({resp.status_code}): {resp.text[:300]}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--end", type=int, default=len(ISSUES))
    parser.add_argument("--sleep", type=float, default=1.5)
    args = parser.parse_args()

    print(f"Repo: {REPO}\nIssues defined: {len(ISSUES)}")

    titles = [f"{i['area']}: {i['title']}" for i in ISSUES]
    if len(set(titles)) != len(titles):
        dupes = {t for t in titles if titles.count(t) > 1}
        print(f"ERROR: duplicate titles within this batch: {dupes}", file=sys.stderr)
        sys.exit(1)

    if not args.dry_run:
        print("Ensuring labels exist...")
        ensure_labels()

    # Always fetch, including on a dry run: previewing which issues would be
    # skipped as duplicates is the main thing a dry run is for.
    print("Fetching existing issue titles (so nothing is duplicated)...")
    already = existing_titles()
    print(f"  {len(already)} issues already in the tracker — these will be left untouched.")

    created = skipped = 0
    for i, issue in enumerate(ISSUES[args.start : args.end], start=args.start):
        full = f"{issue['area']}: {issue['title']}"
        if full in already:
            print(f"  [{i}] skip (already exists): {full}")
            skipped += 1
            continue
        print(f"  [{i}] {full}")
        create_issue(issue, dry_run=args.dry_run)
        created += 1
        if not args.dry_run:
            time.sleep(args.sleep)

    print(f"\nDone. Created: {created}, skipped as existing: {skipped}")


def B(title, summary, details, approach, acceptance, files, area="Backend", security=False):
    return dict(area=area, title=title, summary=summary, details=details,
                approach=approach, acceptance=acceptance, files=files, security=security)


ISSUES = [

# ═══════════════════════════ BACKEND (21) ═══════════════════════════

B("rate-limit-redis is imported with the wrong CJS interop — every limiter throws at require time once REDIS_URL is set",
  "rateLimiter.js does `require(\"rate-limit-redis\")` and uses the module object as a constructor, but v4 exports `{ RedisStore, default }`. Limiters are built at module scope, so the first require of any route file crashes boot — but only when Redis is configured, which CI never exercises.",
  "`backend/src/middleware/rateLimiter.js:2` does `const RedisStore = require(\"rate-limit-redis\")`. In v4.3.1 that resolves to a namespace object, so `new RedisStore({...})` throws `TypeError: RedisStore is not a constructor`. Because every limiter is constructed at module scope (`routes/admin.js:12`, `donations.js`, `updates.js`, `ratings.js`, `profiles.js`, `notifications.js`, `subscriptions.js`), the failure happens while `server.js` is still loading routes — a boot crash loop rather than a request error. `middleware/rateLimiter.redis.test.js` is `describe.skip` unless `REDIS_URL` is set, so no CI job ever reaches this path.",
  "Destructure the named export (or `.default`), and make store construction fail soft: fall back to the in-memory store with a loud warning rather than taking the process down. Add a CI job with a Redis service container so the configured path is actually exercised.",
  ["`new RedisStore(...)` resolves correctly and is covered by a unit test that needs no live Redis.",
   "A test proves every route module loads with `REDIS_URL` set (ioredis-mock or a service container).",
   "Store construction failure degrades to the in-memory limiter with a warning instead of crashing boot.",
   "At least one CI job runs with `REDIS_URL` pointing at a Redis service container."],
  ["backend/src/middleware/rateLimiter.js", "backend/src/middleware/rateLimiter.redis.test.js"], security=True),

B("Donation-match caps are never consumed in the event-sourced path, so one match offer can pay out without limit",
  "indexerService computes a match's remaining cap from `donation_matches.matched_xlm`, but nothing in the CQRS path ever writes that column — the projection writes a different table. Every donation therefore sees `matched_xlm = 0` and re-issues the full cap.",
  "`services/indexerService.js` (~line 175) reads `cap_xlm` and `matched_xlm` from `donation_matches` to compute `remaining`. Grepping for writers of `donation_matches.matched_xlm` finds exactly one: `services/turrets.js` (~line 104), an opt-in separate server. The event-sourced path instead maintains `match_state` (`eventSourcing/projections.js`), a different table. So on the normal path `matched_xlm` stays 0 forever and every donation to that project can trigger a full-cap match payout.",
  "Pick one authoritative table for match accounting and make the other a view or remove it. Enforce cap consumption atomically with a conditional update (`UPDATE ... WHERE matched_xlm + $1 <= cap_xlm`) rather than read-then-write, so two donations in the same second cannot both see the full remaining cap.",
  ["`donation_matches` and `match_state` have a single documented owner.",
   "Cap consumption is a single atomic statement, not read-then-write.",
   "A concurrent-donation test proves total matched never exceeds `cap_xlm`.",
   "A reconciliation script (with `--dry-run`) backfills existing rows."],
  ["backend/src/services/indexerService.js", "backend/src/eventSourcing/projections.js", "backend/src/services/turrets.js"], security=True),

B("A project with any active match offer silently loses every incoming donation",
  "Creating a match offer inserts straight into `donation_matches` without emitting `MatchCreated`, so no `match_state` row exists. A truthy-but-empty aggregate then fails cap validation, which rolls back the already-recorded donation — and the error is only console.error'd while the Horizon cursor advances.",
  "`POST /api/v1/projects/:id/matching` (`routes/projects.js`) inserts into `donation_matches` and never emits `MatchCreated`, so `match_state` has no row. `commandBus.getMatchState` calls `MatchAggregate.fromState(undefined)`, which returns a *truthy* default aggregate with `capXlm = 0` (`eventSourcing/aggregates.js`), so the `if (matchState)` guard passes and `validateApplyMatch` throws \"Match cap has been fully consumed\". That throw propagates into `indexerService.handleDonation`'s try block, triggering the `ROLLBACK` that discards the already-executed `RecordDonation`, and is then swallowed. The on-chain donation is never recorded anywhere, and the cursor still advances so it is never retried.",
  "Make `fromState(null)` return `null` (or expose an explicit `exists` flag callers must check), route match-offer creation through `CreateMatchOfferCommand` so `match_state` is always populated, and stop a failed match application from rolling back the donation itself.",
  ["`fromState(null/undefined)` no longer returns a truthy empty aggregate.",
   "Match-offer creation emits `MatchCreated` so `match_state` exists.",
   "A failing match application does not roll back the donation event.",
   "Integration test: a donation to a project with an active offer still records `DonationRecorded`.",
   "Rolled-back donations emit a structured error including the transaction hash."],
  ["backend/src/routes/projects.js", "backend/src/eventSourcing/commandBus.js", "backend/src/eventSourcing/aggregates.js", "backend/src/services/indexerService.js"], security=True),

B("MigratedDonationEvent's EVENT_TYPE does not match the string every projection subscribes to, so migrated donations reach zero subscribers",
  "The event class declares `EVENT_TYPE = \"LegacyDonationMigrated\"` while all three projections subscribe to `\"MigratedDonation\"`. Dispatch is a registry lookup on `event.eventType`, so migrated events are marked processed without ever updating a read model.",
  "`eventSourcing/events.js` (~line 243) sets `EVENT_TYPE = \"LegacyDonationMigrated\"` (its aggregate type is `\"MigratedDonation\"`). `eventSourcing/projections.js` subscribes to `\"MigratedDonation\"` and its branches test `event.eventType === \"MigratedDonation\"`. `dispatchToProjections` does `registry.get(event.eventType)`, so every migrated legacy donation dispatches to nothing, is marked `processed = true`, and never reaches `projects.raised_xlm` or `donor_stats`. `verifyMigration` in `eventSourcing/migrate.js` filters on the same wrong name, so it always reports `xlmTotalMatch: false` — and `runLegacyMigration` records success regardless.",
  "Introduce one canonical constant for the event type and reference it from the event class, the projections and the verification query. Make `dispatchToProjections` warn (or throw) when an event type has no subscribers so this class of typo cannot be silent again.",
  ["A single exported constant defines the event type; no string literals remain.",
   "`dispatchToProjections` surfaces events with zero subscribers instead of silently dropping them.",
   "`runLegacyMigration` refuses to record success when verification fails.",
   "An idempotent replay path re-projects events that were migrated but never projected."],
  ["backend/src/eventSourcing/events.js", "backend/src/eventSourcing/projections.js", "backend/src/eventSourcing/migrate.js"]),

B("Legacy migration writes a bogus ProjectStatusChanged event with newStatus: undefined for every project",
  "The migration's SELECT omits the `status` column, so the guard `if (project.status !== \"active\")` is always true and every project gets a status-change event whose `newStatus` is undefined.",
  "`eventSourcing/migrate.js` (~line 37) selects `id, name, description, category, location, wallet_address, goal_xlm, tags, created_at` — no `status`. Line ~56 then tests `if (project.status !== \"active\")`, which is `undefined !== \"active\"` and therefore always true, so every project gets a version-2 `ProjectStatusChangedEvent` with `previousStatus: \"active\"` and `newStatus: undefined`. Replaying that through `ProjectAggregate.apply` sets `state.status = undefined`, which `storeProjectAggregate` would then write into `projects.status`.",
  "Select the column and fix the conditional, validate required payload fields at event construction so an undefined `newStatus` cannot be built, and add a compensating path for streams that already contain the bad event — the log is append-only, so it cannot simply be updated away.",
  ["`status` is selected and the conditional behaves correctly on real data.",
   "Events validate required payload fields at construction time.",
   "A documented compensation or gated re-migration repairs existing bad streams.",
   "Test: an active project produces exactly one migration event."],
  ["backend/src/eventSourcing/migrate.js", "backend/src/eventSourcing/events.js"]),

B("rebuildReadModels paginates with OFFSET over the very predicate it mutates, skipping roughly half the event stream",
  "The rebuild loop pages `WHERE processed = false ... LIMIT/OFFSET` while marking each batch processed, so after the first batch the offset skips past rows that just left the result set.",
  "`eventSourcing/migrate.js` (~lines 248-269) iterates `i` in steps of `BATCH_SIZE` querying `WHERE processed = false ... LIMIT $1 OFFSET $2`, then marks that batch `processed = true`. Batch 2 asks for `OFFSET 500` of a set that has already shrunk by 500, so events 500-999 are never dispatched. The whole loop also runs inside one long transaction on a single client, so a large stream holds a transaction open for its entire duration.",
  "Switch to keyset pagination on a stable cursor (`occurred_at`/`event_id`), or simply re-query with a constant `OFFSET 0` since the predicate shrinks. Break the single long transaction into resumable chunks.",
  ["Iteration uses a keyset cursor or constant-offset re-query.",
   "Rebuilding N events dispatches exactly N times, asserted with a counter.",
   "A long rebuild does not hold one transaction open for the whole stream.",
   "Progress is resumable after a crash."],
  ["backend/src/eventSourcing/migrate.js"]),

B("The donations table is dead in the write path, so every aggregate endpoint reports zeros on a fresh deployment",
  "Only the opt-in Turrets server ever inserts into `donations`; the API and indexer write only `event_stream`. Six read endpoints still query `donations`, so stats, impact, leaderboard and the network graph all read empty while `projects.raised_xlm` is correct.",
  "Grepping `INSERT INTO donations` across `backend/src/` returns exactly one hit, in `services/turrets.js`. The API path (`routes/donations.js` → `commandBus.DonationCommandHandler`) and `services/indexerService.js` both write only `event_stream`. Yet `routes/stats.js`, all three `routes/impact.js` endpoints, `routes/leaderboard.js`, `routes/network.js` and `routes/ratings.js` read `FROM donations`. The result is a visible inconsistency: raised totals move but donor history, CO2 totals and the leaderboard stay at zero.",
  "Choose one source of truth: either add a `donations` read-model projection (with backfill and a cursor) or rewrite the six aggregate queries against `event_stream` JSONB with supporting expression indexes.",
  ["One documented source of truth for donation history.",
   "`/stats/global`, `/impact/*`, `/leaderboard` and `/network/graph` reflect a donation recorded through the API.",
   "A backfill script populates history from `event_stream` for existing environments.",
   "Regression test records a donation and asserts each aggregate endpoint reflects it."],
  ["backend/src/routes/stats.js", "backend/src/routes/impact.js", "backend/src/routes/leaderboard.js", "backend/src/routes/network.js", "backend/src/eventSourcing/projections.js"]),

B("update_likes is read and written in six places but the table is never created in schema.sql",
  "The update like/unlike endpoints query a table that does not exist, so both fail with a Postgres undefined-table error surfaced as a generic 500.",
  "`routes/updates.js` reads and writes `update_likes` in six places (~lines 130-180). `db/schema.sql` never creates it — `project_updates` exists, `update_likes` does not. `POST /api/v1/updates/:updateId/like` and the likes-count endpoint therefore fail with `42P01 relation \"update_likes\" does not exist`, which the error handler turns into a 500. The toggle is also implemented as SELECT-then-INSERT/DELETE, which is racy even once the table exists.",
  "Create the table with a uniqueness constraint on `(update_id, donor_address)` and an index supporting the per-update count, and make the toggle a single atomic statement. Decide how a like is attributed, since `donor_address` currently arrives as unauthenticated free text.",
  ["`update_likes` exists in `schema.sql` with a UNIQUE constraint and an FK to `project_updates`.",
   "An index supports the per-update count query.",
   "The like toggle is one atomic statement rather than SELECT-then-write.",
   "Route tests exercise like, unlike and count against a real schema."],
  ["backend/src/routes/updates.js", "backend/src/db/schema.sql"]),

B("routes/subscriptions.js is mounted but defines no route handlers at all",
  "The file declares a rate limiter and an email regex, then exports the router with zero handlers — while its own docblock advertises subscribe and count endpoints, and the update fan-out reads a table nothing can populate.",
  "`server.js` mounts `./routes/subscriptions` at `/api/v1/subscriptions`, but `routes/subscriptions.js` declares `subscriptionLimiter` and `EMAIL_RE` and then goes straight to `module.exports = router`. Its docblock still advertises `POST /api/subscriptions` and `GET /api/subscriptions/:projectId/count`. Meanwhile `routes/updates.js` fans email out to `project_subscriptions`, a table that no endpoint can write to.",
  "Implement subscribe, unsubscribe and count with the existing limiter and email validation. This needs real opt-in/opt-out semantics and PII handling, not just an INSERT — and it interacts with the unbounded fan-out issue.",
  ["Subscribe, unsubscribe and count endpoints exist, validated and rate-limited.",
   "An unsubscribe token flow lets recipients opt out of update emails.",
   "`UNIQUE(project_id, email)` conflicts are handled idempotently.",
   "Tests cover subscribe → update posted → email queued → unsubscribe."],
  ["backend/src/routes/subscriptions.js", "backend/src/routes/updates.js"]),

B("syncDonorProjectCount runs an unindexed full scan of event_stream on every single donation event",
  "Each donation triggers a `COUNT(DISTINCT ...)` over the whole event log filtered on an unindexed JSONB expression, so projection cost grows with total platform history rather than staying flat.",
  "`eventSourcing/projections.js` (~lines 525-539) runs `SELECT COUNT(DISTINCT payload->'data'->>'projectId') FROM event_stream WHERE aggregate_type IN (...) AND payload->'data'->>'donorAddress' = $1` once per event. No index covers that expression — `db/schema.sql` indexes only `(aggregate_type, aggregate_id)`, `occurred_at` and `(processed, occurred_at)`. This directly contradicts the four-statements-per-event capacity claim documented alongside it. Separately the filter lists `'MatchApplied'`, which is an *event* type, while `MatchAppliedEvent.AGGREGATE_TYPE` is `\"Match\"` — so match-only projects are never counted.",
  "Maintain the distinct-project count incrementally in `donor_stats` rather than recomputing it, which needs exactly-once semantics from the projection. If any scan remains, add an expression index.",
  ["The distinct-project count is maintained incrementally, not recomputed per event.",
   "The aggregate-type filter is corrected to `'Match'`.",
   "An expression index backs any remaining scan.",
   "A benchmark shows per-event projection cost stays flat as `event_stream` grows to ~1M rows."],
  ["backend/src/eventSourcing/projections.js", "backend/src/db/schema.sql"]),

B("Match deduplication scans the whole event stream on an unindexed JSONB field inside the donation hot path",
  "Every match application runs a filter on `payload->'data'->>'originalTxHash'` with no supporting index, inside the indexer's open transaction.",
  "`ApplyMatchCommandHandler` (`eventSourcing/commandBus.js` ~lines 127-133) queries `event_stream` filtering on `payload->'data'->>'originalTxHash'` and `matchId` on every match application. The only partial expression index in `db/schema.sql` is `ux_donation_tx_hash`, on `transactionHash` for `DonationRecorded`. So this is a sequential scan that runs while the indexer holds a transaction open on the donation path.",
  "Add a partial unique index on `(originalTxHash, matchId) WHERE event_type = 'MatchApplied'` and let the constraint enforce idempotency via `ON CONFLICT`, rather than pre-reading. Creating it on a live append-only table needs `CONCURRENTLY` and a duplicate check first.",
  ["A partial unique index covers the dedup predicate.",
   "Deduplication relies on the constraint rather than a pre-read SELECT.",
   "An `EXPLAIN` in a test or doc shows an index scan.",
   "Pre-existing duplicates are detected and reported before the index is created."],
  ["backend/src/eventSourcing/commandBus.js", "backend/src/db/schema.sql"]),

B("Hot query columns on donations, project_updates, project_follows and donation_matches have no indexes",
  "schema.sql creates indexes only for `admin_audit_log`, `event_stream` and `ai_summary_job_failures`; every other frequently-filtered column is unindexed.",
  "Missing coverage found by matching queries to `db/schema.sql`: `donations(project_id, created_at DESC)` for the cursor pagination and message wall in `routes/donations.js`; `donations(donor_address)` for `routes/donations.js`, `routes/impact.js` and `routes/leaderboard.js`; `project_updates(project_id)` for `routes/updates.js`; `project_follows(device_token_id)` for `routes/notifications.js` and `services/push.js`; `donation_matches(project_id, expires_at)` for `services/indexerService.js` and `routes/projects.js`; `project_ratings(project_id)` for `routes/projects.js`.",
  "Add each index shaped to the real filter and sort (the donations cursor needs a composite matching its `ORDER BY created_at DESC`), created `CONCURRENTLY`, and tie it into whatever migration mechanism exists.",
  ["Each listed query is covered by an index verified with `EXPLAIN (ANALYZE)`.",
   "Composite index ordering matches the query's `ORDER BY`.",
   "Indexes are created without long write locks on a populated database.",
   "A check flags new queries filtering on unindexed columns."],
  ["backend/src/db/schema.sql", "backend/src/routes/donations.js", "backend/src/routes/leaderboard.js"]),

B("getNextVersion plus a raw INSERT is a lost-update race against the stream-version unique constraint",
  "Version numbers are chosen with an unlocked `SELECT MAX(version)+1` and inserted with no `ON CONFLICT`, so two concurrent events on the same stream pick the same version and the loser aborts the surrounding transaction.",
  "`eventSourcing/commandBus.js` (~lines 351-357) computes the next version with `SELECT MAX(version)+1` and no lock; every handler then does a plain `INSERT INTO event_stream` with no conflict clause. Two concurrent `MatchApplied` events for the same `Match:<matchId>` stream compute the same version and the loser hits `23505`. Inside the indexer that aborts the whole transaction and the donation is lost, with only a `console.error` to show for it.",
  "Give append an expected-version parameter and surface a typed concurrency error, with bounded retry against freshly-loaded aggregate state. The retry must be safe with respect to side effects already written by `storeProjectAggregate`/`storeDonorAggregate`.",
  ["Append takes an expected version and raises a typed `ConcurrencyError`.",
   "Callers retry a bounded number of times with refreshed aggregate state.",
   "A concurrency test shows N parallel appends to one stream all succeed with contiguous versions.",
   "Version conflicts are counted in metrics rather than only logged."],
  ["backend/src/eventSourcing/commandBus.js", "backend/src/eventSourcing/eventStore.js"]),

B("DomainEvent.getStreamId double-prefixes the aggregate type, so every aggregate-stream read returns empty",
  "Events are constructed with an already-prefixed `aggregateId`, and `getStreamId()` prefixes it again — while both readers rebuild the id single-prefixed, so they never match a stored row.",
  "`eventSourcing/events.js` (~line 24) returns `` `${this.aggregateType}:${this.aggregateId}` ``, but callers already pass a prefixed id — `commandBus.js` passes `aggregateId: \"Donation:<txHash>\"` — so `stream_id` is stored as `\"Donation:Donation:<txHash>\"`. Both `eventStore.getStream` and `commandBus.loadAggregateStream` compute `` `${aggregateType}:${aggregateId}` ``, single-prefixed. Every aggregate-stream read therefore returns an empty array, which silently reads as \"new aggregate\" rather than an error.",
  "Let one helper own stream-id construction and store `aggregateId` unprefixed. `stream_id` participates in the unique constraint, so normalising existing rows is a data migration.",
  ["One helper constructs stream ids; `aggregateId` is stored unprefixed.",
   "A round-trip test proves `getStream`/`loadAggregateStream` return a stream's events.",
   "A migration rewrites existing `stream_id` values without violating the unique constraint.",
   "Replaying an aggregate reproduces its read-model state."],
  ["backend/src/eventSourcing/events.js", "backend/src/eventSourcing/eventStore.js", "backend/src/eventSourcing/commandBus.js"]),

B("Six mutating project endpoints have no authentication and record an attacker-supplied audit actor",
  "Only the status route is protected. Campaign creation, milestone creation, milestone completion, match offers and both on-chain admin routes are unauthenticated, and each logs `req.body.adminAddress` as the auditor.",
  "In `routes/projects.js` only `PATCH /:id/status` uses `adminRequired`. `POST /:id/campaigns`, `POST /:id/milestones`, `POST /:id/milestones/:milestoneId/reach`, `POST /:id/matching`, `POST /admin/register` and `POST /admin/confirm` have no auth, and each calls `logAdminAction({ actor: req.body?.adminAddress || \"unknown\" })` — so the audit trail is whatever the caller typed. `/admin/confirm` hardcodes `actor: \"admin\"` and flips both `verified` and `on_chain_verified` for any `projectId` whose supplied `transactionHash` merely resolves to a successful transaction; it never checks that the transaction actually registered *that* project.",
  "These routes serve two different principals (platform admin vs project owner), so this needs a real authorization model, plus verification that the referenced Soroban transaction really registered the given project id.",
  ["Every mutating project route requires an authenticated principal.",
   "The audit actor always comes from the verified token, never the request body.",
   "`/admin/confirm` verifies the transaction's contract, function and project id before setting verification flags.",
   "Owner-scoped actions authorize against `projects.wallet_address`.",
   "Tests assert 401/403 for unauthenticated and wrong-owner callers."],
  ["backend/src/routes/projects.js", "backend/src/middleware/auth.js"], security=True),

B("The Turrets server exposes an unauthenticated endpoint that accepts a Stellar secret key in the request body",
  "`POST /admin/presign` takes `matcherSecret` as JSON, builds a keypair from it and returns signed XDRs. The server has no auth middleware, enables wide-open CORS, and echoes error messages back to the caller.",
  "`services/turrets.js` (~lines 327-356) defines `POST /admin/presign`, reads `matcherSecret` from the request body, passes it to `Keypair.fromSecret` and returns signed transaction envelopes. `startTurretsServer` (~line 303) registers no authentication and calls `cors()` with no options; the handler returns `error.message` to the caller, which for `fromSecret` failures can leak key-format detail. It runs whenever `ENABLE_TURRETS === \"true\"`.",
  "Secrets must not travel in an HTTP body — this needs a signing-service or pre-signed-envelope design rather than middleware bolted on top. Restrict CORS on the Turrets port and make error responses generic.",
  ["`/admin/presign` requires authentication and never accepts a secret key over HTTP.",
   "Signing material comes from a secret manager or an external signer.",
   "CORS on the Turrets port is restricted and error responses are generic.",
   "A test asserts a request carrying `matcherSecret` is rejected."],
  ["backend/src/services/turrets.js"], security=True),

B("A poison event pins the batch head forever and turns the scheduler into a maximum-size hot loop",
  "Dispatch failures leave the row unprocessed and it is re-fetched every tick, while the adaptive sizing reads the permanent backlog as \"behind\" and grows the batch to its maximum with a near-zero delay.",
  "`eventSourcing/eventStore.js` `processBatch` (~lines 208-217) catches per-event dispatch errors, increments `failedCount` and leaves `processed = false`. `getUnprocessed` orders by `occurred_at ASC`, so the same failing event heads every subsequent batch indefinitely. Meanwhile `recordBatchOutcome` treats `total >= limit` as behind and doubles `batchSize` toward the configured maximum, and `nextDelayMs` returns the short catch-up delay for saturated batches — so a stuck backlog becomes a maximum-size, near-zero-delay loop against Postgres.",
  "Add a per-event attempt counter with a dead-letter destination after N failures, and make saturation-driven growth back off when `processed === 0` across consecutive batches. The attempt counter needs care on an append-only table.",
  ["Per-event attempt count with a dead-letter destination after N failures.",
   "Batch growth backs off when consecutive batches process nothing.",
   "Failed events are visible to operators with their error message.",
   "Test: one permanently-failing event neither blocks later events nor spins the scheduler."],
  ["backend/src/eventSourcing/eventStore.js"]),

B("push.js uses the pg-boss v9 worker contract against pg-boss v10, so the receipt worker throws on every job",
  "The receipt handler treats its argument as a single job, but v10 always passes an array — and the queue is never created, which v10 requires before send/work do anything.",
  "`services/push.js` (~line 33) registers `boss.work(RECEIPT_QUEUE, ..., async (job) => { await checkPushReceipts(job.data.receipts) })`. `services/summaryQueue.js` documents in its own comments that v10 invokes the callback with an array of jobs, so here `job.data` is `undefined` and `checkPushReceipts(undefined)` throws on `receipts.map`. `push.js` also never calls `boss.createQueue(RECEIPT_QUEUE)`, which v10 requires — `summaryQueue.js` does call it. Both bugs sit behind a 900-second delay, so a normal test run never reaches them.",
  "Call `createQueue` in `start()` before `work()`/`send()`, iterate the job array the way `handleSummaryJob` does, and drive the registered handler directly in a test with a v10-shaped payload.",
  ["`createQueue(RECEIPT_QUEUE)` is called before `work()`/`send()`.",
   "The worker iterates the job array like the summary queue's handler.",
   "A test invokes the registered handler with a v10-shaped `[{ data }]` payload.",
   "Handler errors are logged with ticket ids rather than lost."],
  ["backend/src/services/push.js", "backend/src/services/summaryQueue.js"]),

B("Leaderboard ranks restart at 1 on every page, and the query aggregates every profile before paginating",
  "Rank is computed from the array index while the offset is applied in SQL, so page 2 repeats ranks 1..N. The query also joins all donations onto all profiles and sorts everything before applying LIMIT/OFFSET, with no supporting index and no total.",
  "`routes/leaderboard.js` computes `rank: i + 1` from the map index while `offset` is applied in the SQL. The query `LEFT JOIN`s all of `donations` onto all of `profiles`, groups by every profile and sorts the whole result before `LIMIT/OFFSET`, with no index on `donations.donor_address`. No `total` is returned, so clients cannot tell when to stop, and `offset` is unbounded (`parseInt(...) || 0`) — unlike the admin audit route, which caps it through a Zod schema.",
  "Use a window function for absolute ranking with deterministic tie-breaking, and read from `donor_stats` or a materialized view instead of aggregating raw donations per request. Validate and bound `offset` with a schema.",
  ["`rank` reflects absolute position across pages.",
   "Tie-breaking is deterministic so paging cannot repeat or skip donors.",
   "The query reads a maintained aggregate rather than joining all donations per request.",
   "`offset` is validated and bounded, and a `total` is returned."],
  ["backend/src/routes/leaderboard.js", "backend/src/schemas"]),

B("Unbounded in-process cache keyed on raw request URLs, plus unbounded notification fan-out",
  "The response cache is a bare Map with no size limit, no TTL sweep and keys taken from `req.originalUrl`, so distinct query strings grow the heap indefinitely. Update notifications separately load every subscriber and every device token into memory on a fire-and-forget promise.",
  "`services/cache.js` is a plain `Map` with no maximum size and no sweeper — entries are only deleted when read. `routes/impact.js` keys it on `req.originalUrl`, so any junk query string inserts a permanent entry, which an attacker can use to grow the heap. Separately `routes/updates.js` selects *all* rows from `project_subscriptions` for a project and hands the whole array to `sendUpdateNotifications`, and `services/push.js` selects every follower token for a project — both unbounded fan-outs on a promise whose rejection is only `console.error`d.",
  "Bound the cache with an LRU plus TTL sweep and key it on validated route params rather than raw URLs. Move the fan-outs to chunked background jobs on the existing pg-boss queue so they are retryable and observable.",
  ["The cache has a maximum entry count with LRU/TTL eviction and a periodic sweep.",
   "Cache keys are built from validated route params, not `req.originalUrl`.",
   "Subscriber and follower fan-out is chunked and runs through the job queue.",
   "Failed notification batches are retried and observable rather than swallowed."],
  ["backend/src/services/cache.js", "backend/src/routes/impact.js", "backend/src/routes/updates.js", "backend/src/services/push.js"], security=True),

B("ChangeProjectStatus reports the new status as previousStatus because the aggregate is mutated first",
  "The handler applies the event to the aggregate and only afterwards reads `project.state.status` for the `previousStatus` field, so both fields carry the new value.",
  "`eventSourcing/commandBus.js` (~line 194) calls `project.apply(statusChangeEvent)`, which overwrites `state.status`, and then at ~line 203 returns `{ previousStatus: project.state.status, newStatus: command.payload.status }`. Both therefore report the new status. Anything consuming that return value for audit or notification purposes records a status transition that appears to go from the new value to itself.",
  "Capture the previous status before applying the event, and cover it with a handler test asserting the returned transition.",
  ["`previousStatus` is captured before the event is applied.",
   "A handler test asserts the returned transition is `old -> new`.",
   "Any consumer relying on this value (audit log, notifications) is checked for the same mistake."],
  ["backend/src/eventSourcing/commandBus.js"]),


# ═══════════════════════════ CONTRACTS (13) ═══════════════════════════

B("release_partial transfers tokens before updating state, reintroducing the reentrancy pattern release_escrow was hardened against",
  "The milestone partial-release function does the token transfer first and decrements `remaining_amount` afterwards — the exact Checks-Effects-Interactions violation that was fixed in `release_escrow` directly above it, which still carries the comment explaining why.",
  "`contracts/escrow-contract/src/lib.rs` `release_escrow` (~line 157) sets `job.remaining_amount = 0`, marks the job Released and writes storage *before* calling `token_client.transfer`, with an explicit comment: \"Effects: all state writes BEFORE the external token transfer (Checks-Effects-Interactions to defend against reentrancy from a malicious token contract passed via `token` in `create_job`)\". `release_partial` (~line 187), added later for milestone payments, does the opposite: `token_client.transfer(...)` runs at ~line 209 and only then does it execute `job.remaining_amount -= amount` and write storage. A token contract that re-enters during `transfer` sees the *undecremented* `remaining_amount` and can release more than the job holds.",
  "Reorder so `remaining_amount` and any status change are written to storage before the transfer, matching `release_escrow`. Add a regression test with a malicious token stub that attempts re-entry during `transfer`, so this class of regression cannot silently return a third time.",
  ["`release_partial` writes state before calling `token_client.transfer`.",
   "A test with a re-entering token stub proves the remaining balance cannot be over-released.",
   "The CEI comment is carried onto `release_partial` so the ordering requirement is visible at the site.",
   "All existing escrow tests continue to pass."],
  ["contracts/escrow-contract/src/lib.rs"], area="Contracts", security=True),

B("escrow-contract keeps every job in instance storage, the unbounded-growth pattern greenpay-contract was already migrated off",
  "All eight storage calls in escrow-contract use `instance()`, including the per-job and per-token maps. greenpay-contract moved its unbounded records to persistent storage with per-key TTLs; escrow was left behind.",
  "Grepping `contracts/escrow-contract/src/lib.rs` finds 8 uses of `env.storage().instance()` and zero uses of `.persistent()`. Those include `DataKey::Job(String)` — one entry per job, forever — and `DataKey::AllowedToken(Address)`. greenpay-contract now routes the equivalent records through `read_persistent`/`write_persistent`/`has_persistent` helpers with explicit TTL extension. Instance storage is documented for small contract-wide configuration: it carries a single combined footprint whose rent is bumped on *every* invocation, and it has a hard entry-size ceiling that a growing job table will eventually hit.",
  "Mirror greenpay-contract's persistent-storage helpers for `Job` (and decide whether the token allowlist belongs in instance or persistent storage), including per-key TTL extension on read and write. Existing deployments need a migration path, which ties into the upgrade entrypoint that now exists.",
  ["Per-job records live in persistent storage with explicit TTL extension on read and write.",
   "A documented, tested migration moves any existing instance-storage jobs.",
   "A test registering many jobs shows contract calls stay within size limits and do not degrade.",
   "The storage-type choice is documented so new `DataKey` variants land in the right place."],
  ["contracts/escrow-contract/src/lib.rs", "contracts/greenpay-contract/src/lib.rs"], area="Contracts"),

B("None of the three contracts can rotate their admin — a lost or compromised admin key is unrecoverable",
  "`DataKey::Admin` (and the DAO's `dao_admin`) is written once during `initialize` and there is no transfer, rotation or recovery entrypoint anywhere in the workspace.",
  "Grepping all three contracts for `set_admin`, `transfer_admin` or any rotation function returns nothing. In `contracts/greenpay-contract/src/lib.rs` the admin is set at `initialize` (~line 292) and thereafter only read. That single key gates `allow_token`, `remove_token`, `register_project`, `deactivate_project`, `set_dao_contract`, `create_proposal` and `upgrade`. escrow-contract's admin additionally gates `resolve_dispute` — the only path out of a disputed job. dao-governance-contract's `dao_admin` lives inside `Config`, which is written only at `initialize` and has no setter either. If any of those keys is lost, the contract is permanently frozen in its current configuration; if one is stolen, there is no way to revoke it short of a WASM upgrade signed by that same stolen key.",
  "Add an authenticated admin-transfer entrypoint to each contract, ideally two-step (propose then accept) so a typo cannot brick the contract. Consider whether the DAO should be able to rotate `dao_admin` through `execute_proposal` rather than relying on the key itself.",
  ["Each contract exposes a two-step admin transfer (propose, then accept by the new admin).",
   "The DAO's `dao_admin` is rotatable, and the path is documented.",
   "Tests cover: successful rotation, rejection of an unauthorized proposer, and that a pending transfer can be cancelled.",
   "An event is emitted on both proposal and acceptance so rotations are auditable on-chain."],
  ["contracts/greenpay-contract/src/lib.rs", "contracts/escrow-contract/src/lib.rs", "contracts/dao-governance-contract/src/lib.rs"], area="Contracts", security=True),

B("upgrade() swaps contract WASM instantly on a single admin signature, with no timelock, multisig or announcement window",
  "All three contracts now have an upgrade entrypoint gated only on an admin equality check, so one key can replace the code holding user funds with no delay and no on-chain notice period.",
  "`contracts/greenpay-contract/src/lib.rs` (~line 878), `contracts/escrow-contract/src/lib.rs` (~line 395) and `contracts/dao-governance-contract/src/lib.rs` (~line 597) each implement `upgrade(env, admin/caller, new_wasm_hash)` as `require_auth` plus an equality check against the stored admin, then call `env.deployer().update_current_contract_wasm(...)` immediately. The mechanism itself was the right thing to add, but its governance was not specified: there is no timelock between announcing and applying a hash, no multi-signature requirement, and no way for donors or freelancers with funds in escrow to observe a pending change and exit first. dao-governance-contract's own doc comment even suggests routing upgrades through `execute_proposal`, but nothing enforces that.",
  "Introduce a two-phase upgrade: `propose_upgrade(hash)` emits an event and records an `executable_from_ledger`, and `apply_upgrade()` refuses before that ledger. For greenpay and escrow, consider making the DAO's `execute_proposal` the only permitted caller so upgrades inherit the existing quorum and timelock.",
  ["Upgrades are two-phase, with a minimum ledger delay enforced on-chain between proposal and application.",
   "A pending upgrade is observable via an event and a public getter.",
   "Tests cover: applying before the delay panics, applying after succeeds, and a pending upgrade can be cancelled.",
   "A documented decision records whether the DAO or a multisig is the eventual upgrade authority."],
  ["contracts/greenpay-contract/src/lib.rs", "contracts/escrow-contract/src/lib.rs", "contracts/dao-governance-contract/src/lib.rs"], area="Contracts", security=True),

B("execute_proposal checks the target allowlist at execution time, letting the DAO admin unilaterally veto a passed proposal",
  "The allowlist is consulted only in `execute_proposal`, after voting and the timelock. The admin who controls `remove_allowed_target` can therefore cancel any decision the DAO has already approved, and proposals can be voted on for targets that were never permitted.",
  "`contracts/dao-governance-contract/src/lib.rs` `create_proposal` (~line 344) stores `target_contract`, `function` and `calldata` with no allowlist check. The check happens in `execute_proposal` (~line 576): `if !env.storage().persistent().has(&allow_key) { panic!(\"target/function not allowlisted\") }`. Two consequences follow. First, the DAO can spend a full discussion, snapshot, voting and timelock cycle on a proposal that was never executable. Second, `remove_allowed_target` (~line 315) is gated only on `config.dao_admin`, so that single key can remove an entry after a proposal passes and permanently block it — a unilateral veto over the governance process the allowlist was introduced to constrain.",
  "Validate the target against the allowlist at proposal-creation time so unexecutable proposals cannot be raised, and decide the intended semantics of a mid-flight allowlist change: either snapshot the allowlist decision with the proposal, or require allowlist changes to themselves go through `execute_proposal`.",
  ["`create_proposal` rejects a target/function pair that is not allowlisted.",
   "Mid-flight allowlist changes have documented, tested semantics for already-passed proposals.",
   "Allowlist mutation is either DAO-governed or explicitly documented as an admin escape hatch with its risk stated.",
   "Tests cover: creating a non-allowlisted proposal fails, and removing a target after a proposal passes behaves as documented."],
  ["contracts/dao-governance-contract/src/lib.rs"], area="Contracts", security=True),

B("DAO Config is immutable after initialize — quorum, voting period and timelock can never be tuned",
  "`DataKey::Config` is written exactly once, in `initialize`, and there is no setter, so every governance parameter is fixed for the contract's lifetime.",
  "`contracts/dao-governance-contract/src/lib.rs` writes `DataKey::Config` at ~line 120 inside `initialize` and nowhere else; grepping for `set_config`, `update_config` or `set_quorum` returns nothing. That freezes `gp_token`, `quorum`, `voting_period_ledgers`, `timelock_ledgers` and `dao_admin`. A DAO that picks a quorum before it knows its real participation rate cannot correct it, and a voting period that proves too short or too long cannot be adjusted — the only remedy is a full WASM upgrade, which only `dao_admin` can perform.",
  "Add a governance-parameter update path that is itself DAO-governed (a proposal targeting the DAO's own `set_config`), with bounds so a proposal cannot set a nonsensical quorum or a zero timelock.",
  ["Governance parameters are updatable through a DAO-approved path rather than only a WASM upgrade.",
   "Updates are bounds-checked (non-zero timelock, quorum within a sane range).",
   "A parameter change emits an event and is covered by tests.",
   "A test proves an out-of-bounds parameter change is rejected."],
  ["contracts/dao-governance-contract/src/lib.rs"], area="Contracts"),

B("Quorum is an absolute vote total rather than a proportion of locked supply, so it drifts out of calibration as the DAO grows",
  "`finalise_vote` compares `votes_for + votes_against` against a fixed `config.quorum`, so the same threshold becomes trivial to reach as more tokens are locked and impossible if participation falls.",
  "`contracts/dao-governance-contract/src/lib.rs` `finalise_vote` (~line 535) computes `total_votes = votes_for + votes_against` and approves when `total_votes >= config.quorum && votes_for > votes_against`. `config.quorum` is an absolute i128 fixed at `initialize`, and voting power is time-decayed lock weight (`get_voting_power`), so the denominator it should be measured against moves constantly. Combined with the immutable `Config`, a quorum chosen early can never be recalibrated — the DAO either rubber-stamps everything or deadlocks, with no on-chain remedy.",
  "Track total outstanding voting power (or total locked amount) and express quorum as a proportion of it, snapshotted alongside the proposal so a mid-vote change in locked supply cannot move the goalposts.",
  ["Quorum is evaluated as a proportion of voting power outstanding at the proposal's snapshot.",
   "Total outstanding voting power is maintained incrementally rather than recomputed by iterating lockers.",
   "Tests cover quorum behaviour as locked supply grows and shrinks.",
   "The migration from an absolute to a proportional quorum is documented for any live deployment."],
  ["contracts/dao-governance-contract/src/lib.rs"], area="Contracts"),

B("resolve_stale_dispute marks a half-and-half split as Refunded, so on-chain status misreports what happened to the money",
  "The timeout fallback pays half to the freelancer and half to the client, then records `JobStatus::Refunded` — the same status used when the client gets everything back.",
  "`contracts/escrow-contract/src/lib.rs` `resolve_stale_dispute` (~line 303) computes `freelancer_share = remaining / 2`, gives the remainder to the client, and then sets `job.status = JobStatus::Refunded`. `JobStatus` has only `Escrowed`, `Released`, `Disputed` and `Refunded`, so a split settlement is indistinguishable from a full client refund by any consumer reading `get_job`. Anything that reports earnings, reconciles balances or builds freelancer history from contract state will attribute nothing to the freelancer even though they were paid.",
  "Add a distinct status for a timed-out split settlement (or record the settled amounts on the `Job`), and check every consumer that branches on `JobStatus` for the new variant. Adding an enum variant changes the stored type, so this needs the storage-migration story that the upgrade entrypoint now makes possible.",
  ["A split settlement is distinguishable from a full refund in contract state.",
   "Every consumer branching on `JobStatus` handles the new case.",
   "A storage-compatible migration path is documented and tested.",
   "The emitted event and the stored status agree on what happened."],
  ["contracts/escrow-contract/src/lib.rs"], area="Contracts"),

B("No contract has a pause or emergency-stop, so the only response to a live exploit is a full WASM upgrade",
  "There is no circuit breaker anywhere in the workspace: if a vulnerability is found in `donate` or the escrow flow, funds keep moving until a replacement WASM is written, reviewed and deployed.",
  "Grepping all three contracts for `paused`, `emergency` or `circuit` returns nothing. `donate` (`contracts/greenpay-contract/src/lib.rs` ~line 402), `create_job` and `release_partial` all execute unconditionally. The upgrade entrypoints added recently give a recovery path, but it is slow: an operator must author and verify new WASM under time pressure while the exploit continues. A pause flag checked by the fund-moving entrypoints would stop the bleeding in one transaction.",
  "Add an admin- (or DAO-) settable pause flag checked at the top of every fund-moving entrypoint, deliberately leaving withdrawal/refund paths callable so a pause cannot itself trap user funds. Document precisely which functions a pause blocks.",
  ["A pause flag is checked by every entrypoint that moves funds.",
   "Withdrawal and refund paths remain callable while paused, so users are never trapped.",
   "Pausing and unpausing emit events and are covered by tests.",
   "The set of paused functions is documented alongside the incident-response runbooks."],
  ["contracts/greenpay-contract/src/lib.rs", "contracts/escrow-contract/src/lib.rs", "contracts/dao-governance-contract/src/lib.rs"], area="Contracts", security=True),

B("Removing a token from the allowlist has no defined effect on jobs and donations already denominated in it",
  "`remove_token` deletes the allowlist entry, but nothing specifies what happens to escrowed jobs or in-flight flows using that token — the behaviour is whatever the code happens to do, and it is untested.",
  "`contracts/greenpay-contract/src/lib.rs` `remove_token` (~line 320) and `contracts/escrow-contract/src/lib.rs` `remove_token` (~line 92) both simply remove `DataKey::AllowedToken(token)`. `create_job` and `donate` check the allowlist on entry, but `release_escrow`, `release_partial`, `resolve_dispute`, `resolve_stale_dispute` and `cancel_job` do not re-check it. So today an escrowed job in a de-listed token can still be released — probably the desired behaviour, but nowhere stated or tested. If a future change adds a consistency re-check to those paths, every job in a de-listed token would become permanently unwithdrawable.",
  "Write down the intended policy (existing obligations always settle; the allowlist only gates new inflows), assert it with tests, and add a comment at each settlement path explaining why it deliberately does not re-check.",
  ["The policy for de-listed tokens is documented in the contract and in the deployment docs.",
   "Tests prove an escrowed job in a de-listed token can still be released, refunded and disputed.",
   "Tests prove a de-listed token cannot be used for a new job or donation.",
   "Settlement paths carry a comment explaining the deliberate absence of an allowlist re-check."],
  ["contracts/greenpay-contract/src/lib.rs", "contracts/escrow-contract/src/lib.rs"], area="Contracts"),

B("Legacy badge-holder governance still runs alongside the DAO path, giving project verification two live and unequal routes",
  "`create_proposal`, `vote_verify_project` and `resolve_proposal` are labelled deprecated but remain callable, so a project can be verified either by a DAO vote or by the older admin-created, one-address-one-vote scheme.",
  "`contracts/greenpay-contract/src/lib.rs` marks the block at ~line 733 \"Legacy Governance (deprecated — superseded by DAO integration)\" and says the functions remain for deployments that have not yet registered a DAO. But nothing gates them: `create_proposal` (~line 748), `vote_verify_project` (~line 797) and `resolve_proposal` (~line 847) work exactly as before even once `set_dao_contract` has been called. The two routes have very different security properties — the DAO path is lock-weighted with a timelock and an allowlist, the legacy path is admin-initiated and Sybil-attackable — so leaving both live means the weaker one defines the contract's real security.",
  "Gate the legacy path on the absence of a registered DAO contract, so registering a DAO atomically retires it, and plan its removal in a later upgrade. Existing in-flight legacy proposals need a documented resolution path.",
  ["The legacy voting path panics (or is inert) once a DAO contract is registered.",
   "In-flight legacy proposals have a documented resolution path across the cutover.",
   "Tests cover both configurations: no DAO registered (legacy works) and DAO registered (legacy refuses).",
   "A deprecation timeline for removing the legacy functions is recorded."],
  ["contracts/greenpay-contract/src/lib.rs"], area="Contracts", security=True),

B("Badge thresholds are hard-coded independently in the contract and the backend, with nothing detecting drift",
  "The tier boundaries that decide a donor's badge exist in both the Soroban contract and the Node backend as separate literals, so a change to one silently disagrees with the other.",
  "`contracts/greenpay-contract/src/lib.rs` computes badge tiers from constants inside the contract, while `backend/src/services/store.js` defines its own `BADGE_THRESHOLDS` array and `backend/src/eventSourcing/projections.js` has a second `computeBadges` with the same literals inline. Three copies, no shared source and no cross-check. A donor's badge is therefore whichever copy answered — the contract for `get_badge`, the projection for `donor_stats.badges`, the backend helper for anything reading `store.js` — and a threshold change to one leaves the others silently wrong, including the on-chain NFT minting path that gates on the contract's view.",
  "Pick one authoritative definition and derive the others, or add a cross-validation test that reads the contract's constants and asserts the backend copies match. The contract cannot import JavaScript, so a generated constants file or a test that parses both is the practical route.",
  ["A single source of truth for badge thresholds, or an automated cross-check between the copies.",
   "The duplicate `computeBadges` implementations in the backend are consolidated.",
   "A test fails if the contract's thresholds and the backend's disagree.",
   "The chosen mechanism is documented so future tier changes cannot drift."],
  ["contracts/greenpay-contract/src/lib.rs", "backend/src/services/store.js", "backend/src/eventSourcing/projections.js"], area="Contracts"),

B("greenpay-contract accepts a msg_hash it only echoes into an event, with no length, format or provenance guarantee",
  "`donate` takes a `msg_hash: u32` that is never validated or used for anything except being republished in the donation event, so it is an unauthenticated free field on a financial record.",
  "`contracts/greenpay-contract/src/lib.rs` `donate` (~line 402) takes `msg_hash: u32` and the only other reference is the event publish at ~line 531. Nothing checks that it corresponds to the donor's message, nothing prevents collisions, and a `u32` is far too narrow to be a meaningful commitment to message content — the frontend computes it with a djb2 hash (`frontend/lib/stellar.ts` `hashMessage`), which is not collision-resistant. Anyone reading the event stream to associate on-chain donations with off-chain messages is trusting a field with no integrity property at all.",
  "Decide what the field is for. If it is a commitment to the donor's message, it needs a real cryptographic digest (and a wider type) plus a documented verification procedure; if it is only a client-side correlation id, rename it and document that it carries no integrity guarantee.",
  ["The field's purpose is documented, and its name reflects whether it is a commitment or a correlation id.",
   "If it is a commitment, it uses a collision-resistant digest and a verification procedure is documented.",
   "The frontend and contract agree on how the value is derived, covered by a test.",
   "Consumers reading the event stream are told what they can and cannot infer from it."],
  ["contracts/greenpay-contract/src/lib.rs", "frontend/lib/stellar.ts"], area="Contracts"),


# ═══════════════════════════ INFRA (8) ═══════════════════════════

B("The Trivy severity gate is a no-op — its jq expression always evaluates to 0, so images publish however many CRITICALs they carry",
  "Trivy runs with `--exit-code 0` and the enforcement step counts findings with a jq stream addition that yields nothing when one side is an empty stream, so the count is always 0 and the gate is permanently green.",
  "`.github/workflows/ci.yml` (~lines 353-376) runs Trivy with `--exit-code 0`, then a separate step computes `jq '[.Results[]?.Misconfigurations[]? + .Results[]?.Vulnerabilities[]? | select(...)] | length'`. In jq, `A + B` where `A` is an *empty* stream produces no output at all — image scans emit no `Misconfigurations` key — so the array is `[]` and the count is 0 regardless of what Trivy found. A `|| echo 0` fallback and a `| tee` pipe (which masks Trivy's own exit status) hide it further. `greenpay-backend`, `greenpay-frontend` and `greenpay-scheduler` are pushed to GHCR with the gate reporting clean.",
  "Count from each key independently with proper null handling, use `set -o pipefail` (or write Trivy's output to a file) so its exit status is not masked, and prove the gate with a fixture.",
  ["A deliberately vulnerable image (or fixture JSON) fails the job; a clean image passes.",
   "The count handles absent `Vulnerabilities`/`Misconfigurations`/`Secrets` keys without swallowing findings.",
   "Entries suppressed via `.trivyignore` are still excluded, proven by a test case.",
   "The scanned image digest is the same artifact that gets pushed — no second, unscanned build."],
  [".github/workflows/ci.yml"], area="Infra", security=True),

B("scheduler/Dockerfile runs go mod tidy at build time, discarding the go.sum that CI verified",
  "`go mod tidy` re-resolves and rewrites the module graph inside the image, so the dependency set compiled into the shipped binary is whatever the proxy served — not what the lockfile job validated.",
  "`scheduler/Dockerfile` runs `RUN go mod tidy` after `COPY . .`. That rewrites `go.mod`/`go.sum` in the build context, defeating the verification `.github/workflows/lockfile-verify.yml` performs with `go mod verify` for the Scheduler matrix entry. Copying all source before any dependency layer also means every `.go` edit invalidates the module cache. Separately the runtime `USER` uid is inconsistent: `distroless:nonroot` is 65532 while `k8s/scheduler/deployment.yaml` pins `runAsUser: 65534` and the Dockerfile comment claims 65534.",
  "Split into `COPY go.mod go.sum` → `go mod download` → `COPY .` layers, drop `tidy`, and build with `-mod=readonly` so an incomplete module file fails loudly instead of being silently repaired.",
  ["`go mod tidy` is removed and the build fails if `go.mod`/`go.sum` are incomplete.",
   "Dependency download is a separate cached layer; a source edit does not re-download modules.",
   "CI asserts `git diff --exit-code go.mod go.sum` after a container build.",
   "The runtime uid is consistent between the Dockerfile, its comment and the Deployment's `runAsUser`."],
  ["scheduler/Dockerfile", ".github/workflows/lockfile-verify.yml", "k8s/scheduler/deployment.yaml"], area="Infra", security=True),

B("k8s/kustomization.yaml never references pdb.yaml or ingress.yaml, and no CI job validates the raw manifests",
  "The newly added PodDisruptionBudgets are dead files — `kubectl apply -k k8s/` will never create them — and nothing runs `kustomize build`, so the omission is invisible.",
  "`k8s/kustomization.yaml` lists namespace, configmap, secret, postgres, backend, frontend, the `ml-workloads/*` files and `network-policy.yaml`, but not `k8s/pdb.yaml` or `k8s/ingress.yaml`. Its trailing `components:` key has only comments beneath it and no items. Meanwhile `ci.yml`'s Helm job lints and renders the chart thoroughly, but nothing ever runs `kubectl kustomize k8s/` or a schema validator, so the four PDBs a contributor wrote are never applied by the kustomize path.",
  "Reconcile the two parallel deployment paths (kustomize `k8s/` including ml-workloads and scheduler vs. the Helm chart), decide which is authoritative, and add `kustomize build | kubeconform -strict` to CI — including a check that each PDB selector matches a real workload's pod labels.",
  ["`kustomize build k8s/` output contains all four PDBs; every file in `k8s/` is referenced or documented as intentionally excluded.",
   "A CI job builds and schema-validates `k8s/` and `k8s/scheduler/`.",
   "The empty `components:` key is removed or populated.",
   "A test asserts each PDB selector matches at least one workload in the built output."],
  ["k8s/kustomization.yaml", "k8s/pdb.yaml", ".github/workflows/ci.yml"], area="Infra"),

B("network-policy.yaml default-denies all ingress with no allow rule for backend or frontend, so applying it blackholes the app",
  "A namespace-wide default-deny is paired with a single allow policy for Postgres. Nothing permits the ingress controller to reach the frontend or backend, and the file is in kustomization.yaml — so the outage ships with the manifests.",
  "`k8s/network-policy.yaml` creates `default-deny-ingress` with `podSelector: {}` across the `greenpay` namespace, then only `allow-postgres` (backend + summary-worker → 5432). There is no policy allowing the ingress controller (which lives in another namespace) to reach `app: backend` or `app: frontend`, and none for frontend → backend. There are also no `Egress` rules at all, so pods may egress anywhere — including exfiltration to arbitrary hosts.",
  "Add allow policies keyed on the labels the manifests actually use, with the right `namespaceSelector` for the ingress controller in use. If egress restriction is adopted, the DNS-to-kube-system rule is the one that always breaks first and must be included.",
  ["Allow policies exist for ingress→frontend, ingress→backend and frontend→backend, matching real labels.",
   "Egress policy is added, or an ADR records why egress is deliberately unrestricted; if added, DNS to kube-system is allowed.",
   "A documented smoke test proves allowed paths succeed and a random namespace is denied.",
   "The Helm chart has equivalent policies, or is documented as not the hardened path."],
  ["k8s/network-policy.yaml", "k8s/kustomization.yaml"], area="Infra", security=True),

B("The scheduler profile sets no plugin weights, is duplicated in two files, and its ConfigMap checksum annotation is an empty string",
  "Comments claim MLWorkloadScore runs at weight 10, but the profile entries carry no `weight:` field so everything defaults to 1. The same config is duplicated inside the Deployment's ConfigMap, and the annotation meant to trigger a rollout on change is literally empty.",
  "`k8s/scheduler/config.yaml` comments state MLWorkloadScore is weight 10 and NodeResourcesFit weight 2, but the `score.enabled` entries are bare `- name:` with no `weight:`, so both default to 1 and the intended dominant signal never exists. The identical config is duplicated inside the ConfigMap in `k8s/scheduler/deployment.yaml`, and the pod template's `checksum/config` annotation is `\"\"` with a comment claiming it is populated by a hash transformer — none is configured, so editing the ConfigMap never restarts the scheduler, which does not hot-reload `--config`.",
  "Make weights explicit (or correct the comments), keep the config in exactly one place generated via `configMapGenerator`, and let the generated name-suffix hash drive the rollout.",
  ["Weights are explicit and match the documented intent, or the comments are corrected.",
   "The scheduler config exists in one place; the ConfigMap is generated from it.",
   "A ConfigMap change produces a new pod template hash and triggers a rollout, verified on rendered output.",
   "`postFilter` wiring for the preemption plugin is included."],
  ["k8s/scheduler/config.yaml", "k8s/scheduler/deployment.yaml"], area="Infra"),

B("Most workflows run with default token permissions and every third-party action floats on a mutable tag",
  "Seven workflows declare no `permissions:` block, so jobs that download and execute third-party code get the repository default token — next to AWS, database and GCS secrets in the backup workflow.",
  "`ci.yml`, `contract-deploy.yml`, `extension.yml`, `database-backup.yml`, `db-restore-drill.yml`, `mobile.yml` and `lockfile-verify.yml` have no top-level `permissions:` (only `container_build_scan`, `release.yml` and `secret-scanning.yml` scope theirs). Meanwhile every third-party action floats: `zaproxy/action-baseline@v0.14.0`, `softprops/action-gh-release@v1`, `aquasec/trivy:latest`, `expo/expo-github-action@v8`, `dtolnay/rust-toolchain@stable`, `google-github-actions/setup-gcloud@v1` — and `actions/checkout` is `@v6` in `secret-scanning.yml` but `@v4` everywhere else. A tag repoint on any of these runs attacker code with a token that can push to GHCR.",
  "Audit each job for least privilege, default to `contents: read` at top level and widen per job only where needed, and pin every non-`actions/*` action to a full commit SHA with a version comment plus Dependabot's `github-actions` ecosystem to keep them current.",
  ["Every workflow declares top-level `permissions:`, defaulting to `contents: read`.",
   "All third-party actions are pinned to commit SHAs; `aquasec/trivy:latest` is pinned to a digest.",
   "`actions/checkout` is consistent across workflows.",
   "Dependabot is configured to bump the pinned SHAs."],
  [".github/workflows"], area="Infra", security=True),

B("secret-scanning.yml pipes a release tarball straight into /usr/local/bin and executes it with no integrity check",
  "The gitleaks binary is curl'd and untarred directly into PATH with no checksum, no signature and no `--fail`, then run — in a workflow that triggers on every push and holds `pull-requests: write`.",
  "`.github/workflows/secret-scanning.yml` (~lines 29-33) does `curl -sSL <release tarball> | tar -xz -C /usr/local/bin gitleaks` and immediately executes it. There is no SHA verification, no signature or attestation check, and `curl` lacks `--fail`, so an HTTP error page or a substituted release asset is unpacked into PATH and run. The comment above correctly explains why the licensed Action wrapper was dropped — but the replacement traded one supply-chain risk for a larger one.",
  "Pin the expected SHA-256, verify before extraction into a temp directory rather than straight into PATH, and use `curl --fail --proto '=https' --tlsv1.2`. Keep the version and digest together so updating is a single edit.",
  ["The archive's SHA-256 is verified against a pinned digest before extraction; a mismatch fails the job.",
   "Extraction targets a temp dir and uses hardened curl flags.",
   "Version and digest live in one place, updatable by a single edit.",
   "A negative test with a tampered digest demonstrably fails the workflow."],
  [".github/workflows/secret-scanning.yml"], area="Infra", security=True),

B("frontend image reinstalls dependencies in the runner and starts via npx, and both Dockerfiles can bake .env files into published layers",
  "The frontend runs `npm ci` twice and launches `npx next start` as PID 1, so SIGTERM reaches the server only indirectly. Both `.dockerignore` files miss `.env` variants that the image `COPY`s in.",
  "`frontend/Dockerfile` runs `npm ci` in the builder and a second `npm ci --only=production` in the runner, then uses `CMD [\"npx\", \"next\", \"start\", ...]` — `frontend/next.config.mjs` sets no `output`, so there is no standalone server and `npx` is PID 1. Separately, `frontend/.dockerignore` ignores only `.env*.local` (not `.env` or `.env.production`) while the builder does `COPY . .`; `backend/.dockerignore` ignores `.env` but not `.env.production`/`.env.*` while `backend/Dockerfile` does `COPY --chown=node:node . .` into the **final** image. A developer- or CI-present env file is therefore baked into a published GHCR layer.",
  "Adopt `output: 'standalone'` and copy build artifacts rather than reinstalling, make the Node server PID 1, and tighten both `.dockerignore` files with a CI assertion that no `.env*` file exists in the built image.",
  ["The runner stage installs no dependencies; artifacts come from the builder.",
   "Both `.dockerignore` files exclude all `.env*` variants, asserted by a CI check against the built image.",
   "PID 1 is the Node server and `docker stop` shuts down gracefully within the grace period.",
   "Image size and cold-build time are recorded before and after in the PR."],
  ["frontend/Dockerfile", "backend/Dockerfile", "frontend/.dockerignore", "backend/.dockerignore"], area="Infra", security=True),

# ═══════════════════════════ SCHEDULER (8) ═══════════════════════════

B("PostFilter nominates a node but never evicts the victims it selected, so the preemptor loops forever",
  "The preemption plugin builds a victim list, confirms enough capacity would be freed, then returns a nominated node and discards the list. No pod is ever evicted, and the RBAC does not permit eviction anyway.",
  "`scheduler/pkg/plugins/preemption.go` (~lines 165-204) assembles `selectedVictims`, verifies freed VRAM/GPUs, then returns `framework.NewPostFilterResultWithNominatedNode(bestNode)` and drops `selectedVictims` entirely. Nothing is deleted, no eviction is issued, and no victim status is recorded. The preemptor is nominated onto a node that is still full, fails the next cycle, re-enters PostFilter and loops — while its nomination reserves resources against other pods. `k8s/scheduler/rbac.yaml` grants `pods: get,list,watch` only, with no `delete` and no `pods/eviction: create`, so eviction could not work even if implemented.",
  "Follow the upstream `prepareCandidate` semantics: delete victims with the right grace period, clear lower-priority nominations on the target, handle delete conflicts and `NotFound`, emit preemption events, and stay idempotent across restarts and leader-election failover.",
  ["Victims are evicted before the node is nominated; failures surface as a failed PostFilter, not a silent nomination.",
   "RBAC grants exactly the verbs the implementation needs and nothing more.",
   "Preemption events are emitted for the preemptor and each victim.",
   "Tests assert victims are gone and the nomination is set; and that no eviction occurs when capacity checks fail."],
  ["scheduler/pkg/plugins/preemption.go", "k8s/scheduler/rbac.yaml"], area="Scheduler", security=True),

B("The filter returns Unschedulable for immutable hardware mismatches, forcing preemption to string-match rejection messages",
  "Vendor, model and no-GPU rejections are conditions preemption can never fix, but they return `Unschedulable`, so the framework treats those nodes as preemption candidates — and the plugin compensates by grepping the human-readable reason text.",
  "`scheduler/pkg/plugins/filter.go` returns `framework.NewStatus(framework.Unschedulable, reason)` for every rejection including vendor (~line 78), model (~line 90) and no-GPU (~line 108). `preemption.go` (~line 133) then calls `isImmutableHardwareMismatch(filterStatus.Message())`, which lowercases the message and greps for `\"vendor\"`, `\"model\"`, `\"zone\"`, `\"bandwidth\"`, `\"no gpu\"` (~lines 207-214). Any wording change to a `fmt.Sprintf` silently breaks preemption correctness. The check also only inspects this plugin's status — the `filteredNodeStatusMap` carrying every other plugin's verdict is never read.",
  "Return `UnschedulableAndUnresolvable` for conditions preemption cannot change, delete the string matching, and have PostFilter derive candidates from `filteredNodeStatusMap` and re-validate with the full filter chain rather than instantiating a bare filter that bypasses taints, affinity and resource fit.",
  ["Vendor/model/zone/no-GPU rejections return `UnschedulableAndUnresolvable`; capacity rejections stay `Unschedulable`.",
   "`isImmutableHardwareMismatch` and its string matching are deleted.",
   "PostFilter uses `filteredNodeStatusMap` and re-validates the target with the full filter chain.",
   "Tests cover a vendor-rejected node (never a candidate) and a capacity-rejected node (a candidate)."],
  ["scheduler/pkg/plugins/filter.go", "scheduler/pkg/plugins/preemption.go"], area="Scheduler"),

B("PDB checks read a stale budget that is never decremented, so one budget of 1 can authorise many victims",
  "Each candidate victim is tested independently against `DisruptionsAllowed`, which is never decremented as victims accumulate — so a PDB permitting one disruption approves three victims from the same Deployment.",
  "`scheduler/pkg/plugins/preemption.go` (~lines 216-232) tests each victim against `pdb.Status.DisruptionsAllowed <= 0`, but the value is never decremented in the accumulation loop (~lines 170-185). The value also comes straight from the informer cache via `pdbLister.List`, which lags the disruption controller by seconds — precisely the window preemption runs in. This directly undermines the `maxUnavailable: 1` budgets in `k8s/pdb.yaml`.",
  "Deep-copy the PDBs per PostFilter invocation and decrement as victims are chosen, precompute pod→PDB selector matching once instead of O(pods × pdbs), and decide policy for pods covered by multiple PDBs and for informer lag.",
  ["Budgets are copied and decremented across the whole victim-selection pass.",
   "Pods matched by multiple PDBs consume all matching budgets.",
   "Selector matching is precomputed once per PostFilter.",
   "Tests cover a budget of 1 with two candidates, a victim with no PDB, and a PDB with an invalid selector."],
  ["scheduler/pkg/plugins/preemption.go", "k8s/pdb.yaml"], area="Scheduler"),

B("GetPodRequestedGPUCount reads a node-label key from pod annotations, and two GPU-resource predicates disagree about TPUs",
  "The GPU count lookup uses a key that only ever appears as a node label, so it is dead for every real pod and always falls back to 1 — an 8-GPU pod's preemption target is computed as one GPU.",
  "`scheduler/pkg/plugins/preemption.go` (~line 68) reads `pod.Annotations[hardware.LabelGPUCount]`, but `LabelGPUCount` is `greenpay.io/gpu-count`, defined in `pkg/hardware/labels.go` as a **node** label; the pod annotation taxonomy has no GPU-count annotation. The branch is unreachable, so it falls back to 1 GPU (~line 77). Separately `plugins.isGPUResource` (`filter.go` ~line 150) matches `google.com/tpu` and bare `gpu`, while `hardware.isGPUResourceName` (`node_info.go` ~line 312) matches only `*/gpu` and `gpu.*` — so `GPUCountReq` is always 0 for TPU pods, silently making the NUMA locality score return its neutral value for exactly the workloads it exists for.",
  "Adopt one exported accelerator predicate shared by both packages, derive counts from container resource requests rather than a label key, and decide whether accelerator classes are summed or kept per-vendor (summing GPUs and TPUs is meaningless).",
  ["One accelerator-resource predicate is shared by `pkg/plugins` and `pkg/hardware`; the duplicate is deleted.",
   "GPU counts come from container resource requests, not a node-label key.",
   "TPU pods produce a non-zero requirement and exercise the NUMA path, covered by a test.",
   "A test asserts an 8-GPU pod requires 8 GPUs of freed capacity during preemption."],
  ["scheduler/pkg/plugins/preemption.go", "scheduler/pkg/plugins/filter.go", "scheduler/pkg/hardware/node_info.go"], area="Scheduler"),

B("The preemption plugin is registered but wired into no profile, and its score plugin's args type can never be decoded",
  "`postFilter` appears in neither the standalone config nor the ConfigMap, so the default preemption plugin runs and the new one is unreachable. The score plugin's args type is not registered in any scheme, so its config assertion always fails.",
  "`scheduler/pkg/register.go` registers `MLWorkloadPreemption`, but neither `k8s/scheduler/config.yaml` nor the inlined ConfigMap in `k8s/scheduler/deployment.yaml` has a `postFilter` section — the default plugin runs instead. Similarly `NewMLWorkloadScore` (`score.go` ~lines 122-126) asserts `obj.(*MLWorkloadScoreArgs)`, but that type is never added to a runtime scheme, so the decoded config arrives as a generic object and the assertion always fails; the profile's `args: {}` can therefore never set `fragThreshold`. `DeepCopyObject` also drops the embedded `TypeMeta`, breaking the round-trip a registered type requires.",
  "Register the args type into the scheduler's config scheme with conversion and defaulting, wire `postFilter` in both config locations, and decide explicitly whether it replaces `DefaultPreemption` — the two will fight over nominations otherwise.",
  ["`postFilter` is wired in both config locations with an explicit, commented decision on `DefaultPreemption`.",
   "The args type is scheme-registered so a non-empty `fragThreshold` reaches the plugin, asserted by a test.",
   "`DeepCopyObject` copies all fields including `TypeMeta`.",
   "A startup check validates the shipped config against the plugin registry so an unwired plugin name fails fast."],
  ["scheduler/pkg/register.go", "scheduler/pkg/plugins/score.go", "k8s/scheduler/config.yaml"], area="Scheduler"),

B("Victim selection counts pods that free nothing, and preempts for pods that need no GPU at all",
  "Every non-PDB-blocked candidate is added as a victim and its freed VRAM/GPU counted — both of which are 0 for ordinary pods. For a preemptor needing neither, the loop's break condition is satisfied after the first victim.",
  "In `scheduler/pkg/plugins/preemption.go` (~lines 170-196) each candidate is appended to `selectedVictims` and `freedVRAM`/`freedGPUs` incremented by helpers that return 0 for non-GPU pods, so a victim freeing nothing still counts toward `minVictimCount`. The break condition `(targetVRAM == 0 || …) && (targetGPUs == 0 || …)` (~line 182) is true after the first victim when the preemptor requests neither — so the plugin kills an arbitrary lower-priority pod for a pod whose real constraint was CPU or memory, which it never measures. `GetPodPriority` (~lines 40-57) also invents priorities from workload-type annotations when `Spec.Priority` is unset, and nothing excludes DaemonSet, mirror, terminating pods, or preemptors with `preemptionPolicy: Never`.",
  "Model freed capacity across every resource dimension against why the node actually failed filtering, respect `PreemptionPolicy`, exclude non-evictable pods, and replace the order-dependent fewest-victims tiebreak with a documented cost function.",
  ["A victim that frees none of the needed resources is never selected.",
   "A preemptor requesting no GPU/VRAM does not trigger preemption on GPU grounds.",
   "Pods with `preemptionPolicy: Never` do not preempt; DaemonSet/mirror/terminating pods are never victims.",
   "Node selection uses a documented cost function, with a test where two nodes tie on count but differ on victim priority."],
  ["scheduler/pkg/plugins/preemption.go"], area="Scheduler"),

B("Score panics the scheduler on a CycleState type mismatch, and the bandwidth state's mutex and Clone are misused",
  "An unchecked type assertion on whatever is stored under a non-namespaced CycleState key can panic inside a parallel Score goroutine and take the process down. The accompanying mutex is taken where it is unnecessary and omitted where a copy is made.",
  "`scheduler/pkg/plugins/score.go` (~line 186) does `bwState := raw.(*clusterBandwidthState)` with no comma-ok. Any other plugin — or a future collision on the plain string key `\"greenpay/bandwidthState\"` (~line 77) — makes this panic in a parallel `Score` goroutine. `Clone()` (~line 73) reads `s.maxGbps` without holding `s.mu` and drops the mutex state, while `PreScore` (~lines 153-157) locks per node on an object no other goroutine can reach yet. The max is also computed over the *filtered candidate subset*, which varies with `percentageOfNodesToScore`, so a node's bandwidth sub-score is not stable across cycles.",
  "Use the comma-ok form and degrade to the neutral path, namespace the key via a typed constant, and make locking consistent — either the state is immutable after PreScore (no mutex) or `Clone` and all readers take it.",
  ["The type assertion is comma-ok and degrades instead of panicking; the state key is a typed constant.",
   "Locking is consistent: either no mutex, or `Clone` and all readers take it.",
   "`go test -race ./...` exercises concurrent `Score` plus a `Clone` and passes.",
   "A test covers `Score` when a foreign value is stored under the bandwidth key."],
  ["scheduler/pkg/plugins/score.go"], area="Scheduler"),

B("fragmentationScore short-circuits to a perfect score for any GPU node missing greenpay.io labels",
  "GPU presence is decided purely from labels, so a real GPU node advertising `nvidia.com/gpu` but not yet labelled returns the maximum fragmentation score — making the extended-resource fallbacks written just below it unreachable for exactly those nodes.",
  "`scheduler/pkg/plugins/score.go` (~line 368) starts with `if !hw.HasGPU() { return 100.0 }`, and `NodeHardware.HasGPU()` (`pkg/hardware/node_info.go` ~lines 75-77) requires both `greenpay.io/gpu-count > 0` and a non-`none` `greenpay.io/gpu-vendor` label. An unlabelled GPU node therefore scores 100 unconditionally, and the extended-resource fallback code at ~lines 383-397 never runs. `binPackingScore` and `bandwidthScore` have the mirror-image problem: an unlabelled node scores the neutral 50, which beats a truthfully-labelled low-bandwidth or heavily-packed node — so missing metadata is rewarded.",
  "Derive GPU presence from labels *or* allocatable extended resources, and apply one documented unknown-vs-measured policy consistently across all four sub-scores so a node with no information cannot outrank one with genuinely poor measured characteristics.",
  ["GPU presence comes from labels or node allocatable; an unlabelled GPU node gets a real fragmentation score.",
   "A documented missing-metadata policy is applied consistently across all four sub-scores.",
   "A test asserts an unlabelled node with 8/8 GPUs allocated does not score 100 for fragmentation.",
   "A test asserts an unlabelled node cannot outrank an equivalent labelled node purely by lacking labels."],
  ["scheduler/pkg/plugins/score.go", "scheduler/pkg/hardware/node_info.go"], area="Scheduler"),

# ═══════════════════════════ EXTENSION (6) ═══════════════════════════

B("Clicking a highlighted address sends a message shape the service worker does not handle, so the headline feature is inert",
  "The content script sends `{ action: 'openDonatePopup' }` while the background switches on `request.type`, so every click falls through to the unsupported-request default and nothing happens.",
  "`extension/src/content-script.ts` (~lines 123-130) sends `chrome.runtime.sendMessage({ action: 'openDonatePopup', address })`. `extension/src/background.ts` `handleMessage` (~lines 47-69) switches on `request.type` and handles only `GET_RECOVERY_STATE`, `SET_WALLET_SESSION`, `CLEAR_WALLET_SESSION` and `REFRESH_PROJECTS`; the `BackgroundRequest` union in `src/messages.ts` has no `action` variant at all. Every click therefore hits `default:` and returns `{ ok: false, error: 'Unsupported background request' }`, which nothing reads.",
  "There is no reliable MV3 way to open the action popup from a content script on older Chrome, so pick a real UX — a badge plus a pending address stashed in `chrome.storage.session`, or an extension page in a tab — and thread the address through `WorkerSessionState` so it survives worker termination.",
  ["The message is part of the typed request union and handled by `handleMessage`.",
   "Clicking a highlighted address produces a visible outcome and preselects the donation target.",
   "The pending address survives a simulated service-worker termination.",
   "A test asserts an unknown message type is rejected without leaving the response port open."],
  ["extension/src/content-script.ts", "extension/src/background.ts", "extension/src/messages.ts"], area="Extension"),

B("The message listener performs no sender validation, so any page's content script can set or clear the wallet session",
  "The background listener ignores `sender` entirely and dispatches on message content alone, while the content script is injected into every URL — so a hostile page can poison the stored wallet identity.",
  "`extension/src/background.ts` (~lines 78-87) registers a listener that never inspects `_sender`. The content script is injected across `<all_urls>` per `manifest.json`, so any compromised page reaching that context can issue `SET_WALLET_SESSION` with an attacker-chosen key — `WorkerSessionState.setWallet` (`src/session-state.ts` ~line 266) only checks the `G[A-Z2-7]{55}` shape — or `CLEAR_WALLET_SESSION`, poisoning the identity the popup displays and re-persisting it to `chrome.storage.session`.",
  "Define which request types may originate from a content script (arguably none) versus only from extension pages (`sender.id === chrome.runtime.id && sender.tab === undefined`), and validate every request field at runtime — the TypeScript union is erased at build time and guarantees nothing.",
  ["Wallet mutation messages are accepted only from extension-page senders; content-script senders are rejected.",
   "Every request is validated at runtime by discriminant and field types, not merely type-asserted.",
   "Tests cover: popup sender accepted, content-script sender rejected, malformed payload rejected.",
   "The trust boundary is documented alongside the existing session-state notes."],
  ["extension/src/background.ts", "extension/src/session-state.ts"], area="Extension", security=True),

B("Background fetches have no timeout or abort, and the response path has no rejection handling",
  "A hung backend leaves the popup stuck in its disabled \"Restoring session…\" state indefinitely, and a popup closed mid-flight produces an unhandled rejection inside the service worker.",
  "`extension/src/background.ts` `fetchProjects` (~line 29) calls `fetch()` with no `AbortSignal`, no timeout and no retry, so if the API hangs the popup's `send()` never settles and `bootstrap()` sits disabled via `setInteractive(false)`. The listener does `void handleMessage(request).then(sendResponse)` with no `.catch` (~line 84), so when the popup closes and the port is gone `sendResponse` throws into an unhandled rejection. `return true` is also issued for *every* message including unrecognised ones, holding ports open needlessly.",
  "Combine an `AbortController` timeout with bounded retry that cannot outlive the worker, a popup-side timeout with a retry affordance, and correct interaction with the search coordinator's sequence numbers so a timed-out search cannot resolve a newer one.",
  ["All background fetches carry an `AbortController` with a bounded timeout; timeouts surface as a structured error.",
   "`handleMessage(...).then(sendResponse)` has a `.catch`, and `return true` is issued only for handled request types.",
   "The popup exits its disabled state within a bounded time on a hung backend and offers a retry.",
   "Tests cover a never-resolving fetch and a `sendResponse` that throws."],
  ["extension/src/background.ts", "extension/src/popup.ts"], area="Extension"),

B("The donation destination address is never validated, while the donor's own key is validated strictly",
  "A project's `walletAddress` is accepted as any string (defaulting to empty) and flows straight into the payment operation, while the user's own key is regex-checked in two places. The least-validated field is the one that decides where money goes.",
  "`extension/src/background.ts` `toProjectSummary` (~lines 11-24) accepts `walletAddress` if it is a string and otherwise substitutes `''`; `src/session-state.ts` `isProject` (~lines 151-160) — used when rehydrating the project cache from `chrome.storage.local` — also only checks `typeof === 'string'`. That value reaches `Operation.payment({ destination: project.walletAddress })` in `src/popup.ts` (~line 275). By contrast the user's own public key is validated against `/^G[A-Z2-7]{55}$/` in both `isWalletSession` and `setWallet`. The unvalidated destination is cached in `storage.local` and replayed on later popup opens.",
  "Validate with the SDK's StrKey check (not a length regex) at both ingestion and cache rehydration, and decide the failure policy: drop the project, render it non-donatable, or fail the list. Muxed (`M…`) and contract (`C…`) addresses need an explicit decision too.",
  ["`walletAddress` is StrKey-validated at ingestion and at cache rehydration.",
   "Projects with an invalid destination are excluded or explicitly non-donatable; the donate button cannot arm against one.",
   "A poisoned `chrome.storage.local` cache entry is rejected on load.",
   "Tests cover a valid address, a 55-char near-miss, an empty string and a checksum-invalid 56-char string."],
  ["extension/src/background.ts", "extension/src/session-state.ts", "extension/src/popup.ts"], area="Extension", security=True),

B("signTransaction does not pin the signing account, and the extension is hardcoded to testnet in four independent places",
  "Freighter signs with whichever account is currently selected, so switching accounts between the wallet probe and the signature prompt yields a signature that does not match the transaction source.",
  "`extension/src/popup.ts` (~line 290) calls `signTransaction(xdr, { networkPassphrase: Networks.TESTNET })` with no account pinned, while the transaction source is `currentWallet.publicKey` (~line 267). A user who switches accounts between `probeWallet()` in `donate()` (~line 311) and the prompt gets a `tx_bad_auth` after a confusing dialog. The testnet assumption is baked in at four layers: the Horizon server URL (~line 25), `Networks.TESTNET` in build/sign/parse, `WalletSession.network: 'TESTNET'` as a literal type in `src/session-state.ts`, and the manifest CSP `connect-src` allowlist — with no check that Freighter itself is on testnet.",
  "Pin the expected signing account and detect a mismatch before submission, check Freighter's active network first, and thread one network configuration source through popup, background, the session schema (which currently discards mismatched state on version change) and the manifest CSP.",
  ["The signing request pins the expected account; a signer/source mismatch is detected before submission.",
   "Freighter's active network is checked against the configured network before building a transaction.",
   "Network configuration lives in one module, and `connect-src` in both manifests is asserted against it.",
   "Tests cover an account switched between probe and sign, and Freighter on the wrong network."],
  ["extension/src/popup.ts", "extension/src/session-state.ts", "extension/manifest.json"], area="Extension"),

B("Tooltip positioning mixes viewport and document coordinates and leaves an over-constrained box",
  "Adjacent lines use two different coordinate systems: `top` adds `scrollY` while `left` uses a raw viewport x with no `scrollX`, so the tooltip is displaced by the full horizontal scroll offset.",
  "`extension/src/content-script.ts` (~lines 107-112) creates an absolutely-positioned tooltip whose `cssText` already sets `bottom: 100%; left: 50%; transform: translateX(-50%); margin-bottom: 8px` (~lines 35-51), appends it to `document.body`, then overrides with `tooltip.style.left = rect.left + rect.width / 2 + 'px'` and `tooltip.style.top = rect.top + window.scrollY + 'px'`. The leftover `bottom: 100%` combined with an explicit `top` over-constrains the box, `translateX(-50%)` now centres against a document-absolute origin rather than the span, and `margin-bottom` is dead once `bottom` is neutralised.",
  "Commit to one coordinate system — document coordinates including both scroll offsets, or a fixed-position viewport tooltip — and remove the conflicting declarations. Placement must survive a positioned `document.body`, transformed ancestors and horizontally scrolled pages.",
  ["Placement uses one coordinate system consistently.",
   "Conflicting `bottom`/`margin-bottom`/`transform` declarations are removed so one positioning model applies.",
   "Placement is correct on a page scrolled both ways and when `document.body` has a non-zero offset.",
   "A test with stubbed `getBoundingClientRect` and non-zero scroll offsets asserts the computed `left`/`top`."],
  ["extension/src/content-script.ts"], area="Extension"),


# ═══════════════════════════ FRONTEND (13) ═══════════════════════════

B("renderMarkdown interpolates link URLs into an href attribute without escaping quotes, allowing stored script injection",
  "The hand-rolled markdown renderer escapes `&`, `<` and `>` up front but never `\"`, then substitutes the raw link capture group into `href=\"$2\"`. Its output goes straight into `dangerouslySetInnerHTML` for every project update body.",
  "`renderMarkdown` in `frontend/pages/projects/[id].tsx` (~lines 1617-1630) escapes the whole string once, then applies `/\\[([^\\]]+)\\]\\(([^)]+)\\)/g` producing `href=\"$2\"`. Because `\"` is not escaped, a body like `[click](\" onfocus=\"…\" x=\")` closes the attribute and injects an event handler; there is also no scheme allowlist, so `javascript:` URLs pass. The result is rendered via `dangerouslySetInnerHTML` at ~line 1296. Update bodies are attacker-influenced through `createProjectUpdate` (`lib/api.ts` ~line 325).",
  "Escape per capture group in its own context (attribute vs. text) rather than pre-escaping the whole string — pre-escaping is what makes a naive fix mangle legitimate `&` in URLs — add an `http(s):`/`mailto:` scheme allowlist, and consider replacing the regex renderer with a sanitizing library, documenting the decision either way.",
  ["Each capture group is escaped for the context it lands in; quotes cannot terminate an attribute.",
   "`href` accepts only an allowlisted scheme; anything else renders as plain text.",
   "Property-based tests (the repo already depends on `fast-check`) assert no input yields a new HTML attribute or `on*` handler.",
   "Bold, italic, link and newline rendering is unchanged for benign input.",
   "Tests do not rely on CSP to block execution — CSP is defence in depth, not the fix."],
  ["frontend/pages/projects/[id].tsx", "frontend/lib/api.ts"], area="Frontend", security=True),

B("handlePrintReport writes unescaped project data into a same-origin popup via document.write",
  "The print report is built by string-interpolating project name, location, category, description, wallet address and every update title/body into an HTML document, then written into an `about:blank` popup — which inherits the app's origin and its `sessionStorage`.",
  "`handlePrintReport` in `frontend/pages/projects/[id].tsx` (~lines 178-589) interpolates those fields with no escaping (~lines 470-540), then does `window.open(\"\", \"_blank\")` followed by `printWindow.document.write(printContent)` (~lines 579-588). An `about:blank` popup shares the opener's origin, so injected script runs against the app — including the admin JWT that `lib/api.ts` (~lines 60-73) keeps in `sessionStorage`. The popup also receives no nonce-bearing CSP, so the policy in `middleware.ts` does not apply to it. A `setTimeout(printWindow.print, 250)` runs with no guard for a popup the user closed first.",
  "Either escape every interpolation, or build the report with DOM APIs / a sandboxed `srcdoc` iframe instead of `document.write` — the latter also fixes the CSP gap. Keep the existing print stylesheet and layout intact.",
  ["No dynamic value reaches the popup unescaped, or the report is built without `document.write`.",
   "The print surface is covered by an equivalent CSP, or is sandboxed so inline script cannot execute.",
   "The 250 ms print timer is cleared when the popup closes early.",
   "A regression test prints a project whose name contains a script tag and a double quote and asserts no execution.",
   "Update titles and bodies get the same treatment as the project fields."],
  ["frontend/pages/projects/[id].tsx"], area="Frontend", security=True),

B("The donation feed tears down and reopens its Horizon stream every second",
  "Three mechanisms combine: an always-on one-second countdown timer re-renders the page, an inline arrow prop changes identity each render, and the stream effect depends on the callback derived from it.",
  "`components/DonationFeed.tsx` opens its Horizon stream in an effect keyed on `[loading, walletAddress, handleNewPayment]` (~lines 123-132); `handleNewPayment` is a `useCallback` over the `onNewDonation` prop (~line 84). `pages/projects/[id].tsx` passes `onNewDonation` as an inline arrow (~lines 1328-1337) and runs `setInterval(() => setCountdownNow(Date.now()), 1000)` unconditionally (~lines 110-113) — even with no active campaign. So an EventSource to Horizon is destroyed and re-established once per second for the life of the page.",
  "Hold the callback in a latest-value ref inside `DonationFeed` so caller identity never restarts the stream, narrow the effect's dependencies, and gate the countdown timer on an active campaign with a deadline — while keeping `seenTxHashesRef` dedupe working across reconnects.",
  ["The stream effect depends only on `walletAddress` and initial-load completion.",
   "`onNewDonation` is invoked through a ref; prop identity changes never restart the stream.",
   "The countdown interval runs only when an active campaign with a deadline exists.",
   "A test asserts the stream factory is called exactly once across N parent re-renders.",
   "`seenTxHashesRef` is bounded — it currently grows without limit for the session."],
  ["frontend/components/DonationFeed.tsx", "frontend/pages/projects/[id].tsx"], area="Frontend"),

B("A backend donation database ID is passed to Horizon as a paging cursor",
  "The feed seeds its cursor from the backend API's donation `id` and hands it to Horizon's `.cursor()`. Horizon cursors are ledger paging tokens; an application UUID either errors the stream or silently resets the replay window.",
  "`components/DonationFeed.tsx` sets `latestIdRef.current = data[0].id` from `fetchProjectDonations` (~line 37) — a database identifier — then passes it as the SSE cursor (~line 126) into `streamProjectPayments(walletAddress, onPayment, cursor)`, which does `.cursor(cursor || \"now\")` (`lib/stellar.ts` ~lines 533-549). The failure is invisible because `onerror` only `console.error`s (~line 563) and Socket.IO delivers the same events, so the feed still appears live while its backfill window is wrong.",
  "Type paging tokens distinctly from donation IDs so the two cannot be confused, derive the cursor from a Horizon payment record's `paging_token`, or drop cursor-based backfill and reconcile purely through `seenTxHashesRef`.",
  ["`streamProjectPayments` accepts only a Horizon paging token, typed distinctly from a donation ID.",
   "No backend donation ID is used as a cursor anywhere in the codebase.",
   "Stream errors surface a real UI state (for example a disconnected indicator) rather than only logging.",
   "A unit test asserts the value passed to Horizon is a paging token or `\"now\"`."],
  ["frontend/components/DonationFeed.tsx", "frontend/lib/stellar.ts"], area="Frontend"),

B("A donation confirmed on-chain is shown as a failure when the backend record call fails, and the transaction hash is discarded",
  "`submitAndConfirmDonation` resolves only after on-chain success, but if the subsequent backend `recordDonation` throws, the catch block clears the transaction hash and shows a generic error — so the donor loses the explorer link to a payment that settled, and the backend never learns of it.",
  "In `components/DonateForm.tsx` `handleDonate` (~lines 244-298), `setTxHash(hash)` runs after confirmed on-chain success; `recordDonation` at ~line 266 can then throw, reaching a catch that unconditionally does `setTxHash(null)` (~line 281) and `setErrorKind(\"generic\")`. `lib/stellar.ts` (~lines 329-450) already models `submission_failed` / `execution_failed` / `unknown` carefully, but there is no state for *chain succeeded, ledger-of-record failed* — the case mobile handles via `horizonTransactionHash` on its offline queue.",
  "Add a fourth terminal state that presents on-chain success plus a retry affordance, never clear a confirmed hash, and make the retry re-post only the hash so it can never rebuild or re-sign a transaction. Persist the orphaned hash locally so a refresh does not lose it.",
  ["A new error kind shows on-chain success with a retry-recording action.",
   "`txHash` is never cleared once the on-chain outcome is confirmed successful.",
   "The retry path posts only the transaction hash; it never re-signs.",
   "The orphaned hash survives a page refresh.",
   "Tests cover chain success plus a `recordDonation` 500, and a subsequent successful retry."],
  ["frontend/components/DonateForm.tsx", "frontend/lib/stellar.ts"], area="Frontend"),

B("The native asset contract address is hardcoded to testnet in the contract-donation path",
  "Every other network value in the Stellar library derives from `NETWORK`, but the native asset contract ID is a literal with a testnet comment — so a mainnet build builds contract donations against a testnet contract.",
  "`components/DonateForm.tsx` (~lines 195-196) hardcodes the native asset contract ID with a `// Native XLM on testnet` comment and passes it to `buildContractDonationTransaction` (`lib/stellar.ts` ~lines 120-171), while `NETWORK` / `NETWORK_PASSPHRASE` (~lines 7-13) drive everything else. The resulting simulation error is routed through `formatSimulationFailure`, which maps unknown host errors to a generic message about checking the network and contract ID (~lines 261-265) — plausible enough to read as misconfiguration rather than a code defect.",
  "Resolve the contract ID from `NETWORK` or an explicit environment variable, and add a boot-time assertion that every configured contract ID matches the selected network so a mismatch fails loudly at startup rather than at donation time.",
  ["The native asset contract ID is resolved per network and never hardcoded.",
   "A build- or boot-time check fails when the network and the configured contract IDs disagree.",
   "`formatSimulationFailure` distinguishes a network-configuration mismatch from a generic host error where detectable.",
   "A test asserts the correct contract ID is selected for each network value."],
  ["frontend/components/DonateForm.tsx", "frontend/lib/stellar.ts"], area="Frontend"),

B("The homepage subscribes to the unfiltered Horizon payment firehose",
  "The landing page opens a global payments stream with no account filter and discards non-matching destinations client-side — so every visitor streams every payment operation on the network.",
  "`pages/index.tsx` (~lines 96-141) fetches up to 100 projects and calls `streamGlobalProjectDonations`, which does `server.payments().cursor(\"now\").stream(...)` with no `forAccount` filter (`lib/stellar.ts` ~lines 592-627) and filters destinations in the browser (~lines 597-608). Bandwidth and main-thread work scale with total network activity rather than with the projects displayed.",
  "Horizon offers no server-side multi-account payment filter, so the fix is architectural: move aggregation behind the backend's existing Socket.IO `donation_event` channel (already consumed by `hooks/useDonationSocket.ts`) or a bounded polled endpoint, preserving the ticker's perceived liveness, its dedupe by donation id and its ten-item cap.",
  ["The homepage no longer opens an unfiltered global Horizon stream.",
   "Live donations come from the backend broadcast or a bounded endpoint with comparable latency.",
   "Measured bytes received and main-thread handler time on an idle homepage drop by an order of magnitude; numbers recorded in the pull request.",
   "Ticker dedupe and the ten-item cap behave exactly as before."],
  ["frontend/pages/index.tsx", "frontend/lib/stellar.ts", "frontend/hooks/useDonationSocket.ts"], area="Frontend"),

B("There is no React error boundary anywhere in the frontend, so any render-time throw blanks the page",
  "A repository-wide search for `ErrorBoundary`, `componentDidCatch` and `getDerivedStateFromError` under `frontend/` returns nothing, and `_app.tsx` wraps the tree in providers with no boundary.",
  "`pages/_app.tsx` (~lines 44-58) composes the i18n provider, toaster and navbar with no boundary, and `pages/_document.tsx` is a plain Document. A throw during render — a failed WebGL renderer construction in `TransactionGraphVisualizer`, a malformed campaign deadline in `formatCountdown`, an unexpected API shape reaching `parseFloat` in a leaderboard row — unmounts the entire tree to a blank document with no recovery path. Only `404.tsx` exists; there is no `_error.tsx`.",
  "Use several boundaries rather than one: a root boundary that resets on route change, and local boundaries with inline fallbacks around the heavy visualisation widgets. Because `_app.getInitialProps` forces server-side rendering on every request, server-side throws need `_error.tsx` as well — client boundaries alone will not cover them.",
  ["A root boundary renders a recoverable UI and resets on route change.",
   "Local boundaries wrap the graph, chart and map components with inline fallbacks.",
   "`pages/_error.tsx` handles server-render failures.",
   "Caught errors are reported with their component stack, not swallowed.",
   "A test asserts a throwing child renders the fallback rather than a blank document."],
  ["frontend/pages/_app.tsx", "frontend/pages/_error.tsx", "frontend/components/TransactionGraphVisualizer.tsx"], area="Frontend"),

B("Two incompatible admin session mechanisms coexist, and the refresh token and expiry returned at login are discarded",
  "`adminLogin` receives `{ token, refreshToken, expiresIn }` and stores only the access token, while one admin page keeps its own token in React state — so that page logs the operator out on refresh even though a valid token is still in session storage.",
  "`lib/api.ts` holds a module-level `adminToken` seeded from `sessionStorage` (~lines 60-63) and attaches it via an interceptor (~lines 79-84); `adminLogin` (~lines 373-380) drops `refreshToken` and `expiresIn` entirely, so there is no silent refresh and the hour-long token simply expires. `pages/admin/ai-summary-failures.tsx` instead keeps a token in component state (~line 17) passed as an explicit header (~lines 431-437 in `lib/api.ts`). Meanwhile `pages/admin/index.tsx` (~lines 22-40) gates only on a connected wallet and never calls `isAdminAuthenticated()` — and `pages/admin/login.tsx` (~line 18) redirects there, so logging in leads to a page that does not consume the login.",
  "Unify on one session module, persist and use the refresh token with a single shared in-flight refresh so concurrent 401s do not stampede, and interleave that retry correctly with the existing CSRF 403 retry (`lib/api.ts` ~lines 86-104). Decide and document the token storage policy, and add route guards without breaking the wallet-ownership gate on the per-project admin page.",
  ["One admin session module; the failures page reads from it and survives a refresh.",
   "Refresh token and expiry are persisted and drive silent refresh; concurrent 401s share one refresh.",
   "Admin routes redirect to the login page when unauthenticated.",
   "Logout clears the access token, refresh token and any in-flight retry state.",
   "Tests cover refresh-on-401, refresh failure leading to redirect, and refresh across a page reload."],
  ["frontend/lib/api.ts", "frontend/pages/admin/index.tsx", "frontend/pages/admin/ai-summary-failures.tsx"], area="Frontend", security=True),

B("The celebration overlay regenerates fifty randomized DOM nodes every second",
  "Confetti positions and animation timings are computed with `Math.random()` inside the render body, and the page re-renders once per second, so all fifty elements get new inline styles and restart their animations indefinitely.",
  "`pages/projects/[id].tsx` (~lines 496-514) renders `Array.from({ length: 50 })` with `left`, `animationDelay` and `animationDuration` derived from `Math.random()` during render, keyed by index. The unconditional one-second countdown interval (~lines 110-113) triggers a re-render every second, forcing style recalculation across all fifty nodes for as long as a fully-funded project page stays open, with no `prefers-reduced-motion` opt-out.",
  "`Math.random()` in a render body is an impurity that React's StrictMode double-invocation already makes nondeterministic. Memoize the particle set on project completion, or move the effect to pure CSS, and gate it behind the reduced-motion query — coordinating with the celebration styles in `styles/globals.css`.",
  ["Confetti positions and timings are computed once and stay stable across re-renders.",
   "The overlay is suppressed under `prefers-reduced-motion`.",
   "Countdown state no longer re-renders the page tree when there is nothing to count down.",
   "A profile of an idle funded project page shows no recurring style-recalculation or layout work."],
  ["frontend/pages/projects/[id].tsx", "frontend/styles/globals.css"], area="Frontend"),

B("The graph visualizer runs unthrottled O(N) picking on every pointermove and never releases its WebGL context",
  "The file header claims interaction cost scales with what is on screen rather than total graph size, but picking runs synchronously on every native pointermove and allocates per candidate — and when zoomed out, every node is a candidate.",
  "`components/TransactionGraphVisualizer.tsx`: `onPointerMove` (~line 209) calls `pickNode` on every event; `pickNode` (~lines 185-207) iterates all `visibleIndices` allocating a fresh vector per candidate (~line 197), and `recomputeFrustumVisibility` (~lines 168-178) rebuilds that array from scratch with its own allocations. Cleanup (~lines 257-269) disposes geometries and materials but never calls `forceContextLoss()`, so repeated mounts through the dynamic import in `pages/network.tsx` leak WebGL contexts toward the browser's roughly sixteen-context limit.",
  "Coalesce pointer events to at most one pick per animation frame, hoist allocations out of the hot loop, and to genuinely reach the stated fifty-thousand-node target use GPU-side picking via a colour-ID render target or a spatial index. Verify context release across remounts.",
  ["Picking runs at most once per animation frame.",
   "No per-candidate allocation remains in `pickNode` or `recomputeFrustumVisibility`.",
   "Cleanup calls `forceContextLoss()`; mounting and unmounting the page twenty times does not exhaust WebGL contexts.",
   "A benchmark at fifty thousand nodes documents frame time under continuous pointer movement.",
   "The canvas gains a keyboard-accessible fallback — it currently has no accessibility affordances at all."],
  ["frontend/components/TransactionGraphVisualizer.tsx", "frontend/pages/network.tsx"], area="Frontend"),

B("useCountUp misses late-mounting elements, commits state every animation frame, and restarts from zero when its target changes",
  "The intersection observer is created in a mount-only effect that captures the ref at that instant, so elements rendered after data loads are never observed and never animate.",
  "`hooks/useCountUp.ts` (~lines 8-24) creates the observer with `[]` dependencies and observes `elementRef.current` immediately — `null` for the stat blocks that mount after their API data arrives. The animation effect (~lines 26-49) calls `setCount` on every animation frame, forcing a React commit per frame; and because `target` is a dependency, a value arriving mid-animation restarts the effect with a null start time and re-eases from zero rather than continuing from the current value. `elementRef` is typed as `any`.",
  "Attach via a callback ref so conditionally-rendered nodes are always observed, avoid a React commit per frame by writing to the DOM through a ref or throttling commits, and interpolate from the currently displayed value when the target changes — keeping the easing curve visually identical.",
  ["A callback ref ensures conditionally-rendered elements are observed.",
   "Count updates do not trigger a React commit on every animation frame.",
   "A target change mid-flight eases from the displayed value, not from zero.",
   "`elementRef` is properly typed with no `any`.",
   "A test asserts the animation is cancelled and the observer disconnected on unmount."],
  ["frontend/hooks/useCountUp.ts"], area="Frontend"),

B("137 locale keys are defined and kept in sync across three languages, but only about twenty are consumed",
  "The locale files are perfectly synchronised and almost entirely unused. The donation flow — the one surface that most needs translating — imports the hook and then hardcodes every string.",
  "`locales/en.json`, `es.json` and `ar.json` each hold 137 flattened keys, but searching for `t(\"…\")` across `pages/` and `components/` yields roughly twenty distinct keys, mostly navigation. Only 15 of 43 files under those directories import the i18n hook at all. `components/DonateForm.tsx` imports it (~line 40) yet hardcodes every heading, error and button label; `MonthlyGivingSetup.tsx`, both admin pages and `404.tsx` are entirely untranslated. Because `t()` falls back to returning the key itself (`lib/i18n.tsx` ~line 125), a typo renders a key path with no warning.",
  "This is not a mechanical string sweep: the pluralization machinery in `lib/i18n.tsx` (~lines 69-93) has to be driven correctly for Arabic's six plural categories, and the right-to-left rendering needs review against the logical `start-`/`end-` utility classes already in use. Add tooling so coverage does not drift back.",
  ["CI fails when a `t()` key is missing from any locale, and when a locale key is referenced nowhere in source.",
   "The donation flow is fully translated, with counts using plural syntax rather than manual branching.",
   "In development, `t()` warns on a missing key instead of silently returning the key path.",
   "The Arabic donation flow is reviewed end to end in right-to-left.",
   "Remaining untranslated surfaces are documented as a tracked follow-up list."],
  ["frontend/lib/i18n.tsx", "frontend/locales/en.json", "frontend/components/DonateForm.tsx"], area="Frontend"),

# ═══════════════════════════ MOBILE (11) ═══════════════════════════

B("The project detail screen calls useTheme without importing it, and no TypeScript check runs in the mobile toolchain",
  "The screen references a hook that was never imported, so it throws on render. Nothing catches it because the mobile package has no TypeScript dependency, no type-check script, and a test command that passes with no tests.",
  "`mobile/app/projects/[id].tsx` (~line 29) destructures `useTheme()` and uses the result throughout its render (~lines 111-120 onward), but the import block (~lines 5-9) never imports it — the hook is exported from `app/theme.tsx` (~line 89). The screen raises a reference error on mount. `mobile/package.json` has no `typescript` devDependency and no `type-check` script; `tsconfig.json` exists with `strict: true` but no `include`, so it has never been enforced; and `npm test` is `jest --passWithNoTests`.",
  "The import is one line — the real work is making this class of defect impossible. Add TypeScript to the mobile package extending the Expo base config, wire `tsc --noEmit` into CI, and work through whatever backlog of type errors that first run surfaces.",
  ["The hook is imported and the screen renders in a smoke test.",
   "`typescript` is a mobile devDependency and `tsconfig.json` extends the Expo base config.",
   "A `type-check` script exists and passes.",
   "CI runs the mobile type check on every pull request.",
   "Every screen registered in the root layout has a rendering smoke test."],
  ["mobile/app/projects/[id].tsx", "mobile/package.json", "mobile/tsconfig.json"], area="Mobile"),

B("Double-tapping donate can submit two payments because the in-flight flag is set after the biometric prompt",
  "`handleDonate` performs a connectivity check, key derivation and biometric authentication before setting the submitting flag, so the button's disabled binding does nothing during the prompt.",
  "In `mobile/app/donate/[id].tsx`, `handleDonate` awaits a connectivity fetch (~line 156), derives a keypair (~line 188) and awaits authentication (~line 202) before reaching `setSubmitting(true)` at ~line 208; the button binds `disabled={submitting}` at ~line 412. Two quick taps produce two flows that both validate, both load the account (~line 215) and both submit.",
  "Guard with a synchronous ref — React state updates are asynchronous and batched, so a state flag cannot close this window — and release it on every return path including the offline-queue branch (~line 178) and each alert bailout. Two transactions built from one loaded account collide on sequence number, but the observable outcome differs with submission timing, so tests need to cover both interleavings.",
  ["A synchronous ref blocks re-entry from the first line of the handler.",
   "The ref is released on every return path: validation failure, offline queue, biometric cancel, network error and success.",
   "The button appears disabled from the moment the flow starts, not after the biometric prompt.",
   "A test simulating two near-simultaneous taps asserts exactly one submission."],
  ["mobile/app/donate/[id].tsx"], area="Mobile", security=True),

B("The wallet connect flow uses an alert as if it accepted text input, so it cannot work on either platform",
  "The screen calls the plain alert API with an OK handler that expects a typed string. Alerts never pass text back; the text-input variant is a different, iOS-only API — so on Android the handler receives a press event and validation always fails.",
  "`mobile/app/donate/[id].tsx` (~lines 287-307) calls `Alert.alert('Connect Wallet', 'Enter your Stellar public key:', [...])` whose OK handler stringifies its argument and tests it against a regex. `Alert.prompt` is the text-input API and exists only on iOS; there is no Android equivalent. A working modal-based flow already exists in `src/components/WalletConnect.tsx` (~lines 52-97) backed by `useWallet` and secure storage, and this screen ignores it, keeping the address in throwaway local state (~line 44) that resets on navigation.",
  "Reuse the existing modal flow. Note the validation split it exposes: this screen uses a hand-rolled regex while `src/hooks/useWallet.ts` (~line 24) correctly uses the SDK's key validator. Reconcile the screen's local address state with the persisted value without breaking the secret-to-public key match check at ~line 194.",
  ["The donate screen uses the shared connect flow; the alert-based prompt is removed.",
   "Address validation goes through the SDK validator everywhere, not a regex.",
   "The connect flow is verified working on both an Android and an iOS device or emulator.",
   "The connected address persists across navigation and app restart.",
   "A test asserts the donate screen reads its address from the shared wallet hook."],
  ["mobile/app/donate/[id].tsx", "mobile/src/components/WalletConnect.tsx", "mobile/src/hooks/useWallet.ts"], area="Mobile"),

B("Secret key handling on the donate screen: unhardened input, unbounded lifetime, and clearing on only some paths",
  "The secret key lives in plain component state behind a text input that sets only secure entry and lowercase autocapitalization — no autocorrect or spellcheck disabling, no context-menu suppression, no autofill opt-out — and is cleared on only some exit paths.",
  "`mobile/app/donate/[id].tsx` keeps the secret in `useState` (~line 43) bound to a `TextInput` (~lines 374-381) missing `autoCorrect={false}`, `spellCheck={false}`, `contextMenuHidden` and the platform autofill opt-outs. The derived keypair (~line 188) is retained, the string stays reachable in the heap and in developer tooling for the screen's lifetime, and error handling logs whole error objects (~line 237) that can carry the submitted envelope. `setSecretKey('')` runs on some paths (~lines 268, 281) but not after a key-mismatch or biometric-cancel return.",
  "JavaScript strings are immutable, so true zeroization is impossible — the mitigation is minimizing lifetime and blast radius: clear on every return path, on screen blur and on app background, and drop the keypair reference immediately after signing. Document what the resulting threat model does and does not cover.",
  ["The input disables autocorrect, spellcheck, the context menu and autofill on both platforms.",
   "The secret is cleared on every exit path, on blur, and when the app backgrounds.",
   "The keypair reference is dropped immediately after signing.",
   "No code path logs an object that could contain key material or a signed envelope.",
   "A threat model in `docs/` records what is and is not protected."],
  ["mobile/app/donate/[id].tsx"], area="Mobile", security=True),

B("A donation confirmed on-chain but rejected by the backend is only persisted if it came from the offline queue",
  "The recovery path exists but sits inside a branch that only runs for queue-originated donations. For an ordinary online donation the transaction hash survives only inside a status string, so navigating away loses an on-chain payment the platform will never see.",
  "`mobile/app/donate/[id].tsx` (~lines 269-281) handles the accepted-on-chain, backend-failed case by calling `updateQueuedDonation(queueEntry.id, { horizonTransactionHash })` — but only within `if (queueEntry)` (~line 271). In the common online case the hash lives only in a status message (~line 277), and the retry helper (~line 100) is unreachable because it is gated on `queueEntry?.horizonTransactionHash` (~line 137).",
  "Create a queue entry after successful submission for donations that never went through the queue, without reintroducing the duplicate-submission risk the queue design deliberately avoids. The preflight check in `hooks/useDonationSync.ts` (~lines 95-97) already treats a present transaction hash as *completed, remove*, so those reconciliation semantics must be extended rather than reused as-is.",
  ["Any donation reaching the network but failing backend confirmation is persisted with its hash, queue-originated or not.",
   "The sync hook retries backend confirmation — never resubmission — for such entries on reconnect.",
   "The donate screen's retry path works for entries that did not originate in the queue.",
   "No path can resubmit a payment that already carries a transaction hash.",
   "A test covers online donation, backend failure, app restart and reconnect, asserting it is recorded exactly once."],
  ["mobile/app/donate/[id].tsx", "mobile/hooks/useDonationSync.ts", "mobile/utils/donationQueue.ts"], area="Mobile"),

B("The scanner's state-based guard allows concurrent scans, and dismissing the rejection alert on Android disables it permanently",
  "Scan suppression uses React state, which commits asynchronously, so several frames can pass the guard and launch concurrent lookups and navigations. Separately, an Android alert is dismissible without invoking either button handler, leaving the guard stuck on.",
  "`mobile/src/screens/QRScannerScreen.tsx` (~lines 77-79) guards with `if (scanned) return; setScanned(true);` before an async project lookup (~line 90) and a navigation (~line 74). `rejectScan` (~lines 66-71) shows a two-button alert; Android alerts are cancelable by default, so a back-button press or outside tap runs neither handler and leaves the scanned flag set forever with the camera live. The permission request (~lines 60-64) has no unmount guard and no rejection handling.",
  "Use a synchronous ref guard, set the alert non-cancelable or handle its dismissal explicitly, and make the permission flow unmount-safe — while preserving the fail-closed link-validation ordering at ~lines 86-114.",
  ["A ref-based guard makes concurrent scan handling impossible.",
   "Dismissing the rejection alert by back button or outside tap restores scanning.",
   "The permission request is unmount-safe and handles rejection.",
   "A test firing several barcode events in one tick asserts a single navigation.",
   "Behaviour is verified on a physical Android device."],
  ["mobile/src/screens/QRScannerScreen.tsx"], area="Mobile"),

B("Camera and biometric permission declarations are missing, and there is no production build profile",
  "The app requests camera and biometric permissions at runtime, but neither usage description is declared — so an iOS build crashes on first camera access and would not survive review.",
  "`mobile/app.json` declares only the router and notifications plugins, with no iOS `infoPlist` block and no Android permissions, while the scanner screen requests camera permission and the biometric hook requests local authentication — requiring camera and face-authentication usage descriptions respectively. Android 13 and later also needs an explicit notification permission. `eas.json` contains only a preview profile: no development profile, no production profile and no submit configuration, and `app.json` has no runtime version, updates block, build number or version code.",
  "This needs an understanding of which native settings come from config plugins versus raw property-list entries, plus a versioning strategy that distinguishes over-the-air updates from store builds. Also evaluate the barcode scanner dependency, which is deprecated in favour of the camera module in current SDK versions.",
  ["Camera and biometric usage descriptions are present and a fresh iOS build grants camera access without crashing.",
   "The Android notification permission is declared for API 33 and above.",
   "`eas.json` gains development and production profiles plus submit configuration.",
   "Runtime version policy and the version/build-number strategy are documented.",
   "The scanner-module migration is either completed or tracked with a rationale."],
  ["mobile/app.json", "mobile/eas.json"], area="Mobile"),

B("The header font family is referenced but never loaded",
  "The root navigator sets a header font by name, but no font-loading call exists anywhere in the mobile app and neither font package is a dependency — so the name resolves to nothing.",
  "`mobile/app/_layout.tsx` (~line 46) sets a header title font family on the root stack. Searching the mobile tree for the font module, the font package or a font-loading hook returns exactly that one line. Tellingly, the Jest transform-ignore configuration in `package.json` already allowlists the font package namespace, so a font setup was started and abandoned. iOS silently substitutes the system font; Android's handling of an unregistered family name varies by version, so the two platforms diverge visually.",
  "Loading fonts correctly also means holding the splash screen until they resolve, which interacts with the initialization context's hydration sequence (`src/context/AppInitContext.tsx` ~lines 76-92) — the app currently renders the navigator before hydration completes, so getting the ordering wrong yields either a font flash or a stuck splash.",
  ["The font is loaded properly, or the reference is removed.",
   "The splash screen is held until both font loading and context hydration complete.",
   "Header typography is verified identical on iOS and Android screenshots.",
   "No unregistered font family names remain in the codebase."],
  ["mobile/app/_layout.tsx", "mobile/src/context/AppInitContext.tsx", "mobile/package.json"], area="Mobile"),

B("Device-token registration and the notification response listener are dead code, and tokens are interpolated into URLs unencoded",
  "Two exported functions that register the device and route notification taps are never called from anywhere in the app, so the backend never receives a token and tapping a push does nothing.",
  "`mobile/utils/notifications.ts` exports `registerDeviceToken` (~line 109) and `setupNotificationListener` (~line 219); searching `app/`, `src/`, `components/` and `hooks/` finds no caller. Only the token getter and the follow/unfollow helpers are imported. Consequently the pending-registration retry path (~lines 25-48) is unreachable, no response listener is mounted, and the Android notification channel is never created — which Android 8 and later requires for the sound and alert settings in the module-scope handler (~lines 17-23) to take effect. Separately, `getFollowedProjects` (~line 197) and the follow-status check in `app/projects/[id].tsx` (~line 60) interpolate the token straight into a query string; these tokens contain square brackets, which go unencoded.",
  "Decide where registration belongs in the app lifecycle — root layout after hydration, tied to wallet connect and disconnect — create the Android channel before any notification arrives, route notification taps through the already-validated deep-link parser, and handle token rotation.",
  ["Registration runs once per session after hydration and on wallet connect/disconnect.",
   "The response listener is mounted at the root and torn down on unmount.",
   "The Android notification channel is created before any notification is scheduled or received.",
   "Push tokens are URL-encoded in query strings, or moved into request bodies.",
   "Tapping a donation notification routes to the correct screen via the validated deep-link parser."],
  ["mobile/utils/notifications.ts", "mobile/app/_layout.tsx", "mobile/app/projects/[id].tsx"], area="Mobile"),

B("The notification permission prompt fires on every project detail mount, with no user gesture and no rationale",
  "Merely viewing a project triggers the operating-system permission dialog, and there is no persisted record of a prior decline. The permission is only actually needed when the user taps Follow.",
  "`mobile/app/projects/[id].tsx` (~lines 38-56) runs an initialization effect on mount that fetches a push token (~line 47), which requests notification permission (`utils/notifications.ts` ~lines 70-85). The existing permission check short-circuits after an operating-system-level decision, but on Android 13 the flow can re-prompt under documented conditions and on iOS the token fetch still runs on every mount — all with no explanation shown to the user first.",
  "Adopt a pre-permission pattern: an in-app rationale, then the system prompt on explicit intent. Persist a tri-state decision — not asked, declined, granted — and handle a Follow press while permission is denied by deep-linking to settings. This interacts with wherever registration ends up living in the app lifecycle.",
  ["Permission is requested only on an explicit user action, never on screen mount.",
   "An in-app rationale precedes the system prompt.",
   "A declined decision is persisted and not re-prompted on every visit.",
   "The Follow control handles the denied case with a settings deep-link.",
   "Follow status still displays correctly when permission has never been granted."],
  ["mobile/app/projects/[id].tsx", "mobile/utils/notifications.ts"], area="Mobile"),

B("An async function is passed straight to useFocusEffect, so its Promise is treated as the cleanup destructor",
  "React Navigation treats a focus effect's return value as a cleanup function. An async function returns a Promise, which triggers the documented warning and means no cleanup ever runs.",
  "`mobile/app/recurring.tsx` (~lines 90-97) defines `refresh` as an async callback and passes it directly to `useFocusEffect`. The refresh also sets a loading flag before an await with no blur or unmount guard, so navigating away mid-load updates state on an unmounted screen and can strand the screen on its loading branch (~line 104). `app/sync-conflicts.tsx` (~line 22) imports the same hook and should be audited for the same shape.",
  "The idiomatic form wraps a synchronous callback around a self-invoking async function and returns a real cleanup that flips a cancellation flag. Understanding *why* the flag is needed — rather than only wrapping the call — matters here, because the cancel handler (~line 99) mutates state optimistically, so the refresh-versus-cancel interleaving has to stay consistent.",
  ["The focus effect receives a synchronous callback returning a real cleanup function.",
   "Async loads are guarded by a cancellation flag; no state updates occur after blur or unmount.",
   "The same pattern is audited and applied in the sync-conflicts screen.",
   "No navigation effect-return warnings appear during navigation.",
   "A test focuses the screen, navigates away mid-load, and asserts no state update and no warning."],
  ["mobile/app/recurring.tsx", "mobile/app/sync-conflicts.tsx"], area="Mobile"),


# ═══════════════════════ CROSS-CUTTING (20) ═══════════════════════

B("Four different Stellar address validators across the codebase, three of them accepting invalid addresses",
  "Backend and frontend validate with `/^G[A-Z0-9]{55}$/`. Stellar keys are base32, whose alphabet is `A-Z` and `2-7` — so that pattern accepts `0`, `1`, `8` and `9`, which can never appear in a valid key, while rejecting nothing on checksum grounds.",
  "The same value is validated four incompatible ways: `backend/src/schemas/common.js` (~line 13), `backend/src/eventSourcing/commands.js` (~lines 41, 75, 147), `backend/src/routes/profiles.js` (~line 12) and `backend/src/routes/impact.js` (~line 22) use `[A-Z0-9]`; `frontend/lib/stellar.ts` `isValidStellarAddress` (~line 452) uses `[A-Z0-9]`; `extension/src/session-state.ts` (~lines 58, 179) and `content-script.ts` (~lines 1-2) use the correct `[A-Z2-7]` alphabet but no checksum; and mobile is split — `utils/stellarValidation.ts` (~line 25) and `src/hooks/useWallet.ts` (~line 24) use the SDK's `StrKey.isValidEd25519PublicKey`, while `app/donate/[id].tsx` (~line 297) uses `[A-Z0-9]`. Only the StrKey calls verify the trailing CRC16 checksum, which is the entire point of the encoding: a single mistyped character in a pasted address passes every regex variant and the donation goes to an address that may not exist.",
  "Every subsystem already depends on a Stellar SDK exposing `StrKey`. Replace all regex validation with it behind one helper per subsystem, and make explicit, consistent decisions about muxed (`M…`) and contract (`C…`) addresses — today each site implicitly rejects both. The content script's *scanning* regex is a separate concern and legitimately stays a regex, but each match it finds should be StrKey-verified before being treated as an address.",
  ["No `G[A-Z0-9]{55}` or `G[A-Z2-7]{55}` pattern is used to decide whether an address is valid anywhere in the repository.",
   "Each subsystem validates through `StrKey`, exposed as a single named helper.",
   "Muxed and contract address handling is decided explicitly and documented, not left implicit.",
   "A shared test vector file — valid keys, checksum-invalid keys, wrong-alphabet keys, muxed and contract addresses — is exercised by backend, frontend, mobile and extension test suites.",
   "The content script StrKey-verifies each regex match before highlighting it."],
  ["backend/src/schemas/common.js", "frontend/lib/stellar.ts", "mobile/app/donate/[id].tsx", "extension/src/session-state.ts"], area="Cross-cutting", security=True),

B("Exact NUMERIC(20,7) balances are read through parseFloat, reintroducing binary floating-point error into money",
  "The schema stores every monetary column as `NUMERIC(20, 7)` — exact decimal at stroop precision — but roughly 55 `parseFloat` calls in the backend and 36 in the frontend convert those strings to IEEE-754 doubles before arithmetic, comparison or display.",
  "`backend/src/db/schema.sql` declares `goal_xlm`, `raised_xlm`, `amount`, `amount_xlm`, `total_donated_xlm`, `amount_escrow_xlm`, `cap_xlm` and `matched_xlm` as `NUMERIC(20, 7)`, and the Postgres driver correctly returns them as strings to preserve exactness. That care is then discarded: totals are summed as doubles, goal-completion is decided by comparing doubles, and matching-pool caps are enforced against doubles. Seven decimal places of stroops plus a twenty-digit range exceeds what a double represents exactly, so sums drift and a project can read as funded when it is a stroop short, or vice versa.",
  "Pick one exact representation and drive it end to end: integer stroops (`bigint`) or a decimal library, converting only at the display boundary. Push aggregate arithmetic into SQL where the database can do it exactly. The migration has to handle values already persisted, and the on-chain side is authoritative in stroops, so the boundary conversion belongs where chain data enters the system.",
  ["No monetary value passes through `parseFloat` or `Number()` before arithmetic or comparison.",
   "One exact representation is used consistently, with conversion confined to display and chain boundaries.",
   "Aggregations are computed by the database or an exact decimal type, never by summing doubles.",
   "Property-based tests assert that summing many donations yields exactly the stored total, including values with all seven decimals populated.",
   "A goal-completion boundary test at exactly one stroop below, at, and above the goal behaves correctly."],
  ["backend/src/db/schema.sql", "backend/src/eventSourcing/projections.js", "frontend/lib/api.ts"], area="Cross-cutting"),

B("Read-model donation totals are inflated by the historical double-counting bug and need reconciliation from the event stream",
  "The double-count was fixed at the write path, so new donations are correct — but every total written while the bug was live remains overstated, and nothing recomputes them.",
  "Before the fix, both the command bus and the projection wrote donation totals, so each donation incremented `projects.raised_xlm` and the donor's `total_donated_xlm` twice. The command bus no longer writes read-model totals and the projection owns them exclusively, which stops the bleeding but does not repair history. `event_stream` holds the authoritative record of every donation event, so correct totals are derivable — but no reconciliation job exists, meaning displayed amounts raised, donor leaderboards and any goal-completion state derived from them are wrong for all affected rows.",
  "Write an idempotent reconciliation that replays `event_stream` to recompute totals and reports a diff before applying anything — operators need to see the blast radius first. Decide what happens to projects the inflated numbers pushed over their goal (celebration state, campaign closure, escrow release may already have fired) and whether the correction is announced. Running it must be safe concurrently with live traffic, or it must document the required maintenance window.",
  ["A command recomputes project and donor totals from `event_stream` and reports a diff without writing.",
   "An apply mode writes corrections inside a transaction and is idempotent across repeat runs.",
   "Projects whose goal state was reached only because of inflation are identified and handled by a documented policy.",
   "The job is safe against concurrent writes, or the required maintenance procedure is documented.",
   "A test seeds a stream with known double-counted history and asserts exact recovered totals."],
  ["backend/src/eventSourcing/projections.js", "backend/src/eventSourcing/commandBus.js"], area="Cross-cutting"),

B("The database schema is applied wholesale on every boot with no migration versioning",
  "`migrate.js` reads `schema.sql` and executes the entire file inside one transaction on every run. There is no migration table, no ordering, no down path, and no record of what has been applied.",
  "`backend/src/db/migrate.js` (~lines 8-16) does `BEGIN`, executes the whole of `schema.sql`, then seeds. This works only because every statement in the file is written defensively — `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `ON CONFLICT DO NOTHING`. That idiom cannot express anything a real schema change requires: renaming a column, changing a type, backfilling data, adding a constraint that existing rows violate, or dropping something. Each such change has to be hand-written as an idempotent no-op-if-already-done statement, and nothing verifies that a fresh database and a long-lived one converge to the same schema.",
  "Adopt a migration runner with a versions table, forward migrations as ordered discrete files, and an advisory lock so concurrent backend instances cannot race on startup. The existing `schema.sql` becomes the baseline. Add a CI check that a database built by replaying migrations is structurally identical to one built from the baseline — that drift check is what makes the whole thing trustworthy.",
  ["A versions table records applied migrations; each runs exactly once.",
   "Migrations are discrete ordered files; `schema.sql` becomes the baseline for a fresh database.",
   "An advisory lock prevents concurrent instances from racing on startup.",
   "CI asserts that replaying migrations and building from baseline produce identical schemas.",
   "Seeding is separated from migration and does not run in production."],
  ["backend/src/db/migrate.js", "backend/src/db/schema.sql"], area="Cross-cutting"),

B("Two incompatible response envelopes are returned by the API, roughly evenly split",
  "About 50 handler paths return a bare `{ error }` object while about 56 return `{ success: true, data }`. Clients cannot tell from a response shape whether a call succeeded without also inspecting the status code, and error handling is written twice.",
  "Counting across `backend/src/routes`, `res.status(...).json({ error: ... })` appears roughly 50 times and `success: true` roughly 56. Some endpoints return a paginated `{ success, data, pagination }`, some a bare array, some a bare object. Errors are sometimes `{ error: \"...\" }` and sometimes flow through the error middleware. Every client — frontend, mobile and extension — reimplements unwrapping, and each does it slightly differently, so a shape change in one endpoint breaks consumers unpredictably.",
  "Settle on one envelope and apply it via middleware rather than by editing every handler, so new routes cannot drift. Error responses need a stable machine-readable code alongside the human message — clients currently branch on message text, which breaks on any rewording. This is a breaking change for existing clients, so it needs a versioning or transition plan, and `docs/openapi.yml` must be updated in the same change.",
  ["One success envelope and one error envelope are defined and documented.",
   "Envelopes are applied by shared middleware; no handler constructs one by hand.",
   "Error responses carry a stable machine-readable code distinct from the display message.",
   "No client branches on error message text.",
   "The specification matches the implementation, enforced by the response-shape test suite."],
  ["backend/src/routes", "backend/src/middleware", "docs/openapi.yml"], area="Cross-cutting"),

B("The OpenAPI specification describes 37 paths with nothing verifying it matches the running API",
  "`docs/openapi.yml` is 55 KB of hand-maintained specification. No test asserts that a documented path exists, that an undocumented path does not, or that response bodies match declared schemas.",
  "The specification declares roughly 37 paths. Route handlers are added, changed and removed independently of it — the session that added the summary-failure operator endpoints, for instance, had to add routes that returned 404 despite being documented behaviour. Nothing catches the reverse either: a route that exists but is undocumented is invisible to anyone building against the specification, and a response shape that drifts from its declared schema is never noticed.",
  "Generate the route inventory from the Express router at test time and diff it against the specification, then validate real responses from the existing integration suite against their declared schemas. The interesting design question is which direction is authoritative — specification-first with generated route assertions, or implementation-first with a generated specification. Pick one and make the other side fail CI, otherwise drift simply resumes.",
  ["A test enumerates registered routes and fails on any path documented but unimplemented, or implemented but undocumented.",
   "Integration-test responses are validated against their declared schemas, including error responses.",
   "The authoritative direction is chosen and documented.",
   "The check runs in CI on every pull request.",
   "Existing drift is fixed rather than allowlisted, or each exception carries a written rationale."],
  ["docs/openapi.yml", "backend/src/routes"], area="Cross-cutting"),

B("Network and contract configuration is hardcoded independently in each client, with nothing asserting the four agree",
  "Frontend, mobile and extension each decide which Stellar network they talk to in their own way, and the deployed contract identifiers live in a fourth place. Nothing verifies consistency, so a mainnet cutover is four uncoordinated edits.",
  "The frontend derives most values from `NETWORK` but hardcodes the native asset contract identifier; the extension hardcodes the network passphrase, the Horizon URL, a literal network in its session schema, and a `connect-src` allowlist in its manifest; mobile carries its own Horizon configuration; and the contract deployment workflow produces identifiers that reach clients by manual copying. A client can therefore be pointed at mainnet Horizon while signing with a testnet passphrase, or hold a stale contract identifier — and the resulting failures surface as generic simulation or authentication errors rather than as configuration mismatches.",
  "Publish one machine-readable deployment manifest per network — passphrase, Horizon and RPC endpoints, and every contract identifier — emitted by the deploy workflow and consumed by all clients, with validation at build or boot so a mismatch fails immediately and legibly. The extension's manifest `connect-src` must be generated from the same source, since a hand-maintained allowlist is exactly what silently blocks a correctly configured endpoint.",
  ["One manifest per network is the single source for endpoints, passphrase and contract identifiers.",
   "The deploy workflow emits the manifest; no client hardcodes a contract identifier.",
   "Build- or boot-time validation fails on any internal inconsistency, with a message naming the mismatch.",
   "The extension's `connect-src` allowlist is generated from the manifest.",
   "A test asserts each supported network resolves to a fully consistent configuration."],
  ["frontend/lib/stellar.ts", "mobile/app/donate/[id].tsx", "extension/manifest.json", ".github/workflows/contract-deploy.yml"], area="Cross-cutting"),

B("Recording a donation has no idempotency key, so a client retry can create a duplicate record",
  "Clients retry the backend record call after network failures, and both mobile's offline queue and the proposed frontend retry path replay the same donation. Nothing at the boundary guarantees that replaying is safe.",
  "A donation is uniquely identified on-chain by its transaction hash, which is the natural idempotency key — but the record endpoint does not treat it as one. Mobile's queue explicitly replays entries on reconnect, and the frontend needs the same recovery for donations confirmed on-chain whose record call failed. Without a uniqueness guarantee enforced by the database, two concurrent retries can both pass a read-then-write existence check and produce two donation rows for one payment, which then flows into totals, donor counts and leaderboards.",
  "Enforce uniqueness on the transaction hash at the database level — an application-level check cannot close the concurrent-retry window — and have the endpoint return the existing record on a repeat rather than an error, so a retry is indistinguishable from a first success. Reconcile this with the event-sourced path, where the same guarantee has to hold at the aggregate boundary, and decide what a replay with mismatched amount or project means: that is tampering, not a retry.",
  ["A database uniqueness constraint on the transaction hash makes duplicate records impossible.",
   "Replaying a record call returns the existing record with a success status, not an error.",
   "A replay whose other fields disagree with the stored record is rejected and logged as suspicious.",
   "The event-sourced path enforces the same guarantee at the aggregate boundary.",
   "A concurrency test issues N simultaneous identical record calls and asserts exactly one row and one event."],
  ["backend/src/routes/donations.js", "backend/src/eventSourcing/commandBus.js", "mobile/utils/donationQueue.ts"], area="Cross-cutting"),

B("No request correlation identifier links a donation across client, backend, job queue and chain",
  "A donation crosses a client, an HTTP handler, the event store, a background job and Horizon. Nothing carries an identifier through those hops, so reconstructing one user's failed donation means correlating by timestamp across separate logs.",
  "Logging is largely `console.log` and `console.error` with no structure and no shared identifier. When a donor reports a failure, there is no way to select the backend log lines, the event-stream rows, the background job attempts and the Horizon submission belonging to that attempt. The offline-queue and retry paths make this worse: one logical donation can span multiple sessions, days apart.",
  "Adopt structured logging with a correlation identifier generated at the client, propagated as a request header, attached to event metadata and job payloads, and recorded alongside the transaction hash. The genuinely hard part is propagation across the asynchronous boundary — the identifier has to survive into background jobs and into retries that happen long after the originating request ended. Logs must not capture key material or full signed envelopes.",
  ["A correlation identifier is generated client-side and propagated through headers, events and job payloads.",
   "Logging is structured, with the identifier on every line emitted while handling a request or job.",
   "The identifier survives into background jobs and into retries issued in later sessions.",
   "A documented procedure retrieves the full trace of one donation attempt from its identifier.",
   "No log line can contain key material or a full signed transaction envelope, asserted by a test."],
  ["backend/src/server.js", "backend/src/eventSourcing/eventStore.js", "backend/src/services/summaryQueue.js"], area="Cross-cutting"),

B("Socket.IO events are an untyped contract with no shared schema between backend and clients",
  "Realtime event names and payload shapes are string literals duplicated in the backend emitters and in each client consumer. Nothing checks that a client's expectations match what the server sends.",
  "The backend emits donation and project events; the frontend consumes them through its socket hook and mobile has its own consumer. Event names and field shapes exist independently in each place, so renaming a field or changing a payload silently breaks consumers at runtime with no build error and no test failure. There is also no documented contract for delivery semantics — whether an event can arrive twice, arrive out of order relative to the REST view, or be missed entirely during a reconnect — yet clients merge these events into state that must not double-count.",
  "Define the event contract in one shared place with runtime validation at the consumer boundary, since the transport carries arbitrary JSON and compile-time types are erased. Document the delivery semantics explicitly and make consumers correct under them: at-least-once delivery means every consumer needs idempotent merge, and the reconnect gap needs either replay or reconciliation against the REST view.",
  ["Event names and payload schemas are defined once and consumed by backend and clients.",
   "Consumers validate payloads at runtime and reject malformed events without corrupting state.",
   "Delivery semantics are documented, and consumers are idempotent under them.",
   "Reconnect behaviour is specified — replay or reconcile — and implemented.",
   "A test asserts a consumer receiving the same event twice does not double-count."],
  ["backend/src/server.js", "frontend/hooks/useDonationSocket.ts"], area="Cross-cutting"),

B("Environment variables are read ad hoc across the backend with no startup validation",
  "Roughly 54 `process.env` reads are scattered through the backend, most with inline fallbacks. A missing or misspelled variable is discovered when the code path that needs it first runs, which for admin authentication or queue configuration may be long after deploy.",
  "Values are read at point of use with `||` defaults, so there is no single inventory of what the service requires. The admin login route illustrates the failure mode: a missing password variable is only discovered when someone attempts to log in, returning a 503 at that moment rather than refusing to start. `.env.example` files exist for backend and frontend but nothing verifies they list every variable actually read, so they drift. A production-only variable that is silently absent falls back to a development default, which is the more dangerous version of the same problem.",
  "Validate the full environment once at startup against a schema, failing fast with a message naming every missing or malformed variable at once. Distinguish genuinely optional variables from those that merely have a development default — the latter must not silently apply in production. Add a CI check that `.env.example` and the schema agree, so drift becomes a build failure.",
  ["A single schema declares every environment variable with its type and whether it is required.",
   "Startup fails with a message listing all problems at once, not the first one found.",
   "Development-only defaults cannot silently apply in production.",
   "CI asserts `.env.example` matches the schema for backend and frontend.",
   "No `process.env` read remains outside the configuration module."],
  ["backend/src/server.js", "backend/.env.example", "frontend/.env.example"], area="Cross-cutting"),

B("Rate limiting is per-IP only, which is both trivially evaded and unfairly shared",
  "Limits key on client IP. Donors behind a carrier NAT or a corporate egress share one bucket and throttle each other, while an attacker with a pool of addresses is barely constrained.",
  "The rate limiter is applied to sensitive routes including admin login, but IP is the only dimension. Mobile users on cellular networks routinely share egress addresses, so one heavy user can lock out an entire carrier range; conversely the admin login limit of ten attempts per fifteen minutes per IP is not a meaningful barrier against a distributed attempt. Nothing rate-limits per wallet address or per authenticated subject, so an authenticated actor is unconstrained regardless of source address, and there is no global backpressure on expensive endpoints.",
  "Layer the limits: per-IP as a coarse floor, plus per-wallet and per-authenticated-subject limits for actions tied to an identity, plus a global cap on expensive operations. Correct source-address extraction behind the proxy matters here — a trust-proxy misconfiguration makes the IP dimension either forgeable or uselessly collapsed to the load balancer. Admin login specifically wants progressive delay tied to the account rather than the address.",
  ["Limits are keyed on wallet address and authenticated subject where an identity exists, not only IP.",
   "Proxy trust configuration is explicit and correct; a test asserts the extracted address behind a proxy.",
   "Admin login applies progressive delay per account in addition to per-IP limits.",
   "Expensive endpoints have a global cap independent of per-client limits.",
   "Tests cover shared-NAT clients not starving each other and a distributed attempt still being bounded."],
  ["backend/src/middleware/rateLimiter.js", "backend/src/routes/admin.js", "backend/src/server.js"], area="Cross-cutting", security=True),

B("No test exercises a donation end to end across contract, backend indexer and read model",
  "Each layer is tested in isolation with the others mocked, so the interfaces between them — the places where representations actually disagree — are the least covered part of the system.",
  "Contract tests run against the Soroban test environment; backend tests mock chain interaction; frontend tests mock the API. Nothing runs a donation through a deployed contract, observes the resulting on-chain event, drives the backend's ingestion path and asserts the read model converges to the right totals. Every defect this project has hit at a boundary — amounts double-counted between command bus and projection, database identifiers used as chain cursors, exact decimals read as floats — lives precisely in that untested gap.",
  "Build a test that runs against a local network with the contracts deployed, submits a real donation, and asserts the read model converges. The hard parts are determinism and time: chain finality is asynchronous, so the test needs a convergence assertion with a bounded wait rather than a fixed sleep, and it must be able to run in CI without depending on a public network being reachable or funded.",
  ["A test deploys contracts to a local network, submits a donation, and asserts the resulting read-model totals.",
   "The test asserts convergence with a bounded wait, not a fixed sleep, and is not flaky over repeated runs.",
   "It runs in CI without depending on a public network.",
   "Exact amounts are asserted at stroop precision through every layer.",
   "A failure at any boundary produces a message identifying which layer diverged."],
  ["contracts", "backend/src/eventSourcing", "frontend/playwright.integration.config.ts"], area="Cross-cutting"),

B("Accessibility is enforced only on the frontend; mobile and the extension have no checks and few affordances",
  "The frontend runs automated accessibility scans in end-to-end tests. Mobile has roughly fifty touchable elements across a dozen screens with about four accessibility properties among them, and the extension has none at all.",
  "The frontend's Playwright suite scans pages for violations, but that coverage stops at the web app. In mobile, tappable controls largely lack accessibility labels, roles and state, so screen-reader users get unlabelled buttons — including in the donation flow, where an unlabelled confirm control is a genuine hazard. The extension's popup and its injected tooltip have no roles, no keyboard path and no focus management; the tooltip in particular is mouse-only. The frontend also has gaps its automated scan cannot catch: the graph canvas exposes no non-visual alternative, and the giving-setup modal has no dialog role, focus trap or dismiss-on-escape.",
  "Extend automated checks where the platform allows, but note that automated scanning catches only a minority of real barriers — the modal, canvas and tooltip problems here need manual keyboard and screen-reader testing. Establish a baseline standard, add per-platform tooling, and cover the donation flow first on every platform since it is the one path that must work for everyone.",
  ["Mobile controls have accessibility labels, roles and state; the donation flow is verified with a screen reader on both platforms.",
   "The extension popup is fully keyboard-navigable with correct roles and focus management.",
   "Modal dialogs have a dialog role, a focus trap and escape-to-dismiss.",
   "The graph canvas exposes a keyboard-accessible non-visual alternative.",
   "Automated checks run in CI for every platform that supports them, with manual test procedures documented for what they cannot cover."],
  ["mobile/app/donate/[id].tsx", "extension/src/popup.ts", "frontend/components/MonthlyGivingSetup.tsx"], area="Cross-cutting"),

B("Internationalization exists only in the frontend, and even there it is largely unused",
  "The frontend ships English, Spanish and Arabic locale files. Mobile and the extension have no internationalization at all — every string is a hardcoded English literal.",
  "Three synchronized locale files back the frontend, but the donation flow itself is hardcoded, and mobile and the extension have no locale infrastructure whatsoever. For a platform whose stated purpose is transparent climate giving across regions, the two clients closest to the donor are English-only. Right-to-left support compounds this: the frontend uses logical CSS properties so its layout adapts, but mobile has no right-to-left handling and the extension's injected tooltip positions itself with hardcoded left-to-right assumptions, so an Arabic-language page gets a tooltip on the wrong side.",
  "Extend a shared translation approach across all three clients rather than adding a second unrelated system per platform, and share the message catalogue so a translated string is written once. Right-to-left needs real layout work on mobile and in the injected extension content, not just string substitution — and pluralization rules differ enough between the supported languages that manual count formatting will be wrong for at least one.",
  ["Mobile and the extension have working internationalization with the same locale coverage as the frontend.",
   "The message catalogue is shared so a translated string is authored once.",
   "Right-to-left layout is correct on mobile and for injected extension content, verified by screenshots.",
   "Counts use proper plural rules on every platform, not manual branching.",
   "CI fails when a key is missing from any locale on any platform."],
  ["frontend/lib/i18n.tsx", "mobile", "extension/src"], area="Cross-cutting"),

B("No dependency vulnerability scanning for the JavaScript workspaces",
  "Container images are scanned, and secrets are scanned, but nothing audits the dependency trees of the backend, frontend, mobile or extension packages — where the overwhelming majority of the code actually shipped comes from.",
  "The image scan inspects operating-system packages and whatever the scanner detects in the final layer, which is not equivalent to auditing four separate lockfiles. Mobile and the extension are never containerized at all, so their dependencies are scanned by nothing whatsoever — and the mobile application is a signed artifact distributed to devices. There is also no scanning of the Rust or Go dependency trees, and no automated dependency update mechanism, so trees age until an upgrade becomes a large risky change rather than a routine small one.",
  "Add per-ecosystem auditing with a documented policy for what severity blocks a merge — an unconditional block on every advisory produces alert fatigue and gets disabled, which is worse than a calibrated gate. Pair it with automated update pull requests so the tree stays current, and a documented triage path for advisories with no available fix, since blocking on an unfixable transitive advisory otherwise stops all work.",
  ["Every JavaScript workspace, plus the Rust and Go trees, is audited in CI.",
   "A documented severity policy determines what blocks a merge; suppressions require a written rationale and an expiry.",
   "Automated dependency update pull requests are enabled for all ecosystems.",
   "Advisories with no available fix have a documented triage path that does not block unrelated work.",
   "Mobile and extension dependencies are covered despite not being containerized."],
  [".github/workflows/ci.yml", "backend/package.json", "mobile/package.json", "extension/package.json"], area="Cross-cutting", security=True),

B("The restore drill verifies that a restore runs, not that the restored data is correct",
  "A backup that restores without error but is missing recent writes, or silently truncated, passes the current drill. The drill proves the mechanism works; it does not prove the data survived.",
  "There is a backup workflow and a restore drill workflow, which is already better than most projects manage. But a restore drill's value lies in what it asserts afterwards: whether every table is present with expected row counts, whether donation totals in the restored copy match the source, whether the event stream is contiguous with no gaps, and how much data the actual recovery point loses. Without those assertions the drill confirms only that a dump file can be loaded. The event-sourced design raises the stakes — a gap in `event_stream` means the read model can never be correctly rebuilt.",
  "Add substantive post-restore verification: schema completeness, row counts, monetary totals reconciled against the source, and event-stream contiguity. Measure and record the actual recovery point and recovery time objectives the drill demonstrates, rather than assuming them, and make the drill fail loudly if either regresses.",
  ["The drill asserts schema completeness, per-table row counts and reconciled monetary totals after restore.",
   "Event-stream contiguity is verified; any sequence gap fails the drill.",
   "Measured recovery point and recovery time objectives are recorded on each run and regressions fail.",
   "The drill covers restoring to a specific point in time, not only the latest backup.",
   "The runbook is written so someone who has never done it can follow it under pressure."],
  [".github/workflows/db-restore-drill.yml", ".github/workflows/database-backup.yml"], area="Cross-cutting"),

B("The backend exposes no metrics, so nothing about donation health is observable in production",
  "There is no metrics endpoint and no instrumentation. Whether donations are succeeding, whether the job queue is draining, and whether projections are keeping up are all invisible until a user reports a problem.",
  "The event-sourced architecture has specific health signals that matter and are currently unmeasured: projection lag behind the event stream, job queue depth and permanent-failure rate, donation success and failure counts split by failure mode, and Horizon and RPC latency and error rates. The adaptive batching in the event-sourcing layer tunes itself with no exported signal, so nobody can tell whether it is behaving well or oscillating. The Kubernetes manifests define no service monitor and no alerting.",
  "Instrument the paths that carry money first — donation outcomes by failure mode, projection lag, queue depth — and expose them for scraping. The design work is choosing labels with bounded cardinality: labelling by project identifier is the obvious mistake, since it grows without limit. Alerts should be defined on the resulting signals, with thresholds justified rather than guessed.",
  ["A metrics endpoint exposes donation outcomes by failure mode, projection lag, queue depth and permanent failures.",
   "Chain interaction latency and error rate are instrumented.",
   "Label cardinality is bounded, with no per-project or per-donor labels.",
   "Kubernetes manifests include scrape configuration, and alerts with justified thresholds are defined.",
   "A dashboard covering the donation path is documented alongside the metric definitions."],
  ["backend/src/server.js", "backend/src/eventSourcing/projections.js", "k8s"], area="Cross-cutting"),

B("Recurring donations and campaign deadlines have no explicit timezone or daylight-saving policy",
  "Recurring schedules and campaign deadlines are handled without a stated policy for which timezone governs them, so behaviour around daylight-saving transitions and month boundaries is whatever the implementation happens to do.",
  "A monthly recurring donation set up on the 31st has no defined behaviour in a 30-day month. A schedule anchored to a local time crosses a daylight-saving boundary twice a year, either skipping an occurrence or running one twice. Campaign deadlines are compared against client clocks in the countdown display and against server time when enforced, so a donor can see a campaign as open that the server considers closed. None of this is documented, and the countdown component recomputes against the browser clock, which the user can set arbitrarily.",
  "State the policy explicitly — store instants in UTC, store the intended local timezone alongside any user-facing recurrence, and compute occurrences in that timezone so the local time stays stable across daylight-saving transitions. Define month-end behaviour deliberately. Deadline enforcement must be server-authoritative with the client display derived from a server-provided instant, so a skewed client clock cannot mislead a donor into a donation that gets rejected.",
  ["Instants are stored in UTC with the intended timezone stored alongside recurrence rules.",
   "Month-end and daylight-saving behaviour is defined, documented and covered by tests including a 31st-of-month monthly schedule.",
   "Deadline enforcement is server-authoritative; client countdowns derive from a server-provided instant.",
   "A test asserts no occurrence is skipped or duplicated across both daylight-saving transitions.",
   "The policy is documented where a contributor adding a scheduled feature will find it."],
  ["backend/src/services", "mobile/app/recurring.tsx", "frontend/pages/projects/[id].tsx"], area="Cross-cutting"),

B("Validation logic is reimplemented in every subsystem with no shared source of truth",
  "Address formats, donation amount bounds, project field limits and status values are each defined independently in the backend schemas, the frontend, mobile and the extension. They disagree, and nothing detects it.",
  "The address validation split is the clearest instance, but the pattern is general: amount bounds enforced client-side may differ from what the server accepts and from what the contract enforces, so a donation can pass two layers and fail the third with an opaque error. Project status values are enumerated in the backend schema, again in the contract and again in client display logic. Field length limits differ between the client form and the server schema, so a user can type a description the server will reject. Each divergence surfaces as a confusing late failure rather than immediate inline feedback.",
  "Define shared validation once and consume it everywhere. The genuine constraint is that four runtimes are involved — Node, browser, React Native and Rust — so a single shared module cannot cover all of them; the realistic approach is one machine-readable definition with generated or verified per-runtime implementations, plus a conformance suite every implementation must pass. The contract's rules are authoritative wherever they apply, since it is the layer that cannot be bypassed.",
  ["Shared validation rules are defined once in a machine-readable form.",
   "Backend, frontend, mobile and extension derive their validation from it rather than reimplementing.",
   "A conformance suite of shared test vectors is executed by every implementation, including the contract.",
   "Where the contract enforces a rule, its bounds are authoritative and clients match exactly.",
   "CI fails when any implementation diverges from the shared definition."],
  ["backend/src/schemas", "frontend/lib/stellar.ts", "mobile/utils/stellarValidation.ts", "contracts"], area="Cross-cutting"),

]

if __name__ == "__main__":
    main()
