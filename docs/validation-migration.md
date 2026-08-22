# Request Validation Migration Plan

This document tracks the incremental migration of the Stellar GreenPay backend
from hand-rolled, per-route regex/field checks to a single, declarative
[Zod](https://zod.dev) validation layer.

## Why

A repo-wide audit found that no request-schema validation library was in use.
Every route implemented its own ad-hoc checks:

- `routes/donations.js` had `validateKey` / `validateTxHash` regex helpers.
- `routes/projects.js` `'s status route accepted an unchecked `adminAddress``
  (the authorization gap flagged in this same audit).
- `routes/admin.js`, `routes/impact.js`, `routes/profiles.js`, `routes/jobs.js`
  each re-implemented Stellar-key / tx-hash validation independently.

This lets `docs/openapi.yml` (the hand-maintained contract) silently drift from
the implementation, because nothing validates incoming requests against it.

## What was introduced

- **Dependency:** `zod` (`backend/package.json`). It is plain-JS friendly today
  and can later share inferred types with the TypeScript frontend.
- **Central schemas** in `backend/src/schemas/` — the single, reviewable source
  of truth:
  - `common.js` — `stellarPublicKey`, `transactionHash`, `uuid` (the shared
    regexes, defined once).
  - `donations.js` — `DonationCreateSchema`.
  - `projects.js` — `ProjectStatusUpdateSchema`.
  - `admin.js` — `AdminLoginSchema`, `AdminRefreshSchema`, `AdminAuditQuerySchema`.
  - `index.js` — barrel export.
- **`middleware/validate.js`** with two entry points:
  - `validate(schema, { source })` — Express middleware (preferred pattern)
    that validates `req.body` / `req.query` / `req.params` and replaces it with
    the stripped, coerced value. Rejects with `400 { error }`.
  - `validateBody(schema, value)` — parse inside a handler and throw a
    `ValidationError` (status 400) for handlers exercised in isolation by unit
    tests (e.g. `donations.recordDonation`).

## Completed (highest-risk mutating routes)

| Route | Schema | Mechanism |
| --- | --- | --- |
| `POST /api/v1/donations` | `DonationCreateSchema` | `validateBody` inside handler (preserves unit tests) + removed inline regex |
| `GET /api/v1/donations/donor/:publicKey` | `stellarPublicKey` | `validate(..., { source: "params" })` |
| `PATCH /api/v1/projects/:id/status` | `ProjectStatusUpdateSchema` | `validate` middleware (now requires `adminAddress`) |
| `POST /api/v1/admin/login` | `AdminLoginSchema` | `validate` middleware |
| `POST /api/v1/admin/refresh` | `AdminRefreshSchema` | `validate` middleware |
| `GET /api/v1/admin/audit` | `AdminAuditQuerySchema` | `validate(..., { source: "query" })` |

## Remaining routes (incremental)

Apply the same pattern. For each, add a schema in `src/schemas/` (or extend an
existing one) and mount `validate(...)` at the router. Routes still using
ad-hoc checks:

1. `routes/impact.js` — `validateKey` on `:publicKey` param.
2. `routes/profiles.js` — `validateKey` on `:publicKey` / body `publicKey`.
3. `routes/jobs.js` — `validateTxHash` on `releaseTransactionHash`.
4. `routes/projects.js` — `createProject` / `addMilestone` / matcher creation
   bodies (currently inline length/number checks).
5. `routes/ratings.js`, `routes/updates.js`, `routes/subscriptions.js`,
   `routes/notifications.js` — request bodies.

### Definition of done per route
- No inline `regex.test(...)` / manual field checks remain for that route.
- A schema exists in `src/schemas/` and is referenced from the route.
- Field names/types mirror the corresponding `docs/openapi.yml` entry.

## Future: close the OpenAPI drift

Once all routes use schemas, generate `docs/openapi.yml` request bodies from the
Zod schemas (e.g. via `zod-to-openapi`) or add a CI check that asserts every
`requestBody` has a matching schema, so the contract and implementation cannot
silently drift again.
