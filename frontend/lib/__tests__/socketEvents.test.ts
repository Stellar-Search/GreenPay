/**
 * lib/__tests__/socketEvents.test.ts
 *
 * Unit tests for frontend socketEvents TypeScript wrappers and runtime validation.
 */
import {
  SOCKET_EVENTS,
  validateDonationPayload,
  validateAISummaryPayload,
  validateSocketEvent,
} from "../socketEvents";

describe("frontend socketEvents wrapper", () => {
  const validDonation = {
    projectId: "8d9ac19b-52eb-42f7-80d9-19a88ba59e43",
    donorAddress: "GDYO6GEXKXPU3UH5SWGTAVHMBBZZEKUHWHXUJ33PL2TJJVHZB7CG6BI5",
    amountXLM: 100,
    transactionHash: "c".repeat(64),
    timestamp: "2026-08-21T10:00:00.000Z",
  };

  test("validates valid donation payload correctly", () => {
    const res = validateDonationPayload(validDonation);
    expect(res.success).toBe(true);
    expect(res.data).toEqual(validDonation);
  });

  test("rejects malformed donation payload", () => {
    const res = validateDonationPayload({ projectId: "invalid" });
    expect(res.success).toBe(false);
    expect(res.error).toBeDefined();
  });

  test("validates AI summary payload correctly", () => {
    const res = validateAISummaryPayload({
      projectId: "8d9ac19b-52eb-42f7-80d9-19a88ba59e43",
      aiSummary: "Summary text",
      aiSummaryGeneratedAt: "2026-08-21T10:00:00.000Z",
      aiSummaryModel: "summary-model",
    });
    expect(res.success).toBe(true);
  });

  test("dispatches event validation via validateSocketEvent", () => {
    const res = validateSocketEvent(SOCKET_EVENTS.DONATION_EVENT, validDonation);
    expect(res.success).toBe(true);
  });
});
