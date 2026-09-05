#!/usr/bin/env python3
"""
scripts/create_platform_depth_issues.py

Opens twenty large contributor issues covering platform depth: production
correctness, data integrity, reach and trust. Each is grounded in something
verified in this repository rather than a generic best practice.

Idempotent: fetches every existing issue title first and skips anything
already present, and refuses to run if two issues in this batch share a title.

    python3 scripts/create_platform_depth_issues.py --dry-run
    python3 scripts/create_platform_depth_issues.py
"""
import argparse
import os
import subprocess
import sys
import time

import requests

REPO = "Stellar-Search/GreenPay"
API = f"https://api.github.com/repos/{REPO}"

TOKEN = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
if not TOKEN:
    try:
        TOKEN = subprocess.check_output(["gh", "auth", "token"], text=True).strip()
    except Exception:
        TOKEN = None
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


def body_for(i: dict) -> str:
    parts = [
        f"> **Goal this serves — {i['goal']}**",
        "## Why this matters\n\n" + i["why"],
        "## Evidence\n\n" + i["evidence"],
        "## Why this is hard\n\n" + i["hard"],
        "## Suggested approach\n\n" + i["approach"],
        "## Acceptance criteria\n\n" + "\n".join(f"- [ ] {c}" for c in i["acceptance"]),
        "## Scope\n\n" + i["scope"],
        "## Relevant files\n\n" + "\n".join(f"- `{f}`" for f in i["files"]),
    ]
    if i.get("related"):
        parts.append("## Related\n\n" + i["related"])
    return "\n\n".join(parts)


def create_issue(i: dict, dry_run: bool = False) -> None:
    title = f"{i['area']}: {i['title']}"
    labels = ["complexity: high", i["label"]]
    if i.get("security"):
        labels.append("security")
    if dry_run:
        print(f"    [dry-run] {title}")
        return
    r = SESSION.post(f"{API}/issues", json={"title": title, "body": body_for(i), "labels": labels})
    if r.status_code >= 300:
        print(f"    ERROR {r.status_code}: {r.text[:300]}", file=sys.stderr)
        r.raise_for_status()
    print(f"    created #{r.json()['number']}")


def I(area, label, goal, title, why, evidence, hard, approach, acceptance, scope, files,
      related=None, security=False):
    return dict(area=area, label=label, goal=goal, title=title, why=why, evidence=evidence,
                hard=hard, approach=approach, acceptance=acceptance, scope=scope, files=files,
                related=related, security=security)


SCOPE_6K = "Roughly **5,000–7,000 lines**, including tests."

ISSUES = [

    I("Backend", "area: backend",
      "Real-time donation feed (README feature) working in production",
      "Socket.IO has no multi-instance adapter, so the live donation feed only reaches clients on the same pod",
      "The live donation feed is a headline feature — donors watch contributions arrive in real time, and it is a "
      "large part of what makes the platform feel transparent. In production it is silently broken for most "
      "viewers.\n\n"
      "The backend autoscales to a minimum of two replicas. Socket.IO keeps connections in per-process memory, so "
      "an `io.emit` from the pod that handled a donation reaches only the clients connected to that pod. With two "
      "replicas roughly half of connected donors never see the event; at ten replicas, ninety percent do not. "
      "Nothing errors, no test fails, and locally with one process it looks perfect.",
      "```yaml\n# k8s/hpa.yaml:32-33\nminReplicas: 2\nmaxReplicas: 10\n```\n\n"
      "```js\n// backend/src/server.js:100\nconst io = new Server(server, { ... });   // no adapter\n```\n\n"
      "`ioredis` is already a backend dependency, so the transport this needs is present but unused. There is also "
      "no session affinity in the Ingress definitions, which matters for the HTTP long-polling fallback.",
      "**It is invisible in every environment a developer uses.** One process locally, one process in most test "
      "setups. The bug only exists at two or more replicas, so reproducing it requires a genuinely multi-instance "
      "test harness — building that is a real part of this work.\n\n"
      "**Polling fallback needs affinity, WebSockets do not.** Socket.IO upgrades from long-polling, and the "
      "handshake sequence must land on the same pod. That is an Ingress concern, not an application one, so the fix "
      "spans code and manifests.\n\n"
      "**Delivery semantics need deciding.** A donor whose socket drops during a reconnect currently misses events "
      "entirely. Whether the system replays, reconciles against REST, or accepts the gap is a design decision that "
      "affects every consumer.\n\n"
      "**Redis becomes a new failure mode.** If the adapter's backing store is unavailable, the question is whether "
      "the feed degrades to single-pod delivery or fails loudly.",
      "Introduce a shared adapter backed by the existing Redis dependency and prove it with a test that runs two "
      "backend processes and asserts an event emitted by one reaches a client attached to the other.\n\n"
      "Configure session affinity for the polling handshake in the Ingress resources, and decide explicitly whether "
      "to pin to WebSocket-only transport instead.\n\n"
      "Define reconnect behaviour rather than leaving it implicit — clients should be able to establish what they "
      "missed.",
      ["An event emitted by one backend process reaches clients connected to any other, proven by a multi-process test.",
       "Session affinity is configured for the polling handshake, or WebSocket-only transport is chosen with the trade-off documented.",
       "Reconnect behaviour is defined and implemented: a client can determine and recover what it missed while disconnected.",
       "Adapter-store unavailability degrades in a documented way rather than silently dropping events.",
       "The test harness runs at least two backend instances in CI, not one.",
       "Connection counts and delivery are observable per pod so the failure mode cannot recur unnoticed.",
       "Load characteristics are measured at a realistic replica count and recorded.",
       "Existing single-instance behaviour in local development is unchanged."],
      SCOPE_6K,
      ["backend/src/server.js", "k8s/backend.yaml", "k8s/hpa.yaml",
       "frontend/hooks/useDonationSocket.ts", "backend/src/services/indexerService.js"],
      related="Complements #375 (untyped event contract) and #134 (no reconnect backfill) — this issue is about "
              "delivery across replicas, those are about payload shape and client recovery."),

    I("Cross-cutting", "area: cross-cutting",
      "Diagnosing donation failures — radical transparency requires knowing what happened",
      "No distributed tracing links a donation across client, API, event store, job queue and chain",
      "When a donor reports that their donation failed, there is currently no way to reconstruct what happened. The "
      "attempt crosses a browser or phone, an HTTP handler, the event store, a background job and Horizon, and "
      "nothing carries an identifier through those hops. Support means correlating by timestamp across separate "
      "logs and hoping.\n\n"
      "This matters more here than in most systems because donations can span days — the offline queue on mobile "
      "and the record-failure recovery on web both mean one logical donation may involve several sessions.",
      "There is a structured logger at `backend/src/utils/logger.js` that reads a correlation identifier from "
      "async storage, and the API sets an `X-Correlation-ID` response header. But the identifier does not "
      "originate at the client, is not propagated into background jobs, and is not recorded alongside the "
      "transaction hash.\n\n"
      "No tracing library is present anywhere: a search for OpenTelemetry or an equivalent across `backend/src` "
      "returns nothing. Spans, timings and cross-service causality do not exist.",
      "**The asynchronous boundary is the whole problem.** Propagating a header through synchronous HTTP is "
      "routine. Carrying causality into an event appended now and projected later, or into a job retried hours "
      "afterwards, is not — and that is exactly where donations get lost.\n\n"
      "**The chain is outside the trace.** Horizon submission is the one hop that cannot be instrumented. Linking "
      "a trace to a transaction hash, and back, is the only way to close the loop.\n\n"
      "**Sampling versus completeness.** Tracing everything is expensive; sampling means the failure you need is "
      "often the one not sampled. Donation flows likely warrant complete capture while browse traffic does not.\n\n"
      "**Nothing may leak.** Traces must never carry secret keys, signed envelopes or donor personal data, and that "
      "has to be enforced structurally rather than by reviewer vigilance.",
      "Generate the identifier at the client so the trace begins where the donation does, propagate it as a header, "
      "attach it to event metadata and job payloads, and store it beside the transaction hash so a trace can be "
      "found from a chain record and vice versa.\n\n"
      "Instrument spans across the request, the projection and the job execution. Decide sampling per route rather "
      "than globally.\n\n"
      "Enforce redaction at the exporter, and prove it with a test that asserts key material cannot appear in an "
      "emitted span.",
      ["A correlation identifier originates at the client and survives into background jobs and later-session retries.",
       "Spans cover the HTTP request, the event append, the projection and the job execution, with causal links intact.",
       "A trace can be found from a transaction hash, and a transaction hash from a trace.",
       "Sampling is configured per route, with donation flows captured completely.",
       "Redaction is enforced at the exporter and proven by a test asserting key material and signed envelopes cannot appear.",
       "A documented procedure retrieves the full history of one donation attempt from a single identifier.",
       "The 100 remaining `console.*` calls on the donation path are migrated to the structured logger.",
       "Overhead is measured and recorded against a baseline."],
      SCOPE_6K,
      ["backend/src/utils/logger.js", "backend/src/server.js", "backend/src/eventSourcing/eventStore.js",
       "backend/src/services/summaryQueue.js", "frontend/lib/api.ts"]),

    I("Backend", "area: backend",
      "Donors finding projects to fund — discovery drives donations",
      "Project search is a substring LIKE scan with no ranking, so results are effectively arbitrary",
      "Search is how a donor finds a cause they care about. Today it is a case-insensitive substring match across "
      "name and description, returned in whatever order the database produces. A search for *reforestation* ranks a "
      "project mentioning the word once in passing identically to one whose entire purpose it is. There is no "
      "typo tolerance, no stemming, no relevance, and no way to narrow by what a donor actually cares about.\n\n"
      "A donor who cannot find a project they connect with does not donate.",
      "```js\n// backend/src/routes/projects.js:176-180\nif (search && typeof search === \"string\") {\n"
      "  values.push(`%${search}%`);\n  ...\n    name ILIKE $N\n    OR description ILIKE $N\n```\n\n"
      "A leading-wildcard `ILIKE` cannot use a standard index, so this degrades to a sequential scan that worsens "
      "linearly as the project count grows. There is no `to_tsvector` column, no trigram index, and no ranking "
      "term anywhere in the query.",
      "**Relevance is a product decision disguised as a technical one.** Should a verified project outrank a better "
      "textual match? Should a project near its funding goal be boosted, or one that is struggling? These choices "
      "shape where donations flow, and they deserve to be explicit and tunable rather than emergent.\n\n"
      "**Multilingual content breaks naive stemming.** Project descriptions may be in several languages, and a "
      "single stemming configuration will handle some badly.\n\n"
      "**Facets interact with permissions.** Counts must reflect only projects the requester may see, or they leak "
      "the existence of unlisted ones.\n\n"
      "**Ranking needs evaluation.** Without a labelled set of queries and expected results, changes to ranking are "
      "guesswork and regressions are invisible.",
      "Introduce a proper text search index with stemming and trigram support for typo tolerance, and a ranking "
      "function that combines textual relevance with signals the project chooses deliberately.\n\n"
      "Add facets — category, status, verification, funding progress, location — with counts computed under the "
      "same visibility rules as the results.\n\n"
      "Build a small evaluation harness with labelled queries so ranking changes can be measured rather than "
      "argued about.",
      ["Search uses an indexed text search with stemming and typo tolerance; no leading-wildcard scan remains on the hot path.",
       "Results are ranked by an explicit, documented and tunable function rather than database order.",
       "Facets are available with counts computed under the same visibility rules as the results themselves.",
       "Ranking signals beyond text relevance are explicit configuration, not hardcoded.",
       "An evaluation harness with labelled queries measures ranking quality, and changes report their effect.",
       "Search latency is measured at a realistic project count and meets a documented budget.",
       "Multilingual descriptions are handled with a stated strategy, not silently mis-stemmed.",
       "Existing search API consumers keep working, or the change is versioned."],
      SCOPE_6K,
      ["backend/src/routes/projects.js", "backend/src/db/schema.sql", "frontend/pages/projects.tsx"]),

    I("Backend", "area: backend",
      "Correct, stable listings as data grows",
      "Offset pagination across the API returns duplicated and skipped rows once data changes between pages",
      "Ten list endpoints paginate with `LIMIT` and `OFFSET`. That is correct only if nothing is inserted or "
      "deleted while a client pages through — and on a donation platform the most active lists are exactly the "
      "ones changing constantly. A donation arriving between page one and page two shifts every subsequent row, so "
      "a donor sees the same entry twice and never sees another at all.\n\n"
      "Deep offsets also force the database to walk and discard every skipped row, so page fifty costs far more "
      "than page one for the same payload.",
      "```\n$ git grep -InE 'LIMIT \\$|OFFSET \\$' -- backend/src/routes | wc -l\n10\n```\n\n"
      "Several of these queries have no `ORDER BY` that is guaranteed unique, which means even a static dataset can "
      "return rows in a different order between requests — pagination over a non-deterministic ordering is "
      "undefined regardless of insert activity.",
      "**Keyset pagination requires a total ordering.** Ordering by a timestamp alone is not enough when two rows "
      "share a value; a unique tiebreaker must be part of both the sort and the cursor.\n\n"
      "**Cursors are a compatibility surface.** Once issued, a cursor may be used later. Encoding the sort key "
      "directly leaks schema and breaks when ordering changes; opaque cursors need versioning.\n\n"
      "**Not every list can drop offsets.** Jumping to an arbitrary page is incompatible with keyset pagination, so "
      "any interface offering numbered pages needs rethinking rather than a mechanical swap.\n\n"
      "**Aggregate counts are expensive.** Exact totals over large filtered sets cost as much as the query itself, "
      "and the honest answer is often an estimate or no count at all.",
      "Define one cursor format used by every list endpoint, opaque and versioned, carrying the full sort key "
      "including its tiebreaker. Ensure every paginated query has a total ordering.\n\n"
      "Replace numbered-page interfaces with continuation-based ones where keyset pagination applies, and be "
      "explicit about where exact totals are dropped in favour of estimates.\n\n"
      "Prove correctness with tests that insert and delete rows mid-pagination and assert no row is duplicated or "
      "skipped.",
      ["Every paginated endpoint uses keyset pagination over a guaranteed total ordering.",
       "Cursors are opaque and versioned; an old cursor either works or fails with a clear, actionable error.",
       "A test inserts and deletes rows between page fetches and asserts no duplication and no skipping.",
       "Interfaces offering numbered pages are converted to continuation-based navigation, or the exception is justified.",
       "Where exact totals are dropped, the API says so explicitly rather than returning a wrong number.",
       "Deep-page latency no longer grows with offset depth; before and after measurements are recorded.",
       "Existing consumers keep working through a documented transition, or the change is versioned.",
       "The pagination contract is documented once and referenced by every endpoint that implements it."],
      SCOPE_6K,
      ["backend/src/routes", "backend/src/db/schema.sql", "docs/openapi.yml", "frontend/lib/api.ts"]),

    I("Backend", "area: backend",
      "Trustworthy totals — the event store is only useful if it can be replayed",
      "There is no safe way to rebuild a projection, so a bug in read-model logic is unrecoverable",
      "The platform is event-sourced: `event_stream` is the authoritative record and read models are derived from "
      "it. The entire point of that design is that a derived view can be discarded and rebuilt from the events. "
      "There is no mechanism to do so.\n\n"
      "This is not hypothetical. A double-counting bug inflated donation totals, and the fix could only stop new "
      "damage — the existing wrong values remain because nothing can recompute them. Every future projection bug "
      "has the same permanent consequence.",
      "`backend/src/eventSourcing/` contains an event store, a command bus and projections, and `schema.sql` "
      "carries `idx_event_stream_processed`, so processing position is tracked. What does not exist is any way to "
      "reset that position, rebuild a projection from scratch, or run a new projection version alongside the old "
      "one.\n\n"
      "Issue #368 records the concrete consequence: totals inflated by a historical bug, with recomputation from "
      "`event_stream` identified as the fix and nothing available to perform it.",
      "**Rebuilding while serving traffic.** Taking the site down to rebuild is not acceptable, so a rebuild has to "
      "run alongside live projection, catch up to the live position, and switch over atomically.\n\n"
      "**Event schema evolves.** Events written a year ago may lack fields today's projection expects. Versioned "
      "events and upcasting are unavoidable once replay is real.\n\n"
      "**Side effects must not replay.** Projections that send email or enqueue jobs cannot be naively re-run — "
      "rebuilding must not re-notify every donor in the platform's history.\n\n"
      "**Correctness needs proving.** A rebuild that silently produces different numbers is worse than none. There "
      "must be a way to compare a rebuilt projection against the live one before switching.",
      "Make projections explicitly versioned and independently positioned so a new version can be built from the "
      "beginning of the stream while the current one keeps serving.\n\n"
      "Separate pure derivation from side effects so replay is safe by construction rather than by remembering to "
      "disable notifications.\n\n"
      "Provide a comparison mode that reports divergence between a rebuilt and live projection before any "
      "switchover, and make the switch atomic and reversible.\n\n"
      "Use this to recompute the totals #368 describes as the first real exercise of the mechanism.",
      ["A projection can be rebuilt from the start of the event stream while the current one continues serving.",
       "Projections are versioned and independently positioned.",
       "Side-effecting behaviour is separated from derivation so replay cannot re-notify or re-enqueue.",
       "A comparison mode reports divergence between rebuilt and live projections before switchover.",
       "Switchover is atomic and reversible.",
       "Event schema versioning and upcasting are supported, with a worked example of an evolved event.",
       "Rebuild progress and estimated completion are observable.",
       "The inflated totals described in #368 are recomputed using this mechanism, with a before-and-after diff recorded.",
       "A rebuild of representative data completes within a documented time budget."],
      SCOPE_6K,
      ["backend/src/eventSourcing/projections.js", "backend/src/eventSourcing/eventStore.js",
       "backend/src/db/schema.sql"],
      related="Provides the mechanism #368 needs."),

    I("Backend", "area: backend",
      "“Every transaction tracked on-chain” (README) — the indexer is what makes that true",
      "The chain indexer has no gap detection, reorg handling or backfill, so donations can be missed permanently",
      "The indexer is the component that makes the platform's central claim true: it watches project wallets and "
      "records donations that arrive on-chain, including ones no client ever reported. If it misses a payment, that "
      "donation exists on Stellar and does not exist on the platform — the donor's contribution is invisible, their "
      "leaderboard position is wrong, and the project's total understates reality.\n\n"
      "It persists a cursor and resumes from it, which handles a clean restart. It does not handle the cases that "
      "actually occur.",
      "`backend/src/services/indexerService.js` maintains `horizon_operations_cursor` and flushes it periodically. "
      "A search across that file for reorg, gap, backfill or catch-up handling returns nothing.\n\n"
      "Concretely: the cursor is flushed on an interval rather than per processed operation, so a crash between "
      "flushes reprocesses or skips depending on ordering; a project wallet added while the indexer is running is "
      "picked up only from that moment, with no backfill of prior donations; and there is no verification that the "
      "sequence of processed operations is contiguous.",
      "**Detecting a gap requires knowing what should have been there.** A cursor tells you where you are, not "
      "whether you skipped something. Contiguity has to be verified against the ledger rather than assumed.\n\n"
      "**Ledger history is large.** Backfilling a newly added wallet from genesis is impractical; scoping the "
      "backfill window correctly, and being honest about what falls outside it, is a design decision.\n\n"
      "**Exactly-once against an at-least-once source.** Reprocessing must be harmless, which means idempotency at "
      "the ingestion boundary rather than hoping the cursor is accurate.\n\n"
      "**Horizon is not always available.** Extended downtime, rate limiting and pagination limits all need "
      "handling that does not silently drop a window of history.\n\n"
      "**Silence is ambiguous.** No events can mean no donations or a broken indexer, and the system currently "
      "cannot tell those apart.",
      "Verify contiguity explicitly rather than trusting the cursor, and reconcile periodically against the chain "
      "to detect anything missed.\n\n"
      "Make ingestion idempotent so reprocessing is safe, then treat the cursor as an optimisation rather than a "
      "correctness mechanism.\n\n"
      "Support bounded backfill for newly added wallets and after extended downtime, and make indexer health "
      "observable so silence is distinguishable from failure.",
      ["Ingestion is idempotent: reprocessing an operation cannot create a duplicate donation, proven by a test.",
       "Gaps in processed history are detected rather than assumed absent, and detection is tested against a synthetic gap.",
       "A newly added project wallet is backfilled over a bounded, documented window.",
       "Extended Horizon downtime is recovered from without dropping a window of history.",
       "Rate limiting and pagination limits are handled with backoff rather than silent truncation.",
       "Indexer lag and health are observable, so a stalled indexer is distinguishable from a quiet period.",
       "A reconciliation pass compares on-chain payments to recorded donations and reports discrepancies.",
       "Cursor persistence semantics are documented, including exactly what a crash between flushes can cause."],
      SCOPE_6K,
      ["backend/src/services/indexerService.js", "backend/src/services/sorobanEventIndexer.js",
       "backend/src/db/schema.sql", "docs/indexer.md"]),

    I("Cross-cutting", "area: cross-cutting",
      "Operating lawfully in the jurisdictions donors live in",
      "There is no donor data export or erasure path, and on-chain donations make the usual answer wrong",
      "Donors have legal rights over their personal data in many jurisdictions, including the right to obtain a "
      "copy and, in defined circumstances, the right to have it erased. Neither exists here — there is no export "
      "endpoint, no deletion flow, and no defined position on what happens when a donor asks.\n\n"
      "This platform cannot answer with the usual pattern, because donations are recorded immutably on a public "
      "blockchain. Deleting a database row does not erase anything, and claiming it does would be worse than not "
      "offering the feature at all. Working out what can honestly be promised is the substance of this issue.",
      "```\n$ git grep -lIiE 'erasure|data export|deleteAccount|anonymi' -- backend/src frontend\n"
      "(no matches)\n```\n\n"
      "`docs/data-retention-policy.md` exists and describes retention intent, but no code enforces or implements "
      "it. The `profiles` and `donations` tables carry donor wallet addresses, and `donations` additionally carries "
      "an optional donor message — free text a donor may have put personal information into.\n\n"
      "A wallet address is pseudonymous, not anonymous: it is stable, publicly linkable across every donation, and "
      "in many regimes constitutes personal data.",
      "**The immutable record is the hard part.** What is deletable is the platform's off-chain association between "
      "a wallet and any identifying information, plus free-text content. The chain record cannot be touched, and "
      "the response has to say so plainly rather than implying erasure that did not happen.\n\n"
      "**Aggregates encode individuals.** Removing a donor while leaving totals and leaderboard positions intact "
      "can still identify them by subtraction — differential effects on public aggregates need thinking through.\n\n"
      "**Export must be complete to be honest.** A partial export is a compliance failure, so the work includes "
      "enumerating every store that holds donor data, including logs, caches and backups.\n\n"
      "**Backups outlive deletion.** Erasure that a restore reverses is not erasure, so retention and restore "
      "procedures are part of this.\n\n"
      "**This is not a lawyer-free zone.** The engineering should make the technically possible options clear so a "
      "policy decision can be made, rather than inventing one.",
      "Enumerate every location holding donor data — tables, caches, logs, backups, third-party services — and "
      "treat that inventory as a deliverable in its own right.\n\n"
      "Implement export as a complete, machine-readable extract covering that inventory.\n\n"
      "Implement erasure as removal of the off-chain association and free-text content, with an explicit, "
      "donor-facing explanation of what remains on-chain and why it cannot be removed.\n\n"
      "Make the retention policy enforced by scheduled deletion rather than documented and ignored.",
      ["Every store holding donor data is inventoried, and the inventory is verified by test rather than by hand.",
       "A donor can export all data held about them in a machine-readable format covering that full inventory.",
       "Erasure removes off-chain associations and free-text content, and states plainly what remains on-chain.",
       "The donor-facing explanation is accurate and does not imply erasure that did not occur.",
       "Effects on public aggregates and leaderboards are considered so a removed donor is not identifiable by subtraction.",
       "Interaction with backups is defined: an erasure is not silently reversed by a restore.",
       "The retention policy in `docs/data-retention-policy.md` is enforced by scheduled deletion, not just documented.",
       "Both flows are rate-limited and authenticated so they cannot be used to enumerate or grief other donors.",
       "The engineering options and their limits are documented clearly enough for a non-engineer to make the policy call."],
      SCOPE_6K,
      ["backend/src/routes/profiles.js", "backend/src/db/schema.sql",
       "docs/data-retention-policy.md", "backend/src/utils/logger.js"],
      security=True),

    I("Frontend", "area: frontend",
      "Donors finding the platform at all",
      "The site is invisible to search engines and social previews — no sitemap, robots or structured data",
      "A public donation platform depends on being findable. Someone searching for a reforestation project to "
      "support should be able to arrive at a project page from a search engine. Today they cannot, because nothing "
      "tells search engines the pages exist.\n\n"
      "The same gap affects sharing: a donor posting a project link gets no title, description or image preview, "
      "which measurably reduces click-through on exactly the channel that grows a donation platform.",
      "```\n$ git grep -lIiE 'next-seo|sitemap|robots' -- frontend\n(no matches)\n$ ls frontend/public/\n"
      "(no robots.txt, no sitemap.xml)\n```\n\n"
      "Project pages are server-rendered on demand — `_app.tsx` forces server-side rendering so the CSP nonce "
      "reaches every script — so the content is available to crawlers. Nothing declares it. There is no canonical "
      "URL handling, no Open Graph or card metadata, and no structured data describing projects or the "
      "organisation.",
      "**A sitemap over dynamic content must stay current.** Projects are created and change status continuously, "
      "so the sitemap has to be generated rather than committed, and must reflect visibility rules — unlisted or "
      "rejected projects must not appear.\n\n"
      "**Structured data invites scrutiny.** Marking up a project with donation and organisation metadata makes "
      "claims machine-readable, which means unverified impact figures would be published in a form aggregators "
      "consume. What is safe to expose depends on provenance.\n\n"
      "**Preview images need generating.** A useful share preview is project-specific, which means generated "
      "images, which means caching and invalidation.\n\n"
      "**Interaction with the CSP.** The existing nonce-based policy is strict, and metadata and image generation "
      "must fit within it rather than loosening it.",
      "Generate the sitemap from live project data, honouring visibility rules, and serve it alongside a robots "
      "policy that reflects which routes should be crawled.\n\n"
      "Add per-page metadata with canonical URLs, and structured data for projects and the organisation — "
      "restricted to claims the platform can stand behind.\n\n"
      "Generate share images per project with a caching strategy, and verify the result against real crawler and "
      "social-platform validators rather than assuming correctness.",
      ["A sitemap is generated from live data, honours visibility rules, and excludes unlisted and rejected projects.",
       "A robots policy is served and reflects which routes should be crawled.",
       "Every public page has title, description and canonical URL metadata; duplicates under different URLs resolve to one canonical.",
       "Structured data is emitted for projects and the organisation, restricted to claims the platform can stand behind.",
       "Share previews render correctly, verified against real social-platform validators.",
       "Generated preview images are cached with a defined invalidation strategy.",
       "All additions comply with the existing nonce-based CSP without loosening it.",
       "Crawlability is verified with a real crawler against a deployed build, not only in unit tests.",
       "Unverified impact figures are not exposed as machine-readable factual claims."],
      SCOPE_6K,
      ["frontend/pages/_app.tsx", "frontend/pages/projects/[id].tsx",
       "frontend/middleware.ts", "frontend/next.config.mjs"],
      related="Structured data should distinguish verified from unverified impact claims — see the impact "
              "provenance work."),

    I("Frontend", "area: frontend",
      "Donors on slow connections completing donations",
      "No performance budget: 349 kB of shared JavaScript loads before anything renders",
      "Every page loads 349 kB of shared JavaScript before rendering. On a fast connection that is invisible; on a "
      "mid-range phone over mobile data — which is how a large share of donors worldwide browse — it is many "
      "seconds of blank screen before a project page is usable.\n\n"
      "For a platform whose purpose is collecting donations, that delay sits directly in front of the conversion "
      "step. Nothing currently measures it, so it can regress indefinitely without anyone noticing.",
      "```\nFirst Load JS shared by all              349 kB\n  chunks/pages/_app-*.js                 258 kB\n```\n\n"
      "The application shell alone is 258 kB. Contributing factors are visible in the dependency set: the full "
      "Stellar SDK, a charting library, a 3D rendering library for the network graph, and an internationalisation "
      "message formatter — several of which are needed on a small number of routes but are paid for on all of "
      "them.\n\n"
      "No budget is enforced anywhere in CI, and no Core Web Vitals measurement exists.",
      "**The heavy dependencies are load-bearing.** The Stellar SDK is required to build and sign transactions, "
      "and cannot simply be dropped — it has to be deferred to the point of use without breaking the donation flow "
      "or reintroducing a delay at the worst moment.\n\n"
      "**Server-side rendering is mandatory here.** `_app.tsx` forces it so the CSP nonce reaches every script, "
      "which constrains which optimisations are available.\n\n"
      "**Budgets need enforcement to matter.** A measured number that does not fail a build regresses within "
      "weeks.\n\n"
      "**Field data differs from lab data.** Synthetic measurements miss what real donors experience, and the "
      "metric that matters — whether donations complete — is not a bundle size.",
      "Establish budgets per route and enforce them in CI so a regression fails the build with a clear diff of what "
      "grew.\n\n"
      "Defer route-specific heavy dependencies to their point of use, taking particular care that the donation flow "
      "does not simply move its delay to the moment of signing.\n\n"
      "Measure Core Web Vitals in the field rather than only in the lab, and connect the result to donation "
      "completion so the work is justified by outcome rather than by a number going down.",
      ["Per-route performance budgets are enforced in CI; exceeding one fails the build with a readable diff.",
       "Shared first-load JavaScript is materially reduced, with before and after figures recorded.",
       "Route-specific heavy dependencies load at point of use without introducing a delay inside the donation flow.",
       "The donation path is measured end to end and does not regress; this is asserted by a test.",
       "Core Web Vitals are collected from real sessions, not only synthetic runs.",
       "Server-side rendering and the nonce-based CSP continue to work unchanged.",
       "Donation completion rate is reported alongside performance metrics so impact is visible.",
       "A short guide explains how to add a dependency without breaking the budget."],
      SCOPE_6K,
      ["frontend/next.config.mjs", "frontend/pages/_app.tsx",
       "frontend/components/TransactionGraphVisualizer.tsx", "frontend/lib/stellar.ts", ".github/workflows/ci.yml"]),

    I("Frontend", "area: frontend",
      "Donations surviving bad connectivity, as they already do on mobile",
      "The web donation flow has no offline resilience, while mobile has a full queue and reconciliation",
      "The mobile app treats connectivity loss as normal: it queues a donation intent, reconciles against the chain "
      "when connectivity returns, and can recover a donation that reached Stellar but never reached the backend. "
      "The web app, which most donors use, has none of that. A connection lost at the wrong moment leaves the "
      "donor with an error and no path forward.\n\n"
      "The asymmetry is the point — the problem has already been solved once in this repository, on the platform "
      "where it is arguably less critical.",
      "`mobile/utils/donationQueue.ts` and `mobile/hooks/useDonationSync.ts` implement queueing, transaction-hash "
      "reconciliation and retry of backend confirmation without resubmitting to the chain.\n\n"
      "On web, `frontend/components/DonateForm.tsx` has a `record_failed` state that persists a transaction hash to "
      "local storage and offers a retry — a partial and welcome step — but there is no queue, no connectivity "
      "awareness, no background reconciliation, and nothing that survives the tab being closed before recovery.",
      "**Web storage is weaker than a phone's.** Local storage can be cleared, is per-origin and per-device, and "
      "private windows behave differently. A recovery mechanism that assumes persistence will lose donations.\n\n"
      "**No background execution.** A mobile app can reconcile on next launch; a closed tab cannot. Service workers "
      "offer a limited path with real constraints.\n\n"
      "**Never double-submit.** Any retry must reconcile against the chain first. Re-signing a donation the donor "
      "already made is the worst possible outcome and is precisely what a naive retry produces.\n\n"
      "**Signing cannot be deferred.** A queued intent is not a signed transaction — the wallet must be present. "
      "That makes web queueing meaningfully different from mobile's model.\n\n"
      "**Two implementations will diverge.** The reconciliation rules should be shared with mobile rather than "
      "written twice.",
      "Detect connectivity and represent a donation as a durable intent with explicit states rather than transient "
      "component state.\n\n"
      "Reconcile against the chain before any retry so a donation that already settled is recognised rather than "
      "repeated, and share those reconciliation rules with the mobile implementation instead of duplicating them.\n\n"
      "Be explicit about what web can and cannot recover — a closed tab before signing is genuinely unrecoverable, "
      "and the interface should say so rather than implying otherwise.",
      ["Connectivity loss is detected and communicated before the donor commits to an action that cannot complete.",
       "A donation is represented as a durable intent with explicit states that survive a page reload.",
       "Any retry reconciles against the chain first; a donation that already settled is never resubmitted, proven by a test.",
       "Reconciliation rules are shared with the mobile implementation rather than duplicated.",
       "Storage unavailability degrades gracefully and is covered by a test.",
       "The interface states plainly what cannot be recovered rather than implying full resilience.",
       "A donation that reached the chain but not the backend is recoverable on a later visit.",
       "Tests cover connection loss before signing, after signing but before submission, and after submission but before recording."],
      SCOPE_6K,
      ["frontend/components/DonateForm.tsx", "frontend/lib/stellar.ts",
       "mobile/utils/donationQueue.ts", "mobile/hooks/useDonationSync.ts"]),

    I("Mobile", "area: mobile",
      "Shipping fixes to donors' phones without waiting on store review",
      "There is no over-the-air update, staged rollout or crash reporting, so a bad mobile release is unrecoverable",
      "The mobile app handles the donation flow, including transaction signing. If a release contains a defect on "
      "that path — and this repository has already shipped one that made the donate screen unusable — there is "
      "currently no way to respond quickly. A fix waits on store review, and in the meantime every user has a "
      "broken app with no way to roll back.\n\n"
      "There is also no crash reporting, so a defect that does not produce a support message is simply invisible.",
      "`mobile/eas.json` now defines development, preview and production build profiles, which is the prerequisite "
      "for this work and is in place.\n\n"
      "What does not exist: no `expo-updates` configuration, so no over-the-air delivery; no `runtimeVersion` "
      "policy, so no way to express which native binary an update is compatible with; no staged rollout, so a "
      "release is all-or-nothing; and no crash or error reporting integration anywhere in the mobile tree.\n\n"
      "The consequence is concrete: the donate screen defects fixed recently would have reached every user and "
      "stayed there until a new store submission was reviewed.",
      "**Runtime version compatibility is the trap.** An over-the-air bundle that assumes native modules not "
      "present in the installed binary crashes on launch, and a crash on launch cannot be fixed over the air — the "
      "recovery channel is exactly what breaks. The policy must make that impossible by construction.\n\n"
      "**Rollback needs to be instant and tested.** A rollback path first exercised during an incident is not a "
      "rollback path.\n\n"
      "**Staged rollout needs a signal.** Releasing to a small percentage only helps if something detects that the "
      "cohort is failing, which requires crash reporting and a defined abort threshold.\n\n"
      "**Reports must not leak keys.** The app handles secret keys and signed envelopes; a crash reporter that "
      "captures state indiscriminately is a serious hazard, so scrubbing has to be structural.\n\n"
      "**Store policy applies.** Over-the-air updates are permitted within limits that the rollout process must "
      "respect.",
      "Adopt over-the-air updates with a runtime version policy that makes an incompatible bundle impossible to "
      "deliver rather than merely unlikely.\n\n"
      "Add crash and error reporting with structural scrubbing of key material, verified by test.\n\n"
      "Define staged rollout with an explicit abort threshold driven by the crash signal, and rehearse rollback "
      "before relying on it.",
      ["Over-the-air updates are configured with a runtime version policy that prevents delivering a bundle incompatible with the installed binary.",
       "Rollback to a previous bundle is possible and has been rehearsed, with the procedure documented.",
       "Releases roll out in stages with a defined abort threshold, not all at once.",
       "Crash and error reporting is integrated, with symbolication working for release builds.",
       "Reports are structurally scrubbed of secret keys and signed envelopes, proven by a test.",
       "The crash signal drives the rollout abort decision rather than being informational.",
       "Store policy constraints on over-the-air updates are documented and respected.",
       "A release runbook covers shipping, staging, aborting and rolling back."],
      SCOPE_6K,
      ["mobile/eas.json", "mobile/app.json", "mobile/app/_layout.tsx", ".github/workflows/mobile.yml"],
      security=True),

    I("Mobile", "area: mobile",
      "Donors arriving from a link or notification reaching the right screen",
      "Deep links and push notifications are not wired into one routing system, so taps go nowhere",
      "Two of the main ways a donor returns to the app — following a shared project link, and tapping a "
      "notification about a project they support — depend on routing that is only partly built. A donor who taps a "
      "notification about a milestone should land on that project; today the machinery to do so is not connected.\n\n"
      "Both paths also accept externally supplied input, which makes them a security boundary as well as a "
      "usability one.",
      "`mobile/utils/notifications.ts` exports `registerDeviceToken` and `setupNotificationListener`, and a search "
      "across `app/`, `src/`, `components/` and `hooks/` finds no caller for either. So the backend never receives "
      "a device token, and no listener exists to respond to a notification tap.\n\n"
      "Deep link parsing exists separately in `mobile/hooks/useDeepLink.ts` with its own validation, and the two "
      "have no shared notion of a destination. There is no Android notification channel, which that platform "
      "requires before notification presentation settings take effect.",
      "**Cold start versus warm start differ.** A tap on a cold app must hold the destination until navigation is "
      "ready, and getting this wrong produces a link that works only when the app is already open — a bug that "
      "reproduces inconsistently and wastes enormous debugging time.\n\n"
      "**External input reaches routing.** Both a link and a notification payload are attacker-influenceable, so "
      "destinations must be validated against an allowlist rather than constructed from received data.\n\n"
      "**Permission timing.** Requesting notification permission at the wrong moment gets it denied permanently, "
      "and Android and iOS differ in how a denial can be recovered.\n\n"
      "**Token lifecycle.** Device tokens rotate, and must be tied to wallet connection and disconnection so "
      "notifications do not follow a device after the donor disconnects.\n\n"
      "**Testing is genuinely hard.** Cold-start routing and notification taps need harnesses that do not exist "
      "here yet.",
      "Define one destination model that both entry points resolve into, validated against an allowlist so no "
      "externally supplied value becomes a route directly.\n\n"
      "Handle cold start explicitly by holding the pending destination until navigation is ready.\n\n"
      "Wire token registration into the wallet lifecycle, create the Android channel before any notification "
      "arrives, and request permission on explicit user intent with a rationale shown first.",
      ["A single destination model resolves both deep links and notification taps.",
       "Destinations are validated against an allowlist; no externally supplied value becomes a route directly.",
       "Cold start and warm start both route correctly, each covered by a test.",
       "Device tokens are registered with the backend and tied to wallet connect and disconnect.",
       "Token rotation is handled without leaving stale registrations.",
       "The Android notification channel is created before any notification is received.",
       "Permission is requested on explicit user intent with a rationale shown first, and denial is recoverable.",
       "Malformed and hostile link payloads are rejected safely, covered by fuzz tests.",
       "Tapping a donation or milestone notification lands on the correct screen on both platforms, verified on devices."],
      SCOPE_6K,
      ["mobile/utils/notifications.ts", "mobile/hooks/useDeepLink.ts",
       "mobile/app/_layout.tsx", "mobile/app.json"],
      security=True),

    I("Contracts", "area: contracts",
      "Fixing a contract bug without losing donation history",
      "Contract upgrades have no storage migration, versioning or rollback path",
      "The contracts hold donation records, escrow balances and badge ownership. All three contracts expose an "
      "upgrade function, which is correct — an unupgradeable contract with a bug is worse. But an upgrade that "
      "changes how data is laid out, with no migration step, either reads the old data incorrectly or cannot read "
      "it at all.\n\n"
      "There is no way to know from outside which version is deployed, no way to migrate stored data as part of an "
      "upgrade, and no rehearsed path back if an upgrade goes wrong. For contracts holding funds, that combination "
      "is the highest-consequence gap in the codebase.",
      "Each contract exposes `upgrade`, and there are tests asserting that state and storage keys are preserved "
      "across an upgrade — which is good, and confirms the concern is understood. What those tests cover is an "
      "upgrade that does *not* change the data layout.\n\n"
      "There is no version stored in contract state, no migration hook invoked as part of an upgrade, and no test "
      "exercising an upgrade that changes a stored structure. Issues already filed note that `upgrade` has no "
      "timelock in any of the three contracts.",
      "**Storage migration on-chain is resource-bounded.** Rewriting every entry may not fit within a single "
      "transaction's limits, which forces incremental or lazy migration — and lazy migration means both old and new "
      "layouts must be readable simultaneously during the transition.\n\n"
      "**Rollback may be impossible after migration.** Once data is rewritten, reverting the code does not revert "
      "the data. What is genuinely reversible must be established rather than assumed.\n\n"
      "**Instance versus persistent storage differ.** They have different lifetimes and archival behaviour, and a "
      "migration must handle each correctly — this repository has already had a bug from using the wrong one.\n\n"
      "**Coordination across contracts.** Contracts reference one another, so an upgrade changing an interface "
      "requires a defined ordering.\n\n"
      "**Off-chain consumers.** The indexer and backend decode contract events; a layout change breaks them unless "
      "versioning is visible from outside.",
      "Store a version in contract state and expose it, so any consumer can determine what is deployed.\n\n"
      "Introduce a migration hook invoked as part of an upgrade, designed for incremental progress within resource "
      "limits, and support reading both layouts during a transition.\n\n"
      "Establish what is reversible and rehearse the rollback on a test network before it is needed. Define the "
      "ordering for upgrades that span contracts, and make version visible to off-chain consumers.",
      ["Each contract stores and exposes a version that off-chain consumers can read.",
       "An upgrade can run a migration, with a test exercising an upgrade that changes a stored structure.",
       "Migration works incrementally within transaction resource limits, and both layouts are readable during transition.",
       "Instance and persistent storage are each handled correctly, covered by tests.",
       "What is reversible after migration is documented, and rollback is rehearsed on a test network.",
       "Upgrade ordering across interdependent contracts is defined and tested.",
       "The indexer and backend detect the deployed version and fail clearly on an unsupported one rather than misdecoding.",
       "An upgrade runbook covers pre-checks, execution, verification and abort.",
       "Interaction with the timelock work already filed is addressed rather than conflicting with it."],
      SCOPE_6K,
      ["contracts/greenpay-contract/src/lib.rs", "contracts/dao-governance-contract/src/lib.rs",
       "contracts/escrow-contract/src/lib.rs", "backend/src/services/sorobanEventIndexer.js"],
      security=True),

    I("Contracts", "area: contracts",
      "Contracts holding donations behaving correctly under every input, not just tested ones",
      "The contracts have example-based tests only — no property or invariant testing over the money paths",
      "The contracts hold real value: donation records, escrow balances and badge ownership. They are covered by a "
      "substantial example-based suite, which catches the cases someone thought to write down. It cannot catch the "
      "sequence nobody imagined — and for contracts, the unimagined sequence is where funds are lost.\n\n"
      "Properties are different in kind from examples. *Escrow released never exceeds escrow held.* *The sum of "
      "donations equals the recorded total.* *No sequence of operations lets a donor withdraw more than they put "
      "in.* Those should hold for every input, and can be tested that way.",
      "The three contracts have roughly 147 tests between them, all example-based: a specific sequence with "
      "specific values asserting a specific outcome. Several exist precisely because a bug was found — a partial "
      "release violating checks-effects-interactions, a proposal resolving with no eligible votes — which "
      "demonstrates that the hard cases are being discovered reactively.\n\n"
      "There is no property-based testing, no invariant suite and no fuzzing anywhere under `contracts/`. Arithmetic "
      "on balances has no systematic overflow exploration.",
      "**Stating the right properties is most of the work.** A weak property passes trivially; an overly strong one "
      "fails for legitimate reasons. Deriving properties that are both true and meaningful requires understanding "
      "the economics, not just the code.\n\n"
      "**State space is large.** Contracts hold accumulated state across many operations, so meaningful "
      "counterexamples usually require sequences rather than single calls. Generating valid sequences is "
      "substantially harder than generating values.\n\n"
      "**Shrinking matters.** A hundred-step counterexample is not actionable; shrinking to a minimal reproduction "
      "is what makes property testing usable.\n\n"
      "**Runtime versus coverage.** Deep exploration is slow and CI is not, so the split between a fast subset and "
      "a longer scheduled run needs deciding.\n\n"
      "**Rounding is where money leaks.** Fixed-point arithmetic on stroops accumulates error, and properties about "
      "conservation are exactly what catches it.",
      "Start by writing the invariants down in plain language and agreeing they are true — that document is a "
      "deliverable in its own right and will likely provoke discussion about intended behaviour.\n\n"
      "Generate operation sequences rather than isolated calls, with shrinking so failures reduce to minimal "
      "reproductions.\n\n"
      "Focus first on conservation properties on the escrow and donation paths, where a violation means lost funds, "
      "then extend to governance and badges. Split fast and deep runs between CI and a scheduled job.",
      ["Invariants are documented in plain language before being encoded, and reviewed for correctness.",
       "Property tests generate valid operation sequences, not only isolated calls.",
       "Conservation properties on escrow and donation paths are covered: released never exceeds held, and recorded totals match the sum of donations.",
       "Failures shrink to minimal reproductions.",
       "Fixed-point rounding behaviour is explored systematically, including accumulation over many operations.",
       "Overflow and underflow on every arithmetic path over balances are explored.",
       "A fast subset runs in CI and a deeper run is scheduled, with the split documented.",
       "Any counterexample found is converted into a regression test.",
       "Coverage of the money paths is reported before and after."],
      SCOPE_6K,
      ["contracts/greenpay-contract/src/lib.rs", "contracts/escrow-contract/src/lib.rs",
       "contracts/dao-governance-contract/src/lib.rs"],
      security=True),

    I("Contracts", "area: contracts",
      "Donations continuing to work as the platform grows",
      "No resource or fee budgeting, so a contract call can start failing once enough data accumulates",
      "Soroban meters CPU, memory, storage reads and writes, and a call exceeding its limits fails. Costs here grow "
      "with accumulated state — more donors, more badges, more proposals. A contract call that works comfortably "
      "today can begin failing as adoption grows, and the first sign will be donations failing in production for "
      "reasons nobody can immediately explain.\n\n"
      "Nothing currently measures resource consumption or would detect a change that pushes a call toward its "
      "limit.",
      "There is a test named for scale — covering hundreds of projects and donors — which shows the concern exists. "
      "What it asserts is correctness, not resource consumption.\n\n"
      "No test measures CPU instructions, memory, or storage reads and writes. No budget is recorded anywhere, and "
      "no CI check would notice a change that doubles the cost of a donation. Fee estimation on the client side "
      "uses a fixed value rather than one derived from simulation, so a call approaching its limits would surface "
      "to a donor as an opaque failure.",
      "**Costs scale with state, not just input.** A function iterating over accumulated entries costs more as the "
      "platform succeeds, which means load testing on an empty ledger proves nothing.\n\n"
      "**Simulation is the only reliable measurement.** Costs must be measured through the host environment rather "
      "than reasoned about from source, which means building measurement infrastructure.\n\n"
      "**Fixing an over-budget call may require redesign.** If a function is unbounded by nature, no optimisation "
      "saves it — the data structure has to change so cost stops growing with state, which is a larger change than "
      "it first appears.\n\n"
      "**Fees affect donors directly.** Underestimating produces failures; overestimating overcharges. Deriving "
      "estimates from simulation is the correct answer and needs building.\n\n"
      "**Budgets need enforcement.** A measurement that does not fail a build will regress.",
      "Build measurement infrastructure that reports resource consumption per contract call, and run it against "
      "realistic accumulated state rather than an empty ledger.\n\n"
      "Record budgets per function and enforce them in CI so a change that materially increases cost fails with a "
      "clear report.\n\n"
      "Identify functions whose cost grows with accumulated state and address them structurally. Replace fixed "
      "client-side fee estimation with values derived from simulation.",
      ["Resource consumption is measured per contract call through the host environment and reported.",
       "Measurements run against realistic accumulated state, not an empty ledger.",
       "Per-function budgets are recorded and enforced in CI; exceeding one fails the build with a readable report.",
       "Functions whose cost grows with accumulated state are identified and addressed structurally.",
       "Client-side fee estimation derives from simulation rather than a fixed value.",
       "A call approaching its limits surfaces an actionable error rather than an opaque failure.",
       "Headroom against limits is documented per function so growth can be projected.",
       "A guide explains how to check the resource impact of a contract change."],
      SCOPE_6K,
      ["contracts/greenpay-contract/src/lib.rs", "frontend/lib/stellar.ts",
       "mobile/utils/donationTransaction.ts", ".github/workflows/contract-deploy.yml"]),

    I("Infra", "area: infra",
      "Protecting the credentials that control donation infrastructure",
      "Secrets are a committed manifest of placeholders with no rotation path or external provider wired up",
      "The Kubernetes secret manifest is committed with empty placeholder values and a comment explaining that real "
      "values should come from an external provider or be created out of band. That comment is the entire "
      "mechanism. Nothing implements the external path, nothing rotates a credential, and nothing detects a "
      "credential that has been in use far too long.\n\n"
      "These credentials protect the database holding donation records and the accounts that submit transactions. "
      "The current arrangement depends on every operator reading a comment and doing the right thing manually.",
      "```yaml\n# k8s/secret.yaml\n# the Helm chart with secrets.provider=external (External Secrets Operator).\n"
      "stringData:\n  POSTGRES_PASSWORD: \"\"\n  RESEND_API_KEY: \"\"\n  AWS_SECRET_ACCESS_KEY: \"\"\n```\n\n"
      "The Helm chart references an external provider option, so the intent exists. No External Secrets Operator "
      "resources are defined anywhere, no rotation procedure is documented, and nothing checks credential age.\n\n"
      "The committed file contains no real credentials, which is correct — the gap is that no supported path exists "
      "for supplying them safely.",
      "**Rotation without downtime needs overlap.** A database password cannot be changed instantaneously across "
      "running pods, so the design must support two valid credentials during a rotation window — that dual-validity "
      "period is where most rotation designs fail.\n\n"
      "**Stellar keys are different.** A key controlling an account cannot simply be replaced; rotation means "
      "moving authority on-chain, which is a different operation with its own risk.\n\n"
      "**Provider choice affects everyone.** Whichever backing store is chosen must be workable for a solo "
      "maintainer and a larger deployment alike.\n\n"
      "**Local development must stay easy.** A secrets architecture that makes running the project locally painful "
      "will be bypassed.\n\n"
      "**Compromise response is part of this.** Knowing which credential leaked, what it could reach, and how "
      "quickly it can be revoked is as important as rotation.",
      "Implement the external provider path the chart already anticipates, with a documented local development "
      "story that does not require it.\n\n"
      "Support rotation with an overlap window so a credential can be replaced without downtime, and document the "
      "distinct procedure for Stellar account authority.\n\n"
      "Track credential age and surface anything overdue. Write the compromise runbook alongside the mechanism "
      "rather than after an incident.",
      ["An external secrets provider path is implemented end to end, not only referenced in a comment.",
       "Local development works without the external provider, with a documented path.",
       "Database credential rotation is possible without downtime, using an overlap window, and is rehearsed.",
       "Rotation of Stellar account authority is documented as a distinct procedure with its own risks stated.",
       "Credential age is tracked and anything overdue is surfaced.",
       "No plaintext credential is required in any committed file for any environment.",
       "A compromise runbook covers identifying scope, revoking and reissuing, per credential type.",
       "Pods consume secrets in a way that supports rotation without a manual restart, or the restart requirement is documented."],
      SCOPE_6K,
      ["k8s/secret.yaml", "helm/greenpay/values.yaml", "k8s/backend.yaml", "docs/runbooks/"],
      security=True),

    I("Cross-cutting", "area: cross-cutting",
      "A leaderboard and impact figures donors can believe",
      "Nothing detects wash donations, so the leaderboard and totals are trivially gameable",
      "The leaderboard ranks donors by total given, and it is a visible incentive. Nothing prevents someone "
      "manufacturing that position: a donor who also controls a project can donate to themselves repeatedly, "
      "paying only network fees, and climb the rankings while the platform reports inflated totals and "
      "correspondingly inflated impact.\n\n"
      "The same absence allows a project to appear better funded than it is, which influences where other donors "
      "give. On a platform whose product is trust, an unguarded incentive is a direct threat to the numbers "
      "everything else rests on.",
      "There is no relationship between donor and project wallets recorded anywhere — nothing would notice that a "
      "donation came from an address controlled by the receiving project. Donation ingestion validates format and "
      "idempotency, not plausibility.\n\n"
      "Rate limiting exists at the HTTP layer, but the indexer records donations observed on-chain regardless of "
      "whether any API call was made, so an on-chain wash cycle bypasses it entirely.\n\n"
      "Nothing anywhere flags circular flows, self-donation or rapid repeated donation between the same pair of "
      "addresses.",
      "**Pseudonymity limits certainty.** Wallet addresses are cheap to create, so this cannot be solved by "
      "identity. Detection has to work on behaviour and flow structure, which means accepting probabilistic "
      "signals rather than proof.\n\n"
      "**False positives are costly.** A legitimate large donor flagged as fraudulent is a serious harm. Any "
      "enforcement needs human review and appeal rather than automatic penalty.\n\n"
      "**Detection can be evaded once published.** Being open about thresholds invites gaming them; being opaque "
      "conflicts with the platform's transparency values. That tension needs an explicit, defensible position.\n\n"
      "**Graph analysis at scale.** Detecting circular flows means analysing a transaction graph, which is real "
      "algorithmic work if it is to run continuously.\n\n"
      "**Enforcement policy is a product decision.** Excluding from leaderboard, flagging publicly, or excluding "
      "from impact totals are different answers with different consequences.",
      "Model relationships between addresses so self-donation is detectable, and analyse flow structure to surface "
      "circular patterns and rapid repeated transfers between the same pair.\n\n"
      "Score rather than judge: produce signals with confidence, route anything significant to human review, and "
      "keep enforcement out of the automatic path.\n\n"
      "Decide and document the disclosure position, and define separately what a confirmed case means for the "
      "leaderboard, for displayed totals and for impact figures.",
      ["Self-donation — a donation from an address controlled by the receiving project — is detectable and detected.",
       "Circular flows and rapid repeated donations between the same address pair are surfaced with a confidence score.",
       "Detection runs continuously at realistic transaction volume within a documented budget.",
       "Signals route to human review; no automatic penalty is applied to a donor account.",
       "An appeal path exists and is documented.",
       "Enforcement policy defines separately what a confirmed case means for leaderboard position, displayed totals and impact figures.",
       "The disclosure position on detection thresholds is decided and documented with its reasoning.",
       "False-positive rate is measured against a labelled set before any enforcement is enabled.",
       "Detection covers donations observed on-chain by the indexer, not only those recorded through the API."],
      SCOPE_6K,
      ["backend/src/services/indexerService.js", "backend/src/routes/leaderboard.js",
       "backend/src/db/schema.sql", "backend/src/routes/impact.js"],
      security=True),

    I("Backend", "area: backend",
      "Project updates donors can trust and safely read",
      "Project updates are unmoderated user content rendered as markdown, with no review or reporting path",
      "Projects post updates that donors read as evidence their money is being used well. That text is "
      "user-supplied, rendered as markdown, and passes through no review of any kind. There is no reporting "
      "mechanism, no moderation queue, no record of what changed after donors read it, and no way to act on a "
      "project posting fraudulent claims or abusive content.\n\n"
      "This surface has already produced a security defect: the markdown renderer allowed attribute injection "
      "through link URLs. That was fixed, but the underlying position — that this is trusted content — has not "
      "changed.",
      "```sql\n-- backend/src/db/schema.sql:79\nbody TEXT NOT NULL,\n```\n\n"
      "Project updates are stored as free text and rendered through a hand-rolled markdown renderer into "
      "`dangerouslySetInnerHTML`. Notification emails are generated from the same content and delivered to donors, "
      "so an update reaches inboxes without any review step.\n\n"
      "There is no report action anywhere in the frontend, no moderation state on the record, no edit history, and "
      "no rate limit on posting.",
      "**Moderation policy comes before tooling.** What is disallowed — fraudulent impact claims, abuse, spam, "
      "off-topic solicitation — has to be decided before anything can enforce it, and for a climate platform "
      "\"fraudulent claim\" is genuinely hard to define.\n\n"
      "**Speed versus safety.** Pre-publication review is safest and adds latency projects will resent; "
      "post-publication review is faster and means harmful content is visible for a window. The choice may differ "
      "by project trust level.\n\n"
      "**Notifications are irrevocable.** An update sent by email cannot be unsent, so the interaction between "
      "moderation and notification timing is a genuine constraint rather than a detail.\n\n"
      "**Edits after donation.** A project that posts a modest claim and later inflates it changes what donors "
      "relied on; history and visible edit indication matter.\n\n"
      "**Reporting can be weaponised.** A reporting mechanism invites abuse against legitimate projects.\n\n"
      "**Rendering is a security boundary.** Any renderer change must be treated as such, given the history here.",
      "Define the content policy first and write it in a form both projects and moderators can apply.\n\n"
      "Add moderation state to updates with a defined lifecycle, and decide the pre- versus post-publication "
      "position — possibly varying by project trust level — including how it interacts with notification timing.\n\n"
      "Give donors a reporting path with its own abuse protections, keep edit history with visible indication, and "
      "treat the renderer as a security boundary with tests to match.",
      ["A content policy is written and applicable by both projects and moderators.",
       "Updates carry moderation state with a defined lifecycle and an audit trail of who acted and why.",
       "The pre- versus post-publication position is decided, documented, and reflected in notification timing.",
       "Donors can report an update, and the reporting mechanism has its own abuse protections.",
       "Edit history is retained and edits after publication are visibly indicated to donors.",
       "Posting is rate-limited per project.",
       "The markdown renderer is treated as a security boundary, with property-based tests asserting no input can inject attributes or handlers.",
       "Moderation decisions are appealable, with the process documented.",
       "Content removed after notification has a defined follow-up, since the email cannot be recalled."],
      SCOPE_6K,
      ["backend/src/routes/updates.js", "backend/src/db/schema.sql",
       "frontend/pages/projects/[id].tsx", "backend/src/services/email.js"],
      security=True),

    I("Cross-cutting", "area: cross-cutting",
      "Integrators and clients depending on the API without breaking",
      "There is a versioning shim with no deprecation policy, so no consumer knows when anything will break",
      "The API carries a `/api/v1` prefix and redirects unversioned requests to it with a deprecation header — "
      "someone thought about versioning. What does not exist is any policy behind it: no statement of what "
      "constitutes a breaking change, no sunset date on the legacy path, no way for a consumer to discover a "
      "version is going away, and no plan for introducing a second version.\n\n"
      "The platform has web, mobile and browser-extension clients, and mobile is the one that matters most: an old "
      "app version stays installed on phones for a long time, so a change that breaks it strands donors mid-flow.",
      "```js\n// backend/src/server.js — legacy unversioned routes\nres.set(\"Deprecation\", \"true\");\n"
      "res.set(\"Link\", `<${API_V1}>; rel=\"successor-version\"`);\nreturn res.redirect(308, ...);\n```\n\n"
      "The header signals deprecation without a sunset date, so it communicates intent but not a timeline. There is "
      "no policy document defining what counts as breaking, and `docs/openapi.yml` describes only the current shape "
      "with no versioning or deprecation annotations.\n\n"
      "Nothing measures which clients or versions are still calling which endpoints, so the impact of removing "
      "anything is unknown.",
      "**Mobile cannot be forced to upgrade.** Old versions persist on devices indefinitely, so any deprecation "
      "timeline must be driven by observed usage rather than a calendar — which requires measuring usage first.\n\n"
      "**The breaking-change boundary is subtler than it looks.** Adding a field is usually safe, unless a client "
      "validates strictly. Changing an error code breaks anything branching on it. The definition needs to be "
      "specific enough to apply mechanically.\n\n"
      "**Two versions means two implementations.** Serving both is a maintenance cost, and the mechanism — parallel "
      "routes, transformation, or something else — determines how expensive that is.\n\n"
      "**Enforcement is what makes a policy real.** Without a check, a breaking change ships in a patch release.\n\n"
      "**Deprecation must be discoverable.** A header nobody reads is not communication.",
      "Define what constitutes a breaking change, specifically enough to be checked mechanically, and enforce it "
      "with a compatibility check against the previous specification.\n\n"
      "Measure endpoint usage by client and version so deprecation decisions rest on evidence — this is the "
      "prerequisite for everything else.\n\n"
      "Add sunset dates to deprecation signalling, communicate through more than a header, and document the "
      "mechanism for introducing a second version before it is needed.",
      ["A written policy defines what constitutes a breaking change, specifically enough to apply mechanically.",
       "A compatibility check runs in CI against the previous published specification and fails on an unannounced breaking change.",
       "Endpoint usage is measured by client and version, so deprecation decisions rest on evidence.",
       "Deprecation responses carry a sunset date, not only a deprecation flag.",
       "Deprecation is communicated through a documented channel beyond response headers.",
       "The mechanism for serving two versions concurrently is implemented and documented, with a worked example.",
       "The legacy unversioned path has a decided fate: a sunset date based on observed usage, or a documented commitment to keep it.",
       "Mobile clients degrade gracefully against an API newer than they expect, covered by a test.",
       "`docs/openapi.yml` carries version and deprecation annotations."],
      SCOPE_6K,
      ["backend/src/server.js", "docs/openapi.yml", "docs/api.md", ".github/workflows/ci.yml"]),

    I("Cross-cutting", "area: cross-cutting",
      "Reaching donors who do not read English",
      "Interface strings are translated but project content is English-only, so most of the world sees an untranslated site",
      "The interface supports English, Spanish and Arabic. The content donors actually read to decide where to give "
      "— project names, descriptions, categories, locations and update posts — exists only in whatever language the "
      "project entered.\n\n"
      "So a Spanish-speaking donor gets translated navigation and buttons around a page of English text describing "
      "the project. The translation work already done delivers a fraction of its value, and the platform's reach "
      "outside English-speaking countries is limited by content rather than interface.",
      "`shared/locales/` carries synchronised interface strings across three languages, and a translation check "
      "runs in CI — the infrastructure is real and working.\n\n"
      "`backend/src/db/schema.sql` stores `name`, `description`, `location` and update `body` as single columns "
      "with no language dimension. There is no translation table, no source-language field, and no way to store the "
      "same project in two languages.\n\n"
      "Search compounds this: text matching runs against whichever language the content happens to be in, so a "
      "donor searching in Spanish will not match an English description of exactly the project they want.",
      "**The data model change reaches everywhere.** Adding a language dimension affects reads, writes, search, "
      "caching, notifications and the API contract — this is not a localised change.\n\n"
      "**Who translates, and can it be trusted?** Machine translation scales but can distort claims about "
      "environmental impact in ways that matter. Human translation does not scale. A hybrid needs a quality "
      "position, and mistranslated impact claims are a credibility risk, not just a quality one.\n\n"
      "**Fallback must be graceful.** A donor should see the best available language, with clear indication of what "
      "they are reading and whether it was machine-translated.\n\n"
      "**Right-to-left affects layout, not just text.** Arabic content inside a page needs correct bidirectional "
      "handling in components built for left-to-right.\n\n"
      "**Search must become language-aware**, which intersects directly with the search work.\n\n"
      "**Translations are user content too**, so they inherit the moderation question.",
      "Add a language dimension to content, with an explicit source language and translations as separate records "
      "rather than overwriting.\n\n"
      "Define fallback so a donor always sees the best available language, always labelled — including whether it "
      "was machine-translated.\n\n"
      "Decide the translation quality position explicitly, with particular care for impact claims, and make search "
      "language-aware so a donor can find projects described in another language.",
      ["Project content supports multiple languages with an explicit source language recorded.",
       "Translations are stored as separate records; adding one never overwrites the original.",
       "Fallback always shows the best available language and labels what the donor is reading.",
       "Machine-translated content is visibly marked as such.",
       "The translation quality position is documented, with specific handling for impact claims.",
       "Right-to-left content renders correctly inside the existing components, verified by screenshot tests.",
       "Search matches content across languages, so a query in one language can find a project described in another.",
       "Notification emails use the recipient's preferred language where a translation exists.",
       "Translated content is covered by the same moderation path as original content.",
       "The API exposes language selection without breaking existing consumers."],
      SCOPE_6K,
      ["backend/src/db/schema.sql", "shared/i18n/index.ts", "backend/src/routes/projects.js",
       "frontend/lib/i18n.tsx", "backend/src/services/email.js"],
      related="Intersects with the search ranking work — language-aware matching should be designed alongside it."),
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--sleep", type=float, default=1.2)
    args = parser.parse_args()

    print(f"Repo: {REPO}\nIssues defined: {len(ISSUES)}")

    titles = [f"{i['area']}: {i['title']}" for i in ISSUES]
    if len(set(titles)) != len(titles):
        dupes = {t for t in titles if titles.count(t) > 1}
        print(f"ERROR: duplicate titles within this batch: {dupes}", file=sys.stderr)
        sys.exit(1)

    print("Fetching existing issue titles (so nothing is duplicated)...")
    already = existing_titles()
    print(f"  {len(already)} issues already in the tracker — these will be left untouched.")

    created = skipped = 0
    for idx, issue in enumerate(ISSUES):
        full = f"{issue['area']}: {issue['title']}"
        if full in already:
            print(f"  [{idx}] skip (already exists): {full}")
            skipped += 1
            continue
        print(f"  [{idx}] {full}")
        create_issue(issue, dry_run=args.dry_run)
        created += 1
        if not args.dry_run:
            time.sleep(args.sleep)

    print(f"\nDone. Created: {created}, skipped as existing: {skipped}")


if __name__ == "__main__":
    main()
