"use strict";

const { Pool } = require("pg");
const { env } = require("../config/env");

const useSsl =
  env.databaseSsl === "true" ||
  (env.isProduction &&
    env.databaseSsl !== "false" &&
    !env.databaseUrl.includes("localhost") &&
    !env.databaseUrl.includes("postgres:5432") &&
    !env.databaseUrl.includes("@postgres"));

const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

pool.on("error", (err) => {
  console.error("[Postgres] Unexpected client error:", err.message);
});

module.exports = pool;
