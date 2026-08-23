"use strict";

jest.mock("../db/pool", () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

const pool = require("../db/pool");
const { normalizeDoublePrefixedStreamIds } = require("./migrate");

function makeClient() {
  return {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: jest.fn(),
  };
}

describe("normalizeDoublePrefixedStreamIds", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("skips the rewrite entirely when already marked done", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: "stream-id-normalization" }] });

    const result = await normalizeDoublePrefixedStreamIds();

    expect(result).toEqual({ status: "already_migrated", rowsFixed: 0 });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rewrites double-prefixed rows, records the migration state, and returns the count fixed", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // not yet migrated

    const client = makeClient();
    client.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 3 }) // UPDATE ... rewrote 3 rows
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT INTO event_store_migration_state
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT
    pool.connect.mockResolvedValueOnce(client);

    const result = await normalizeDoublePrefixedStreamIds();

    expect(result).toEqual({ status: "completed", rowsFixed: 3 });

    const updateCall = client.query.mock.calls[1];
    expect(updateCall[0]).toMatch(/UPDATE event_stream/);
    expect(updateCall[0]).toMatch(/WHERE aggregate_id LIKE aggregate_type \|\| ':%'/);

    const insertCall = client.query.mock.calls[2];
    expect(insertCall[0]).toContain("event_store_migration_state");
    expect(insertCall[1]).toEqual([3]);

    expect(client.query).toHaveBeenNthCalledWith(1, "BEGIN");
    expect(client.query).toHaveBeenNthCalledWith(4, "COMMIT");
    expect(client.release).toHaveBeenCalled();
  });

  it("records zero as the fixed count when no rows needed rewriting", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const client = makeClient();
    client.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // UPDATE matched nothing
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT INTO event_store_migration_state
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT
    pool.connect.mockResolvedValueOnce(client);

    const result = await normalizeDoublePrefixedStreamIds();

    expect(result).toEqual({ status: "completed", rowsFixed: 0 });
  });

  it("rolls back, releases the client, and rethrows when the rewrite fails", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const client = makeClient();
    const dbError = new Error("connection lost");
    client.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockRejectedValueOnce(dbError) // UPDATE fails
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK
    pool.connect.mockResolvedValueOnce(client);

    await expect(normalizeDoublePrefixedStreamIds()).rejects.toThrow("connection lost");

    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalled();
  });
});
