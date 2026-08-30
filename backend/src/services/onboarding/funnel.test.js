/**
 * src/services/onboarding/funnel.test.js
 */
"use strict";

const {
  STAGES,
  PATHS,
  FunnelError,
  startSession,
  recordStage,
  completeSession,
  sweepAbandonedSessions,
  conversionReport,
  compareToBaseline,
  biggestDropOffs,
  normalizeReferrer,
} = require("./funnel");

function fakePool(rows = []) {
  return { query: jest.fn().mockResolvedValue({ rows, rowCount: rows.length }) };
}

describe("stage definitions", () => {
  it("starts at intent and ends at a recorded donation", () => {
    expect(STAGES[0]).toBe("donate_intent");
    expect(STAGES[STAGES.length - 1]).toBe("donation_recorded");
  });

  it("includes the existing wallet flow so the new paths are comparable to it", () => {
    // Without a baseline emitted by the pre-change path, "conversion improved"
    // is an opinion.
    expect(PATHS).toContain("connected_wallet");
  });

  it("puts the trade-off acknowledgement before the account is ready", () => {
    // If it came after, the disclosure would be a confirmation rather than a
    // decision, which is exactly the failure this feature is trying to avoid.
    expect(STAGES.indexOf("tradeoff_acknowledged")).toBeLessThan(STAGES.indexOf("account_ready"));
  });
});

describe("normalizeReferrer", () => {
  it("buckets a URL rather than storing it", () => {
    expect(normalizeReferrer("https://twitter.com/some/very/identifying/path")).toBe("social");
    expect(normalizeReferrer("https://www.google.com/search?q=secret+query")).toBe("search");
    expect(normalizeReferrer("https://unknown.example/x")).toBe("external");
  });

  it("treats a missing referrer as direct", () => {
    expect(normalizeReferrer(null)).toBe("direct");
  });

  it("accepts an already-bucketed value", () => {
    expect(normalizeReferrer("qr")).toBe("qr");
  });

  it("never returns anything not in the bucket list", () => {
    const buckets = ["direct", "social", "search", "internal", "external", "qr", "email", "unknown"];
    for (const input of ["https://x.com/a", "mailto:x", "!!!", "https://[bad", "email"]) {
      expect(buckets).toContain(normalizeReferrer(input));
    }
  });
});

describe("startSession", () => {
  it("stores no identifying data alongside the session", async () => {
    const pool = fakePool();
    await startSession({ path: "sponsored_account", referrer: "https://twitter.com/x" }, pool);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO onboarding_sessions/);
    // Bucketed, not the URL.
    expect(params).toContain("social");
    expect(params.join(" ")).not.toMatch(/twitter\.com\/x/);
  });

  it("refuses an unknown path", async () => {
    await expect(startSession({ path: "magic" }, fakePool())).rejects.toThrow(FunnelError);
  });
});

describe("recordStage", () => {
  it("is idempotent per session and stage, so a re-render cannot inflate conversion", async () => {
    const pool = fakePool();
    await recordStage({ sessionId: "s", stage: "path_offered", path: "onramp" }, pool);
    expect(pool.query.mock.calls[0][0]).toMatch(/ON CONFLICT \(session_id, stage, path_key\) DO UPDATE/);
  });

  it("advances the session's furthest stage monotonically", async () => {
    const pool = fakePool();
    await recordStage({ sessionId: "s", stage: "account_ready" }, pool);
    expect(pool.query.mock.calls[1][0]).toMatch(/GREATEST\(furthest_stage_index/);
  });

  it("refuses an unknown stage rather than recording a name nothing can read", async () => {
    await expect(recordStage({ sessionId: "s", stage: "vibes" }, fakePool())).rejects.toThrow(FunnelError);
  });

  it("requires a session", async () => {
    await expect(recordStage({ stage: "donate_intent" }, fakePool())).rejects.toThrow(/sessionId is required/);
  });
});

describe("completeSession", () => {
  it("only closes a session that is still in progress", async () => {
    const pool = fakePool();
    await completeSession({ sessionId: "s", outcome: "completed" }, pool);
    expect(pool.query.mock.calls[0][0]).toMatch(/outcome = 'in_progress'/);
  });

  it("refuses an unknown outcome", async () => {
    await expect(completeSession({ sessionId: "s", outcome: "maybe" }, fakePool())).rejects.toThrow(FunnelError);
  });
});

describe("sweepAbandonedSessions", () => {
  it("stops stale sessions counting as still deciding", async () => {
    // Left open, they inflate conversion by removing people who left from
    // the denominator's failure side.
    const pool = fakePool([{ id: "a" }]);
    await expect(sweepAbandonedSessions({ olderThanHours: 6 }, pool)).resolves.toBe(1);
    expect(pool.query.mock.calls[0][1]).toEqual(["6"]);
  });
});

describe("conversionReport", () => {
  function rowsFor(path, counts) {
    return STAGES.map((stage, index) => ({
      stage,
      stage_index: index,
      path,
      sessions: String(counts[index]),
    }));
  }

  it("computes conversion from the previous stage and from the top", async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({
        rows: rowsFor("sponsored_account", [1000, 900, 500, 450, 400, 380, 200, 190, 180]),
      }),
    };
    const report = await conversionReport({}, pool);
    const [path] = report.paths;

    expect(path.donateIntent).toBe(1000);
    expect(path.donationsRecorded).toBe(180);
    expect(path.overallConversionPct).toBe(18);
    // 500 of the 900 who were offered a path picked one.
    expect(path.stages[2].fromPreviousPct).toBeCloseTo(55.56, 1);
  });

  it("reports both paths separately so they can be compared", async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({
        rows: [
          ...rowsFor("connected_wallet", [100, 100, 100, 100, 95, 90, 85, 84, 84]),
          ...rowsFor("sponsored_account", [900, 800, 400, 350, 300, 280, 150, 145, 140]),
        ],
      }),
    };
    const report = await conversionReport({}, pool);
    expect(report.paths.map((p) => p.path)).toEqual(["sponsored_account", "connected_wallet"]);
    expect(report.overall.donateIntent).toBe(1000);
    expect(report.overall.donationsRecorded).toBe(224);
  });

  it("returns nulls rather than dividing by zero on an empty window", async () => {
    const report = await conversionReport({}, fakePool([]));
    expect(report.overall.conversionPct).toBeNull();
    expect(report.paths).toEqual([]);
  });

  it("refuses an unknown path filter", async () => {
    await expect(conversionReport({ path: "wat" }, fakePool())).rejects.toThrow(FunnelError);
  });
});

describe("compareToBaseline", () => {
  function stageRows(path, counts) {
    return STAGES.map((stage, index) => ({
      stage,
      stage_index: index,
      path,
      sessions: String(counts[index]),
    }));
  }

  it("reports percentage points and relative change separately", async () => {
    // 2% -> 3% is +1 percentage point and +50% relative. Quoting only the
    // second turns a rounding-level change into a triumph.
    const pool = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: stageRows("connected_wallet", [1000, 1000, 1000, 1000, 1000, 1000, 30, 25, 20]) })
        .mockResolvedValueOnce({ rows: stageRows("sponsored_account", [1000, 1000, 1000, 1000, 1000, 1000, 40, 35, 30]) }),
    };

    const comparison = await compareToBaseline(
      {
        baselineSince: "2026-01-01T00:00:00.000Z",
        baselineUntil: "2026-02-01T00:00:00.000Z",
        currentSince: "2026-02-01T00:00:00.000Z",
      },
      pool,
    );

    expect(comparison.baseline.conversionPct).toBe(2);
    expect(comparison.current.conversionPct).toBe(3);
    expect(comparison.deltaPercentagePoints).toBe(1);
    expect(comparison.relativeChangePct).toBe(50);
  });

  it("says when the sample is too small to conclude anything", async () => {
    const pool = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: stageRows("connected_wallet", [10, 9, 8, 7, 6, 5, 4, 3, 2]) })
        .mockResolvedValueOnce({ rows: stageRows("sponsored_account", [12, 11, 10, 9, 8, 7, 6, 5, 4]) }),
    };
    const comparison = await compareToBaseline(
      { baselineSince: "2026-01-01T00:00:00.000Z", baselineUntil: "2026-02-01T00:00:00.000Z", currentSince: "2026-02-01T00:00:00.000Z" },
      pool,
    );
    expect(comparison.sufficientSample).toBe(false);
  });
});

describe("biggestDropOffs", () => {
  it("names the stage transition that loses the most people", async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({
        rows: STAGES.map((stage, index) => ({
          stage,
          stage_index: index,
          path: "onramp",
          sessions: String([1000, 950, 900, 850, 300, 280, 260, 255, 250][index]),
        })),
      }),
    };
    const report = await conversionReport({}, pool);
    const [worst] = biggestDropOffs(report);

    expect(worst).toMatchObject({ from: "tradeoff_acknowledged", to: "account_ready", lost: 550 });
  });
});
