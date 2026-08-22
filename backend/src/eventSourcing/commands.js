"use strict";

const { v4: uuid } = require("uuid");
const { xlmToStroops, xlmToStroopsRounded, stroopsToXlm } = require("../utils/xlm");

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
    if (!this.payload.donorAddress || !/^G[A-Z0-9]{55}$/.test(this.payload.donorAddress)) {
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
      // Fiat amounts never enter stroop arithmetic; validate positivity and
      // magnitude on their decimal string without going through a double.
      try {
        const units = xlmToStroopsRounded(this.payload.amount ?? 0);
        if (units <= 0n) errors.push("amount must be a positive number");
        // Same ceiling as before (> 1e15), enforced on the exact scaled integer.
        if (units > 10_000_000_000_000_000_000_000n) errors.push("amount exceeds allowed maximum");
      } catch {
        errors.push("amount must be a positive number");
      }
    }
    return errors;
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
    if (!this.payload.donorAddress || !/^G[A-Z0-9]{55}$/.test(this.payload.donorAddress)) {
      errors.push("donorAddress must be a valid Stellar public key");
    }
    try {
      if (this.getMatchAmountStroops() <= 0n) errors.push("matchAmount must be a positive number");
    } catch {
      errors.push("matchAmount must be a positive XLM amount with at most 7 decimal places");
    }
    return errors;
  }

  getMatchAmountStroops() {
    return xlmToStroopsRounded(this.payload.matchAmount ?? 0);
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
    if (!this.payload.matcherAddress || !/^G[A-Z0-9]{55}$/.test(this.payload.matcherAddress)) {
      errors.push("matcherAddress must be a valid Stellar public key");
    }
    try {
      if (this.getCapStroops() <= 0n) errors.push("capXlm must be a positive number");
    } catch {
      errors.push("capXlm must be a positive XLM amount with at most 7 decimal places");
    }
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

  getCapStroops() {
    return xlmToStroopsRounded(this.payload.capXlm ?? 0);
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
