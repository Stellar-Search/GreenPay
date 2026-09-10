/**
 * shared/socketEvents.js
 *
 * Single source of truth for Socket.IO realtime event names, payload schemas,
 * and runtime validators across backend and frontend.
 *
 * Zero external dependencies — runs identically in Node.js (CommonJS)
 * and browser/Next.js (ESM / TypeScript).
 */
"use strict";

const STELLAR_PUBLIC_KEY_REGEX = /^G[A-Z0-9]{55}$/;
const TRANSACTION_HASH_REGEX = /^[a-fA-F0-9]{64}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Canonical Socket.IO event names emitted by the GreenPay backend.
 */
const SOCKET_EVENTS = Object.freeze({
  DONATION_EVENT: "donation_event",
  AI_SUMMARY_READY: "ai_summary_ready",
});

/**
 * Validates a donation_event socket payload.
 *
 * @param {unknown} data
 * @returns {{ success: true, data: { projectId: string, donorAddress: string, amountXLM: number, transactionHash: string, timestamp: string } } | { success: false, error: string }}
 */
function validateDonationPayload(data) {
  if (!data || typeof data !== "object") {
    return { success: false, error: "Payload must be a non-null object" };
  }

  const { projectId, donorAddress, amountXLM, transactionHash, timestamp } = data;

  if (typeof projectId !== "string" || !UUID_REGEX.test(projectId.trim())) {
    return { success: false, error: "Invalid or missing projectId (must be UUID)" };
  }

  if (typeof donorAddress !== "string" || !STELLAR_PUBLIC_KEY_REGEX.test(donorAddress.trim())) {
    return { success: false, error: "Invalid or missing donorAddress (must be valid Stellar public key)" };
  }

  const parsedAmount = typeof amountXLM === "number" ? amountXLM : Number.parseFloat(amountXLM);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return { success: false, error: "Invalid amountXLM (must be a positive number)" };
  }

  if (typeof transactionHash !== "string" || !TRANSACTION_HASH_REGEX.test(transactionHash.trim())) {
    return { success: false, error: "Invalid or missing transactionHash (must be 64-char hex string)" };
  }

  if (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) {
    return { success: false, error: "Invalid or missing timestamp (must be valid ISO date string)" };
  }

  return {
    success: true,
    data: {
      projectId: projectId.trim(),
      donorAddress: donorAddress.trim(),
      amountXLM: parsedAmount,
      transactionHash: transactionHash.trim(),
      timestamp: new Date(timestamp).toISOString(),
    },
  };
}

/**
 * Validates an ai_summary_ready socket payload.
 *
 * @param {unknown} data
 * @returns {{ success: true, data: { projectId: string, aiSummary: string, aiSummaryGeneratedAt: string, aiSummaryModel: string } } | { success: false, error: string }}
 */
function validateAISummaryPayload(data) {
  if (!data || typeof data !== "object") {
    return { success: false, error: "Payload must be a non-null object" };
  }

  const { projectId, aiSummary, aiSummaryGeneratedAt, aiSummaryModel } = data;

  if (typeof projectId !== "string" || !UUID_REGEX.test(projectId.trim())) {
    return { success: false, error: "Invalid or missing projectId (must be UUID)" };
  }

  if (typeof aiSummary !== "string" || aiSummary.trim().length === 0) {
    return { success: false, error: "Invalid or missing aiSummary (must be non-empty string)" };
  }

  if (typeof aiSummaryGeneratedAt !== "string" || Number.isNaN(Date.parse(aiSummaryGeneratedAt))) {
    return { success: false, error: "Invalid or missing aiSummaryGeneratedAt (must be valid ISO date string)" };
  }

  if (typeof aiSummaryModel !== "string" || aiSummaryModel.trim().length === 0) {
    return { success: false, error: "Invalid or missing aiSummaryModel" };
  }

  return {
    success: true,
    data: {
      projectId: projectId.trim(),
      aiSummary: aiSummary.trim(),
      aiSummaryGeneratedAt: new Date(aiSummaryGeneratedAt).toISOString(),
      aiSummaryModel: aiSummaryModel.trim(),
    },
  };
}

/**
 * Generic socket event payload validator dispatcher.
 *
 * @param {string} eventName
 * @param {unknown} payload
 * @returns {{ success: boolean, data?: unknown, error?: string }}
 */
function validateSocketEvent(eventName, payload) {
  switch (eventName) {
  case SOCKET_EVENTS.DONATION_EVENT:
    return validateDonationPayload(payload);
  case SOCKET_EVENTS.AI_SUMMARY_READY:
    return validateAISummaryPayload(payload);
  default:
    return { success: false, error: `Unknown event name: ${eventName}` };
  }
}

module.exports = {
  SOCKET_EVENTS,
  validateDonationPayload,
  validateAISummaryPayload,
  validateSocketEvent,
  STELLAR_PUBLIC_KEY_REGEX,
  TRANSACTION_HASH_REGEX,
  UUID_REGEX,
};
