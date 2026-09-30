# API Reference — Stellar GreenPay

Base URL: `http://localhost:4000`

All responses: `{ "success": true, "data": {...} }` or `{ "error": "..." }`

---

## Versioning

All API routes are served under a version prefix: **`/api/v1`**. The version
prefix lets us ship breaking changes in a future `/api/v2` without disrupting
existing clients.

The normative, mechanically enforceable rules live in the
[API versioning and compatibility policy](api-versioning-policy.md). Changes
and deprecations are announced in the [API lifecycle changelog](api-changelog.md)
and at `GET /api/versions/changelog`.

**Summary**

- Resource routes live under `/api/v1/<resource>` (e.g. `/api/v1/projects`).
- `/health` is unversioned (infrastructure/liveness check).
- New non-breaking fields may be added to a version without a bump. Breaking
  changes (removing/renaming fields, changing semantics) introduce a new
  version (`/api/v2`) and the previous version is supported until deprecated.
- **Legacy redirect:** unversioned `/api/*` requests are answered with a
  `308 Permanent Redirect` to their `/api/v1/*` equivalent and carry a
  `Deprecation: true` header, a
  `Sunset: Tue, 31 Dec 2030 23:59:59 GMT` header, and links to the successor
  and changelog. The sunset is an earliest retirement floor: the redirect is
  kept longer unless the policy's 90-day usage gates pass. The `308` status
  preserves the HTTP method and body, so existing `POST`/`PATCH` clients keep
  working. New clients should call `/api/v1` directly.
- Clients send `X-Client-Name`, `X-Client-Version`, and
  `X-Client-API-Version`; completed requests are measured by endpoint and these
  dimensions. `GET /api/v1/admin/api-usage` exposes the current authenticated
  operational snapshot and structured `api_request` logs retain history.

### Concurrent-version worked example

`GET /api/v1/meta` serves the stable flat representation while
`GET /api/v2/meta` concurrently serves an experimental nested representation.
Both reuse the same domain result; the v2 transform is isolated at its mount so
v1 cannot change accidentally. See the policy for the route/adapter mechanism.

---

## Health
`GET /health` — Server status check.

---

## Projects

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/projects` | List projects (`?category=&status=active&limit=50`) |
| GET | `/api/v1/projects/:id` | Get single project |

### Project object
```json
{
  "id": "uuid",
  "name": "Amazon Reforestation Initiative",
  "description": "...",
  "category": "Reforestation",
  "location": "Brazil, South America",
  "walletAddress": "GABC...XYZ",
  "goalXLM": "50000.0000000",
  "raisedXLM": "18420.0000000",
  "donorCount": 147,
  "status": "active",
  "verified": true,
  "tags": ["reforestation", "amazon"],
  "createdAt": "2025-01-01T00:00:00.000Z"
}
```

---

## Donations

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/donations` | Record a donation after on-chain tx |
| GET | `/api/v1/donations/project/:id` | Donations for a project (`?limit=20`) |
| GET | `/api/v1/donations/donor/:publicKey` | A donor's full history |

### POST /api/v1/donations
```json
{
  "projectId": "uuid",
  "donorAddress": "GABC...XYZ",
  "amountXLM": "25.0000000",
  "message": "For the Amazon 🌳",
  "transactionHash": "abc123...64hexchars"
}
```

Donations are **deduplicated by transactionHash** — safe to retry.

---

## Profiles

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/profiles/:publicKey` | Get donor profile + badges |
| POST | `/api/v1/profiles` | Create or update profile |

---

## Leaderboard

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/leaderboard` | Top donors by total XLM (`?limit=20`) |

Leaderboard totals and displayed badges use the confirmed-only integrity
surface. A detector signal alone does not change rank or account state.

### Leaderboard entry
```json
{
  "rank": 1,
  "publicKey": "GABC...XYZ",
  "displayName": "Alice",
  "totalDonatedXLM": "2500.0000000",
  "projectsSupported": 4,
  "topBadge": "earth"
}
```

---

## Environmental impact claims

Donation amounts and environmental claims are separate resources. None of the
endpoints below calculates a donor outcome from XLM.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/impact/project/:id` | Donation facts plus all current/historical project claims |
| GET | `/api/v1/impact/global` | Donation totals and methodology-compatible claim groups |
| GET | `/api/v1/impact/donor/:publicKey` | Donation facts plus claims belonging to supported projects, with no donor allocation |
| GET | `/api/v1/impact/methodologies` | Methodology registry |
| GET | `/api/v1/impact/claims/:id/verification` | Canonical payload, SHA-256, anchor and revocation state |
| POST | `/api/v1/impact/project/:id/claims` | Admin: record an operator assertion |
| POST | `/api/v1/impact/claims/:id/evidence` | Admin: attach a source URI and content hash |
| POST | `/api/v1/impact/claims/:id/attestations` | Admin: record independent review and optional anchor receipt |
| POST | `/api/v1/impact/attestations/:id/anchor` | Admin: attach a confirmed Soroban receipt |
| POST | `/api/v1/impact/attestations/:id/revoke` | Admin: record verifier/admin revocation |
| POST | `/api/v1/impact/claims/:id/revoke` | Admin: withdraw a claim without deleting history |

An impact claim includes a quantity range, unit, claim type, methodology,
measurement period, vintage, baseline, uncertainty/confidence, asserting party,
evidence and provenance. `avoided_emissions`, `sequestration` and `offset` are
never combined. See [impact accounting](impact-accounting.md).

Confirmed integrity cases are excluded separately from displayed funding totals
and impact-supporting donation facts. Gross event-store accounting remains
immutable.

---

## Donation integrity

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/integrity/policy` | Public signal, disclosure, enforcement, and appeal position |
| GET | `/api/v1/integrity/status` | Admin: worker, queue, and enforcement state |
| POST | `/api/v1/integrity/relationships` | Admin: record an evidence-backed related wallet |
| GET | `/api/v1/integrity/reviews` | Admin: list the human-review queue |
| GET | `/api/v1/integrity/reviews/:id` | Admin: assessment, signals, events, and appeals |
| POST | `/api/v1/integrity/reviews/:id/decision` | Admin: confirm or dismiss with a reason |
| POST | `/api/v1/integrity/reviews/:id/appeal-challenge` | Affected wallet: request a one-time signing challenge |
| POST | `/api/v1/integrity/reviews/:id/appeals` | Affected wallet: submit a signed appeal |
| GET | `/api/v1/integrity/appeals` | Admin: list pending appeals |
| POST | `/api/v1/integrity/appeals/:id/decision` | Independent admin: grant or deny an appeal |
| POST | `/api/v1/integrity/reviews/:id/label` | Admin: add an independently reviewed evaluation label |
| GET | `/api/v1/integrity/evaluation` | Admin: false-positive, recall, and enablement-gate report |
| POST | `/api/v1/integrity/enforcement/enable` | Admin: enable confirmed-case exclusions after the gate passes |
| POST | `/api/v1/integrity/enforcement/disable` | Admin: immediately stop exclusions |

Detection scores behaviour rather than identity. Significant signals enter a
private review queue and leave all enforcement flags off. Enforcement requires a
human confirmation and a separately enabled labelled-set gate. Appeals require a
signature by the affected donor or project wallet and are decided by someone
other than the original reviewer. See the full
[donation integrity policy](donation-integrity.md).

---

## Project Updates

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/updates/:projectId` | Public and public-under-review updates posted by a project |
| POST | `/api/v1/updates` | Create an update; review mode follows project trust and notifications wait for approval |
| PATCH | `/api/v1/updates/:updateId` | Edit an update, retain the previous revision, and return the edit to review |
| GET | `/api/v1/updates/:updateId/history` | Donor-visible history of earlier public revisions |
| POST | `/api/v1/updates/:updateId/reports` | Donor: report an update (`donorAddress`, fixed `reason`, optional `details`) |
| GET | `/api/v1/updates/:updateId/reports` | Admin: inspect report reasons, details, and resolutions |
| GET | `/api/v1/updates/moderation/queue` | Admin: pending, public-under-review, and appealed updates |
| POST | `/api/v1/updates/:updateId/moderation` | Admin: `approve`, `reject`, `remove`, or `reinstate` with a reason |
| GET | `/api/v1/updates/:updateId/moderation-history` | Admin: immutable actor/reason lifecycle audit |
| POST | `/api/v1/updates/:updateId/appeals` | Project admin: appeal a rejected or removed update |
| GET | `/api/v1/updates/moderation/appeals` | Admin: pending appeal queue |
| POST | `/api/v1/updates/appeals/:appealId/decision` | Different moderator: grant or deny an appeal with a reason |
| POST | `/api/v1/updates/:updateId/notifications/retry` | Admin: queue only publication channels not previously handed off |

New standard-project updates use pre-publication review. Fully verified
projects are visible during post-publication review, with a label. Email and
push always wait for approval. Reports are restricted to project donors,
rate-limited, deduplicated, and never remove content automatically. See the
[project update content and moderation policy](project-update-moderation.md)
for applicable rules, lifecycle, evidence standard, appeals, edit history, and
the required follow-up when notified content is removed.

---

## Badge Tiers

| Tier | Threshold | Emoji |
|------|-----------|-------|
| `seedling` | ≥ 10 XLM | 🌱 |
| `tree` | ≥ 100 XLM | 🌳 |
| `forest` | ≥ 500 XLM | 🌲 |
| `earth` | ≥ 2,000 XLM | 🌍 |
