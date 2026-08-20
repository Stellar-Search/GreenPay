"use strict";

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

jest.mock("pg-boss", () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    start: jest.fn().mockResolvedValue(undefined),
    work: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue("job-id"),
  }));
});

jest.mock("expo-server-sdk", () => {
  const mockExpoInstance = {
    chunkPushNotifications: jest.fn((messages) => (messages.length === 0 ? [] : [messages])),
    sendPushNotificationsAsync: jest.fn(),
    chunkPushNotificationReceiptIds: jest.fn((ids) => [ids]),
    getPushNotificationReceiptsAsync: jest.fn(),
  };
  function Expo() {
    return mockExpoInstance;
  }
  Expo.isExpoPushToken = jest.fn(() => true);
  Expo.__mockInstance = mockExpoInstance;
  return { Expo };
});

const pool = require("../db/pool");
const PgBoss = require("pg-boss");
const { Expo } = require("expo-server-sdk");
const mockExpo = Expo.__mockInstance;
const push = require("./push");

describe("sendUpdatePushNotifications", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExpo.chunkPushNotifications.mockImplementation((messages) =>
      messages.length === 0 ? [] : [messages],
    );
    mockExpo.chunkPushNotificationReceiptIds.mockImplementation((ids) => [ids]);
    Expo.isExpoPushToken.mockReturnValue(true);
  });

  const project = { id: "project-1", name: "Reef Cleanup" };
  const update = { id: "update-1", title: "New photos from the field" };

  it("sends notifications to followers and logs the ticket count", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ token: "ExponentPushToken[good]", platform: "ios" }],
    });
    mockExpo.sendPushNotificationsAsync.mockResolvedValueOnce([
      { status: "ok", id: "ticket-1" },
    ]);

    await push.sendUpdatePushNotifications({ project, update });

    expect(mockExpo.sendPushNotificationsAsync).toHaveBeenCalledWith([
      expect.objectContaining({ to: "ExponentPushToken[good]" }),
    ]);
  });

  it("skips tokens that Expo does not recognize as valid push tokens", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ token: "not-a-real-token", platform: "ios" }],
    });
    Expo.isExpoPushToken.mockReturnValue(false);

    await push.sendUpdatePushNotifications({ project, update });

    expect(mockExpo.sendPushNotificationsAsync).not.toHaveBeenCalled();
  });

  it("does nothing when the project has no followers", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await push.sendUpdatePushNotifications({ project, update });

    expect(mockExpo.chunkPushNotifications).not.toHaveBeenCalled();
  });

  it("queues a delayed receipt check for each accepted ticket after sending", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ token: "ExponentPushToken[good]", platform: "ios" }],
    });
    mockExpo.sendPushNotificationsAsync.mockResolvedValueOnce([
      { status: "ok", id: "ticket-1" },
    ]);

    await push.start();
    const bossInstance = PgBoss.mock.results[0].value;

    await push.sendUpdatePushNotifications({ project, update });

    expect(bossInstance.send).toHaveBeenCalledWith(
      "expo-push-receipts",
      { receipts: [{ ticketId: "ticket-1", token: "ExponentPushToken[good]" }] },
      expect.objectContaining({ startAfter: expect.any(Number), retryLimit: expect.any(Number) }),
    );
  });

  it("does not queue a receipt check for tickets Expo rejected immediately", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ token: "ExponentPushToken[bad]", platform: "ios" }],
    });
    mockExpo.sendPushNotificationsAsync.mockResolvedValueOnce([
      { status: "error", message: "InvalidCredentials", details: { error: "InvalidCredentials" } },
    ]);

    await push.start();
    const bossInstance = PgBoss.mock.results[0].value;

    await push.sendUpdatePushNotifications({ project, update });

    expect(bossInstance.send).not.toHaveBeenCalled();
  });
});

describe("checkPushReceipts", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExpo.chunkPushNotificationReceiptIds.mockImplementation((ids) => [ids]);
  });

  it("prunes the device_tokens row whose Expo receipt reports DeviceNotRegistered", async () => {
    // Realistic shape of Expo's getPushNotificationReceiptsAsync response —
    // see https://docs.expo.dev/push-notifications/sending-notifications/#push-tickets-and-receipts
    mockExpo.getPushNotificationReceiptsAsync.mockResolvedValueOnce({
      "ticket-ok": { status: "ok" },
      "ticket-stale": {
        status: "error",
        message:
          "\"ExponentPushToken[stale-token]\" is not a registered push notification recipient",
        details: { error: "DeviceNotRegistered" },
      },
    });
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    await push.checkPushReceipts([
      { ticketId: "ticket-ok", token: "ExponentPushToken[good]" },
      { ticketId: "ticket-stale", token: "ExponentPushToken[stale-token]" },
    ]);

    expect(pool.query).toHaveBeenCalledWith(
      "DELETE FROM device_tokens WHERE token = ANY($1::text[])",
      [["ExponentPushToken[stale-token]"]],
    );
  });

  it("does not touch device_tokens when every receipt comes back ok", async () => {
    mockExpo.getPushNotificationReceiptsAsync.mockResolvedValueOnce({
      "ticket-ok": { status: "ok" },
    });

    await push.checkPushReceipts([{ ticketId: "ticket-ok", token: "ExponentPushToken[good]" }]);

    expect(pool.query).not.toHaveBeenCalled();
  });

  it("logs and skips other Expo error receipts without pruning the token", async () => {
    mockExpo.getPushNotificationReceiptsAsync.mockResolvedValueOnce({
      "ticket-rate-limited": {
        status: "error",
        message: "Rate limit exceeded",
        details: { error: "MessageRateExceeded" },
      },
    });

    await push.checkPushReceipts([
      { ticketId: "ticket-rate-limited", token: "ExponentPushToken[good]" },
    ]);

    expect(pool.query).not.toHaveBeenCalled();
  });
});
