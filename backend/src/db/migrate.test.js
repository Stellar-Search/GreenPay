"use strict";

/**
 * Demo seed data must never reach a production database: the seeded projects
 * are donatable in the UI but their wallet addresses belong to nobody.
 */

jest.mock("./pool", () => ({ connect: jest.fn() }));

const { shouldSeedDemoData } = require("./migrate");
const { seedProjects } = require("../services/store");
const { StrKey } = require("@stellar/stellar-sdk");

describe("shouldSeedDemoData", () => {
  const saved = { node: process.env.NODE_ENV, seed: process.env.SEED_DEMO_DATA };

  afterEach(() => {
    process.env.NODE_ENV = saved.node;
    if (saved.seed === undefined) delete process.env.SEED_DEMO_DATA;
    else process.env.SEED_DEMO_DATA = saved.seed;
  });

  it("does not seed in production by default", () => {
    process.env.NODE_ENV = "production";
    delete process.env.SEED_DEMO_DATA;
    expect(shouldSeedDemoData()).toBe(false);
  });

  it("seeds outside production by default", () => {
    delete process.env.SEED_DEMO_DATA;
    for (const env of ["development", "test", undefined]) {
      if (env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = env;
      expect(shouldSeedDemoData()).toBe(true);
    }
  });

  it("honours an explicit SEED_DEMO_DATA in either direction", () => {
    process.env.NODE_ENV = "production";
    for (const v of ["true", "1"]) {
      process.env.SEED_DEMO_DATA = v;
      expect(shouldSeedDemoData()).toBe(true);
    }
    process.env.NODE_ENV = "development";
    for (const v of ["false", "0"]) {
      process.env.SEED_DEMO_DATA = v;
      expect(shouldSeedDemoData()).toBe(false);
    }
  });
});

describe("demo seed data", () => {
  it("uses wallet addresses that pass StrKey validation", () => {
    // Three of these were previously invalid — one 56-character string with a
    // bad checksum and two only 55 characters long — so a donation to those
    // demo projects could never have settled.
    expect(seedProjects.length).toBeGreaterThan(0);
    for (const project of seedProjects) {
      expect(StrKey.isValidEd25519PublicKey(project.walletAddress)).toBe(true);
    }
  });

  it("gives every demo project a distinct wallet address", () => {
    const addresses = seedProjects.map((p) => p.walletAddress);
    expect(new Set(addresses).size).toBe(addresses.length);
  });
});
