"use strict";

/**
 * backend/src/db/pool.js
 *
 * PostgreSQL connection pool with zero-downtime credential rotation support.
 *
 * During a credential rotation window, Postgres may accept either the new
 * password or the previous password (overlap window). If a connection attempt
 * to the primary DATABASE_URL fails with an authentication error (code 28P01 / 28000),
 * this pool automatically retries using DATABASE_URL_PREVIOUS if configured.
 */

const { Pool } = require("pg");
const { env } = require("../config/env");

function isSslRequired(connectionString) {
  if (!connectionString) return false;
  return (
    env.databaseSsl === "true" ||
    (env.isProduction &&
      env.databaseSsl !== "false" &&
      !connectionString.includes("localhost") &&
      !connectionString.includes("postgres:5432") &&
      !connectionString.includes("@postgres"))
  );
}

function getPreviousUrl() {
  if (env.databaseUrlPrevious) {
    return env.databaseUrlPrevious;
  }
  if (env.postgresPasswordPrevious && env.databaseUrl) {
    try {
      const parsed = new URL(env.databaseUrl);
      parsed.password = env.postgresPasswordPrevious;
      return parsed.toString();
    } catch {
      return null;
    }
  }
  return null;
}

class RotatablePool {
  constructor(primaryUrl, fallbackUrl) {
    this.primaryUrl = primaryUrl;
    this.fallbackUrl = fallbackUrl;
    
    this.primaryPool = this._createPool(this.primaryUrl);
    this.fallbackPool = this.fallbackUrl ? this._createPool(this.fallbackUrl) : null;
    
    this.activePoolName = "primary";
  }

  _createPool(url) {
    const p = new Pool({
      connectionString: url,
      ssl: isSslRequired(url) ? { rejectUnauthorized: false } : false,
    });
    p.on("error", (err) => {
      if (err.code !== "28P01" && err.code !== "28000") {
        console.error("[Postgres] Unexpected client error:", err.message);
      }
    });
    return p;
  }

  isAuthError(err) {
    if (!err) return false;
    return (
      err.code === "28P01" ||
      err.code === "28000" ||
      (err.message && err.message.includes("password authentication failed"))
    );
  }

  async query(...args) {
    try {
      return await this.primaryPool.query(...args);
    } catch (err) {
      if (this.isAuthError(err) && this.fallbackPool) {
        console.warn("[Postgres] Primary authentication failed during rotation; falling back to previous credential pool");
        this.activePoolName = "fallback";
        return await this.fallbackPool.query(...args);
      }
      throw err;
    }
  }

  async connect(...args) {
    try {
      return await this.primaryPool.connect(...args);
    } catch (err) {
      if (this.isAuthError(err) && this.fallbackPool) {
        console.warn("[Postgres] Primary authentication failed during connection; falling back to previous credential pool");
        this.activePoolName = "fallback";
        return await this.fallbackPool.connect(...args);
      }
      throw err;
    }
  }

  on(event, listener) {
    this.primaryPool.on(event, listener);
    if (this.fallbackPool) {
      this.fallbackPool.on(event, listener);
    }
  }

  async end() {
    await this.primaryPool.end();
    if (this.fallbackPool) {
      await this.fallbackPool.end();
    }
  }

  // Update credentials at runtime without restarting process
  updateCredentials(newPrimaryUrl, newFallbackUrl = null) {
    if (this.primaryPool && typeof this.primaryPool.end === "function") {
      Promise.resolve(this.primaryPool.end()).catch(() => {});
    }
    if (this.fallbackPool && typeof this.fallbackPool.end === "function") {
      Promise.resolve(this.fallbackPool.end()).catch(() => {});
    }
    this.primaryUrl = newPrimaryUrl;
    this.fallbackUrl = newFallbackUrl;
    this.primaryPool = this._createPool(this.primaryUrl);
    this.fallbackPool = this.fallbackUrl ? this._createPool(this.fallbackUrl) : null;
    this.activePoolName = "primary";
  }
}

const primaryUrl = env.databaseUrl;
const fallbackUrl = getPreviousUrl();
const pool = new RotatablePool(primaryUrl, fallbackUrl);

module.exports = pool;
