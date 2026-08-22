"use strict";

const { DonationRecordedEvent, MatchAppliedEvent, MatchCreatedEvent, ProjectStatusChangedEvent, MilestoneReachedEvent, JobReleasedEvent, ProjectCreatedEvent, ProfileCreatedEvent } = require("./events");
const { RecordDonationCommand, ApplyMatchCommand, ChangeProjectStatusCommand, ReachMilestoneCommand, ReleaseEscrowCommand, CreateMatchOfferCommand } = require("./commands");
const { xlmToStroopsRounded, stroopsToXlm } = require("../utils/xlm");

const VALID_PROJECT_STATUSES = new Set(["active", "completed", "paused", "rejected"]);

// All monetary aggregate state is held as BigInt stroops (1 XLM = 10^7
// stroops). Sums and comparisons are integer-exact; the only conversions to
// decimal strings happen in getState()/fromState(), i.e. at the persistence
// boundary where NUMERIC(20, 7) columns already speak 7-decimal strings.

function eventAmountStroops(data) {
  if (data.amountStroops !== null && data.amountStroops !== undefined) {
    return BigInt(data.amountStroops);
  }
  return xlmToStroopsRounded(data.amountXlm || 0);
}

class ProjectAggregate {
  constructor(state = null) {
    this.state = state || {
      raisedXlmStroops: 0n,
      donorCount: 0,
      status: "active",
      goalXlmStroops: 0n,
    };
    this.uncommitted = [];
  }

  static fromState(row) {
    if (!row) return new ProjectAggregate(null);
    return new ProjectAggregate({
      raisedXlmStroops: row.raised_xlm === null || row.raised_xlm === undefined ? 0n : xlmToStroopsRounded(row.raised_xlm.toString()),
      donorCount: row.donor_count || 0,
      status: row.status || "active",
      goalXlmStroops: row.goal_xlm === null || row.goal_xlm === undefined ? 0n : xlmToStroopsRounded(row.goal_xlm.toString()),
    });
  }

  loadFromEvents(events) {
    for (const evt of events) {
      this.apply(evt, false);
    }
  }

  apply(event, track = true) {
    switch (event.eventType) {
    case "ProjectCreated":
      this.state.raisedXlmStroops = 0n;
      this.state.donorCount = 0;
      this.state.status = "active";
      this.state.goalXlmStroops = event.data.goalStroops !== undefined && event.data.goalStroops !== null
        ? BigInt(event.data.goalStroops)
        : xlmToStroopsRounded(event.data.goalXlm || 0);
      break;
    case "DonationRecorded":
    case "MigratedDonation":
      if (event.data.currency === "XLM") {
        this.state.raisedXlmStroops += eventAmountStroops(event.data);
      }
      break;
    case "ProjectStatusChanged":
      this.state.status = event.data.newStatus;
      break;
    default:
      break;
    }
    if (track) this.uncommitted.push(event);
  }

  handle(command) {
    switch (command.commandType) {
    case "RecordDonation":
    case "ApplyMatch": {
      if (command.commandType === "RecordDonation") {
        const isXlm = command.payload.currency === "XLM";
        this.uncommitted.push(
          new DonationRecordedEvent({
            aggregateId: createStreamId("Donation", command.getTransactionHash()),
            version: this.uncommitted.length + 1,
            actor: command.actor,
            projectId: command.payload.projectId,
            donorAddress: command.payload.donorAddress,
            amountXlm: command.getAmountXlm(),
            amountStroops: isXlm ? command.getAmountStroops().toString() : undefined,
            currency: command.payload.currency,
            message: command.payload.message,
            transactionHash: command.getTransactionHash(),
          })
        );
      } else {
        this.uncommitted.push(
          new MatchAppliedEvent({
            aggregateId: createStreamId("Match", command.payload.matchId),
            version: this.applyAndGetVersion(command),
            actor: command.actor,
            matchId: command.payload.matchId,
            projectId: command.payload.projectId,
            donorAddress: command.payload.donorAddress,
            matchAmount: command.payload.matchAmount,
            originalTxHash: command.payload.originalTxHash,
            multiplier: command.payload.multiplier,
          })
        );
      }
      break;
    }
    case "ChangeProjectStatus": {
      const newStatus = command.payload.status;
      if (!VALID_PROJECT_STATUSES.has(newStatus)) {
        throw new Error(`Invalid project status: ${newStatus}`);
      }
      this.uncommitted.push(
        new ProjectStatusChangedEvent({
          aggregateId: createStreamId("Project", command.payload.projectId),
          version: this.applyAndGetVersion(command),
          actor: command.actor,
          previousStatus: this.state.status,
          newStatus,
          reason: command.payload.reason || null,
        })
      );
      break;
    }
    default:
      throw new Error(`ProjectAggregate cannot handle: ${command.commandType}`);
    }
  }

  applyAndGetVersion(command) {
    const baseEvent = { aggregateId: "", version: (this.uncommitted.length + 1), actor: command.actor };
    return this.uncommitted.length + 1;
  }

  getUncommitted() {
    return [...this.uncommitted];
  }

  getState() {
    return {
      raisedXlm: stroopsToXlm(this.state.raisedXlmStroops),
      raisedXlmStroops: this.state.raisedXlmStroops,
      goalXlm: stroopsToXlm(this.state.goalXlmStroops),
      goalXlmStroops: this.state.goalXlmStroops,
      donorCount: this.state.donorCount,
      status: this.state.status,
    };
  }
}

class DonorAggregate {
  constructor(state = null) {
    this.state = state || {
      totalDonatedXlmStroops: 0n,
      projectsSupported: new Set(),
      badges: [],
      displayName: null,
      bio: null,
    };
    this.uncommitted = [];
  }

  static fromState(row) {
    if (!row) return new DonorAggregate(null);
    const badges = Array.isArray(row.badges) ? row.badges : [];
    return new DonorAggregate({
      totalDonatedXlmStroops: row.total_donated_xlm === null || row.total_donated_xlm === undefined ? 0n : xlmToStroopsRounded(row.total_donated_xlm.toString()),
      projectsSupported: new Set(row.projects_supported ? [] : []),
      badges,
      displayName: row.display_name || null,
      bio: row.bio || null,
    });
  }

  loadFromEvents(events) {
    for (const evt of events) {
      this.apply(evt, false);
    }
  }

  apply(event, track = true) {
    switch (event.eventType) {
    case "DonationRecorded":
    case "MigratedDonation":
      if (event.data.currency === "XLM") {
        this.state.totalDonatedXlmStroops += eventAmountStroops(event.data);
      }
      this.state.projectsSupported.add(event.data.projectId);
      break;
    default:
      break;
    }
    if (track) this.uncommitted.push(event);
  }

  handle(command) {
    switch (command.commandType) {
    case "RecordDonation":
      this.uncommitted.push(
        new DonationRecordedEvent({
          aggregateId: createStreamId("Donor", command.payload.donorAddress),
          version: this.uncommitted.length + 1,
          actor: command.actor,
          projectId: command.payload.projectId,
          donorAddress: command.payload.donorAddress,
          amountXlm: command.getAmountXlm(),
          amountStroops: command.payload.currency === "XLM" ? command.getAmountStroops().toString() : undefined,
          currency: command.payload.currency,
          message: command.payload.message,
          transactionHash: command.getTransactionHash(),
        })
      );
      break;
    case "ApplyMatch":
      this.uncommitted.push(
        new MatchAppliedEvent({
          aggregateId: createStreamId("Donor", command.payload.donorAddress),
          version: this.uncommitted.length + 1,
          actor: command.actor,
          matchId: command.payload.matchId,
          projectId: command.payload.projectId,
          donorAddress: command.payload.donorAddress,
          matchAmount: command.payload.matchAmount,
          originalTxHash: command.payload.originalTxHash,
          multiplier: command.payload.multiplier,
        })
      );
      break;
    case "ProfileCreated":
      this.uncommitted.push(
        new ProfileCreatedEvent({
          aggregateId: createStreamId("Profile", this.state.displayName || command.payload.displayName),
          version: this.uncommitted.length + 1,
          actor: command.actor,
          displayName: command.payload.displayName,
          bio: command.payload.bio,
        })
      );
      break;
    default:
      throw new Error(`DonorAggregate cannot handle: ${command.commandType}`);
    }
  }

  getUncommitted() {
    return [...this.uncommitted];
  }

  getState() {
    return {
      totalDonatedXlm: stroopsToXlm(this.state.totalDonatedXlmStroops),
      totalDonatedXlmStroops: this.state.totalDonatedXlmStroops,
      projectsSupported: this.state.projectsSupported,
      badges: computeBadges(this.state.totalDonatedXlmStroops),
      displayName: this.state.displayName,
      bio: this.state.bio,
    };
  }
}

class MatchAggregate {
  constructor(state = null) {
    this.state = state || {
      matchedXlmStroops: 0n,
      capXlmStroops: 0n,
      multiplier: 1,
      matcherAddress: null,
      projectId: null,
      expiresAt: null,
    };
    this.uncommitted = [];
  }

  static fromState(row) {
    if (!row) return new MatchAggregate(null);
    return new MatchAggregate({
      matchedXlmStroops: row.matched_xlm === null || row.matched_xlm === undefined ? 0n : xlmToStroopsRounded(row.matched_xlm.toString()),
      capXlmStroops: row.cap_xlm === null || row.cap_xlm === undefined ? 0n : xlmToStroopsRounded(row.cap_xlm.toString()),
      multiplier: row.multiplier || 1,
      matcherAddress: null,
      projectId: null,
      expiresAt: null,
    });
  }

  loadFromEvents(events) {
    for (const evt of events) {
      this.apply(evt, false);
    }
  }

  apply(event, track = true) {
    switch (event.eventType) {
    case "MatchCreated":
      this.state.matchedXlmStroops = 0n;
      this.state.capXlmStroops = event.data.capStroops !== undefined && event.data.capStroops !== null
        ? BigInt(event.data.capStroops)
        : xlmToStroopsRounded(event.data.capXlm || 0);
      this.state.multiplier = event.data.multiplier;
      this.state.matcherAddress = event.data.matcherAddress;
      this.state.projectId = event.data.projectId;
      this.state.expiresAt = event.data.expiresAt;
      break;
    case "MatchApplied":
      this.state.matchedXlmStroops += event.data.matchAmountStroops !== undefined && event.data.matchAmountStroops !== null
        ? BigInt(event.data.matchAmountStroops)
        : xlmToStroopsRounded(event.data.matchAmount || 0);
      break;
    default:
      break;
    }
    if (track) this.uncommitted.push(event);
  }

  handle(command) {
    switch (command.commandType) {
    case "CreateMatchOffer":
      this.uncommitted.push(
        new MatchCreatedEvent({
          aggregateId: createStreamId("Match", command.payload.projectId),
          version: this.uncommitted.length + 1,
          actor: command.actor,
          matchId: command.payload.matchId,
          projectId: command.payload.projectId,
          matcherAddress: command.payload.matcherAddress,
          capXlm: command.payload.capXlm,
          multiplier: command.payload.multiplier,
          expiresAt: command.payload.expiresAt,
        })
      );
      break;
    case "ApplyMatch":
      this.uncommitted.push(
        new MatchAppliedEvent({
          aggregateId: createStreamId("Match", command.payload.matchId),
          version: this.uncommitted.length + 1,
          actor: command.actor,
          matchId: command.payload.matchId,
          projectId: command.payload.projectId,
          donorAddress: command.payload.donorAddress,
          matchAmount: command.payload.matchAmount,
          originalTxHash: command.payload.originalTxHash,
          multiplier: command.payload.multiplier,
        })
      );
      break;
    default:
      throw new Error(`MatchAggregate cannot handle: ${command.commandType}`);
    }
  }

  validateApplyMatch(amountStroops) {
    const remaining = this.state.capXlmStroops - this.state.matchedXlmStroops;
    if (remaining <= 0n) {
      throw new Error("Match cap has been fully consumed");
    }
    if (amountStroops > remaining) {
      throw new Error(`Match amount ${stroopsToXlm(amountStroops)} exceeds remaining cap ${stroopsToXlm(remaining)}`);
    }
  }

  getUncommitted() {
    return [...this.uncommitted];
  }

  getState() {
    return { ...this.state };
  }
}

class JobAggregate {
  constructor(state = null) {
    this.state = state || {
      status: "in_escrow",
      releaseTransactionHash: null,
    };
    this.uncommitted = [];
  }

  static fromState(row) {
    if (!row) return new JobAggregate(null);
    return new JobAggregate({
      status: row.status || "in_escrow",
      releaseTransactionHash: row.release_transaction_hash || null,
    });
  }

  loadFromEvents(events) {
    for (const evt of events) {
      this.apply(evt, false);
    }
  }

  apply(event, track = true) {
    switch (event.eventType) {
    case "JobReleased":
      this.state.status = "completed";
      this.state.releaseTransactionHash = event.data.releaseTransactionHash;
      break;
    default:
      break;
    }
    if (track) this.uncommitted.push(event);
  }

  handle(command) {
    switch (command.commandType) {
    case "ReleaseEscrow":
      if (this.state.status !== "in_escrow") {
        throw new Error(`Job is not awaiting release, current status: ${this.state.status}`);
      }
      this.uncommitted.push(
        new JobReleasedEvent({
          aggregateId: createStreamId("Job", command.payload.jobId),
          version: this.uncommitted.length + 1,
          actor: command.actor,
          clientPublicKey: command.payload.clientPublicKey,
          freelancerPublicKey: command.payload.freelancerPublicKey,
          amountXlm: command.payload.amountXlm,
          releaseTransactionHash: command.payload.releaseTransactionHash,
        })
      );
      break;
    default:
      throw new Error(`JobAggregate cannot handle: ${command.commandType}`);
    }
  }

  getUncommitted() {
    return [...this.uncommitted];
  }

  getState() {
    return { ...this.state };
  }
}

function createStreamId(aggregateType, id) {
  return `${aggregateType}:${id}`;
}

// Badge thresholds in whole XLM, compared exactly against the donor's stroop
// total (min × 10^7).
function computeBadges(totalStroops) {
  const BADGE_THRESHOLDS = [
    { tier: "earth", min: 2000 },
    { tier: "forest", min: 500 },
    { tier: "tree", min: 100 },
    { tier: "seedling", min: 10 },
  ];
  const earned = [];
  for (const badge of BADGE_THRESHOLDS) {
    if (totalStroops >= BigInt(badge.min) * 10_000_000n) {
      earned.push({ tier: badge.tier, earnedAt: new Date().toISOString() });
      break;
    }
  }
  return earned;
}

module.exports = {
  ProjectAggregate,
  DonorAggregate,
  MatchAggregate,
  JobAggregate,
  createStreamId,
  VALID_PROJECT_STATUSES,
};
