/**
 * src/services/onboarding/funnel.js
 *
 * End-to-end instrumentation of the first-donation funnel.
 *
 * The entire justification for graduated onboarding is that more people reach
 * a completed donation. That is a measurable claim, and without measurement it
 * stays an opinion — which is how a change that makes things *worse* survives,
 * because the team that shipped it likes it. So the funnel is instrumented
 * before the flows that depend on it, with the pre-change path emitting the
 * same stages, so there is a real baseline to compare against rather than a
 * remembered one.
 *
 * ── What is deliberately not collected ──────────────────────────────────────
 * No IP addresses, no user agents, no cookies, no cross-site identifiers. A
 * session id is a random value the browser generates and keeps; it is not
 * derived from anything about the person. This is enough to compute
 * stage-to-stage conversion — which is the only question being asked — and not
 * enough to identify anyone. Instrumenting a donation funnel is not a licence
 * to build a profile.
 */
"use strict";

const { randomUUID: uuid } = require("crypto");
const pool = require("../../db/pool");
const { logger: rootLogger } = require("../../utils/logger");

const logger = rootLogger.child({ service: "onboarding-funnel" });

/**
 * The stages, in order. Every path emits the same stage names so that
 * "connected wallet" and "sponsored account" are comparable rather than two
 * incomparable dashboards.
 *
 * The ordering matters: conversion between adjacent stages is what identifies
 * *where* people leave, and a stage appended in the wrong place silently
 * reattributes a drop-off to its neighbour.
 */
const STAGES = Object.freeze([
  /** Donor arrived on a page from which donating is possible. */
  "donate_intent",
  /** Donor was shown the choice of onboarding paths. */
  "path_offered",
  /** Donor picked a path. */
  "path_selected",
  /** Donor was shown, and accepted, the trade-offs of that path. */
  "tradeoff_acknowledged",
  /** A usable account exists (connected, or created). */
  "account_ready",
  /** The account holds enough to donate. */
  "funds_available",
  /** Donor entered an amount and pressed donate. */
  "donation_submitted",
  /** Transaction confirmed on-chain. */
  "donation_confirmed",
  /** Donation recorded by the backend — the funnel's success terminus. */
  "donation_recorded",
]);

/** The paths a donor can take. Recorded so each can be measured separately. */
const PATHS = Object.freeze([
  /** Today's flow: an installed wallet with a funded account. Unchanged. */
  "connected_wallet",
  /** Donor holds an asset (or will) but has no account: sponsored creation. */
  "sponsored_account",
  /** Donor has neither: on-ramp handoff. */
  "onramp",
  /** Value committed before the account exists. */
  "claimable_balance",
]);

/** Terminal outcomes. `abandoned` is inferred by the sweeper, not reported. */
const OUTCOMES = Object.freeze(["completed", "abandoned", "failed", "in_progress"]);

const STAGE_INDEX = new Map(STAGES.map((stage, index) => [stage, index]));

class FunnelError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "FunnelError";
    this.status = status;
    this.code = "FUNNEL_INVALID";
  }
}

function assertStage(stage) {
  if (!STAGE_INDEX.has(stage)) {
    throw new FunnelError(`Unknown funnel stage "${stage}".`);
  }
}

function assertPath(path) {
  if (path && !PATHS.includes(path)) {
    throw new FunnelError(`Unknown onboarding path "${path}".`);
  }
}

/** Starts a funnel session. The id is opaque and holds no personal data. */
async function startSession({ path = null, projectId = null, referrer = null } = {}, dbPool = pool) {
  assertPath(path);
  const id = uuid();
  await dbPool.query(
    `INSERT INTO onboarding_sessions (id, path, project_id, referrer_kind, outcome)
     VALUES ($1, $2, $3, $4, 'in_progress')`,
    [id, path, projectId, normalizeReferrer(referrer)],
  );
  return { sessionId: id };
}

/**
 * Referrers are bucketed, never stored verbatim. "where did they come from" is
 * answerable with a handful of categories; a raw URL is a tracking identifier.
 */
function normalizeReferrer(referrer) {
  if (!referrer) return "direct";
  const value = String(referrer).toLowerCase();
  if (value.includes("//")) {
    try {
      const host = new URL(referrer).hostname;
      if (/(twitter|x\.com|t\.co)/.test(host)) return "social";
      if (/(google|bing|duckduckgo)/.test(host)) return "search";
      if (/greenpay/.test(host)) return "internal";
      return "external";
    } catch {
      return "unknown";
    }
  }
  if (["direct", "social", "search", "internal", "external", "qr", "email"].includes(value)) return value;
  return "unknown";
}

/**
 * Records one stage.
 *
 * Idempotent per (session, stage, path): a component that re-renders must not
 * inflate its own conversion rate. Re-reporting a stage updates its timestamp
 * rather than adding a row.
 */
async function recordStage({ sessionId, stage, path = null, projectId = null, detail = null }, dbPool = pool) {
  assertStage(stage);
  assertPath(path);
  if (!sessionId) throw new FunnelError("sessionId is required.");

  await dbPool.query(
    `INSERT INTO onboarding_funnel_events (id, session_id, stage, stage_index, path, project_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (session_id, stage, path_key) DO UPDATE
       SET occurred_at = NOW(), detail = EXCLUDED.detail`,
    [uuid(), sessionId, stage, STAGE_INDEX.get(stage), path, projectId, detail ? JSON.stringify(detail) : null],
  );

  // The session carries the furthest stage reached so conversion queries do
  // not have to aggregate the event table for the common case.
  await dbPool.query(
    `UPDATE onboarding_sessions
     SET furthest_stage = CASE WHEN $2 > furthest_stage_index THEN $3 ELSE furthest_stage END,
         furthest_stage_index = GREATEST(furthest_stage_index, $2),
         path = COALESCE($4, path),
         updated_at = NOW()
     WHERE id = $1`,
    [sessionId, STAGE_INDEX.get(stage), stage, path],
  );

  return { recorded: true, stage, stageIndex: STAGE_INDEX.get(stage) };
}

/** Closes a session with a terminal outcome. */
async function completeSession({ sessionId, outcome, path = null }, dbPool = pool) {
  if (!OUTCOMES.includes(outcome)) throw new FunnelError(`Unknown outcome "${outcome}".`);
  assertPath(path);
  await dbPool.query(
    `UPDATE onboarding_sessions
     SET outcome = $2, path = COALESCE($3, path), closed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND outcome = 'in_progress'`,
    [sessionId, outcome, path],
  );
  return { sessionId, outcome };
}

/**
 * Marks stale in-progress sessions abandoned so they stop counting as
 * "still deciding" forever and skewing conversion upward.
 */
async function sweepAbandonedSessions({ olderThanHours = 24 } = {}, dbPool = pool) {
  const { rowCount } = await dbPool.query(
    `UPDATE onboarding_sessions
     SET outcome = 'abandoned', closed_at = NOW(), updated_at = NOW()
     WHERE outcome = 'in_progress' AND updated_at < NOW() - ($1 || ' hours')::interval`,
    [String(olderThanHours)],
  );
  if (rowCount) logger.info({ msg: "abandoned onboarding sessions swept", count: rowCount });
  return rowCount;
}

/**
 * Stage-by-stage conversion, optionally split by path and windowed by date.
 *
 * `sinceIso`/`untilIso` exist so the pre-change baseline is queryable with the
 * same code that reports the post-change number. Comparing a new measurement
 * against an old measurement taken a different way is the most common way this
 * kind of analysis lies.
 */
async function conversionReport({ sinceIso = null, untilIso = null, path = null } = {}, dbPool = pool) {
  assertPath(path);

  const { rows } = await dbPool.query(
    `SELECT e.stage, e.stage_index, COALESCE(e.path, 'unknown') AS path,
            COUNT(DISTINCT e.session_id) AS sessions
     FROM onboarding_funnel_events e
     WHERE ($1::timestamptz IS NULL OR e.occurred_at >= $1)
       AND ($2::timestamptz IS NULL OR e.occurred_at <  $2)
       AND ($3::text IS NULL OR e.path = $3)
     GROUP BY e.stage, e.stage_index, e.path
     ORDER BY e.stage_index ASC`,
    [sinceIso, untilIso, path],
  );

  const byPath = new Map();
  for (const row of rows) {
    if (!byPath.has(row.path)) byPath.set(row.path, new Map());
    byPath.get(row.path).set(row.stage, Number(row.sessions));
  }

  const paths = [];
  for (const [pathName, stageCounts] of byPath.entries()) {
    const entry = STAGES.map((stage) => stageCounts.get(stage) || 0);
    const top = entry[0] || 0;
    paths.push({
      path: pathName,
      stages: STAGES.map((stage, index) => {
        const count = entry[index];
        const previous = index === 0 ? count : entry[index - 1];
        return {
          stage,
          sessions: count,
          // Conversion from the immediately preceding stage — where people
          // actually leave — alongside conversion from the top, which is the
          // number the change is judged on.
          fromPreviousPct: previous > 0 ? round2((count / previous) * 100) : null,
          fromTopPct: top > 0 ? round2((count / top) * 100) : null,
        };
      }),
      donateIntent: top,
      donationsRecorded: entry[STAGES.length - 1] || 0,
      overallConversionPct: top > 0 ? round2(((entry[STAGES.length - 1] || 0) / top) * 100) : null,
    });
  }

  paths.sort((a, b) => b.donateIntent - a.donateIntent);

  const totals = STAGES.map((stage, index) =>
    paths.reduce((sum, p) => sum + p.stages[index].sessions, 0),
  );

  return {
    window: { since: sinceIso, until: untilIso },
    stages: STAGES,
    paths,
    overall: {
      donateIntent: totals[0],
      donationsRecorded: totals[totals.length - 1],
      conversionPct: totals[0] > 0 ? round2((totals[totals.length - 1] / totals[0]) * 100) : null,
    },
  };
}

/**
 * Compares two windows — the point of the whole exercise.
 *
 * Returns the delta in percentage *points* rather than a ratio, because a
 * change from 2% to 3% is a percentage-point improvement of 1 and a relative
 * improvement of 50%, and quoting the second without the first is how a
 * rounding-level change gets reported as a triumph.
 */
async function compareToBaseline({ baselineSince, baselineUntil, currentSince, currentUntil = null }, dbPool = pool) {
  const [baseline, current] = await Promise.all([
    conversionReport({ sinceIso: baselineSince, untilIso: baselineUntil }, dbPool),
    conversionReport({ sinceIso: currentSince, untilIso: currentUntil }, dbPool),
  ]);

  const baselinePct = baseline.overall.conversionPct;
  const currentPct = current.overall.conversionPct;

  return {
    baseline: { window: baseline.window, ...baseline.overall },
    current: { window: current.window, ...current.overall },
    deltaPercentagePoints:
      baselinePct === null || currentPct === null ? null : round2(currentPct - baselinePct),
    relativeChangePct:
      baselinePct === null || currentPct === null || baselinePct === 0
        ? null
        : round2(((currentPct - baselinePct) / baselinePct) * 100),
    // A conversion number computed from a handful of sessions is noise. Saying
    // so in the payload is cheaper than explaining it after someone acts on it.
    sufficientSample: baseline.overall.donateIntent >= 100 && current.overall.donateIntent >= 100,
    byPath: current.paths.map((p) => ({
      path: p.path,
      conversionPct: p.overallConversionPct,
      donateIntent: p.donateIntent,
      donationsRecorded: p.donationsRecorded,
    })),
  };
}

/** Where donors leave, biggest drop first. The list to work from. */
function biggestDropOffs(report, limit = 3) {
  const drops = [];
  for (const path of report.paths) {
    for (let i = 1; i < path.stages.length; i += 1) {
      const stage = path.stages[i];
      const previous = path.stages[i - 1];
      if (previous.sessions === 0) continue;
      drops.push({
        path: path.path,
        from: previous.stage,
        to: stage.stage,
        lost: previous.sessions - stage.sessions,
        retainedPct: stage.fromPreviousPct,
      });
    }
  }
  return drops.sort((a, b) => b.lost - a.lost).slice(0, limit);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

module.exports = {
  STAGES,
  PATHS,
  OUTCOMES,
  FunnelError,
  startSession,
  recordStage,
  completeSession,
  sweepAbandonedSessions,
  conversionReport,
  compareToBaseline,
  biggestDropOffs,
  normalizeReferrer,
};
