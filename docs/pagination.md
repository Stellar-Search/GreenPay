# Keyset Pagination Architecture & Specification

## Overview
All paginated list endpoints across the GreenPay platform use **keyset pagination** (cursor-based pagination) over a guaranteed total ordering. Offset-based pagination (`LIMIT` / `OFFSET`) is deprecated because:
1. Concurrent insertions/deletions mid-pagination cause skipped or duplicated rows for active clients.
2. Deep offsets suffer `O(N)` performance degradation as PostgreSQL must scan and discard all skipped rows.

---

## Cursor Specification

### 1. Opaque & Versioned Format
Cursors are opaque base64url strings prefixed with a version identifier:
```
v1.<base64url_json>
```

#### Example:
- **Decoded Payload**:
  ```json
  {
    "createdAt": "2026-08-26T12:00:00.000Z",
    "id": "11111111-1111-1111-1111-111111111111"
  }
  ```
- **Encoded Cursor**:
  `v1.eyJjcmVhdGVkQXQiOiIyMDI2LTA4LTI2VDEyOjAwOjAwWiIsImlkIjoiMTExMTExMTEtMTExMS0xMTExLTExMTEtMTExMTExMTExMTExIn0`

### 2. Backward Compatibility & Error Handling
- **Invalid Cursors**: Requests with malformed base64url data, non-object JSON, or invalid syntax fail with HTTP `400 Bad Request` and machine-readable error code `INVALID_CURSOR`.
- **Unsupported Versions**: Cursors with unsupported version prefixes (e.g., `v2.xxx`) fail with HTTP `400 Bad Request` and machine-readable error code `UNSUPPORTED_CURSOR_VERSION`.
- **Legacy ISO Strings**: For backward compatibility during migration, plain ISO 8601 timestamp strings (e.g. `2026-08-26T12:00:00.000Z`) are accepted as legacy (`v0`) timestamp cursors.

---

## Total Ordering Guarantees

Every paginated SQL query includes primary sort columns **plus a unique tiebreaker column** to enforce total ordering:

| Endpoint | Primary Sort Field(s) | Unique Tiebreaker Field | Keyset Filter Clause |
| :--- | :--- | :--- | :--- |
| `GET /api/projects` | `created_at DESC` | `id DESC` | `(created_at, id) < ($createdAt, $id)` |
| `GET /api/donations/project/:id` | `created_at DESC` | `id DESC` | `(created_at, id) < ($createdAt, $id)` |
| `GET /api/donations/project/:id/messages` | `amount DESC, created_at DESC` | `id DESC` | `amount < $amt OR (amount = $amt AND (created_at, id) < ($time, $id))` |
| `GET /api/donations/donor/:key` | `created_at DESC` | `id DESC` | `(created_at, id) < ($createdAt, $id)` |
| `GET /api/leaderboard` | `total_donated_xlm DESC` | `public_key ASC` | `total_donated_xlm < $total OR (total_donated_xlm = $total AND public_key > $pk)` |
| `GET /api/admin/audit` | `created_at DESC` | `id DESC` | `(created_at, id) < ($createdAt, $id)` |
| `GET /api/admin/ai-summary-failures` | `created_at DESC` | `id DESC` | `(created_at, id) < ($createdAt, $id)` |
| `GET /api/jobs` | `created_at DESC` | `id DESC` | `(created_at, id) < ($createdAt, $id)` |
| `GET /api/updates/:projectId` | `created_at DESC` | `id DESC` | `(created_at, id) < ($createdAt, $id)` |
| `GET /api/notifications/follows` | `created_at DESC` | `project_id DESC` | `(created_at, project_id) < ($createdAt, $projectId)` |

---

## Standardized Response Metadata

Successful paginated requests return metadata in `meta.pagination`:

```json
{
  "success": true,
  "data": [ ... ],
  "meta": {
    "nextCursor": "v1.eyJjcmVhdGVkQXQiOiIyMDI2LTA4LTI2VDEyOjAwOjAwWiIsImlkIjoiYWJjZCJ9",
    "hasMore": true,
    "pagination": {
      "nextCursor": "v1.eyJjcmVhdGVkQXQiOiIyMDI2LTA4LTI2VDEyOjAwOjAwWiIsImlkIjoiYWJjZCJ9",
      "hasMore": true,
      "limit": 20,
      "totalCount": 142,
      "isTotalExact": true
    }
  }
}
```

- `nextCursor`: Opaque cursor string for requesting the next page. `null` when `hasMore` is `false`.
- `hasMore`: `true` if additional records exist beyond the current page payload; `false` otherwise.
- `totalCount`: Exact total item count if calculated, or `null` if dropped in favor of continuation.
- `isTotalExact`: `true` if `totalCount` is exact; `false` if estimated or omitted.

---

## Totals: which endpoints have one, and which do not

An exact `COUNT(*)` over a filtered set costs roughly what the page query costs,
and that cost does not shrink as the page gets deeper. Most list endpoints
therefore do not compute one. They are not returning a cheap approximation and
they are not returning zero — they return `totalCount: null` with
`isTotalExact: false`, which is the API stating plainly that it does not know.

| Endpoint | `totalCount` | `isTotalExact` |
| :--- | :--- | :--- |
| `GET /api/projects` | `null` | `false` |
| `GET /api/donations/project/:id` | `null` | `false` |
| `GET /api/donations/project/:id/messages` | `null` | `false` |
| `GET /api/donations/donor/:key` | `null` | `false` |
| `GET /api/jobs` | `null` | `false` |
| `GET /api/updates/:projectId` | `null` | `false` |
| `GET /api/notifications/follows` | `null` | `false` |
| `GET /api/leaderboard` | exact | `true` |
| `GET /api/admin/audit` | exact | `true` |
| `GET /api/admin/ai-summary-failures` | exact | `true` |

The three that keep an exact total run over small operator-facing tables where
the count is cheap and operators rely on it. Their count reflects the endpoint's
**filters only** — never the keyset predicate. Counting what remains after the
cursor would make `total` shrink on every page, which is worse than having no
total at all, since it looks like a real number.

Clients should drive "is there another page" off `hasMore`, which is exact on
every endpoint: each query fetches `limit + 1` rows and reports whether the
extra one came back.

---

## Numbered pages

Keyset pagination cannot answer "jump to page 50" — there is no cursor for a
page nobody has walked to. Every paginated surface in this repo was checked
against that constraint:

- **Frontend.** `LeaderboardTable` is the only paginated list component, and it
  was already a "Load More" accumulator rather than numbered pages. It now
  follows `meta.pagination.nextCursor` instead of passing `entries.length` as an
  offset. No numbered-page control exists anywhere in `frontend/`, so nothing
  had to be redesigned.
- **`GET /api/leaderboard`, `GET /api/admin/audit` and
  `GET /api/admin/ai-summary-failures`.** These three still accept an `offset`
  query parameter, and that is a deliberate exception, not an oversight. The
  parameter is honoured **only when no `cursor` is supplied**, so a request
  never silently mixes the two strategies. It exists so API clients written
  against the previous contract keep working across the transition. It carries
  the offset caveats it always did, and it is clamped to 10,000 on all three so
  no caller can ask for an unbounded scan — `LeaderboardQuerySchema` and
  `AdminAuditQuerySchema` enforce the bound, and `MAX_OFFSET` in
  `backend/src/routes/admin.js` clamps the one endpoint with no query schema.

## Transition for existing consumers

The change is additive at the request layer, so no consumer breaks on the day
it ships:

| Client sends | Behaviour |
| :--- | :--- |
| Nothing | First page, keyset. Unchanged from before. |
| `cursor=v1.…` | Keyset continuation. The supported path. |
| `offset=N` (leaderboard, admin audit, admin AI-summary failures) | Offset path, deprecated, unchanged behaviour, clamped to 10,000. |
| `offset=N` (any other list endpoint) | Ignored; the first page is returned. |
| A legacy bare ISO timestamp as `cursor` | Accepted as a `v0` timestamp cursor. |
| `cursor` from a future version, e.g. `v2.…` | HTTP 400 `UNSUPPORTED_CURSOR_VERSION`. |
| A malformed `cursor` | HTTP 400 `INVALID_CURSOR`. |

The response envelope is additive too: `meta.pagination` gained `nextCursor`,
`hasMore`, `totalCount` and `isTotalExact`, while the endpoints that previously
returned `total` and `offset` still return them. Both are marked `deprecated` in
the OpenAPI schema and should be read as `totalCount` / `nextCursor` instead.

`GET /api/admin/ai-summary-failures` and `GET /api/notifications/follows`
implement this same contract but are not yet described in `docs/openapi.yml` at
all — a pre-existing gap in that spec, unrelated to pagination.

---

## Deep-page latency: before and after

Measured by `backend/src/routes/pagination.integration.test.js` against a real
Postgres: 50,000 rows in `projects`, page size 20, deep page starting at row
49,960, medians of seven runs after a warm-up pass. Both strategies are asked
for the identical slice, and the test asserts they return the identical row ids.

| Strategy | Page 1 | Deep page (row 49,960) | Penalty for depth |
| :--- | ---: | ---: | ---: |
| **Before** — `LIMIT 20 OFFSET 49960` | 2.10 ms | 28.36 ms | **13.5x** |
| **After** — `WHERE (created_at, id) < (…) LIMIT 20` | 1.63 ms | 1.80 ms | **1.1x** |

The offset plan walks and discards all 49,960 skipped rows, so its cost grows
with depth; the keyset plan seeks straight to the cursor tuple on
`idx_projects_created_at_id` and reads 20 rows, so its cost does not. The
absolute numbers are hardware-specific and will differ on CI — what the test
asserts is the shape: the keyset deep page stays close to the keyset first page
in the same run, and beats the offset deep page it replaced.

Every ordering in the table above has a matching composite index in
`backend/src/db/schema.sql`; without one the keyset predicate still returns
correct rows but degrades to a scan, losing the whole point.
