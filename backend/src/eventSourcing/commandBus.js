"use strict";

const { v4: uuid } = require("uuid");
const pool = require("../db/pool");
const { ProjectAggregate, DonorAggregate, MatchAggregate, JobAggregate } = require("./aggregates");
const { eventStore } = require("./eventStore");

const COMMAND_HANDLERS = new Map();

class CommandHandler {
  static register(commandType, handler) {
    COMMAND_HANDLERS.set(commandType, handler);
  }
}

async function getProjectState(projectId, db = pool) {
  const result = await db.query("SELECT * FROM projects WHERE id = $1", [projectId]);
  return ProjectAggregate.fromState(result.rows[0]);
}

async function getDonorState(donorAddress, db = pool) {
  const result = await db.query("SELECT * FROM donor_stats WHERE public_key = $1", [donorAddress]);
  return DonorAggregate.fromState(result.rows[0]);
}

async function getMatchState(matchId, db = pool) {
  const result = await db.query("SELECT * FROM match_state WHERE match_id = $1", [matchId]);
  return MatchAggregate.fromState(result.rows[0]);
}

async function getJobState(jobId, db = pool) {
  const result = await db.query("SELECT * FROM jobs WHERE id = $1", [jobId]);
  if (!result.rows[0]) return null;
  return JobAggregate.fromState(result.rows[0]);
}

async function loadAggregateStream(aggregateType, aggregateId, db = pool) {
  const streamId = `${aggregateType}:${aggregateId}`;
  const result = await db.query(
    `SELECT event_id, stream_id, aggregate_type, aggregate_id, event_type,
            version, aggregate_version, payload, actor, occurred_at, created_at
     FROM event_stream
     WHERE stream_id = $1
     ORDER BY version ASC`,
    [streamId]
  );
  return result.rows.map((row) => {
    const { fromPayload } = require("./events");
    return fromPayload(row.payload);
  });
}

class DonationCommandHandler {
  async handle(command, db = pool) {
    const errors = command.validate();
    if (errors.length > 0) throw new Error(errors.join("; "));

    const existingCheck = await db.query(
      `SELECT event_id FROM event_stream
       WHERE aggregate_type = 'Donation' AND event_type = 'DonationRecorded'
         AND payload->'data'->>'transactionHash' = $1`,
      [command.getTransactionHash()]
    );
    if (existingCheck.rows.length > 0) {
      const existing = existingCheck.rows[0];
      const row = await db.query("SELECT * FROM event_stream WHERE event_id = $1", [existing.event_id]);
      return { success: true, data: fromRow(row.rows[0]), deduplicated: true };
    }

    const projectResult = await db.query("SELECT id FROM projects WHERE id = $1", [command.payload.projectId]);
    if (!projectResult.rows[0]) throw new Error("Project not found");

    const amountXlm = command.getAmountXlm();
    const amountStroops = command.payload.currency === "XLM" ? command.getAmountStroops().toString() : null;
    const project = await getProjectState(command.payload.projectId, db);
    const donor = await getDonorState(command.payload.donorAddress, db);

    const donationEvent = new (require("./events").DonationRecordedEvent)({
      aggregateId: `Donation:${command.getTransactionHash()}`,
      version: await getNextVersion("Donation", `Donation:${command.getTransactionHash()}`, db),
      actor: command.actor,
      projectId: command.payload.projectId,
      donorAddress: command.payload.donorAddress,
      amountXlm,
      amountStroops,
      currency: command.payload.currency,
      message: command.payload.message,
      transactionHash: command.getTransactionHash(),
    });

    project.apply(donationEvent);
    donor.apply(donationEvent);

    // DonationRecorded is projected by applyProjectProjection, which adds the
    // donation to raised_xlm atomically — so the total is deliberately not
    // written here (see storeProjectAggregate) to avoid counting it twice.
    await storeProjectAggregate(db, command.payload.projectId, project, { includeRaisedTotal: false });
    await storeDonorAggregate(db, command.payload.donorAddress);

    const donationRow = donationEvent.toRow();
    await db.query(
      "INSERT INTO event_stream (event_id, stream_id, aggregate_type, aggregate_id, event_type, version, aggregate_version, payload, actor, occurred_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)",
      [
        donationRow.event_id,
        donationRow.stream_id,
        donationRow.aggregate_type,
        donationRow.aggregate_id,
        donationRow.event_type,
        donationRow.version,
        donationRow.aggregate_version,
        JSON.stringify(donationRow.payload),
        donationRow.actor,
        donationRow.occurred_at,
        donationRow.created_at,
      ]
    );

    return { events: [donationEvent], data: { donationId: donationEvent.eventId, amountXlm }, deduplicated: false };
  }
}

class ApplyMatchCommandHandler {
  async handle(command, db = pool) {
    const errors = command.validate();
    if (errors.length > 0) throw new Error(errors.join("; "));

    const matchId = command.payload.matchId;

    if (command.payload.originalTxHash) {
      const existingMatchTx = await db.query(
        `SELECT event_id FROM event_stream
         WHERE aggregate_type = 'Match' AND event_type = 'MatchApplied'
           AND payload->'data'->>'originalTxHash' = $1
           AND payload->'data'->>'matchId' = $2`,
        [command.payload.originalTxHash, matchId]
      );
      if (existingMatchTx.rows.length > 0) return { success: true, data: null, deduplicated: true };
    }

    const matchState = await getMatchState(matchId, db);
    if (matchState) {
      matchState.validateApplyMatch(command.getMatchAmountStroops());
    }

    const donorAddress = command.payload.donorAddress;
    const donor = await getDonorState(donorAddress, db);

    const matchEvent = new (require("./events").MatchAppliedEvent)({
      aggregateId: `Match:${matchId}`,
      version: await getNextVersion("Match", `Match:${matchId}`, db),
      actor: command.actor,
      matchId,
      projectId: command.payload.projectId,
      donorAddress,
      matchAmount: command.payload.matchAmount,
      originalTxHash: command.payload.originalTxHash,
      multiplier: command.payload.multiplier,
    });

    donor.apply(matchEvent);
    await storeDonorAggregate(db, donorAddress);

    const matchRow = matchEvent.toRow();
    await db.query(
      "INSERT INTO event_stream (event_id, stream_id, aggregate_type, aggregate_id, event_type, version, aggregate_version, payload, actor, occurred_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)",
      [matchRow.event_id, matchRow.stream_id, matchRow.aggregate_type, matchRow.aggregate_id, matchRow.event_type, matchRow.version, matchRow.aggregate_version, JSON.stringify(matchRow.payload), matchRow.actor, matchRow.occurred_at, matchRow.created_at]
    );

    return { events: [matchEvent], data: { matchId, matchAmount: command.payload.matchAmount }, deduplicated: false };
  }
}

class ChangeProjectStatusCommandHandler {
  async handle(command, db = pool) {
    const errors = command.validate();
    if (errors.length > 0) throw new Error(errors.join("; "));

    const projectResult = await db.query("SELECT * FROM projects WHERE id = $1", [command.payload.projectId]);
    if (!projectResult.rows[0]) throw new Error("Project not found");

    const project = ProjectAggregate.fromState(projectResult.rows[0]);

    if (project.state.status === command.payload.status) {
      return { success: true, events: [], noop: true };
    }

    const projectId = command.payload.projectId;
    const statusChangeEvent = new (require("./events").ProjectStatusChangedEvent)({
      aggregateId: `Project:${projectId}`,
      version: await getNextVersion("Project", `Project:${projectId}`, db),
      actor: command.actor,
      previousStatus: project.state.status,
      newStatus: command.payload.status,
      reason: command.payload.reason,
    });

    project.apply(statusChangeEvent);
    await storeProjectAggregate(db, projectId, project);

    const row = statusChangeEvent.toRow();
    await db.query(
      "INSERT INTO event_stream (event_id, stream_id, aggregate_type, aggregate_id, event_type, version, aggregate_version, payload, actor, occurred_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)",
      [row.event_id, row.stream_id, row.aggregate_type, row.aggregate_id, row.event_type, row.version, row.aggregate_version, JSON.stringify(row.payload), row.actor, row.occurred_at, row.created_at]
    );

    return { events: [statusChangeEvent], data: { previousStatus: project.state.status, newStatus: command.payload.status } };
  }
}

class ReachMilestoneCommandHandler {
  async handle(command, db = pool) {
    const errors = command.validate();
    if (errors.length > 0) throw new Error(errors.join("; "));

    const milestoneId = command.payload.milestoneId;
    const milestoneEvent = new (require("./events").MilestoneReachedEvent)({
      aggregateId: `Milestone:${milestoneId}`,
      version: await getNextVersion("Milestone", `Milestone:${milestoneId}`, db),
      actor: command.actor,
      milestoneId,
      projectId: command.payload.projectId,
      percentage: parseInt(command.payload.percentage, 10) || 0,
      title: command.payload.title,
      transactionHash: command.payload.transactionHash,
    });

    const row = milestoneEvent.toRow();
    await db.query(
      "INSERT INTO event_stream (event_id, stream_id, aggregate_type, aggregate_id, event_type, version, aggregate_version, payload, actor, occurred_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)",
      [row.event_id, row.stream_id, row.aggregate_type, row.aggregate_id, row.event_type, row.version, row.aggregate_version, JSON.stringify(row.payload), row.actor, row.occurred_at, row.created_at]
    );

    return { events: [milestoneEvent], data: { milestoneId } };
  }
}

class ReleaseEscrowCommandHandler {
  async handle(command, db = pool) {
    const errors = command.validate();
    if (errors.length > 0) throw new Error(errors.join("; "));

    const jobId = command.payload.jobId;
    const jobState = await getJobState(jobId, db);
    if (!jobState) throw new Error("Job not found");
    const jobRow = await db.query("SELECT * FROM jobs WHERE id = $1", [jobId]);

    const jobReleasedEvent = new (require("./events").JobReleasedEvent)({
      aggregateId: `Job:${jobId}`,
      version: await getNextVersion("Job", `Job:${jobId}`, db),
      actor: command.actor,
      clientPublicKey: jobRow.rows[0].client_public_key,
      freelancerPublicKey: jobRow.rows[0].freelancer_public_key,
      amountXlm: jobRow.rows[0].amount_escrow_xlm?.toString() || "0",
      releaseTransactionHash: command.payload.releaseTransactionHash,
    });

    const row = jobReleasedEvent.toRow();
    await db.query(
      "INSERT INTO event_stream (event_id, stream_id, aggregate_type, aggregate_id, event_type, version, aggregate_version, payload, actor, occurred_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)",
      [row.event_id, row.stream_id, row.aggregate_type, row.aggregate_id, row.event_type, row.version, row.aggregate_version, JSON.stringify(row.payload), row.actor, row.occurred_at, row.created_at]
    );

    return { events: [jobReleasedEvent], data: { jobId, releaseTransactionHash: command.payload.releaseTransactionHash } };
  }
}

class CreateMatchOfferCommandHandler {
  async handle(command, db = pool) {
    const errors = command.validate();
    if (errors.length > 0) throw new Error(errors.join("; "));

    const matchId = uuid();
    const matchCreatedEvent = new (require("./events").MatchCreatedEvent)({
      aggregateId: `Match:${command.payload.projectId}`,
      version: await getNextVersion("Match", `Match:${command.payload.projectId}`, db),
      actor: command.actor,
      matchId,
      projectId: command.payload.projectId,
      matcherAddress: command.payload.matcherAddress,
      capXlm: command.payload.capXlm,
      multiplier: command.payload.multiplier,
      expiresAt: command.payload.expiresAt,
    });

    const row = matchCreatedEvent.toRow();
    await db.query(
      "INSERT INTO event_stream (event_id, stream_id, aggregate_type, aggregate_id, event_type, version, aggregate_version, payload, actor, occurred_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)",
      [row.event_id, row.stream_id, row.aggregate_type, row.aggregate_id, row.event_type, row.version, row.aggregate_version, JSON.stringify(row.payload), row.actor, row.occurred_at, row.created_at]
    );

    return { events: [matchCreatedEvent], data: { matchId } };
  }
}

/**
 * Persists a project aggregate's state to the `projects` read model.
 *
 * `includeRaisedTotal` exists because `raised_xlm` has two potential writers.
 * For donation events the projection (applyProjectProjection) already applies
 * an atomic `raised_xlm = raised_xlm + amount`, so writing the aggregate's
 * absolute total here as well counts the same donation twice — the project's
 * raised figure ends up double the real amount. Callers whose event is also
 * handled by that projection must pass `includeRaisedTotal: false` and let the
 * projection own the total; the atomic increment is also the safer of the two
 * writes, since an absolute SET computed from a previously-read value loses
 * concurrent updates.
 */
async function storeProjectAggregate(pool, projectId, aggregate, { includeRaisedTotal = true } = {}) {
  const state = aggregate.getState();

  if (!includeRaisedTotal) {
    await pool.query(
      `UPDATE projects
       SET donor_count = $1,
           status = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [state.donorCount, state.status, projectId]
    );
    return;
  }

  await pool.query(
    `UPDATE projects
     SET raised_xlm = $1::numeric,
         donor_count = $2,
         status = $3,
         updated_at = NOW()
     WHERE id = $4`,
    // raisedXlm is the aggregate's canonical 7-decimal string, summed exactly
    // in stroops — no double ever touches the total.
    [state.raisedXlm, state.donorCount, state.status, projectId]
  );
}

/**
 * Ensures the donor has a `profiles` row.
 *
 * It deliberately does *not* write `donor_stats`. Both events that reach this
 * function (DonationRecorded, MatchApplied) are handled by donorProjection,
 * whose upsertDonorStats already folds the amount into the donor's running
 * total. Writing the aggregate's absolute total here as well applied the same
 * donation twice — a donor who gave 25 then 10 ended up recorded as having
 * given 70. The projection owns donor_stats; this only guarantees the
 * profiles row that donor_stats.public_key references exists.
 */
async function storeDonorAggregate(pool, donorAddress) {
  await pool.query(
    `INSERT INTO profiles (public_key, total_donated_xlm, projects_supported, badges, created_at)
     VALUES ($1, 0, 0, '[]'::jsonb, NOW())
     ON CONFLICT (public_key) DO NOTHING`,
    [donorAddress]
  );
}

async function getNextVersion(aggregateType, aggregateId, db = pool) {
  const result = await db.query(
    "SELECT MAX(version) AS max_version FROM event_stream WHERE aggregate_type = $1 AND aggregate_id = $2",
    [aggregateType, aggregateId]
  );
  return (result.rows[0]?.max_version || 0) + 1;
}

function fromRow(row) {
  return {
    eventId: row.event_id,
    streamId: row.stream_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    version: row.version,
    aggregateVersion: row.aggregate_version,
    payload: row.payload,
    actor: row.actor,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

const handlers = {
  RecordDonation: new DonationCommandHandler(),
  ApplyMatch: new ApplyMatchCommandHandler(),
  ChangeProjectStatus: new ChangeProjectStatusCommandHandler(),
  ReachMilestone: new ReachMilestoneCommandHandler(),
  ReleaseEscrow: new ReleaseEscrowCommandHandler(),
  CreateMatchOffer: new CreateMatchOfferCommandHandler(),
};

async function execute(command, db = pool) {
  const handler = handlers[command.commandType];
  if (!handler) throw new Error(`No handler registered for command: ${command.commandType}`);
  return handler.handle(command, db);
}

module.exports = {
  CommandHandler,
  execute,
  COMMAND_HANDLERS,
  getProjectState,
  getDonorState,
  getMatchState,
  getJobState,
  loadAggregateStream,
  storeProjectAggregate,
  storeDonorAggregate,
  fromRow,
};
