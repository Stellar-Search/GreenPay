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

jest.mock("./notificationFailures", () => ({
  recordNotificationFailure: jest.fn().mockResolvedValue(undefined),
}));

const pool = require("../db/pool");
const PgBoss = require("pg-boss");
const { Expo } = require("expo-server-sdk");
const { recordNotificationFailure } = require("./notificationFailures");
const mockExpo = Expo.__mockInstance;
const push = require("./push");

function getBossInstance() {
  return PgBoss.mock.results[PgBoss.mock.results.length - 1].value;
}

function getWorkHandler(boss, queueName) {
  const call = boss.work.mock.calls.find((args) => args[0] === queueName);
  return call[call.length - 1];
}

const project = { id: "project-1", name: "Reef Cleanup" };
const update = { id: "update-1", title: "New photos from the field" };

describe("sendUpdatePushNotifications", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockReset();
  });

  it("throws when the update-push queue has not been started", async () => {
    // Force `boss` back to its unstarted state by reloading the module.
    jest.resetModules();
    const freshPush = require("./push");
    await expect(
      freshPush.sendUpdatePushNotifications({ project, update }),
    ).rejects.toThrow("not started");
  });

  it("reads followers in bounded pages and enqueues one job per page", async () => {
    await push.start();

    pool.query
      .mockResolvedValueOnce({
        rows: [
          { id: "follow-1", token: "ExponentPushToken[a]", platform: "ios" },
          { id: "follow-2", token: "ExponentPushToken[b]", platform: "android" },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ token: "ExponentPushToken[a]" }, { token: "ExponentPushToken[b]" }],
      });

    await push.sendUpdatePushNotifications({ project, update });

    const boss = getBossInstance();
    expect(boss.send).toHaveBeenCalledTimes(1);
    expect(boss.send).toHaveBeenCalledWith(
      "update-push-notify",
      {
        project,
        update,
        tokens: [
          { token: "ExponentPushToken[a]", platform: "ios" },
          { token: "ExponentPushToken[b]", platform: "android" },
        ],
      },
      expect.objectContaining({ retryLimit: expect.any(Number), retryDelay: expect.any(Number) }),
    );
  });

  it("logs and queues nothing when the project has no followers", async () => {
    await push.start();
    pool.query.mockResolvedValueOnce({ rows: [] });
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    await push.sendUpdatePushNotifications({ project, update });

    const boss = getBossInstance();
    expect(boss.send).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("[Push] No followers for project", project.id);
    logSpy.mockRestore();
  });

  it("pages through followers past a full chunk using keyset pagination", async () => {
    await push.start();

    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: `follow-${String(i).padStart(3, "0")}`,
      token: `ExponentPushToken[user${i}]`,
      platform: "ios",
    }));
    pool.query
      .mockResolvedValueOnce({ rows: fullPage })
      .mockResolvedValueOnce({ rows: fullPage.map(({ token }) => ({ token })) })
      .mockResolvedValueOnce({
        rows: [{ id: "follow-100", token: "ExponentPushToken[last]", platform: "ios" }],
      })
      .mockResolvedValueOnce({ rows: [{ token: "ExponentPushToken[last]" }] });

    await push.sendUpdatePushNotifications({ project, update });

    const boss = getBossInstance();
    expect(boss.send).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[2][1]).toEqual([project.id, "follow-099", 100, update.id]);
  });

  it("queues removal corrections from the original device-token snapshot", async () => {
    await push.start();
    pool.query
      .mockResolvedValueOnce({
        rows: [{ token: "ExponentPushToken[former]", platform: "ios" }],
      })
      .mockResolvedValueOnce({ rows: [{ token: "ExponentPushToken[former]" }] });

    await push.sendUpdateRemovalPushNotifications({
      project,
      update,
      reason: "Unsupported claim",
    });

    expect(pool.query.mock.calls[0][0]).toContain("project_update_push_recipients");
    expect(pool.query.mock.calls[0][0]).not.toContain("project_follows");
    expect(getBossInstance().send).toHaveBeenCalledWith(
      "update-push-notify",
      expect.objectContaining({
        kind: "removed",
        reason: "Unsupported claim",
        tokens: [{ token: "ExponentPushToken[former]", platform: "ios" }],
      }),
      expect.any(Object),
    );
  });
});

describe("sendPushToTokens", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockReset();
    mockExpo.chunkPushNotifications.mockImplementation((messages) =>
      messages.length === 0 ? [] : [messages],
    );
    mockExpo.chunkPushNotificationReceiptIds.mockImplementation((ids) => [ids]);
    Expo.isExpoPushToken.mockReturnValue(true);
  });

  it("sends notifications to the given tokens and logs the ticket count", async () => {
    mockExpo.sendPushNotificationsAsync.mockResolvedValueOnce([
      { status: "ok", id: "ticket-1" },
    ]);

    await push.sendPushToTokens({
      project,
      update,
      tokens: [{ token: "ExponentPushToken[good]", platform: "ios" }],
    });

    expect(mockExpo.sendPushNotificationsAsync).toHaveBeenCalledWith([
      expect.objectContaining({ to: "ExponentPushToken[good]" }),
    ]);
  });

  it("labels a removal correction and does not repeat the removed body", async () => {
    mockExpo.sendPushNotificationsAsync.mockResolvedValueOnce([
      { status: "ok", id: "ticket-1" },
    ]);
    await push.sendPushToTokens({
      project,
      update: { ...update, body: "Removed body" },
      tokens: [{ token: "ExponentPushToken[good]", platform: "ios" }],
      kind: "removed",
      reason: "Unsupported claim",
    });
    const message = mockExpo.sendPushNotificationsAsync.mock.calls[0][0][0];
    expect(message.title).toContain("Update correction");
    expect(message.body).toContain("Unsupported claim");
    expect(message.body).not.toContain("Removed body");
    expect(message.data.type).toBe("project_update_removed");
  });

  it("skips tokens that Expo does not recognize as valid push tokens", async () => {
    Expo.isExpoPushToken.mockReturnValue(false);

    await push.sendPushToTokens({
      project,
      update,
      tokens: [{ token: "not-a-real-token", platform: "ios" }],
    });

    expect(mockExpo.sendPushNotificationsAsync).not.toHaveBeenCalled();
  });

  it("does nothing when given no tokens", async () => {
    await push.sendPushToTokens({ project, update, tokens: [] });

    expect(mockExpo.chunkPushNotifications).not.toHaveBeenCalled();
  });

  it("queues a delayed receipt check for each accepted ticket after sending", async () => {
    mockExpo.sendPushNotificationsAsync.mockResolvedValueOnce([
      { status: "ok", id: "ticket-1" },
    ]);

    await push.start();
    const bossInstance = PgBoss.mock.results[0].value;

    await push.sendPushToTokens({
      project,
      update,
      tokens: [{ token: "ExponentPushToken[good]", platform: "ios" }],
    });

    expect(bossInstance.send).toHaveBeenCalledWith(
      "expo-push-receipts",
      { receipts: [{ ticketId: "ticket-1", token: "ExponentPushToken[good]" }] },
      expect.objectContaining({ startAfter: expect.any(Number), retryLimit: expect.any(Number) }),
    );
  });

  it("does not queue a receipt check for tickets Expo rejected immediately", async () => {
    mockExpo.sendPushNotificationsAsync.mockResolvedValueOnce([
      { status: "error", message: "InvalidCredentials", details: { error: "InvalidCredentials" } },
    ]);

    await push.start();
    const bossInstance = PgBoss.mock.results[0].value;

    await push.sendPushToTokens({
      project,
      update,
      tokens: [{ token: "ExponentPushToken[bad]", platform: "ios" }],
    });

    expect(bossInstance.send).not.toHaveBeenCalled();
  });

  it("throws when the Expo send call fails, so pg-boss retries the batch", async () => {
    mockExpo.sendPushNotificationsAsync.mockRejectedValueOnce(new Error("Expo outage"));

    await expect(
      push.sendPushToTokens({
        project,
        update,
        tokens: [{ token: "ExponentPushToken[good]", platform: "ios" }],
      }),
    ).rejects.toThrow("Expo outage");
  });
});

describe("start", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockReset();
  });

  it("creates the receipt queue before registering the worker on it", async () => {
    await push.start();
    const boss = getBossInstance();

    expect(boss.createQueue).toHaveBeenCalledWith("expo-push-receipts");
    expect(boss.createQueue.mock.invocationCallOrder[0]).toBeLessThan(
      boss.work.mock.invocationCallOrder[0],
    );
  });

  it("creates the update-push dead-letter queue before the main queue, and both before registering workers", async () => {
    await push.start();
    const boss = getBossInstance();

    expect(boss.createQueue).toHaveBeenCalledWith("update-push-notify-dlq");
    expect(boss.createQueue).toHaveBeenCalledWith(
      "update-push-notify",
      expect.objectContaining({ deadLetter: "update-push-notify-dlq" }),
    );

    const dlqOrder = boss.createQueue.mock.calls.findIndex((args) => args[0] === "update-push-notify-dlq");
    const mainOrder = boss.createQueue.mock.calls.findIndex((args) => args[0] === "update-push-notify");
    expect(dlqOrder).toBeLessThan(mainOrder);
  });
});

describe("update-push-notify worker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockReset();
    mockExpo.chunkPushNotifications.mockImplementation((messages) =>
      messages.length === 0 ? [] : [messages],
    );
    Expo.isExpoPushToken.mockReturnValue(true);
  });

  it("sends push notifications for each job in the batch", async () => {
    await push.start();
    const boss = getBossInstance();
    const handler = getWorkHandler(boss, "update-push-notify");

    mockExpo.sendPushNotificationsAsync.mockResolvedValueOnce([{ status: "ok", id: "ticket-1" }]);

    await handler([
      {
        id: "job-1",
        data: { project, update, tokens: [{ token: "ExponentPushToken[good]", platform: "ios" }] },
      },
    ]);

    expect(mockExpo.sendPushNotificationsAsync).toHaveBeenCalledWith([
      expect.objectContaining({ to: "ExponentPushToken[good]" }),
    ]);
  });
});

describe("update-push-notify-dlq worker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockReset();
  });

  it("records a permanent failure once retries are exhausted", async () => {
    await push.start();
    const boss = getBossInstance();
    const handler = getWorkHandler(boss, "update-push-notify-dlq");

    const failedJob = {
      id: "job-1",
      data: {
        project,
        update,
        tokens: [{ token: "ExponentPushToken[good]", platform: "ios" }],
      },
      output: new Error("Expo outage"),
    };

    await handler([failedJob]);

    expect(recordNotificationFailure).toHaveBeenCalledWith({
      projectId: project.id,
      updateId: update.id,
      channel: "push",
      payload: { tokenCount: 1 },
      error: failedJob.output,
    });
  });
});

describe("receipt-check worker (pg-boss v10 job array contract)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockReset();
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
    pool.query.mockReset();
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
