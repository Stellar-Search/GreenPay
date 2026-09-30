# Project Search

Ranked, indexed project discovery for donors (issue #500).

## Index strategy

- **`search_vector` (GIN):** weighted `tsvector` built from name (A), category/location (B), tags (C), description (D).
- **Trigram GIN indexes** on `name` and `location` for typo tolerance via `similarity()` — no leading-wildcard `ILIKE` on the hot path.
- **B-tree indexes** on `category`, `status`, and `verified` for facet filters.

## Multilingual handling

English stemming applies to **name** and **description** (primary narrative fields).
Category, location, and tags use `'simple'` tokenization so Spanish/Arabic keywords are
not mis-stemmed. Search queries match against a combined english + simple tsquery, plus
trigram similarity for typo tolerance.

## Ranking function

Default weights live in `backend/src/config/searchRanking.js` and can be overridden:

```bash
PROJECT_SEARCH_RANKING='{"verifiedBoost":0.2,"fundingProgressBoost":0.05}'
```

Combined score when `search` is present:

```
rank = textRelevance * (ts_rank_cd + trigramWeight * similarity(name))
     + verifiedBoost * (verified ? 1 : 0)
     + fundingProgressBoost * min(raised/goal, 1)
     + donorCountBoost * log(donor_count + 1) / log(101)
```

Without a search term, results order by `created_at DESC` (unchanged behaviour for browse-only requests).

## Facets

`GET /api/v1/projects` attaches `meta.facets` with counts for category, status, verified, location (top 20), and funding-progress buckets. Counts use the **same visibility WHERE clause** as the result list so unlisted projects cannot leak through facet totals.

## Latency budget

Target: **≤ 150 ms** at ~1,000 projects (`SEARCH_LATENCY_BUDGET_MS`). Actual latency is reported in `meta.latencyMs`.

## Evaluation harness

Labelled queries and nDCG@k scoring live in `backend/src/services/projectSearchEval.js`. Run:

```bash
cd backend && npm test -- projectSearchEval
```

When changing ranking weights, extend labelled cases and compare `meanNdcg` before/after.

## API compatibility

Existing query parameters (`search`, `category`, `status`, `verified`, `limit`) are unchanged. Response shape adds optional `meta` alongside `data` — clients that ignore `meta` continue to work.
