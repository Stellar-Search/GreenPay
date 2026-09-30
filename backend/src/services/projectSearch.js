"use strict";

/**
 * Indexed project search with ranking and facets.
 *
 * Multilingual strategy: English stemming on name/description (primary donor
 * language), plus a parallel 'simple' tokenization pass so Spanish/Arabic
 * keywords in any field still match without being mis-stemmed. Trigram similarity
 * on name/location provides typo tolerance without leading-wildcard scans.
 */

/** SQL fragment: match approved translations via ILIKE (multilingual keywords). */
function translationSearchClause(paramIndex) {
  return `EXISTS (
    SELECT 1 FROM project_translations search_translation
    WHERE search_translation.project_id = p.id
      AND search_translation.moderation_status = 'approved'
      AND (
        search_translation.name ILIKE '%' || $${paramIndex} || '%'
        OR search_translation.description ILIKE '%' || $${paramIndex} || '%'
        OR search_translation.category ILIKE '%' || $${paramIndex} || '%'
        OR search_translation.location ILIKE '%' || $${paramIndex} || '%'
      )
  )`;
}

/** SQL fragment: combined english+simple tsquery match + trigram typo tolerance. */
function searchMatchClause(paramIndex) {
  return `(
      p.search_vector @@ (
        plainto_tsquery('english', $${paramIndex})
        || plainto_tsquery('simple', $${paramIndex})
      )
      OR similarity(p.name, $${paramIndex}) > 0.2
      OR similarity(p.location, $${paramIndex}) > 0.25
    )`;
}

/** SQL fragment: ts_rank_cd against the same combined query used for matching. */
function searchRankClause(paramIndex) {
  return `ts_rank_cd(
      p.search_vector,
      plainto_tsquery('english', $${paramIndex}) || plainto_tsquery('simple', $${paramIndex}),
      32
    )`;
}

const { projectLocalizationSelect } = require("./contentLanguage");
const { decodeCursor, formatPaginatedResponse } = require("../utils/pagination");

const VALID_STATUSES = ["active", "completed", "paused"];
const VALID_CATEGORIES = [
  "Reforestation",
  "Solar Energy",
  "Ocean Conservation",
  "Clean Water",
  "Wildlife Protection",
  "Carbon Capture",
  "Wind Energy",
  "Sustainable Agriculture",
  "Other",
];

const FUNDING_BUCKETS = Object.freeze([
  { key: "under25", min: 0, max: 0.25 },
  { key: "25to50", min: 0.25, max: 0.5 },
  { key: "50to75", min: 0.5, max: 0.75 },
  { key: "over75", min: 0.75, max: 1.0 },
  { key: "funded", min: 1.0, max: Infinity },
]);

/**
 * Escape user input for safe use inside trigram/similarity patterns.
 * Strips SQL wildcard characters so user-supplied % and _ are literal.
 */
function sanitizeSearchTerm(raw) {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/[%_\\]/g, "").slice(0, 200);
}

/**
 * Parse and validate listing query parameters.
 */
function parseFilters(query) {
  const limitRaw = Number.parseInt(query.limit, 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, 100)
    : 50;

  const lang = typeof query.lang === "string" && query.lang.trim()
    ? query.lang.trim().toLowerCase()
    : null;

  let cursor = null;
  if (query.cursor) {
    cursor = decodeCursor(query.cursor);
  }

  return {
    category: VALID_CATEGORIES.includes(query.category) ? query.category : null,
    status: VALID_STATUSES.includes(query.status) ? query.status : null,
    verified: query.verified === "true" ? true : query.verified === "false" ? false : null,
    search: sanitizeSearchTerm(query.search),
    lang,
    cursor,
    limit,
  };
}

/**
 * Append keyset cursor predicates to the listing query only (not facet counts).
 */
function appendListingCursor(filters, whereSql, values) {
  if (!filters.cursor) {
    return whereSql;
  }

  if (filters.cursor.createdAt && filters.cursor.id) {
    values.push(filters.cursor.createdAt, filters.cursor.id);
    const clause = `(p.created_at, p.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`;
    return whereSql ? `${whereSql} AND ${clause}` : `WHERE ${clause}`;
  }

  if (filters.cursor.createdAt) {
    values.push(filters.cursor.createdAt);
    const clause = `p.created_at < $${values.length}::timestamptz`;
    return whereSql ? `${whereSql} AND ${clause}` : `WHERE ${clause}`;
  }

  return whereSql;
}

/**
 * Build shared WHERE clause fragments used by both listing and facet queries.
 */
function buildWhereClause(filters) {
  const where = [];
  const values = [];
  let searchParamIndex = null;

  if (filters.status) {
    values.push(filters.status);
    where.push(`p.status = $${values.length}`);
  }
  if (filters.category) {
    values.push(filters.category);
    where.push(`p.category = $${values.length}`);
  }
  if (filters.verified === true) {
    where.push("p.verified = true");
  } else if (filters.verified === false) {
    where.push("p.verified = false");
  }

  if (filters.search) {
    values.push(filters.search);
    searchParamIndex = values.length;
    where.push(
      `(${searchMatchClause(searchParamIndex)} OR ${translationSearchClause(searchParamIndex)})`,
    );
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return { whereSql, values, searchParamIndex };
}

/**
 * Build ranked listing SQL. When no search term, falls back to created_at DESC.
 */
function buildListingQuery(filters, ranking) {
  const { whereSql, values, searchParamIndex } = buildWhereClause(filters);
  const listingWhereSql = appendListingCursor(filters, whereSql, values);

  let localizationJoin = "";
  let localizationColumns = "";
  if (filters.lang) {
    values.push(filters.lang);
    const languageParam = `$${values.length}`;
    const localization = projectLocalizationSelect(languageParam);
    localizationJoin = localization.join;
    localizationColumns = `${localization.columns}, ${languageParam}::text AS requested_language`;
  }

  const limitIndex = values.length + 1;
  values.push(filters.limit + 1);

  let orderBy;
  let rankSelect = "0 AS rank_score";
  const hasSearchRanking = Boolean(filters.search && searchParamIndex);

  if (hasSearchRanking) {
    const idx = searchParamIndex;
    rankSelect = `(
      $${limitIndex + 1}::float8 * (
        ${searchRankClause(idx)}
        + $${limitIndex + 2}::float8 * GREATEST(similarity(p.name, $${idx}), 0)
      )
      + $${limitIndex + 3}::float8 * CASE WHEN p.verified THEN 1 ELSE 0 END
      + $${limitIndex + 4}::float8 * LEAST(
          CASE WHEN p.goal_xlm > 0 THEN (p.raised_xlm / p.goal_xlm)::float8 ELSE 0 END,
          1.0
        )
      + $${limitIndex + 5}::float8 * (LN(p.donor_count + 1) / LN(101))
    ) AS rank_score`;

    values.push(
      ranking.textRelevance,
      ranking.trigramWeight,
      ranking.verifiedBoost,
      ranking.fundingProgressBoost,
      ranking.donorCountBoost,
    );

    orderBy = "rank_score DESC, created_at DESC, id DESC";
  } else {
    orderBy = "p.created_at DESC, p.id DESC";
  }

  let sql;
  if (hasSearchRanking) {
    sql = `
      SELECT * FROM (
        SELECT p.*, ${rankSelect}${localizationColumns}
        FROM projects p
        ${localizationJoin}
        ${listingWhereSql}
      ) AS listing
      ORDER BY ${orderBy}
      LIMIT $${limitIndex}
    `;
  } else {
    sql = `
      SELECT p.*, ${rankSelect}${localizationColumns}
      FROM projects p
      ${localizationJoin}
      ${listingWhereSql}
      ORDER BY ${orderBy}
      LIMIT $${limitIndex}
    `;
  }

  return { sql, values };
}

/**
 * Build facet aggregation queries under the same visibility WHERE clause.
 */
function buildFacetQueries(filters) {
  const { whereSql, values } = buildWhereClause(filters);
  const baseFrom = `FROM projects p ${whereSql}`;

  return {
    total: {
      sql: `SELECT COUNT(*)::int AS count ${baseFrom}`,
      values: [...values],
    },
    category: {
      sql: `SELECT p.category AS value, COUNT(*)::int AS count ${baseFrom} GROUP BY p.category ORDER BY count DESC`,
      values: [...values],
    },
    status: {
      sql: `SELECT p.status AS value, COUNT(*)::int AS count ${baseFrom} GROUP BY p.status ORDER BY count DESC`,
      values: [...values],
    },
    verified: {
      sql: `SELECT p.verified AS value, COUNT(*)::int AS count ${baseFrom} GROUP BY p.verified ORDER BY count DESC`,
      values: [...values],
    },
    location: {
      sql: `SELECT p.location AS value, COUNT(*)::int AS count ${baseFrom} GROUP BY p.location ORDER BY count DESC LIMIT 20`,
      values: [...values],
    },
    fundingProgress: {
      sql: `
        SELECT bucket AS value, COUNT(*)::int AS count
        FROM (
          SELECT CASE
            WHEN p.goal_xlm > 0 AND p.raised_xlm >= p.goal_xlm THEN 'funded'
            WHEN p.goal_xlm > 0 AND p.raised_xlm / p.goal_xlm >= 0.75 THEN 'over75'
            WHEN p.goal_xlm > 0 AND p.raised_xlm / p.goal_xlm >= 0.5 THEN '50to75'
            WHEN p.goal_xlm > 0 AND p.raised_xlm / p.goal_xlm >= 0.25 THEN '25to50'
            ELSE 'under25'
          END AS bucket
          FROM projects p
          ${whereSql}
        ) sub
        GROUP BY bucket
        ORDER BY count DESC
      `,
      values: [...values],
    },
  };
}

function rowsToCountMap(rows, keyTransform = (v) => v) {
  const map = {};
  for (const row of rows) {
    map[keyTransform(row.value)] = row.count;
  }
  return map;
}

/**
 * Execute search listing + facets against a pool.
 */
async function searchProjects(pool, queryParams, ranking) {
  const filters = parseFilters(queryParams);
  const started = Date.now();

  const listing = buildListingQuery(filters, ranking);
  const facets = buildFacetQueries(filters);

  const [listResult, totalResult, categoryResult, statusResult, verifiedResult, locationResult, fundingResult] =
    await Promise.all([
      pool.query(listing.sql, listing.values),
      pool.query(facets.total.sql, facets.total.values),
      pool.query(facets.category.sql, facets.category.values),
      pool.query(facets.status.sql, facets.status.values),
      pool.query(facets.verified.sql, facets.verified.values),
      pool.query(facets.location.sql, facets.location.values),
      pool.query(facets.fundingProgress.sql, facets.fundingProgress.values),
    ]);

  const latencyMs = Date.now() - started;
  const totalCount = totalResult.rows[0]?.count ?? 0;
  const { data, meta: paginationMeta } = formatPaginatedResponse({
    rows: listResult.rows,
    limit: filters.limit,
    getCursorPayload: (row) => ({
      createdAt: row.created_at,
      id: row.id,
    }),
    totalCount,
    isTotalExact: true,
  });

  return {
    rows: data,
    meta: {
      total: totalCount,
      search: filters.search || null,
      latencyMs,
      ranking: filters.search ? ranking : null,
      facets: {
        category: rowsToCountMap(categoryResult.rows),
        status: rowsToCountMap(statusResult.rows),
        verified: rowsToCountMap(verifiedResult.rows, (v) => String(v)),
        location: rowsToCountMap(locationResult.rows),
        fundingProgress: rowsToCountMap(fundingResult.rows),
      },
      ...paginationMeta,
    },
    filters,
  };
}

module.exports = {
  VALID_STATUSES,
  VALID_CATEGORIES,
  FUNDING_BUCKETS,
  sanitizeSearchTerm,
  parseFilters,
  buildWhereClause,
  buildListingQuery,
  buildFacetQueries,
  searchProjects,
  searchMatchClause,
  searchRankClause,
  translationSearchClause,
};
