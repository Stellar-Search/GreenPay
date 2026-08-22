"use strict";

/**
 * Goal-completion boundary tests.
 *
 * A campaign is complete only when raised >= goal in exact stroops. These
 * tests pin the behaviour one stroop below, exactly at, and one stroop above
 * the goal — the cases where double arithmetic misjudges funding status.
 */

const { campaignProgress, mapCampaignRow } = require("./projects");

const GOAL = "100.0000000";
const DEADLINE_FUTURE = Date.now() + 60_000;
const DEADLINE_PAST = Date.now() - 60_000;

describe("campaignProgress goal-completion boundary", () => {
  test("one stroop below the goal is not complete", () => {
    const result = campaignProgress(GOAL, "99.9999999", DEADLINE_FUTURE, Date.now());
    expect(result.completed).toBe(false);
    expect(result.progressPercent).toBe(100); // rounds to 100 but not funded
  });

  test("exactly at the goal is complete", () => {
    const result = campaignProgress(GOAL, "100.0000000", DEADLINE_FUTURE, Date.now());
    expect(result.completed).toBe(true);
    expect(result.progressPercent).toBe(100);
  });

  test("one stroop above the goal is complete", () => {
    const result = campaignProgress(GOAL, "100.0000001", DEADLINE_FUTURE, Date.now());
    expect(result.completed).toBe(true);
    expect(result.progressPercent).toBe(100);
  });

  test("a past deadline completes the campaign regardless of amount", () => {
    const result = campaignProgress(GOAL, "0.0000001", DEADLINE_PAST, Date.now());
    expect(result.completed).toBe(true);
  });

  test("zero goal never divides by zero", () => {
    const result = campaignProgress("0.0000000", "5.0000000", DEADLINE_FUTURE, Date.now());
    expect(result.progressPercent).toBe(0);
    // raised >= goal (0) → complete
    expect(result.completed).toBe(true);
  });

  test("progress percent rounds half-up exactly", () => {
    // 2/3 of the goal = 66.666...% → 67
    const result = campaignProgress("3.0000000", "2.0000000", DEADLINE_FUTURE, Date.now());
    expect(result.completed).toBe(false);
    expect(result.progressPercent).toBe(67);
  });

  test("large stroop-exact goals stay exact where doubles drift", () => {
    // 20 significant digits exceed IEEE-754 precision; a float comparison
    // of this pair would call the project funded while it is 1 stroop short.
    const hugeGoal = "9999999999999.9999999";
    expect(campaignProgress(hugeGoal, "9999999999999.9999998", DEADLINE_FUTURE, Date.now()).completed).toBe(false);
    expect(campaignProgress(hugeGoal, hugeGoal, DEADLINE_FUTURE, Date.now()).completed).toBe(true);
  });
});

describe("mapCampaignRow", () => {
  test("maps NUMERIC strings to canonical amounts and completion flags", () => {
    const row = {
      id: "c1",
      project_id: "p1",
      title: "Spring match",
      description: null,
      goal_xlm: "10.0000000",
      raised_xlm: "9.9999999",
      deadline: new Date(Date.now() + 60_000).toISOString(),
      created_at: new Date().toISOString(),
    };
    const mapped = mapCampaignRow(row);
    expect(mapped.goalXLM).toBe("10.0000000");
    expect(mapped.raisedXLM).toBe("9.9999999");
    expect(mapped.completed).toBe(false);
    expect(mapped.active).toBe(true);

    row.raised_xlm = "10.0000000";
    const funded = mapCampaignRow(row);
    expect(funded.completed).toBe(true);
    expect(funded.active).toBe(false);
  });
});
