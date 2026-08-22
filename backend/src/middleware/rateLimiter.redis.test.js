"use strict";
/**
 * middleware/rateLimiter.redis.test.js
 * Proves the Redis-backed store shares counters across independently
 * constructed limiter instances — e.g. two backend replicas behind a load
 * balancer — unlike the default in-memory store where each instance holds
 * its own private counters (see rateLimiter.test.js).
 *
 * Requires a reachable REDIS_URL; skipped otherwise. No environment wires
 * REDIS_URL yet (tracked in a follow-up infra issue), so this suite is
 * currently skipped in local dev and in CI until that lands — it is not a
 * mock and will run for real once a Redis instance is reachable.
 */

const hasRedis = Boolean(process.env.REDIS_URL);
const describeIfRedis = hasRedis ? describe : describe.skip;

describeIfRedis("Rate limiting middleware — shared Redis store", () => {
  let express, request, createRateLimiter, redisClient;

  beforeAll(() => {
    express = require("express");
    request = require("supertest");
    ({ createRateLimiter } = require("./rateLimiter"));
    redisClient = require("../cache/redisClient");
  });

  afterAll(async () => {
    if (redisClient) await redisClient.quit();
  });

  function buildApp(name) {
    const app = express();
    app.use(createRateLimiter(3, 1, name));
    app.get("/ping", (_req, res) => res.status(200).json({ ok: true }));
    return app;
  }

  it("shares the counter across two independently constructed limiter instances with the same name", async () => {
    const name = `test-shared-${process.hrtime.bigint()}`;
    const replicaA = buildApp(name);
    const replicaB = buildApp(name);

    // Simulates a load balancer spreading 3 requests across two pods.
    await request(replicaA).get("/ping");
    await request(replicaB).get("/ping");
    const third = await request(replicaA).get("/ping");
    expect(third.status).toBe(200);

    // The 4th request, on either replica, must be blocked — proving the
    // limit is enforced against one shared count, not two private counts of 3.
    const fourthOnB = await request(replicaB).get("/ping");
    expect(fourthOnB.status).toBe(429);
  });

  it("keeps separately named limiters isolated on the same Redis instance", async () => {
    const appA = buildApp(`test-isolated-a-${process.hrtime.bigint()}`);
    const appB = buildApp(`test-isolated-b-${process.hrtime.bigint()}`);

    await request(appA).get("/ping");
    await request(appA).get("/ping");
    await request(appA).get("/ping");
    const blockedOnA = await request(appA).get("/ping");
    expect(blockedOnA.status).toBe(429);

    // A different limiter name must not have been touched by A's requests.
    const okOnB = await request(appB).get("/ping");
    expect(okOnB.status).toBe(200);
  });
});
