"use strict";

const { xlmToStroops, xlmToStroopsRounded, stroopsToXlm, normalizeXlm } = require("../utils/xlm");

const PROJECTION_BATCH_SIZE = 500;

const registry = new Map();

class Projection {
  subscribe(eventType) {
    if (!registry.has(eventType)) registry.set(eventType, []);
    registry.get(eventType).push(this);
  }

  getSubscribers(eventType) {
    return registry.get(eventType) || [];
  }
}

const projectProjection = new Projection();
const donorProjection  = new Projection();
const matchProjection  = new Projection();
const jobProjection    = new Projection();
const milestoneProjection = new Projection();

projectProjection.subscribe("DonationRecorded");
projectProjection.subscribe("MatchApplied");
projectProjection.subscribe("MigratedDonation");

donorProjection.subscribe("DonationRecorded");
donorProjection.subscribe("MatchApplied");
donorProjection.subscribe("MigratedDonation");

matchProjection.subscribe("MatchApplied");
matchProjection.subscribe("MatchCreated");
matchProjection.subscribe("MigratedDonation");

jobProjection.subscribe("JobReleased");

milestoneProjection.subscribe("MilestoneReached");

function getAllProjections() {
  return [projectProjection, donorProjection, matchProjection, jobProjection, milestoneProjection];
}

async function dispatchToProjections(client, event) {
  const subscribers = registry.get(event.eventType) || [];
  for (const projection of subscribers) {
    await projection.apply(client, event);
  }
}

function exactXlmAmount(data) {
  if (data.amountStroops !== null && data.amountStroops !== undefined) {
    return stroopsToXlm(data.amountStroops);
  }
  // Fallback for payloads written before amountStroops existed: repair any
  // double artifacts from old JSONB data by rounding to the nearest stroop.
  return stroopsToXlm(xlmToStroopsRounded(data.amountXlm || 0));
}

// MatchAppliedEvent/MatchCreatedEvent serialize matchAmount/capXlm as
// canonical 7-decimal strings (older payloads stored doubles; the event
// constructors normalize them on hydration), so they go into the numeric
// columns verbatim — no toFixed round-trip through a double.
function exactMatchAmount(data) {
  if (data.matchAmountStroops !== null && data.matchAmountStroops !== undefined) {
    return stroopsToXlm(data.matchAmountStroops);
  }
  return normalizeXlm(data.matchAmount);
}

function exactCapAmount(data) {
  if (data.capStroops !== null && data.capStroops !== undefined) {
    return stroopsToXlm(data.capStroops);
  }
  return normalizeXlm(data.capXlm);
}

async function applyProjectProjection(client, event) {
  const data = event.data;

  if (event.eventType === "MatchApplied") {
    await client.query(
      `UPDATE projects
       SET raised_xlm = raised_xlm + $1::numeric,
           donor_count = donor_count + 1,
           updated_at = NOW(),
           projection_cursor = GREATEST(projection_cursor, $2)
       WHERE id = $3`,
      [exactMatchAmount(data), event.version, data.projectId]
    );
  } else if (event.eventType === "DonationRecorded") {
    const xlmDonation = data.currency === "XLM" ? exactXlmAmount(data) : "0.0000000";
    await client.query(
      `UPDATE projects
       SET raised_xlm = raised_xlm + $1::numeric,
           updated_at = NOW(),
           projection_cursor = GREATEST(projection_cursor, $2)
       WHERE id = $3`,
      [xlmDonation, event.version, data.projectId]
    );
  } else if (event.eventType === "MigratedDonation") {
    const amt = exactXlmAmount(data);
    await client.query(
      `UPDATE projects
       SET raised_xlm = raised_xlm + $1::numeric,
           updated_at = NOW(),
           projection_cursor = GREATEST(projection_cursor, $2)
       WHERE id = $3`,
      [amt, event.version, data.projectId]
    );
  }
}

projectProjection.apply = async (client, event) => {
  await applyProjectProjection(client, event);
};

function computeBadges(totalXLM) {
  const BADGE_THRESHOLDS = [
    { tier: "earth", min: 2000 },
    { tier: "forest", min: 500 },
    { tier: "tree", min: 100 },
    { tier: "seedling", min: 10 },
  ];
  const earned = [];
  for (const badge of BADGE_THRESHOLDS) {
    if (totalXLM >= badge.min) {
      earned.push({ tier: badge.tier, earnedAt: new Date().toISOString() });
      break;
    }
  }
  return earned;
}

async function getExistingDonorStats(client, donorAddress) {
  const result = await client.query(
    "SELECT total_donated_xlm FROM donor_stats WHERE public_key = $1",
    [donorAddress]
  );
  if (result.rows[0]) {
    return {
      exists: true,
      totalStroops: xlmToStroops(result.rows[0].total_donated_xlm?.toString() || "0"),
    };
  }
  return { exists: false, totalStroops: 0n };
}

function computeBadgesFromStroops(totalStroops) {
  return computeBadges(Number(totalStroops / 10_000_000n));
}

async function upsertDonorStats(client, donorAddress, xlmDelta, version) {
  const { exists: donorStatsExists, totalStroops: existingTotalStroops } =
    await getExistingDonorStats(client, donorAddress);
  const newTotalStroops = existingTotalStroops + xlmToStroops(xlmDelta);
  const newTotal = stroopsToXlm(newTotalStroops);
  const badges = computeBadgesFromStroops(newTotalStroops);

  // donor_stats.public_key references profiles(public_key), so a donor's very
  // first donation needs a profile row before the insert below can satisfy its
  // foreign key. Every later donation does not: the existence of a donor_stats
  // row is itself proof the profile exists, so the guard is skipped. That keeps
  // the steady-state projection at the four statements per event documented in
  // docs/performance.md (this insert running unconditionally was a fifth, and
  // capacity is set by statements per event).
  if (!donorStatsExists) {
    await client.query(
      `INSERT INTO profiles (public_key, total_donated_xlm, projects_supported, badges, created_at)
       VALUES ($1, 0, 0, '[]'::jsonb, NOW())
       ON CONFLICT (public_key) DO NOTHING`,
      [donorAddress]
    );
  }

  await client.query(
    `INSERT INTO donor_stats (public_key, total_donated_xlm, projects_supported, badges, projection_cursor)
     VALUES ($1, $2::numeric, 0, $3::jsonb, $4)
     ON CONFLICT (public_key) DO UPDATE SET
       total_donated_xlm = EXCLUDED.total_donated_xlm,
       badges = EXCLUDED.badges,
       projection_cursor = EXCLUDED.projection_cursor`,
    [donorAddress, newTotal, JSON.stringify(badges), version]
  );
}

async function syncDonorProjectCount(client, donorAddress, version) {
  await client.query(
    `UPDATE donor_stats
     SET projects_supported = sub.proj_count,
         projection_cursor = GREATEST(donor_stats.projection_cursor, $2)
     FROM (
       SELECT COUNT(DISTINCT (payload->'data'->>'projectId')) AS proj_count
       FROM event_stream
       WHERE aggregate_type IN ('Donation', 'MigratedDonation', 'MatchApplied')
         AND payload->'data'->>'donorAddress' = $1
     ) sub
     WHERE donor_stats.public_key = $1`,
    [donorAddress, version]
  );
}

async function applyDonorProjection(client, event) {
  const data = event.data;
  let xlmDelta = "0.0000000";

  if (event.eventType === "MigratedDonation") {
    xlmDelta = data.isMatch ? exactXlmAmount(data) : (data.currency === "XLM" ? exactXlmAmount(data) : "0.0000000");
  } else {
    xlmDelta = data.currency === "XLM" ? exactXlmAmount(data) : "0.0000000";
  }

  await upsertDonorStats(client, data.donorAddress, xlmDelta, event.version);
  await syncDonorProjectCount(client, data.donorAddress, event.version);
}

donorProjection.apply = async (client, event) => {
  await applyDonorProjection(client, event);
};

async function applyMatchProjection(client, event) {
  const data = event.data;
  const matchId = data.matchId;

  if (event.eventType === "MatchApplied") {
    await client.query(
      `UPDATE match_state
       SET matched_xlm = matched_xlm + $1::numeric,
           projection_cursor = GREATEST(projection_cursor, $2)
       WHERE match_id = $3`,
      [exactMatchAmount(data), event.version, matchId]
    );
  } else if (event.eventType === "MatchCreated" || event.eventType === "MigratedDonation" && data.isMatch === true) {
    await client.query(
      `INSERT INTO match_state (match_id, matched_xlm, cap_xlm, multiplier, projection_cursor)
       VALUES ($1, '0'::numeric, $2, $3, $4)
       ON CONFLICT (match_id) DO NOTHING`,
      [matchId, exactCapAmount(data), data.multiplier || 1, event.version]
    );
  }
}

matchProjection.apply = async (client, event) => {
  await applyMatchProjection(client, event);
};

async function applyJobProjection(client, event) {
  const jobId = event.aggregateId.split(":")[1];
  await client.query(
    `UPDATE jobs
     SET status = 'completed',
         release_transaction_hash = $1,
         updated_at = NOW(),
         projection_cursor = GREATEST(projection_cursor, $2)
     WHERE id = $3`,
    [event.data.releaseTransactionHash, event.version, jobId]
  );
}

jobProjection.apply = async (client, event) => {
  await applyJobProjection(client, event);
};

async function applyMilestoneProjection(client, event) {
  const data = event.data;
  await client.query(
    `UPDATE project_milestones
     SET reached_at = NOW(),
         transaction_hash = $1,
         projection_cursor = GREATEST(projection_cursor, $2)
     WHERE id = $3 AND project_id = $4`,
    [data.transactionHash, event.version, data.milestoneId, data.projectId]
  );
}

milestoneProjection.apply = async (client, event) => {
  await applyMilestoneProjection(client, event);
};

module.exports = {
  Projection,
  getAllProjections,
  dispatchToProjections,
};
