/**
 * src/services/onboarding/maintenance.test.js
 */
"use strict";

const { runSweeps, startOnboardingMaintenance, stopOnboardingMaintenance } = require("./maintenance");

afterEach(() => {
  stopOnboardingMaintenance();
  jest.useRealTimers();
});

describe("runSweeps", () => {
  it("runs both sweeps and reports what each collected", async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ id: "a" }], rowCount: 1 }) };
    await expect(runSweeps(pool)).resolves.toEqual({ sponsorships: 1, sessions: 1 });
  });

  it("keeps running the session sweep when the sponsorship sweep fails", async () => {
    // A failed sweep must not stop the other one; the worst case is capacity
    // held until the next tick.
    let call = 0;
    const pool = {
      query: jest.fn(async () => {
        call += 1;
        if (call === 1) throw new Error("db blip");
        return { rows: [], rowCount: 2 };
      }),
    };
    await expect(runSweeps(pool)).resolves.toEqual({ sponsorships: 0, sessions: 2 });
  });

  it("never throws, so a failing sweep cannot crash the process", async () => {
    const pool = { query: jest.fn().mockRejectedValue(new Error("everything is down")) };
    await expect(runSweeps(pool)).resolves.toEqual({ sponsorships: 0, sessions: 0 });
  });
});

describe("startOnboardingMaintenance", () => {
  it("unrefs its timers so a test or CLI process is never held open", () => {
    const timers = startOnboardingMaintenance({ dbPool: { query: jest.fn() } });
    expect(timers).toHaveLength(2);
    for (const timer of timers) {
      expect(timer.hasRef()).toBe(false);
    }
  });

  it("replaces existing timers rather than accumulating them on a restart", () => {
    const first = startOnboardingMaintenance({ dbPool: { query: jest.fn() } });
    const second = startOnboardingMaintenance({ dbPool: { query: jest.fn() } });
    expect(second[0]).not.toBe(first[0]);
  });

  it("sweeps on its interval", () => {
    jest.useFakeTimers();
    const pool = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    startOnboardingMaintenance({ dbPool: pool, sponsorshipIntervalMs: 1000, sessionIntervalMs: 5000 });

    jest.advanceTimersByTime(1000);
    expect(pool.query).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(4000);
    expect(pool.query.mock.calls.length).toBeGreaterThanOrEqual(5);
  });
});
