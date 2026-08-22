"use strict";

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

jest.mock("pg-boss", () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    start: jest.fn().mockResolvedValue(undefined),
    createQueue: jest.fn().mockResolvedValue(undefined),
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

function getBossInstance() {
  return PgBoss.mock.results[PgBoss.mock.results.length - 1].value;
}

function getWorkHandler(boss, queueName) {
  const call = boss.work.mock.calls.find((args) => args[0] === queueName);
  return call[call.length - 1];
}

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

describe("start", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("creates the receipt queue before registering the worker on it", async () => {
    await push.start();
    const boss = getBossInstance();

    expect(boss.createQueue).toHaveBeenCalledWith("expo-push-receipts");
    expect(boss.createQueue.mock.invocationCallOrder[0]).toBeLessThan(
      boss.work.mock.invocationCallOrder[0],
    );
  });
});

describe("receipt-check worker (pg-boss v10 job array contract)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExpo.chunkPushNotificationReceiptIds.mockImplementation((ids) => [ids]);
  });

  it("processes a v10-shaped batch of one job by unwrapping job.data.receipts", async () => {
    await push.start();
    const boss = getBossInstance();
    const handler = getWorkHandler(boss, "expo-push-receipts");

    mockExpo.getPushNotificationReceiptsAsync.mockResolvedValueOnce({
      "ticket-stale": {
        status: "error",
        message: "not a registered push notification recipient",
        details: { error: "DeviceNotRegistered" },
      },
    });
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    await handler([
      {
        id: "job-1",
        data: { receipts: [{ ticketId: "ticket-stale", token: "ExponentPushToken[stale-token]" }] },
      },
    ]);

    expect(pool.query).toHaveBeenCalledWith(
      "DELETE FROM device_tokens WHERE token = ANY($1::text[])",
      [["ExponentPushToken[stale-token]"]],
    );
  });

  it("processes every job in a multi-job batch", async () => {
    await push.start();
    const boss = getBossInstance();
    const handler = getWorkHandler(boss, "expo-push-receipts");

    mockExpo.getPushNotificationReceiptsAsync
      .mockResolvedValueOnce({
        "ticket-stale-1": {
          status: "error",
          message: "not a registered push notification recipient",
          details: { error: "DeviceNotRegistered" },
        },
      })
      .mockResolvedValueOnce({
        "ticket-stale-2": {
          status: "error",
          message: "not a registered push notification recipient",
          details: { error: "DeviceNotRegistered" },
        },
      });
    pool.query.mockResolvedValue({ rowCount: 1 });

    await handler([
      {
        id: "job-1",
        data: { receipts: [{ ticketId: "ticket-stale-1", token: "ExponentPushToken[stale-1]" }] },
      },
      {
        id: "job-2",
        data: { receipts: [{ ticketId: "ticket-stale-2", token: "ExponentPushToken[stale-2]" }] },
      },
    ]);

    expect(mockExpo.getPushNotificationReceiptsAsync).toHaveBeenCalledTimes(2);
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [["ExponentPushToken[stale-1]"]]);
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [["ExponentPushToken[stale-2]"]]);
  });

  it("logs the job's ticket ids and rethrows when checking receipts fails", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    await push.start();
    const boss = getBossInstance();
    const handler = getWorkHandler(boss, "expo-push-receipts");

    const dbError = new Error("connection terminated");
    mockExpo.getPushNotificationReceiptsAsync.mockResolvedValueOnce({
      "ticket-stale": {
        status: "error",
        message: "not a registered push notification recipient",
        details: { error: "DeviceNotRegistered" },
      },
    });
    pool.query.mockRejectedValueOnce(dbError);

    await expect(
      handler([
        {
          id: "job-1",
          data: {
            receipts: [{ ticketId: "ticket-stale", token: "ExponentPushToken[stale-token]" }],
          },
        },
      ]),
    ).rejects.toThrow("connection terminated");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("ticket-stale"),
      dbError,
    );

    consoleErrorSpy.mockRestore();
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
