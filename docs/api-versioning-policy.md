# API versioning and compatibility policy

**Owner:** API maintainers
**Effective:** 2026-08-28
**Stable version:** `v1`
**Discovery:** `GET /api/versions`
**Announcements:** [API changelog](api-changelog.md) and
`GET /api/versions/changelog`

This policy protects installed clients, especially mobile releases that may
remain active long after a newer release is available. A client is never
assumed to have upgraded merely because a release was published.

## 1. Compatibility promise

Within a stable major version, an existing conforming request must continue to
be accepted and its observable response must remain usable according to the
published OpenAPI contract. A breaking change requires all of the following:

1. a new major path such as `/api/v2`;
2. an entry in `docs/api-changelog.md` and the machine-readable changelog;
3. a migration guide and a supported overlap period;
4. passing observed-usage removal gates for the older version; and
5. an explicit compatibility approval in `docs/api-breaking-changes.yml` if the
   current specification intentionally breaks its checked baseline.

Patch and minor backend releases do not relax this promise. The API's major
version is carried by the URL, not the deployment package version.

## 2. Mechanical breaking-change boundary

The table is normative. `backend/scripts/check-openapi-compatibility.js`
applies these rules to `docs/openapi-v1.previous.yml` and `docs/openapi.yml`.

| Contract change | Breaking? | Mechanical rule |
|---|---:|---|
| Remove a path or HTTP operation | Yes | Every baseline path/operation must remain. |
| Rename a path, parameter, property, or operation | Yes | Treated as remove + add. |
| Remove a request parameter that a client may send | Yes | Baseline parameter keys `(in,name)` must remain. |
| Make an optional request parameter/body property required | Yes | Current `required` may not gain baseline-optional inputs. |
| Remove a required marker from a response field | Yes | Clients may rely on a promised field being present. |
| Remove a response property | Yes | Every baseline response property must remain. |
| Change schema `type`, `format`, or nullability | Yes | Values accepted/returned no longer have the same shape. |
| Change request/response media type | Yes | Every baseline content type must remain. |
| Remove a documented response status | Yes | Status-specific client branches lose their contract. |
| Narrow accepted request enum values | Yes | Every baseline request enum value must remain accepted. |
| Add a possible response enum value | Yes | Exhaustive clients may not have a branch for it. |
| Tighten request min/max length, numeric bounds, or item bounds | Yes | A previously valid request becomes invalid. |
| Tighten `additionalProperties` from allowed to forbidden | Yes | Previously valid extensions become invalid. |
| Change a stable machine error code | Yes | It is equivalent to changing a response enum value. |
| Change authentication or required scope | Yes | Existing calls stop being accepted. |
| Change pagination order, cursor meaning, idempotency, units, or field semantics | Yes | Semantic changes are announced even if a schema diff cannot see them. |
| Add an optional response property | Compatible | Official clients must ignore unknown fields. |
| Add an optional request parameter/property | Compatible | Existing request documents remain valid. |
| Add a new path, operation, or response status for a new request case | Compatible | Existing operations retain their contract. |
| Improve a description or example without changing semantics | Compatible | No validation or runtime behaviour changes. |

### Error contracts

Clients branch on `error.code`, never `error.message`. Existing code/status
pairs and the meaning of `details` are stable within a major version. New error
codes may be introduced only for a request case that old clients could not
previously produce. If an existing request can start receiving the code, that
is a response-enum addition and therefore breaking.

### Additive responses and strict clients

All first-party clients ignore unknown object and envelope fields. That is part
of the client conformance contract and is covered for mobile by
`mobile/__tests__/apiCompatibility.test.ts`. Third-party clients should do the
same. Additive fields are still called out in the changelog when they materially
change available behaviour.

## 3. CI enforcement and intentional breaks

The backend CI job runs:

```bash
npm run check:api-compat
```

The check compares the current document to the immutable previous published
snapshot. It exits non-zero and prints stable change identifiers for every
unannounced breaking change.

An intentional break is recorded in `docs/api-breaking-changes.yml` using the
identifier printed by the checker. An approval must include:

- announcement date;
- target major version;
- owner;
- rationale; and
- migration-guide URL.

Approval does not make a v1 break acceptable. It records that the difference
belongs to an announced new-major migration and prevents a silent exception.
After a specification is published, release automation replaces the baseline
with that exact artifact and removes approvals no longer present in the diff.

The one `x-compatibility.pathAliases` entry corrects the historical
specification's unversioned path spelling to the actual `/api/v1` stable routes
before comparison. It does not suppress operation or schema differences.

## 4. Client and version usage measurement

Every official client sends:

| Header | Example | Purpose |
|---|---|---|
| `X-Client-Name` | `mobile` | Client family (`web`, `mobile`, `extension`). |
| `X-Client-Version` | `4.2.1` | Installed release, not API version. |
| `X-Client-API-Version` | `1` | Highest major response contract understood. |

For each completed API request the backend emits a structured `api_request`
record containing:

```json
{
  "event": "api_request",
  "apiVersion": "v1",
  "requestedVersion": "legacy",
  "clientName": "mobile",
  "clientVersion": "4.2.1",
  "clientApiVersion": "1",
  "method": "GET",
  "endpoint": "/api/projects",
  "statusCode": 308,
  "deprecated": true,
  "count": 1
}
```

Identifiers, addresses, query strings, bodies, tokens, and source IPs are not
telemetry dimensions. Matched Express route templates prevent project or donor
identifiers from creating one series per person. Invalid/high-cardinality
header values become `unknown`, and the local series set is bounded.

Structured logs are the durable measurement source. Operators can inspect the
current process aggregate at authenticated `GET /api/v1/admin/api-usage`. A
fleet report groups durable records by day, endpoint, requested version, client
name, and client version. The deprecation review must include:

- total and percentage of calls to the deprecated version;
- unique active official client releases during the window;
- success/error rate by release and endpoint; and
- the oldest release with meaningful traffic.

Unknown clients count against removal. Missing headers are not evidence that a
client is gone.

## 5. Deprecation and sunset protocol

A deprecated HTTP response includes all of:

```http
Deprecation: true
Sunset: Tue, 31 Dec 2030 23:59:59 GMT
X-API-Version: 1
Link: </api/v1>; rel="successor-version", </api/versions/changelog>; rel="deprecation"; type="application/json"
```

Deprecation is also published through this policy, `docs/api-changelog.md`, and
the machine-readable discovery/changelog endpoints. A response header is never
the sole notification channel.

The sunset value is an **earliest retirement floor**, not permission to remove
the path on that day. If the usage gates below have not passed, the service
continues to serve the path and publishes a later date before the floor.

## 6. Legacy unversioned path decision

The unversioned `/api/*` redirect is committed through at least
**2030-12-31 23:59:59 UTC**. It remains after that date unless a continuous
90-day production observation proves all of these:

1. legacy traffic is below **0.1%** of API requests on every day of the window;
2. no supported first-party mobile, web, or extension version called it;
3. no `unknown` client cohort has meaningful legacy traffic;
4. the endpoint-level report shows no donation-flow dependency; and
5. a further **180-day** notice has been published in both changelog channels.

Failed gates extend the commitment; they never force a client upgrade. This is
the decided fate until observed data supports a later removal proposal.

The redirect uses HTTP 308 so method, query, and request body are preserved.

## 7. Serving two versions concurrently

`mountApiVersion(app, version, definitions)` mounts isolated route boundaries.
Each definition chooses one of three strategies:

1. **Parallel router** for changed validation or behaviour.
2. **Representation adapter** when domain behaviour is shared but the external
   shape differs.
3. **Shared router** only when the two contracts are genuinely identical.

Do not scatter `if (version)` through domain services. The major-version
boundary must remain visible in `server.js`, and version transforms must be
pure functions with regression tests.

### Worked example: metadata

Both endpoints are live concurrently:

```text
GET /api/v1/meta -> { name, version, environment, network, node, uptimeSeconds, timestamp }
GET /api/v2/meta -> { service: {...}, runtime: {...}, api: { version: "v2", ... } }
```

`routes/meta.js` owns the shared metadata read. `versioning/metaV2.js` adapts
that result only on the `/api/v2/meta` mount. Tests prove the v1 representation
is unchanged while v2 is served. V2 remains experimental and limited to this
worked endpoint until a separately reviewed v2 contract is announced.

## 8. Lifecycle for a future stable v2

1. Copy the last published v1 contract as an immutable baseline.
2. Add v2 routes/adapters and a distinct v2 OpenAPI document or fully annotated
   section.
3. Publish migration examples and an error-code mapping.
4. Add first-party client negotiation/tolerance tests.
5. Advertise v2 as experimental in `GET /api/versions` while clients exercise it.
6. Promote it to stable only after web, extension, and a released mobile build
   have production telemetry.
7. Deprecate v1 only after setting a sunset floor and beginning the observation
   window. Serve both versions until every usage gate passes.

## 9. Release review checklist

- [ ] Compatibility CI is green against the published baseline.
- [ ] Semantic changes not visible in OpenAPI were reviewed against section 2.
- [ ] New fields are optional and official clients ignore them.
- [ ] Error codes and HTTP statuses retain their meaning.
- [ ] Usage telemetry dimensions remain bounded and identifier-free.
- [ ] Deprecations appear in headers, both changelog channels, and OpenAPI.
- [ ] The older version remains deployed and covered by tests.
- [ ] Rollback restores the previous routes and specification together.
