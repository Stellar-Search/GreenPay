/**
 * shared/socketEvents.test.js
 *
 * Unit tests for shared Socket.IO event schema validators.
 */
"use strict";

const {
  SOCKET_EVENTS,
  validateDonationPayload,
  validateAISummaryPayload,
  validateSocketEvent,
} = require("./socketEvents");

describe("shared/socketEvents contract", () => {
  const validDonation = {
    projectId: "8d9ac19b-52eb-42f7-80d9-19a88ba59e43",
    donorAddress: "GDYO6GEXKXPU3UH5SWGTAVHMBBZZEKUHWHXUJ33PL2TJJVHZB7CG6BI5",
    amountXLM: 25.5,
    transactionHash: "a".repeat(64),
    timestamp: "2026-08-21T09:00:00.000Z",
  };

  const validAISummary = {
    projectId: "8d9ac19b-52eb-42f7-80d9-19a88ba59e43",
    aiSummary: "A certified reforestation initiative in the Amazon basin.",
    aiSummaryGeneratedAt: "2026-08-21T09:00:00.000Z",
    aiSummaryModel: "summary-v1",
  };

  describe("SOCKET_EVENTS constants", () => {
    test("defines expected event names as immutable properties", () => {
      expect(SOCKET_EVENTS.DONATION_EVENT).toBe("donation_event");
      expect(SOCKET_EVENTS.AI_SUMMARY_READY).toBe("ai_summary_ready");
      expect(Object.isFrozen(SOCKET_EVENTS)).toBe(true);
    });
  });

  describe("validateDonationPayload", () => {
    test("accepts a valid donation payload", () => {
      const res = validateDonationPayload(validDonation);
      expect(res.success).toBe(true);
      expect(res.data).toEqual(validDonation);
    });

    test("converts string amount to number if valid", () => {
      const res = validateDonationPayload({ ...validDonation, amountXLM: "50.75" });
      expect(res.success).toBe(true);
      expect(res.data.amountXLM).toBe(50.75);
    });

    test("rejects non-object or null payloads", () => {
      expect(validateDonationPayload(null).success).toBe(false);
      expect(validateDonationPayload("string").success).toBe(false);
      expect(validateDonationPayload(123).success).toBe(false);
    });

    test("rejects invalid projectId (non-UUID)", () => {
      const res = validateDonationPayload({ ...validDonation, projectId: "not-a-uuid" });
      expect(res.success).toBe(false);
      expect(res.error).toContain("projectId");
    });

    test("rejects invalid donorAddress (non-Stellar key)", () => {
      const res = validateDonationPayload({ ...validDonation, donorAddress: "invalid-key" });
      expect(res.success).toBe(false);
      expect(res.error).toContain("donorAddress");
    });

    test("rejects non-positive or NaN amountXLM", () => {
      expect(validateDonationPayload({ ...validDonation, amountXLM: 0 }).success).toBe(false);
      expect(validateDonationPayload({ ...validDonation, amountXLM: -10 }).success).toBe(false);
      expect(validateDonationPayload({ ...validDonation, amountXLM: "not-a-number" }).success).toBe(false);
      expect(validateDonationPayload({ ...validDonation, amountXLM: Infinity }).success).toBe(false);
    });

    test("rejects invalid transactionHash (not 64-char hex)", () => {
      expect(validateDonationPayload({ ...validDonation, transactionHash: "short" }).success).toBe(false);
      expect(validateDonationPayload({ ...validDonation, transactionHash: "z".repeat(64) }).success).toBe(false);
    });

    test("rejects invalid timestamp", () => {
      const res = validateDonationPayload({ ...validDonation, timestamp: "invalid-date" });
      expect(res.success).toBe(false);
      expect(res.error).toContain("timestamp");
    });
  });

  describe("validateAISummaryPayload", () => {
    test("accepts a valid AI summary payload", () => {
      const res = validateAISummaryPayload(validAISummary);
      expect(res.success).toBe(true);
      expect(res.data).toEqual(validAISummary);
    });

    test("rejects invalid projectId", () => {
      const res = validateAISummaryPayload({ ...validAISummary, projectId: "bad-id" });
      expect(res.success).toBe(false);
    });

    test("rejects empty summary text", () => {
      const res = validateAISummaryPayload({ ...validAISummary, aiSummary: "   " });
      expect(res.success).toBe(false);
    });

    test("rejects invalid date", () => {
      const res = validateAISummaryPayload({ ...validAISummary, aiSummaryGeneratedAt: "bad-date" });
      expect(res.success).toBe(false);
    });
  });

  describe("validateSocketEvent dispatcher", () => {
    test("dispatches to donation payload validator", () => {
      const res = validateSocketEvent(SOCKET_EVENTS.DONATION_EVENT, validDonation);
      expect(res.success).toBe(true);
    });

    test("dispatches to AI summary payload validator", () => {
      const res = validateSocketEvent(SOCKET_EVENTS.AI_SUMMARY_READY, validAISummary);
      expect(res.success).toBe(true);
    });

    test("returns error for unknown event names", () => {
      const res = validateSocketEvent("unknown_event", {});
      expect(res.success).toBe(false);
      expect(res.error).toContain("Unknown event name");
    });
  });
});
