"use strict";

const mockCloseStream = jest.fn();
let mockCursorArg = null;
const mockStreamFn = jest.fn(() => mockCloseStream);
const mockCursorFn = jest.fn((c) => {
  mockCursorArg = c;
  return { stream: mockStreamFn };
});
const mockOpsFn = jest.fn(() => ({
  cursor: mockCursorFn,
}));

jest.mock("./stellar", () => ({
  server: {
    operations: mockOpsFn,
  },
}));

jest.mock("../db/pool", () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
  connect: jest.fn().mockResolvedValue({
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  }),
}));

jest.mock("uuid", () => ({ v4: () => "test-uuid" }));
jest.mock("../eventSourcing/commandBus", () => ({
  execute: jest.fn(),
}));
jest.mock("../eventSourcing/events", () => ({
  DonationRecordedEvent: jest.fn(),
  MatchAppliedEvent: jest.fn(),
}));
jest.mock("../eventSourcing/commands", () => ({
  RecordDonationCommand: jest.fn(),
  ApplyMatchCommand: jest.fn(),
}));
jest.mock("./donationIntegrity", () => ({
  queueDonationAssessment: jest.fn().mockResolvedValue({}),
  observeNativePayment: jest.fn().mockResolvedValue(false),
  refreshIntegrityWatchlist: jest.fn().mockResolvedValue({ controlled: 0, watched: 0 }),
  startIntegrityWorker: jest.fn(),
  stopIntegrityWorker: jest.fn(),
  getIntegrityWorkerStatus: jest.fn(() => ({ isRunning: false })),
}));

const pool = require("../db/pool");
const indexerService = require("./indexerService");

describe("indexerService shutdown", () => {
  afterEach(() => {
    indexerService.stopIndexer();
    mockCloseStream.mockClear();
    mockOpsFn.mockClear();
    mockCursorFn.mockClear();
    mockStreamFn.mockClear();
    mockCursorArg = null;
  });

  it("stops the refresh interval and closes the Horizon stream", async () => {
    await indexerService.startIndexer(null);
    expect(indexerService.getStatus().isRunning).toBe(true);

    indexerService.stopIndexer();

    expect(mockCloseStream).toHaveBeenCalledTimes(1);
    expect(indexerService.getStatus().isRunning).toBe(false);
  });

  it("is a no-op when called before the indexer has started", () => {
    expect(() => indexerService.stopIndexer()).not.toThrow();
    expect(mockCloseStream).not.toHaveBeenCalled();
  });
});

describe("indexerService cursor persistence", () => {
  afterEach(() => {
    indexerService.stopIndexer();
    mockCloseStream.mockClear();
    mockOpsFn.mockClear();
    mockCursorFn.mockClear();
    mockStreamFn.mockClear();
    mockCursorArg = null;
    pool.query.mockReset();
    pool.query.mockResolvedValue({ rows: [] });
  });

  it("uses cursor 'now' when no persisted cursor exists", async () => {
    await indexerService.startIndexer(null);
    expect(mockCursorArg).toBe("now");
  });

  it("resumes from the persisted cursor on startup", async () => {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === "string" && sql.includes("SELECT value FROM indexer_state")) {
        return Promise.resolve({ rows: [{ value: "12345" }] });
      }
      return Promise.resolve({ rows: [] });
    });
    await indexerService.startIndexer(null);
    expect(mockCursorArg).toBe("12345");
  });

  it("persists the cursor on graceful shutdown", async () => {
    await indexerService.startIndexer(null);

    // Get the onmessage handler from the mock stream call
    const handler = mockStreamFn.mock.calls[0][0];
    handler.onmessage({ ledger_attr: 99999 });

    indexerService.stopIndexer();

    const insertCalls = pool.query.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO indexer_state")
    );
    expect(insertCalls.length).toBeGreaterThanOrEqual(1);
    expect(insertCalls[0][1]).toEqual([
      "horizon_operations_cursor",
      "99999",
    ]);
  });

  it("does not persist cursor on shutdown when no operations were processed", async () => {
    pool.query.mockClear();
    await indexerService.startIndexer(null);
    pool.query.mockClear();
    indexerService.stopIndexer();

    const insertCalls = pool.query.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO indexer_state")
    );
    expect(insertCalls).toHaveLength(0);
  });

  it("replays a donation broadcast during downtime on the next startup", async () => {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === "string" && sql.includes("SELECT value FROM indexer_state")) {
        return Promise.resolve({ rows: [{ value: "500" }] });
      }
      return Promise.resolve({ rows: [] });
    });
    await indexerService.startIndexer(null);

    // Simulate stream emitting an operation at ledger 501
    const handler = mockStreamFn.mock.calls[0][0];
    handler.onmessage({
      ledger_attr: 501,
      type: "payment",
      asset_type: "native",
      to: "some-wallet",
      from: "donor-addr",
      amount: "10",
      transaction_hash: "tx-abc",
    });

    expect(indexerService.getStatus().lastProcessedLedger).toBe(501);
  });
});
