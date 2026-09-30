"use strict";

/**
 * Real-Postgres proof that project search ranking, facets, stemming, and latency
 * behave correctly — unit tests with a mocked pool cannot exercise GIN indexes.
 *
 * Requires Postgres (e.g. docker compose up postgres). Skipped when unreachable.
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { execFileSync } = require("child_process");
const { v4: uuid, v5: uuidv5 } = require("uuid");

const FIXTURE_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function fixtureId(key) {
  return uuidv5(key, FIXTURE_NAMESPACE);
}

const pool = require("../db/pool");
const { apiEnvelope, errorHandler } = require("../middleware/apiEnvelope");
const { searchProjects } = require("../services/projectSearch");
const { DEFAULT_RANKING, SEARCH_LATENCY_BUDGET_MS } = require("../config/searchRanking");
const { evaluateRanking } = require("../services/projectSearchEval");

jest.setTimeout(120000);

const SCHEMA_PATH = path.join(__dirname, "..", "db", "schema.sql");
const CONNECTIVITY_TIMEOUT_MS = 5000;
const DEFAULT_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/greenpay";

function checkDbAvailableSync() {
  const databaseUrl = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
  const probeScript = `
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: ${JSON.stringify(databaseUrl)}, connectionTimeoutMillis: ${CONNECTIVITY_TIMEOUT_MS} });
    pool.query("SELECT 1")
      .then(() => { pool.end(); process.exit(0); })
      .catch(() => { process.exit(1); });
  `;
  try {
    execFileSync(process.execPath, ["-e", probeScript], {
      stdio: "ignore",
      timeout: CONNECTIVITY_TIMEOUT_MS + 2000,
      cwd: path.join(__dirname, ".."),
    });
    return true;
  } catch {
    return false;
  }
}

const dbAvailable = checkDbAvailableSync();
const maybeTest = dbAvailable ? test : test.skip;

if (!dbAvailable) {
  // eslint-disable-next-line no-console
  console.warn(
    `[projectSearch.integration.test] Skipping — no reachable Postgres at ${
      process.env.DATABASE_URL || DEFAULT_DATABASE_URL
    }.`,
  );
}

const FIXTURES = [
  {
    key: "reforest-delta",
    name: "Delta Reforestation Initiative",
    description: "Large-scale reforestation restoring native mangroves across the delta.",
    category: "Reforestation",
    location: "Mississippi Delta",
    tags: ["reforestation", "trees"],
    verified: true,
    goal_xlm: "1000000",
    raised_xlm: "250000",
    donor_count: 120,
  },
  {
    key: "general-green",
    name: "General Green Fund",
    description: "Supports many causes; mentions reforestation once in a footnote.",
    category: "Other",
    location: "Global",
    tags: ["general"],
    verified: false,
    goal_xlm: "500000",
    raised_xlm: "10000",
    donor_count: 3,
  },
  {
    key: "solar-farm",
    name: "Community Solar Farm",
    description: "Solar panels powering rural clinics with clean energy.",
    category: "Solar Energy",
    location: "Arizona",
    tags: ["solar", "energy"],
    verified: true,
    goal_xlm: "800000",
    raised_xlm: "600000",
    donor_count: 85,
  },
  {
    key: "amazon-canopy",
    name: "Amazon Canopy Guardians",
    description: "Protecting rainforest canopy in the Amazon basin.",
    category: "Reforestation",
    location: "Amazon Basin",
    tags: ["amazon", "rainforest"],
    verified: true,
    goal_xlm: "2000000",
    raised_xlm: "400000",
    donor_count: 200,
  },
  {
    key: "clean-water-verified",
    name: "Clean Water Wells",
    description: "Clean water access for rural communities.",
    category: "Clean Water",
    location: "East Africa",
    tags: ["water"],
    verified: true,
    goal_xlm: "300000",
    raised_xlm: "50000",
    donor_count: 40,
  },
  {
    key: "clean-water-unverified",
    name: "Water Relief Pilot",
    description: "Pilot clean water program seeking verification.",
    category: "Clean Water",
    location: "East Africa",
    tags: ["water"],
    verified: false,
    goal_xlm: "100000",
    raised_xlm: "5000",
    donor_count: 2,
  },
];

async function applySchema() {
  const sql = fs.readFileSync(SCHEMA_PATH, "utf8");
  await pool.query(sql);
}

async function seedFixtures() {
  for (const fx of FIXTURES) {
    const id = fixtureId(fx.key);
    await pool.query(
      `INSERT INTO projects (
        id, name, description, category, location, wallet_address,
        goal_xlm, raised_xlm, donor_count, co2_offset_kg, status, verified,
        on_chain_verified, tags
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, 0, 'active', $10,
        false, $11
      ) ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        category = EXCLUDED.category,
        location = EXCLUDED.location,
        goal_xlm = EXCLUDED.goal_xlm,
        raised_xlm = EXCLUDED.raised_xlm,
        donor_count = EXCLUDED.donor_count,
        verified = EXCLUDED.verified,
        tags = EXCLUDED.tags`,
      [
        id,
        fx.name,
        fx.description,
        fx.category,
        fx.location,
        `G${fx.key.padEnd(55, "X")}`.slice(0, 56),
        fx.goal_xlm,
        fx.raised_xlm,
        fx.donor_count,
        fx.verified,
        fx.tags,
      ],
    );
  }
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use("/api/projects", require("../routes/projects"));
  app.use(errorHandler);
  return app;
}

describe("project search integration", () => {
  beforeAll(async () => {
    if (!dbAvailable) return;
    await applySchema();
    await seedFixtures();
  });

  maybeTest("ranks reforestation-focused project above passing mention", async () => {
    const { rows } = await searchProjects(pool, { search: "reforestation", limit: 10 }, DEFAULT_RANKING);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0].id).toBe(fixtureId("reforest-delta"));
  });

  maybeTest("english stemming matches planting/plant queries on description", async () => {
    await pool.query(
      `INSERT INTO projects (
        id, name, description, category, location, wallet_address,
        goal_xlm, raised_xlm, donor_count, status, verified, tags
      ) VALUES (
        $1, 'Tree Planting Co-op', 'Community tree planting across hillsides.',
        'Reforestation', 'Oregon', 'GPLANTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        100000, 0, 0, 'active', true, ARRAY['planting']
      ) ON CONFLICT (id) DO UPDATE SET description = EXCLUDED.description`,
      [uuid()],
    );
    const { rows } = await searchProjects(pool, { search: "plant", limit: 5 }, DEFAULT_RANKING);
    expect(rows.some((r) => r.name.includes("Planting"))).toBe(true);
  });

  maybeTest("trigram typo tolerance surfaces reforestation project", async () => {
    const { rows } = await searchProjects(pool, { search: "reforstation", limit: 5 }, DEFAULT_RANKING);
    expect(rows.some((r) => r.id === fixtureId("reforest-delta"))).toBe(true);
  });

  maybeTest("facets reflect the same visibility filter as results", async () => {
    const { meta } = await searchProjects(
      pool,
      { search: "water", verified: "true", limit: 10 },
      DEFAULT_RANKING,
    );
    expect(meta.total).toBeGreaterThanOrEqual(1);
    expect(meta.facets.verified.true).toBe(meta.total);
    expect(meta.facets.category["Clean Water"]).toBeGreaterThanOrEqual(1);
  });

  maybeTest("API route returns meta envelope with facets", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/projects").query({ search: "solar", limit: 5 }).expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.meta.total).toBeGreaterThanOrEqual(1);
    expect(res.body.meta.facets.category).toBeDefined();
    expect(res.body.meta.latencyMs).toBeLessThan(SEARCH_LATENCY_BUDGET_MS);
  });

  maybeTest("search latency stays within budget at 1000 projects", async () => {
    const bulk = [];
    for (let i = 0; i < 1000; i += 1) {
      bulk.push([
        uuid(),
        `Bulk Project ${i}`,
        `Bulk filler project number ${i} about conservation.`,
        "Other",
        `Region-${i % 50}`,
        `GBULK${String(i).padStart(50, "0")}`.slice(0, 56),
        1000,
        i % 100,
        i % 10,
        "active",
        i % 3 === 0,
        ["bulk"],
      ]);
    }
    try {
      for (const row of bulk) {
        // eslint-disable-next-line no-await-in-loop
        await pool.query(
          `INSERT INTO projects (
          id, name, description, category, location, wallet_address,
          goal_xlm, raised_xlm, donor_count, status, verified, tags
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (id) DO NOTHING`,
          row,
        );
      }

      const { meta } = await searchProjects(pool, { search: "conservation", limit: 20 }, DEFAULT_RANKING);
      expect(meta.latencyMs).toBeLessThan(SEARCH_LATENCY_BUDGET_MS);
    } finally {
      await pool.query("DELETE FROM projects WHERE tags @> ARRAY['bulk']::text[]");
    }
  });

  maybeTest("evaluation harness scores labelled queries against live search", async () => {
    const keyById = Object.fromEntries(FIXTURES.map((f) => [fixtureId(f.key), f.key]));
    const report = await evaluateRanking(async (query) => {
      const { rows } = await searchProjects(pool, { search: query, limit: 10 }, DEFAULT_RANKING);
      return rows.map((r) => ({ id: keyById[r.id] || r.id }));
    }, { minNdcg: 0.4 });

    expect(report.meanNdcg).toBeGreaterThanOrEqual(0.4);
    expect(report.cases.find((c) => c.id === "reforestation-primary")?.pass).toBe(true);
  });
});
