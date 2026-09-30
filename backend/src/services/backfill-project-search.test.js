"use strict";

const { parseArgs } = require("../../scripts/backfill-project-search");

describe("backfill-project-search helpers", () => {
  it("parseArgs defaults batch size and dry-run flag", () => {
    expect(parseArgs([])).toEqual({ batch: 500, dryRun: false });
  });

  it("parseArgs reads batch and dry-run", () => {
    expect(parseArgs(["--batch=100", "--dry-run"])).toEqual({
      batch: 100,
      dryRun: true,
    });
  });
});
