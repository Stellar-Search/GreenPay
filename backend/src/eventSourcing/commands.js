"use strict";

const { v4: uuid } = require("uuid");
const { xlmToStroops, stroopsToXlm } = require("../utils/xlm");
const { isValidStellarAddress } = require("../../../shared/validators/stellarValidator");

class Command {
  static COMMAND_TYPE = null;

  constructor({ commandId, actor, payload }) {
    this.commandId = commandId || uuid();
    this.commandType = this.constructor.COMMAND_TYPE;
    this.actor = actor;
    this.payload = payload;
    this.createdAt = new Date().toISOString();
  }

  validate() {
    throw new Error("validate() must be implemented by subclass");
  }

  toRow() {
    return {
      command_id: this.commandId,
      command_type: this.commandType,
      actor: this.actor,
      payload: this.payload,
      created_at: this.createdAt,
    };
  }
}

class RecordDonationCommand extends Command {
  static COMMAND_TYPE = "RecordDonation";

  constructor({ commandId, actor, projectId, donorAddress, amountXlm, amountStroops, amount, currency = "XLM", message, transactionHash }) {
    super({ commandId, actor, payload: { projectId, donorAddress, amountXlm, amountStroops, amount, currency, message, transactionHash } });
  }

  validate() {
    const errors = [];
    if (!this.payload.projectId) errors.push("projectId is required");
    if (!this.payload.donorAddress || !isValidStellarAddress(this.payload.donorAddress)) {
      errors.push("donorAddress must be a valid Stellar public key");
    }
    if (!this.payload.transactionHash || !/^[a-fA-F0-9]{64}$/.test(this.payload.transactionHash)) {
      errors.push("transactionHash must be a 64-char hex string");
    }
    if (this.payload.currency === "XLM") {
      try {
        const stroops = this.getAmountStroops();
        if (stroops <= 0n) errors.push("amount must be a positive number");
        if (stroops > 10_000_000_000_000_000_000_000n) errors.push("amount exceeds allowed maximum");
      } catch {
        errors.push("amount must be a positive XLM amount with at most 7 decimal places");
      }
    } else {
      const parsed = Number.parseFloat(this.payload.amount);
      if (isNaN(parsed) || parsed <= 0) errors.push("amount must be a positive number");
      if (parsed > 1e15) errors.push("amount exceeds allowed maximum");
    }
    return errors;
  }

  getAmount() {
    return Number.parseFloat(this.getAmountXlm());
  }

  getAmountXlm() {
    if (this.payload.currency !== "XLM") return String(this.payload.amount);
    return stroopsToXlm(this.getAmountStroops());
  }

  getAmountStroops() {
    if (this.payload.currency !== "XLM") {
      throw new Error("stroop conversion is only valid for XLM");
    }
    if (this.payload.amountStroops !== undefined && this.payload.amountStroops !== null) {
      return BigInt(this.payload.amountStroops);
    }
    return xlmToStroops(this.payload.amountXlm ?? this.payload.amount);
  }

  getTransactionHash() {
    return this.payload.transactionHash;
  }
}

class ApplyMatchCommand extends Command {
  static COMMAND_TYPE = "ApplyMatch";

  constructor({ commandId, actor, matchId, projectId, donorAddress, matchAmount, originalTxHash, multiplier }) {
    super({ commandId, actor, payload: { matchId, projectId, donorAddress, matchAmount, originalTxHash, multiplier } });
  }

  validate() {
    const errors = [];
    if (!this.payload.matchId) errors.push("matchId is required");
    if (!this.payload.projectId) errors.push("projectId is required");
    if (!this.payload.donorAddress || !isValidStellarAddress(this.payload.donorAddress)) {
      errors.push("donorAddress must be a valid Stellar public key");
    }
    const matchAmt = Number.parseFloat(this.payload.matchAmount);
    if (isNaN(matchAmt) || matchAmt <= 0) errors.push("matchAmount must be a positive number");
    return errors;
  }
}

class ChangeProjectStatusCommand extends Command {
  static COMMAND_TYPE = "ChangeProjectStatus";

  constructor({ commandId, actor, projectId, status, reason }) {
    super({ commandId, actor, payload: { projectId, status, reason } });
  }

  validate() {
    const valid = ["active", "completed", "paused", "rejected"];
    const errors = [];
    if (!this.payload.projectId) errors.push("projectId is required");
    if (!this.payload.status || !valid.includes(this.payload.status)) {
      errors.push(`status must be one of: ${valid.join(", ")}`);
    }
    return errors;
  }
}

class ReachMilestoneCommand extends Command {
  static COMMAND_TYPE = "ReachMilestone";

  constructor({ commandId, actor, milestoneId, projectId, transactionHash }) {
    super({ commandId, actor, payload: { milestoneId, projectId, transactionHash } });
  }

  validate() {
    const errors = [];
    if (!this.payload.milestoneId) errors.push("milestoneId is required");
    if (!this.payload.projectId) errors.push("projectId is required");
    if (this.payload.transactionHash && !/^[a-fA-F0-9]{64}$/.test(this.payload.transactionHash)) {
      errors.push("transactionHash must be a 64-char hex string if provided");
    }
    return errors;
  }
}

class ReleaseEscrowCommand extends Command {
  static COMMAND_TYPE = "ReleaseEscrow";

  constructor({ commandId, actor, jobId, releaseTransactionHash }) {
    super({ commandId, actor, payload: { jobId, releaseTransactionHash } });
  }

  validate() {
    const errors = [];
    if (!this.payload.jobId) errors.push("jobId is required");
    if (!this.payload.releaseTransactionHash || !/^[a-fA-F0-9]{64}$/.test(this.payload.releaseTransactionHash)) {
      errors.push("releaseTransactionHash must be a 64-char hex string");
    }
    return errors;
  }
}

class CreateMatchOfferCommand extends Command {
  static COMMAND_TYPE = "CreateMatchOffer";

  constructor({ commandId, actor, projectId, matcherAddress, capXlm, multiplier, expiresAt }) {
    super({ commandId, actor, payload: { projectId, matcherAddress, capXlm, multiplier, expiresAt } });
  }

  validate() {
    const errors = [];
    if (!this.payload.projectId) errors.push("projectId is required");
    if (!this.payload.matcherAddress || !isValidStellarAddress(this.payload.matcherAddress)) {
      errors.push("matcherAddress must be a valid Stellar public key");
    }
    const cap = Number.parseFloat(this.payload.capXlm);
    if (isNaN(cap) || cap <= 0) errors.push("capXlm must be a positive number");
    const mult = Number.parseInt(this.payload.multiplier, 10);
    if (isNaN(mult) || mult < 1) errors.push("multiplier must be >= 1");
    if (!this.payload.expiresAt || Number.isNaN(new Date(this.payload.expiresAt).getTime())) {
      errors.push("expiresAt must be a valid ISO date string");
    }
    if (new Date(this.payload.expiresAt).getTime() <= Date.now()) {
      errors.push("expiresAt must be in the future");
    }
    return errors;
  }
}

module.exports = {
  Command,
  RecordDonationCommand,
  ApplyMatchCommand,
  ChangeProjectStatusCommand,
  ReachMilestoneCommand,
  ReleaseEscrowCommand,
  CreateMatchOfferCommand,
};
