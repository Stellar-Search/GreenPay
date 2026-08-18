"use strict";

const { Pool } = require("pg");

const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/greenpay";

const useSsl =
  process.env.DATABASE_SSL === "true" ||
  (process.env.NODE_ENV === "production" &&
    process.env.DATABASE_SSL !== "false" &&
    !DATABASE_URL.includes("localhost") &&
    !DATABASE_URL.includes("postgres:5432") &&
    !DATABASE_URL.includes("@postgres"));

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

pool.on("error", (err) => {
  console.error("[Postgres] Unexpected client error:", err.message);
});

module.exports = pool;
