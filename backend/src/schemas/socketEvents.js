/**
 * src/schemas/socketEvents.js
 *
 * Backend schema definitions for Socket.IO realtime events.
 * Wraps and re-exports the canonical shared contract in ../../../shared/socketEvents.
 */
"use strict";

const { z } = require("zod");
const {
  SOCKET_EVENTS,
  validateDonationPayload,
  validateAISummaryPayload,
  validateSocketEvent,
} = require("../../../shared/socketEvents");
const { stellarPublicKey, transactionHash, uuid } = require("./common");

const DonationSocketSchema = z.object({
  projectId: uuid,
  donorAddress: stellarPublicKey,
  amountXLM: z.number().positive(),
  transactionHash: transactionHash,
  timestamp: z.string().datetime({ offset: true }),
});

const AISummarySocketSchema = z.object({
  projectId: uuid,
  aiSummary: z.string().min(1),
  aiSummaryGeneratedAt: z.string().datetime({ offset: true }),
  aiSummaryModel: z.string().min(1),
});

module.exports = {
  SOCKET_EVENTS,
  DonationSocketSchema,
  AISummarySocketSchema,
  validateDonationPayload,
  validateAISummaryPayload,
  validateSocketEvent,
};
