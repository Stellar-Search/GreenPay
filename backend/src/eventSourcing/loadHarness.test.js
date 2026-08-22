"use strict";

const { runBurstScenario } = require("./loadHarness");
const { EventStoreService } = require("./eventStore");

// The harness runs on a virtual clock, so these scenarios finish in seconds even
// though they replay minutes of donation traffic. Numbers assert the capacity
// documented in docs/performance.md; if the projection path gains or loses
// statements per event, these are the tests that should move first.
jest.setTimeout(60000);

const SUSTAINABLE_RATE = 100;
const SPIKE_RATE = 400;
const SPIKE_SECONDS = 30;

describe("event-sourcing pipeline under donation-spike load", () => {
  test("keeps up at the sustained rate with sub-second catch-up", async () => {
    const result = await runBurstScenario({
      donations: SUSTAINABLE_RATE * SPIKE_SECONDS,
      spikeDurationMs: SPIKE_SECONDS * 1000,
      adaptive: true,
    });

    expect(result.drained).toBe(true);
    expect(result.processed).toBe(SUSTAINABLE_RATE * SPIKE_SECONDS);
    expect(result.unprocessed).toBe(0);
    expect(result.catchUpMs).toBeLessThan(1000);
    expect(result.lagMs.p95).toBeLessThan(1000);
  });

  test("every donation is projected exactly once", async () => {
    const donations = 1200;
    const result = await runBurstScenario({ donations, spikeDurationMs: 10000, adaptive: true });

    expect(result.processed).toBe(donations);
    expect(result.unprocessed).toBe(0);
  });

  test("a spike beyond capacity still drains rather than stalling", async () => {
    const result = await runBurstScenario({
      donations: SPIKE_RATE * SPIKE_SECONDS,
      spikeDurationMs: SPIKE_SECONDS * 1000,
      adaptive: true,
    });

    expect(result.drained).toBe(true);
    expect(result.unprocessed).toBe(0);
    // Backlog builds during the spike: that is the documented behaviour, and the
    // point of the assertion is that it is bounded and clears afterwards.
    expect(result.peakBacklog).toBeGreaterThan(0);
    expect(result.catchUpMs).toBeGreaterThan(0);
  });

  test("adaptive batching beats the fixed 200/500 ms scheduler on a spike", async () => {
    const scenario = {
      donations: SPIKE_RATE * SPIKE_SECONDS,
      spikeDurationMs: SPIKE_SECONDS * 1000,
    };
    const staticRun = await runBurstScenario({ ...scenario, adaptive: false });
    const adaptiveRun = await runBurstScenario({ ...scenario, adaptive: true });

    expect(adaptiveRun.sustainedThroughputPerSec).toBeGreaterThan(
      staticRun.sustainedThroughputPerSec * 1.2
    );
    expect(adaptiveRun.catchUpMs).toBeLessThan(staticRun.catchUpMs);
    expect(adaptiveRun.peakBacklog).toBeLessThanOrEqual(staticRun.peakBacklog);
  });

  test("dispatch costs at most four statements per event", async () => {
    // One projection UPDATE, three donor-stats statements, and an amortised
    // batch mark. A regression here directly lowers pipeline capacity.
    //
    // Measured over a volume large enough for cold start to amortise. The
    // harness cycles a fixed 500-donor set, and each donor's *first* donation
    // costs an extra statement (the profiles FK guard in upsertDonorStats), so
    // a short scenario reports the cold-start ratio rather than the steady
    // state this bound describes.
    const result = await runBurstScenario({ donations: 12000, spikeDurationMs: 5000, adaptive: true });
    expect(result.statementsPerEvent).toBeLessThanOrEqual(4.2);
  });

  test("sustained projection throughput stays above the documented floor", async () => {
    const result = await runBurstScenario({
      donations: 12000,
      spikeDurationMs: 20000,
      adaptive: true,
      queryLatencyMs: 1.2,
    });
    expect(result.sustainedThroughputPerSec).toBeGreaterThan(150);
  });
});

describe("adaptive batch sizing", () => {
  const stubPool = { query: jest.fn(), connect: jest.fn() };

  test("grows the batch while batches come back full", () => {
    const store = new EventStoreService(stubPool);
    store.adaptiveBatch = true;

    expect(store.recordBatchOutcome({ total: 200, limit: 200, processed: 200 })).toBe(400);
    expect(store.recordBatchOutcome({ total: 400, limit: 400, processed: 400 })).toBe(800);
    expect(store.stats.consecutiveSaturated).toBe(2);
  });

  test("caps growth at the configured maximum", () => {
    const store = new EventStoreService(stubPool);
    store.adaptiveBatch = true;
    const max = store.getSchedulerStats().maxBatchSize;

    for (let i = 0; i < 20; i += 1) {
      store.recordBatchOutcome({ total: store.batchSize, limit: store.batchSize, processed: store.batchSize });
    }
    expect(store.batchSize).toBe(max);
  });

  test("shrinks back towards the baseline once the backlog clears", () => {
    const store = new EventStoreService(stubPool);
    store.adaptiveBatch = true;
    store.batchSize = 800;

    store.recordBatchOutcome({ total: 10, limit: 800, processed: 10 });
    expect(store.batchSize).toBe(400);

    for (let i = 0; i < 10; i += 1) {
      store.recordBatchOutcome({ total: 0, limit: store.batchSize, processed: 0 });
    }
    expect(store.batchSize).toBe(store.getSchedulerStats().baseBatchSize);
    expect(store.stats.consecutiveSaturated).toBe(0);
  });

  test("holds the batch size fixed when adaptive batching is disabled", () => {
    const store = new EventStoreService(stubPool);
    store.adaptiveBatch = false;

    store.recordBatchOutcome({ total: 200, limit: 200, processed: 200 });
    expect(store.batchSize).toBe(store.getSchedulerStats().baseBatchSize);
  });

  test("polls again immediately after a saturated batch and on the grid otherwise", () => {
    const store = new EventStoreService(stubPool);
    store.adaptiveBatch = true;
    const { pollIntervalMs, catchUpIntervalMs } = store.getSchedulerStats();

    expect(store.nextDelayMs({ total: 200, limit: 200 }, 1200)).toBe(catchUpIntervalMs);
    expect(store.nextDelayMs({ total: 5, limit: 200 }, 0)).toBe(pollIntervalMs);
    // A batch that overran the interval does not push the next tick a full
    // interval further out.
    expect(store.nextDelayMs({ total: 5, limit: 200 }, pollIntervalMs + 100)).toBe(pollIntervalMs - 100);
  });
});
