"use strict";

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || "test-resend-key";
process.env.APP_URL = process.env.APP_URL || "http://localhost:3000";
process.env.EMAIL_FROM = process.env.EMAIL_FROM || "GreenPay <updates@greenpay.app>";

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

jest.mock("./notificationFailures", () => ({
  recordNotificationFailure: jest.fn().mockResolvedValue(undefined),
}));

const pool = require("../db/pool");
const PgBoss = require("pg-boss");
const { recordNotificationFailure } = require("./notificationFailures");
const email = require("./email");

function getBossInstance() {
  return PgBoss.mock.results[PgBoss.mock.results.length - 1].value;
}

function getWorkHandler(boss, queueName) {
  const call = boss.work.mock.calls.find((args) => args[0] === queueName);
  return call[call.length - 1];
}

const project = { id: "project-1", name: "Reef Cleanup" };
const update = { id: "update-1", title: "New photos from the field" };

describe("enqueueUpdateNotifications", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockReset();
  });

  it("throws when the queue has not been started", async () => {
    // Force `boss` back to its unstarted state by reloading the module.
    jest.resetModules();
    const freshEmail = require("./email");
    await expect(
      freshEmail.enqueueUpdateNotifications({ project, update }),
    ).rejects.toThrow("not started");
  });

  it("reads subscribers in bounded pages and enqueues one job per page", async () => {
    await email.start();

    pool.query
      .mockResolvedValueOnce({
        rows: [
          { id: "sub-1", email: "a@example.com" },
          { id: "sub-2", email: "b@example.com" },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await email.enqueueUpdateNotifications({ project, update });

    const boss = getBossInstance();
    expect(boss.send).toHaveBeenCalledTimes(1);
    expect(boss.send).toHaveBeenCalledWith(
      "update-email-notify",
      { project, update, emails: ["a@example.com", "b@example.com"] },
      expect.objectContaining({ retryLimit: expect.any(Number), retryDelay: expect.any(Number) }),
    );
  });

  it("does nothing when the project has no subscribers", async () => {
    await email.start();
    pool.query.mockResolvedValueOnce({ rows: [] });

    await email.enqueueUpdateNotifications({ project, update });

    const boss = getBossInstance();
    expect(boss.send).not.toHaveBeenCalled();
  });

  it("pages through subscribers past a full chunk using keyset pagination", async () => {
    await email.start();

    const fullPage = Array.from({ length: 50 }, (_, i) => ({
      id: `sub-${String(i).padStart(3, "0")}`,
      email: `user${i}@example.com`,
    }));
    pool.query
      .mockResolvedValueOnce({ rows: fullPage })
      .mockResolvedValueOnce({ rows: [{ id: "sub-050", email: "last@example.com" }] });

    await email.enqueueUpdateNotifications({ project, update });

    const boss = getBossInstance();
    expect(boss.send).toHaveBeenCalledTimes(2);
    // Second page's query starts from the last id seen on the first page.
    expect(pool.query.mock.calls[1][1]).toEqual([project.id, "sub-049", 50]);
  });
});

describe("sendUpdateNotifications", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockReset();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("does nothing when there are no emails", async () => {
    await email.sendUpdateNotifications({ project, update, emails: [] });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("posts a single Resend batch for a chunk of emails", async () => {
    global.fetch.mockResolvedValueOnce({ ok: true });

    await email.sendUpdateNotifications({ project, update, emails: ["a@example.com"] });

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws when Resend returns a non-ok response, so pg-boss retries the job", async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("boom") });

    await expect(
      email.sendUpdateNotifications({ project, update, emails: ["a@example.com"] }),
    ).rejects.toThrow(/Resend error/);
  });

  it("warns and skips when RESEND_API_KEY is not configured", async () => {
    const saved = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    jest.resetModules();

    const freshEmail = require("./email");
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await freshEmail.sendUpdateNotifications({ project, update, emails: ["a@example.com"] });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("RESEND_API_KEY"));

    warnSpy.mockRestore();
    process.env.RESEND_API_KEY = saved;
  });
});

describe("start", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockReset();
  });

  it("creates the dead-letter queue before the main queue, and both before registering workers", async () => {
    await email.start();
    const boss = getBossInstance();

    expect(boss.createQueue).toHaveBeenCalledWith("update-email-notify-dlq");
    expect(boss.createQueue).toHaveBeenCalledWith(
      "update-email-notify",
      expect.objectContaining({ deadLetter: "update-email-notify-dlq" }),
    );
    expect(boss.createQueue.mock.invocationCallOrder[0]).toBeLessThan(
      boss.createQueue.mock.invocationCallOrder[1],
    );
    expect(boss.createQueue.mock.invocationCallOrder[1]).toBeLessThan(
      boss.work.mock.invocationCallOrder[0],
    );
  });
});

describe("update-email-notify worker", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockReset();
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("sends the batch for each job via Resend", async () => {
    await email.start();
    const boss = getBossInstance();
    const handler = getWorkHandler(boss, "update-email-notify");

    await handler([{ id: "job-1", data: { project, update, emails: ["a@example.com"] } }]);

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("update-email-notify-dlq worker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockReset();
  });

  it("records a permanent failure once retries are exhausted", async () => {
    await email.start();
    const boss = getBossInstance();
    const handler = getWorkHandler(boss, "update-email-notify-dlq");

    const failedJob = {
      id: "job-1",
      data: { project, update, emails: ["a@example.com", "b@example.com"] },
      output: new Error("Resend error (500): boom"),
    };

    await handler([failedJob]);

    expect(recordNotificationFailure).toHaveBeenCalledWith({
      projectId: project.id,
      updateId: update.id,
      channel: "email",
      payload: { emailCount: 2 },
      error: failedJob.output,
    });
  });
});
