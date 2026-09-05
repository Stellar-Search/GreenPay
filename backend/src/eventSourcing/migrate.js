"use strict";

const pool = require("../db/pool");
const { v4: uuid } = require("uuid");
const {
  LEGACY_DONATION_MIGRATED,
  MigratedDonationEvent,
  MilestoneReachedEvent,
  JobReleasedEvent,
  ProjectCreatedEvent,
  ProjectStatusChangedEvent,
  fromPayload,
} = require("./events");
const { dispatchToProjections } = require("./projections");
const { round7 } = require("./aggregates");

const BATCH_SIZE = 500;
const EVENT_STORE_BATCH = 200;

/**
 * One-time data fix for the stream-id double-prefix bug: DomainEvent.getStreamId()
 * used to prefix an `aggregateId` that every writer had *already* prefixed
 * (e.g. `Donation:${txHash}`), so historical rows have stream_id stored as
 * "Donation:Donation:<txHash>" and aggregate_id stored as "Donation:<txHash>"
 * instead of the bare id. Both writers and readers now agree that
 * aggregateId is unprefixed (see events.js's buildStreamId), so existing
 * rows need to be rewritten to match or every stream read for data written
 * before this fix stays permanently broken.
 *
 * Guarded by event_store_migration_state the same way runLegacyMigration is,
 * so it runs at most once per database and is a cheap no-op on every
 * subsequent boot.
 */
async function normalizeDoublePrefixedStreamIds() {
  const alreadyDone = await pool.query(
    "SELECT id FROM event_store_migration_state WHERE id = 'stream-id-normalization'"
  );
  if (alreadyDone.rows[0]) {
    console.log("[Migration] Stream id normalization already applied. Skipping.");
    return { status: "already_migrated", rowsFixed: 0 };
  }

  console.log("[Migration] Normalizing double-prefixed stream ids...");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Only rows whose aggregate_id still starts with "<aggregate_type>:" are
    // touched — rows already written correctly (including load-harness rows,
    // which never had aggregateId pre-prefixed) don't match and are left
    // alone, which is also what makes this UPDATE idempotent on its own even
    // without the migration-state guard above. Both SET expressions read the
    // stripped id from the pre-update `aggregate_id` value: a single UPDATE's
    // SET clauses all see the row's original values, not each other's result.
    const result = await client.query(
      `UPDATE event_stream
       SET aggregate_id = substring(aggregate_id from length(aggregate_type) + 2),
           stream_id    = aggregate_type || ':' || substring(aggregate_id from length(aggregate_type) + 2)
       WHERE aggregate_id LIKE aggregate_type || ':%'`
    );
    const rowsFixed = result.rowCount || 0;

    await client.query(
      "INSERT INTO event_store_migration_state (id, migrated_at, event_count) VALUES ('stream-id-normalization', NOW(), $1) ON CONFLICT (id) DO UPDATE SET migrated_at = NOW(), event_count = EXCLUDED.event_count",
      [rowsFixed]
    );

    await client.query("COMMIT");
    console.log(`[Migration] Normalized ${rowsFixed} double-prefixed stream id(s)`);
    return { status: "completed", rowsFixed };
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Migration] Stream id normalization failed:", err.message);
    throw err;
  } finally {
    client.release();
  }
}

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
          aggregateId: project.id,
          version: 1,
          actor: "migration",
          name: project.name,
          description: project.description,
          category: project.category,
          location: project.location,
          walletAddress: project.wallet_address,
          goalXlm: parseFloat(project.goal_xlm?.toString() || "0"),
          tags: project.tags || [],
        })
      );

      if (project.status !== "active") {
        events.push(
          new ProjectStatusChangedEvent({
            aggregateId: project.id,
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

      const amount = donation.amount_xlm
        ? parseFloat(donation.amount_xlm.toString())
        : parseFloat(donation.amount?.toString() || "0");

      events.push(
        new MigratedDonationEvent({
          originalId: donation.id,
          donationId: donation.transaction_hash,
          version: 1,
          actor: "migration",
          originalCreatedAt: donation.created_at?.toISOString ? donation.created_at.toISOString() : donation.created_at,
          projectId: donation.project_id,
          donorAddress: donation.donor_address,
          amountXlm: amount,
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
          aggregateId: match.id,
          version: 1,
          actor: "migration",
          matchId: match.id,
          projectId: match.project_id,
          matcherAddress: match.matcher_address,
          capXlm: parseFloat(match.cap_xlm?.toString() || "0"),
          multiplier: match.multiplier || 1,
          expiresAt: match.expires_at?.toISOString ? match.expires_at.toISOString() : match.expires_at,
        })
      );
      matchCreatedCount++;

      const matchedXlm = parseFloat(match.matched_xlm?.toString() || "0");
      if (matchedXlm > 0) {
        events.push(
          new (require("./events").MatchAppliedEvent)({
            aggregateId: match.id,
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
          aggregateId: milestone.id,
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
          aggregateId: job.id,
          version: 1,
          actor: "migration",
          clientPublicKey: job.client_public_key,
          freelancerPublicKey: job.freelancer_public_key,
          amountXlm: parseFloat(job.amount_escrow_xlm?.toString() || "0"),
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

    const isValid = verification.uniqueTxHashesMatch && verification.xlmTotalMatch && verification.uniqueDonorsMatch;
    if (!isValid) {
      throw new Error(`Migration verification failed: ${JSON.stringify(verification)}`);
    }

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
    const totalEvents = parseInt(result.rows[0]?.total || "0", 10);
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
     WHERE event_type IN ('DonationRecorded', $1) AND payload->'data'->>'isMatch' = 'false'`,
    [LEGACY_DONATION_MIGRATED]
  );
  const actualUniqueTxCount = parseInt(uniqueTxResult.rows[0]?.count || "0", 10);

  const donationResult = await pool.query(
    `SELECT SUM((payload->'data'->>'amountXlm')::numeric) AS total
     FROM event_stream
     WHERE event_type IN ('DonationRecorded', $1) AND payload->'data'->>'isMatch' = 'false'`,
    [LEGACY_DONATION_MIGRATED]
  );
  const eventTotalXlm = parseFloat(donationResult.rows[0]?.total?.toString() || "0");

  const legacyTotalResult = await pool.query("SELECT SUM(amount_xlm::numeric) AS total FROM donations WHERE currency = 'XLM'");
  const legacyTotalXlm = parseFloat(legacyTotalResult.rows[0]?.total?.toString() || "0");

  const donorEventsResult = await pool.query(
    "SELECT COUNT(DISTINCT (payload->'data'->>'donorAddress')) AS count FROM event_stream WHERE aggregate_type IN ('Donation', $1)",
    [LEGACY_DONATION_MIGRATED]
  );
  const eventUniqueDonors = parseInt(donorEventsResult.rows[0]?.count || "0", 10);

  const legacyUniqueDonorsResult = await pool.query(
    "SELECT COUNT(DISTINCT donor_address) AS count FROM donations"
  );
  const legacyUniqueDonors = parseInt(legacyUniqueDonorsResult.rows[0]?.count || "0", 10);

  const matchInEventsResult = await pool.query(
    "SELECT COUNT(*) AS count FROM event_stream WHERE event_type = $1 AND payload->'data'->>'isMatch' = 'true'",
    [LEGACY_DONATION_MIGRATED]
  );
  const eventMatchCount = parseInt(matchInEventsResult.rows[0]?.count || "0", 10);

  const legacyMatchResult = await pool.query(
    "SELECT SUM(matched_xlm::numeric) AS total FROM donation_matches"
  );
  const legacyMatchTotal = parseFloat(legacyMatchResult.rows[0]?.total?.toString() || "0");

  return {
    uniqueTxHashesMatch: actualUniqueTxCount === expectedUniqueTxCount,
    expectedUniqueTxCount,
    actualUniqueTxCount,
    xlmTotalMatch: Math.abs(eventTotalXlm - legacyTotalXlm) < 0.0000001,
    eventTotalXlm,
    legacyTotalXlm,
    uniqueDonorsMatch: eventUniqueDonors === legacyUniqueDonors,
    eventUniqueDonors,
    legacyUniqueDonors,
    eventMatchCount,
    legacyMatchTotal,
  };
}

async function replayUnprojectedMigratedEvents() {
  const alreadyDone = await pool.query(
    "SELECT id FROM event_store_migration_state WHERE id = 'migrated-donation-replay'"
  );
  if (alreadyDone.rows[0]) {
    console.log("[Migration] Migrated donation replay already applied. Skipping.");
    return { status: "already_migrated", eventsReplayed: 0 };
  }

  console.log("[Migration] Replaying unprojected migrated donation events...");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE event_stream
       SET event_type = $1,
           payload = jsonb_set(payload, '{eventType}', to_jsonb($1::text))
       WHERE event_type = 'LegacyDonationMigrated' OR payload->>'eventType' = 'LegacyDonationMigrated'`,
      [LEGACY_DONATION_MIGRATED]
    );

    const resetResult = await client.query(
      `UPDATE event_stream
       SET processed = false
       WHERE (aggregate_type = 'MigratedDonation' OR event_type = $1)
         AND processed = true`,
      [LEGACY_DONATION_MIGRATED]
    );
    const eventsReplayed = resetResult.rowCount || 0;

    await client.query(
      "INSERT INTO event_store_migration_state (id, migrated_at, event_count) VALUES ('migrated-donation-replay', NOW(), $1) ON CONFLICT (id) DO UPDATE SET migrated_at = NOW(), event_count = EXCLUDED.event_count",
      [eventsReplayed]
    );

    await client.query("COMMIT");

    if (eventsReplayed > 0) {
      console.log(`[Migration] Replaying projections for ${eventsReplayed} migrated donation event(s)...`);
      await rebuildReadModels();
    }

    return { status: "completed", eventsReplayed };
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Migration] Replay of migrated events failed:", err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  runLegacyMigration,
  rebuildReadModels,
  verifyMigration,
  normalizeDoublePrefixedStreamIds,
  replayUnprojectedMigratedEvents,
};
