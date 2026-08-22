"use strict";

const pool = require("../db/pool");
const { v4: uuid } = require("uuid");
const {
  MigratedDonationEvent,
  MilestoneReachedEvent,
  JobReleasedEvent,
  ProjectCreatedEvent,
  ProjectStatusChangedEvent,
  fromPayload,
} = require("./events");
const { dispatchToProjections } = require("./projections");
const { compareXlm } = require("../utils/xlm");

const BATCH_SIZE = 500;
const EVENT_STORE_BATCH = 200;

async function runLegacyMigration() {
  console.log("[Migration] Starting legacy data migration into event store...");

  const migrationStateResult = await pool.query(
    "SELECT event_count FROM event_store_migration_state WHERE id = 'legacy'"
  );
  const state = migrationStateResult.rows[0];
  if (state && state.event_count > 0) {
    console.log(`[Migration] Already migrated (${state.event_count} events). Skipping.`);
    return { status: "already_migrated", eventCount: state.event_count };
  }

  const events = [];
  let totalEvents = 0;

  await pool.query("BEGIN");
  try {
    // === 1. Migrate Projects ===
    const projectsResult = await pool.query(
      "SELECT id, name, description, category, location, wallet_address, goal_xlm, tags, created_at FROM projects"
    );
    for (const project of projectsResult.rows) {
      events.push(
        new ProjectCreatedEvent({
          aggregateId: `Project:${project.id}`,
          version: 1,
          actor: "migration",
          name: project.name,
          description: project.description,
          category: project.category,
          location: project.location,
          walletAddress: project.wallet_address,
          // NUMERIC columns arrive as strings — hand them straight to the
          // event, which normalizes exactly in stroops (no parseFloat).
          goalXlm: project.goal_xlm?.toString() || "0",
          tags: project.tags || [],
        })
      );

      if (project.status !== "active") {
        events.push(
          new ProjectStatusChangedEvent({
            aggregateId: `Project:${project.id}`,
            version: 2,
            actor: "migration",
            previousStatus: "active",
            newStatus: project.status,
            reason: null,
          })
        );
      }
    }
    totalEvents += events.length;
    console.log(`[Migration] ${events.length} project events prepared`);

    // === 2. Migrate Donations ===
    const donationsResult = await pool.query(
      "SELECT id, project_id, donor_address, amount_xlm, amount, currency, message, transaction_hash, created_at FROM donations ORDER BY created_at ASC"
    );
    const seenTxHashes = new Set();
    let donationCount = 0;

    for (const donation of donationsResult.rows) {
      if (seenTxHashes.has(donation.transaction_hash)) continue;
      seenTxHashes.add(donation.transaction_hash);

      events.push(
        new MigratedDonationEvent({
          originalId: donation.id,
          donationId: `Donation:${donation.transaction_hash}`,
          version: 1,
          actor: "migration",
          originalCreatedAt: donation.created_at?.toISOString ? donation.created_at.toISOString() : donation.created_at,
          projectId: donation.project_id,
          donorAddress: donation.donor_address,
          amountXlm: (donation.amount_xlm ?? donation.amount ?? 0).toString(),
          currency: donation.currency || "XLM",
          message: donation.message,
          transactionHash: donation.transaction_hash,
          isMatch: false,
        })
      );
      donationCount++;
    }

    totalEvents += donationCount;
    console.log(`[Migration] ${donationCount} unique donation events prepared`);

    // === 3. Migrate Matches ===
    const matchesResult = await pool.query(
      "SELECT id, project_id, matcher_address, cap_xlm, matched_xlm, multiplier, expires_at, created_at FROM donation_matches"
    );
    let matchCreatedCount = 0;
    let matchAppliedCount = 0;

    for (const match of matchesResult.rows) {
      events.push(
        new (require("./events").MatchCreatedEvent)({
          aggregateId: `Match:${match.id}`,
          version: 1,
          actor: "migration",
          matchId: match.id,
          projectId: match.project_id,
          matcherAddress: match.matcher_address,
          capXlm: match.cap_xlm?.toString() || "0",
          multiplier: match.multiplier || 1,
          expiresAt: match.expires_at?.toISOString ? match.expires_at.toISOString() : match.expires_at,
        })
      );
      matchCreatedCount++;

      const matchedXlm = match.matched_xlm?.toString() || "0";
      if (compareXlm(matchedXlm, "0") > 0) {
        events.push(
          new (require("./events").MatchAppliedEvent)({
            aggregateId: `Match:${match.id}`,
            version: 2,
            actor: "migration",
            matchId: match.id,
            projectId: match.project_id,
            donorAddress: match.matcher_address,
            matchAmount: matchedXlm,
            originalTxHash: `migration-match-${match.id}`,
            multiplier: match.multiplier || 1,
          })
        );
        matchAppliedCount++;
      }
    }

    totalEvents += matchCreatedCount + matchAppliedCount;
    console.log(`[Migration] ${matchCreatedCount} match_created + ${matchAppliedCount} match_applied events prepared`);

    // === 4. Migrate Milestones ===
    const milestonesResult = await pool.query(
      "SELECT id, project_id, title, percentage, reached_at, transaction_hash FROM project_milestones WHERE reached_at IS NOT NULL"
    );
    let milestoneCount = 0;

    for (const milestone of milestonesResult.rows) {
      events.push(
        new MilestoneReachedEvent({
          aggregateId: `Milestone:${milestone.id}`,
          version: 1,
          actor: "migration",
          milestoneId: milestone.id,
          projectId: milestone.project_id,
          percentage: parseInt(milestone.percentage, 10) || 0,
          title: milestone.title,
          transactionHash: milestone.transaction_hash,
        })
      );
      milestoneCount++;
    }

    totalEvents += milestoneCount;
    console.log(`[Migration] ${milestoneCount} milestone events prepared`);

    // === 5. Migrate Jobs ===
    const jobsResult = await pool.query("SELECT id, status, release_transaction_hash, client_public_key, freelancer_public_key, amount_escrow_xlm FROM jobs WHERE status = 'completed' AND release_transaction_hash IS NOT NULL");
    let jobCount = 0;

    for (const job of jobsResult.rows) {
      events.push(
        new JobReleasedEvent({
          aggregateId: `Job:${job.id}`,
          version: 1,
          actor: "migration",
          clientPublicKey: job.client_public_key,
          freelancerPublicKey: job.freelancer_public_key,
          amountXlm: job.amount_escrow_xlm?.toString() || "0",
          releaseTransactionHash: job.release_transaction_hash,
        })
      );
      jobCount++;
    }

    totalEvents += jobCount;
    console.log(`[Migration] ${jobCount} job released events prepared`);
    console.log(`[Migration] Total events to write: ${totalEvents}`);

    // === 6. Write events in batches ===
    const { eventStore } = require("./eventStore");

    for (let i = 0; i < events.length; i += EVENT_STORE_BATCH) {
      const batch = events.slice(i, i + EVENT_STORE_BATCH);
      await eventStore.appendBatch(batch);
      const progress = Math.min(i + EVENT_STORE_BATCH, events.length);
      console.log(`[Migration] Written ${progress}/${events.length} events`);
    }

    console.log("[Migration] All events written to event store");
    await pool.query("COMMIT");

    // === 7. Run projections on event store ===
    console.log("[Migration] Running projections to rebuild read models...");
    await rebuildReadModels();

    // === 8. Verify counts ===
    const verification = await verifyMigration(seenTxHashes.size, donationCount);
    console.log(`[Migration] ✓ Verification: ${JSON.stringify(verification)}`);

    // === 9. Record migration state ===
    await pool.query(
      "INSERT INTO event_store_migration_state (id, migrated_at, event_count) VALUES ('legacy', NOW(), $1) ON CONFLICT (id) DO UPDATE SET migrated_at = NOW(), event_count = EXCLUDED.event_count",
      [totalEvents]
    );

    return { status: "completed", eventCount: totalEvents };
  } catch (err) {
    await pool.query("ROLLBACK");
    console.error("[Migration] Failed:", err.message);
    throw err;
  }
}

async function rebuildReadModels() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query("SELECT COUNT(*) AS total FROM event_stream WHERE processed = false");
    const totalEvents = parseInt(result.rows[0].total, 10);
    console.log(`[Rebuild] Processing ${totalEvents} unprocessed events...`);

    const { dispatchToProjections } = require("./projections");

    for (let i = 0; i < totalEvents; i += BATCH_SIZE) {
      const rows = await client.query(
        "SELECT event_id, payload FROM event_stream WHERE processed = false ORDER BY occurred_at ASC, version ASC LIMIT $1 OFFSET $2",
        [BATCH_SIZE, i]
      );

      for (const row of rows.rows) {
        try {
          const event = fromPayload(row.payload);
          await dispatchToProjections(client, event);
        } catch (err) {
          console.error(`[Rebuild] Error dispatching event ${row.event_id}:`, err.message);
        }
      }

      const eventIds = rows.rows.map((r) => r.event_id);
      if (eventIds.length > 0) {
        await client.query(
          "UPDATE event_stream SET processed = true, processed_at = NOW() WHERE event_id = ANY($1::uuid[])",
          [eventIds]
        );
      }

      console.log(`[Rebuild] Processed ${Math.min(i + BATCH_SIZE, totalEvents)}/${totalEvents} events`);
    }

    await client.query("COMMIT");
    console.log("[Rebuild] Read models rebuilt successfully");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function verifyMigration(expectedUniqueTxCount, expectedDonationCount) {
  const uniqueTxResult = await pool.query(
    `SELECT COUNT(DISTINCT (payload->'data'->>'transactionHash')) AS count
     FROM event_stream
     WHERE event_type IN ('DonationRecorded', 'MigratedDonation') AND payload->'data'->>'isMatch' = 'false'`
  );
  const actualUniqueTxCount = parseInt(uniqueTxResult.rows[0]?.count || "0", 10);

  const donationResult = await pool.query(
    `SELECT SUM((payload->'data'->>'amountXlm')::numeric) AS total
     FROM event_stream
     WHERE event_type IN ('DonationRecorded', 'MigratedDonation') AND payload->'data'->>'isMatch' = 'false'`
  );
  // NUMERIC sums come back as strings; compare them exactly in stroops
  // rather than tolerating a drift window between two doubles.
  const eventTotalXlm = donationResult.rows[0]?.total?.toString() || "0";

  const legacyTotalResult = await pool.query("SELECT SUM(amount_xlm::numeric) AS total FROM donations WHERE currency = 'XLM'");
  const legacyTotalXlm = legacyTotalResult.rows[0]?.total?.toString() || "0";

  const donorEventsResult = await pool.query(
    "SELECT COUNT(DISTINCT (payload->'data'->>'donorAddress')) AS count FROM event_stream WHERE aggregate_type IN ('Donation', 'MigratedDonation')"
  );
  const eventUniqueDonors = parseInt(donorEventsResult.rows[0]?.count || "0", 10);

  const legacyUniqueDonorsResult = await pool.query(
    "SELECT COUNT(DISTINCT donor_address) AS count FROM donations"
  );
  const legacyUniqueDonors = parseInt(legacyUniqueDonorsResult.rows[0]?.count || "0", 10);

  const matchInEventsResult = await pool.query(
    "SELECT COUNT(*) AS count FROM event_stream WHERE event_type = 'MigratedDonation' AND payload->'data'->>'isMatch' = 'true'"
  );
  const eventMatchCount = parseInt(matchInEventsResult.rows[0]?.count || "0", 10);

  const legacyMatchResult = await pool.query(
    "SELECT SUM(matched_xlm::numeric) AS total FROM donation_matches"
  );
  const legacyMatchTotal = legacyMatchResult.rows[0]?.total?.toString() || "0";

  return {
    uniqueTxHashesMatch: actualUniqueTxCount === expectedUniqueTxCount,
    expectedUniqueTxCount,
    actualUniqueTxCount,
    xlmTotalMatch: compareXlm(eventTotalXlm, legacyTotalXlm) === 0,
    eventTotalXlm,
    legacyTotalXlm,
    uniqueDonorsMatch: eventUniqueDonors === legacyUniqueDonors,
    eventUniqueDonors,
    legacyUniqueDonors,
    eventMatchCount,
    legacyMatchTotal,
  };
}

module.exports = { runLegacyMigration, rebuildReadModels, verifyMigration };
