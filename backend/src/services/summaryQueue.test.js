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

jest.mock("./claude", () => ({
  generateProjectSummary: jest.fn(),
}));

jest.mock("./audit", () => ({
  logAdminAction: jest.fn(),
}));

// Stub the logger so console output stays quiet during tests but we can
// verify that log calls carry the expected structure.
jest.mock("../utils/logger", () => {
  const loggerMock = {
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockImplementation(() => loggerMock),
  };
  return {
    logger: loggerMock,
    getCorrelationId: jest.fn().mockReturnValue(undefined),
    runWithCorrelationId: jest.fn().mockImplementation((_id, fn) => fn()),
  };
});

const pool = require("../db/pool");
const PgBoss = require("pg-boss");
const { generateProjectSummary } = require("./claude");
const { getCorrelationId } = require("../utils/logger");
const summaryQueue = require("./summaryQueue");

function getBossInstance() {
  return PgBoss.mock.results[PgBoss.mock.results.length - 1].value;
}

function getWorkHandler(boss, queueName) {
  const call = boss.work.mock.calls.find((args) => args[0] === queueName);
  return call[call.length - 1];
}

describe("summaryQueue", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("enqueueAISummary", () => {
    it("throws if called before start()", async () => {
      let freshQueue;
      jest.isolateModules(() => {
        freshQueue = require("./summaryQueue");
      });

      await expect(freshQueue.enqueueAISummary("project-1", {})).rejects.toThrow(
        "summaryQueue not started",
      );
    });

    it("enqueues with retryLimit, retryDelay, and deadLetter routing", async () => {
      await summaryQueue.start(null);
      const boss = getBossInstance();

      await summaryQueue.enqueueAISummary("project-1", {
        name: "Reef Cleanup",
        category: "ocean",
        description: "Cleans reefs",
        adminAddress: "GADMIN",
      });

      expect(boss.send).toHaveBeenCalledWith(
        "ai-summary",
        expect.objectContaining({ projectId: "project-1", name: "Reef Cleanup" }),
        expect.objectContaining({ retryLimit: 3, retryDelay: 10, deadLetter: "ai-summary-dlq" }),
      );
    });

    it("includes correlationId in the job payload when one is present in context", async () => {
      // Simulate a request context where a correlation id has been set.
      getCorrelationId.mockReturnValueOnce("cid-enqueue-test");

      await summaryQueue.start(null);
      const boss = getBossInstance();

      await summaryQueue.enqueueAISummary("project-2", {
        name: "Solar",
        category: "energy",
        description: "Solar panels",
      });

      expect(boss.send).toHaveBeenCalledWith(
        "ai-summary",
        expect.objectContaining({ projectId: "project-2", correlationId: "cid-enqueue-test" }),
        expect.any(Object),
      );
    });

    it("omits correlationId from the payload when no context is set", async () => {
      getCorrelationId.mockReturnValue(undefined);

      await summaryQueue.start(null);
      const boss = getBossInstance();

      await summaryQueue.enqueueAISummary("project-3", { name: "x", category: "x", description: "x" });

      const sentPayload = boss.send.mock.calls.at(-1)[1];
      expect(sentPayload).not.toHaveProperty("correlationId");
    });
  });

  describe("main worker (happy path)", () => {
    it("stores the generated summary and continues to succeed unmodified", async () => {
      await summaryQueue.start(null);
      const boss = getBossInstance();
      const handler = getWorkHandler(boss, "ai-summary");

      generateProjectSummary.mockResolvedValueOnce({ summary: "A great project.", model: "claude-opus-4-7" });
      pool.query.mockResolvedValueOnce({
        rows: [{ ai_summary: "A great project.", ai_summary_generated_at: new Date(), ai_summary_model: "claude-opus-4-7" }],
      });

      await handler([{ data: { projectId: "project-1", name: "Reef Cleanup", category: "ocean", description: "x" } }]);

      expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE projects"), expect.any(Array));
    });

    it("swallows MISSING_API_KEY without throwing (no retry)", async () => {
      await summaryQueue.start(null);
      const boss = getBossInstance();
      const handler = getWorkHandler(boss, "ai-summary");

      const err = new Error("ANTHROPIC_API_KEY is not set");
      err.code = "MISSING_API_KEY";
      generateProjectSummary.mockRejectedValueOnce(err);

      await expect(
        handler([{ data: { projectId: "project-1", name: "x", category: "x", description: "x" } }]),
      ).resolves.toBeUndefined();
      expect(pool.query).not.toHaveBeenCalled();
    });

    it("rethrows other errors so pg-boss retries them", async () => {
      await summaryQueue.start(null);
      const boss = getBossInstance();
      const handler = getWorkHandler(boss, "ai-summary");

      generateProjectSummary.mockRejectedValueOnce(new Error("Anthropic API outage"));

      await expect(
        handler([{ data: { projectId: "project-1", name: "x", category: "x", description: "x" } }]),
      ).rejects.toThrow("Anthropic API outage");
    });
  });

  describe("dead-letter worker (permanent failure)", () => {
    it("records a distinct failure row and fires the alerting hook once retries are exhausted", async () => {
      await summaryQueue.start(null);
      const boss = getBossInstance();
      const handler = getWorkHandler(boss, "ai-summary-dlq");
      const alertSpy = jest.spyOn(summaryQueue, "notifyRepeatedFailure").mockResolvedValue(undefined);

      pool.query.mockResolvedValueOnce({ rows: [] }); // INSERT INTO ai_summary_job_failures

      await handler([{
        data: { projectId: "project-1", name: "Reef Cleanup", category: "ocean", description: "x" },
        output: { name: "Error", message: "content policy rejection", stack: "Error: content policy rejection\n    at x" },
      }]);

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO ai_summary_job_failures"),
        expect.arrayContaining(["project-1", expect.any(String), "content policy rejection", expect.any(String)]),
      );
      expect(alertSpy).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "project-1", errorMessage: "content policy rejection" }),
      );
    });

    it("still fires the alerting hook if persisting the failure row throws", async () => {
      await summaryQueue.start(null);
      const boss = getBossInstance();
      const handler = getWorkHandler(boss, "ai-summary-dlq");
      const alertSpy = jest.spyOn(summaryQueue, "notifyRepeatedFailure").mockResolvedValue(undefined);

      pool.query.mockRejectedValueOnce(new Error("db unavailable"));

      await handler([{
        data: { projectId: "project-1" },
        output: { message: "API outage" },
      }]);

      expect(alertSpy).toHaveBeenCalled();
    });
  });

  describe("notifyRepeatedFailure", () => {
    const originalFetch = global.fetch;
    const originalUrl = process.env.SUMMARY_FAILURE_ALERT_WEBHOOK_URL;

    afterEach(() => {
      global.fetch = originalFetch;
      if (originalUrl === undefined) {
        delete process.env.SUMMARY_FAILURE_ALERT_WEBHOOK_URL;
      } else {
        process.env.SUMMARY_FAILURE_ALERT_WEBHOOK_URL = originalUrl;
      }
    });

    it("posts to the configured webhook with failure context", async () => {
      process.env.SUMMARY_FAILURE_ALERT_WEBHOOK_URL = "https://hooks.example.com/alert";
      global.fetch = jest.fn().mockResolvedValue({ ok: true });
      jest.resetModules();
      const freshQueue = require("./summaryQueue");

      await freshQueue.notifyRepeatedFailure({
        projectId: "project-1",
        errorMessage: "content policy rejection",
        retryLimit: 3,
      });

      expect(global.fetch).toHaveBeenCalledWith(
        "https://hooks.example.com/alert",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("project-1"),
        }),
      );
    });

    it("no-ops without throwing when no webhook is configured", async () => {
      delete process.env.SUMMARY_FAILURE_ALERT_WEBHOOK_URL;
      global.fetch = jest.fn();
      jest.resetModules();
      const freshQueue = require("./summaryQueue");

      await expect(
        freshQueue.notifyRepeatedFailure({ projectId: "project-1", errorMessage: "x", retryLimit: 3 }),
      ).resolves.toBeUndefined();
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
