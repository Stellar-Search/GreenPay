"use strict";

const { LEGACY_DONATION_MIGRATED, DonationRecordedEvent, MatchAppliedEvent, MatchCreatedEvent, ProjectStatusChangedEvent, MilestoneReachedEvent, JobReleasedEvent, ProjectCreatedEvent, ProfileCreatedEvent } = require("./events");
const { RecordDonationCommand, ApplyMatchCommand, ChangeProjectStatusCommand, ReachMilestoneCommand, ReleaseEscrowCommand, CreateMatchOfferCommand } = require("./commands");
const { computeBadges } = require("../services/store");

const VALID_PROJECT_STATUSES = new Set(["active", "completed", "paused", "rejected"]);

class ProjectAggregate {
  constructor(state = null) {
    this.state = state || {
      raisedXlm: 0,
      donorCount: 0,
      status: "active",
      goalXlm: 0,
    };
    this.uncommitted = [];
  }

  static fromState(row) {
    if (!row) return new ProjectAggregate(null);
    return new ProjectAggregate({
      raisedXlm: parseFloat(row.raised_xlm?.toString() || "0"),
      donorCount: row.donor_count || 0,
      status: row.status || "active",
      goalXlm: parseFloat(row.goal_xlm?.toString() || "0"),
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
      this.state.raisedXlm = 0;
      this.state.donorCount = 0;
      this.state.status = "active";
      this.state.goalXlm = event.data.goalXlm;
      break;
    case "DonationRecorded":
    case LEGACY_DONATION_MIGRATED:
      if (event.data.currency === "XLM") {
        this.state.raisedXlm = round7(this.state.raisedXlm + Number.parseFloat(event.data.amountXlm));
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
        this.uncommitted.push(
          new DonationRecordedEvent({
            aggregateId: command.getTransactionHash(),
            version: this.uncommitted.length + 1,
            actor: command.actor,
            projectId: command.payload.projectId,
            donorAddress: command.payload.donorAddress,
            amountXlm: command.getAmount(),
            currency: command.payload.currency,
            message: command.payload.message,
            transactionHash: command.getTransactionHash(),
          })
        );
      } else {
        this.uncommitted.push(
          new MatchAppliedEvent({
            aggregateId: command.payload.matchId,
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
          aggregateId: command.payload.projectId,
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
    return { ...this.state };
  }
}

class DonorAggregate {
  constructor(state = null) {
    this.state = state || {
      totalDonatedXlm: 0,
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
      totalDonatedXlm: parseFloat(row.total_donated_xlm?.toString() || "0"),
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
    case LEGACY_DONATION_MIGRATED:
      if (event.data.currency === "XLM") {
        this.state.totalDonatedXlm = round7(this.state.totalDonatedXlm + Number.parseFloat(event.data.amountXlm));
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
          aggregateId: command.getTransactionHash(),
          version: this.uncommitted.length + 1,
          actor: command.actor,
          projectId: command.payload.projectId,
          donorAddress: command.payload.donorAddress,
          amountXlm: command.getAmount(),
          currency: command.payload.currency,
          message: command.payload.message,
          transactionHash: command.getTransactionHash(),
        })
      );
      break;
    case "ApplyMatch":
      this.uncommitted.push(
        new MatchAppliedEvent({
          aggregateId: command.payload.matchId,
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
          aggregateId: this.state.displayName || command.payload.displayName,
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
      totalDonatedXlm: this.state.totalDonatedXlm,
      projectsSupported: this.state.projectsSupported,
      badges: computeBadges(this.state.totalDonatedXlm),
      displayName: this.state.displayName,
      bio: this.state.bio,
    };
  }
}

class MatchAggregate {
  constructor(state = null) {
    this.state = state || {
      matchedXlm: 0,
      capXlm: 0,
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
      matchedXlm: parseFloat(row.matched_xlm?.toString() || "0"),
      capXlm: parseFloat(row.cap_xlm?.toString() || "0"),
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
      this.state.matchedXlm = 0;
      this.state.capXlm = event.data.capXlm;
      this.state.multiplier = event.data.multiplier;
      this.state.matcherAddress = event.data.matcherAddress;
      this.state.projectId = event.data.projectId;
      this.state.expiresAt = event.data.expiresAt;
      break;
    case "MatchApplied":
      this.state.matchedXlm = round7(this.state.matchedXlm + event.data.matchAmount);
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
          aggregateId: command.payload.projectId,
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
          aggregateId: command.payload.matchId,
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

  validateApplyMatch(amount) {
    const remaining = this.state.capXlm - this.state.matchedXlm;
    if (remaining <= 0) {
      throw new Error("Match cap has been fully consumed");
    }
    if (amount > remaining) {
      throw new Error(`Match amount ${amount} exceeds remaining cap ${remaining}`);
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
          aggregateId: command.payload.jobId,
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

function round7(n) {
  return Math.round(n * 1e7) / 1e7;
}

module.exports = {
  ProjectAggregate,
  DonorAggregate,
  MatchAggregate,
  JobAggregate,
  round7,
  VALID_PROJECT_STATUSES,
};
