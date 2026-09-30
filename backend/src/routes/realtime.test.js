"use strict";

const express = require("express");
const request = require("supertest");
const { apiEnvelope, errorHandler } = require("../middleware/apiEnvelope");
const realtime = require("../realtime");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use("/api/v1/realtime", require("./realtime"));
  app.use(errorHandler);
  return app;
}

describe("GET /api/v1/realtime/replay", () => {
  let app;

  beforeEach(async () => {
    realtime.resetRealtime();
    realtime.metrics.reset();
    app = buildApp();
    // Single-process mode gives a real in-memory log to replay from.
    await realtime.initializeRealtime({ on: () => {}, emit: () => {} }, { redisUrl: null });
  });

  afterAll(() => realtime.resetRealtime());

  it("returns the events broadcast after the client's cursor", async () => {
    const first = await realtime.publish("donation_event", { projectId: "p1" });
    await realtime.publish("donation_event", { projectId: "p2" });
    await realtime.publish("donation_event", { projectId: "p3" });

    const res = await request(app).get("/api/v1/realtime/replay").query({ cursor: first.cursor });

    expect(res.status).toBe(200);
    expect(res.body.data.map((e) => e.payload.projectId)).toEqual(["p2", "p3"]);
    expect(res.body.meta.reset).toBe(false);
    expect(res.body.meta.nextCursor).toBeTruthy();
  });

  it("says so explicitly when it cannot prove the replay is complete", async () => {
    await realtime.publish("donation_event", { projectId: "p1" });

    const res = await request(app).get("/api/v1/realtime/replay").query({ cursor: "l:ffffffffffffffff:1" });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    // The distinction the whole mechanism rests on: an empty array alone would
    // read as "you missed nothing".
    expect(res.body.meta.reset).toBe(true);
    expect(res.body.meta.reason).toBe("CURSOR_FOREIGN");
    expect(res.body.meta.recovery).toMatch(/refetch current state/i);
  });

  it("treats a missing cursor as 'start from now', not as an error", async () => {
    const res = await request(app).get("/api/v1/realtime/replay");
    expect(res.status).toBe(200);
    expect(res.body.meta.reset).toBe(true);
    expect(res.body.meta.reason).toBe("NO_CURSOR");
  });

  it("rejects a repeated cursor parameter rather than coercing an array", async () => {
    const res = await request(app).get("/api/v1/realtime/replay?cursor=a&cursor=b");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_CURSOR");
  });

  it("counts replays and resets so a rise in gaps is visible", async () => {
    const first = await realtime.publish("donation_event", { projectId: "p1" });
    await request(app).get("/api/v1/realtime/replay").query({ cursor: first.cursor });
    await request(app).get("/api/v1/realtime/replay").query({ cursor: "garbage" });

    const snapshot = realtime.metrics.snapshot();
    expect(snapshot.replayRequests).toBe(2);
    expect(snapshot.replayResets).toBe(1);
  });
});

describe("GET /api/v1/realtime/status", () => {
  let app;

  beforeEach(async () => {
    realtime.resetRealtime();
    realtime.metrics.reset();
    app = buildApp();
    await realtime.initializeRealtime({ on: () => {}, emit: () => {} }, { redisUrl: null });
  });

  afterAll(() => realtime.resetRealtime());

  it("reports this pod's delivery scope and counters", async () => {
    const res = await request(app).get("/api/v1/realtime/status");

    expect(res.status).toBe(200);
    // Served through the standard API envelope like every other route.
    const body = res.body.data;
    expect(body.mode).toBe("single-process");
    expect(body.delivery).toBe("instance");
    // Per-instance: an aggregate would hide a pod that receives nothing, which
    // is how the cross-replica bug stayed invisible.
    expect(body.instanceId).toEqual(expect.any(String));
    expect(body.metrics.instanceId).toBe(body.instanceId);
    expect(body.metrics).toHaveProperty("fanoutObserved");
  });
});
