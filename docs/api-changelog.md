# API lifecycle changelog

This is the human-readable announcement channel for API compatibility and
deprecation changes. Clients can discover the same active notices at
`GET /api/versions/changelog`. Subscribe to repository release notes or watch
this file for changes; deprecation response headers are supplementary.

## 2026-08-28 — lifecycle policy and measurement (v1, compatible)

- Published the mechanical [versioning policy](api-versioning-policy.md).
- Added CI compatibility comparison against `openapi-v1.previous.yml`.
- Added client family, client release, supported API, endpoint, status, and
  requested-version usage measurement.
- Added `GET /api/versions` and `GET /api/versions/changelog`.
- Added `X-API-Version` to versioned API responses.
- Corrected stable OpenAPI path spelling from historical `/api/*` aliases to
  the implemented `/api/v1/*` paths. Runtime behaviour is unchanged because
  the aliases continue to redirect with HTTP 308.

No v1 response field, request, error code, or behaviour was removed.

## 2026-08-28 — v2 metadata preview

`GET /api/v2/meta` is available as an experimental worked example of serving
two major representations concurrently. It has no effect on `/api/v1/meta` and
does not announce a complete v2 API.

| Stable v1 field | Experimental v2 location |
|---|---|
| `name` | `service.name` |
| `version` | `service.release` |
| `environment` | `service.environment` |
| `node` | `runtime.node` |
| `network` | `runtime.network` |
| `uptimeSeconds` | `runtime.uptimeSeconds` |
| `timestamp` | `runtime.observedAt` |

## 2026-08-28 — unversioned path deprecation commitment

The legacy `/api/*` path remains a method-preserving redirect to `/api/v1/*`.
Its earliest sunset floor is **2030-12-31 23:59:59 UTC**. It will continue
beyond that floor unless every 90-day observed-usage gate in the policy passes,
followed by at least 180 days of additional notice.

Every legacy response announces:

```http
Deprecation: true
Sunset: Tue, 31 Dec 2030 23:59:59 GMT
Link: </api/v1>; rel="successor-version", </api/versions/changelog>; rel="deprecation"; type="application/json"
```

This is a commitment to old installed clients, not a forced-upgrade deadline.
