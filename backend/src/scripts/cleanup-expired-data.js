#!/usr/bin/env node
/**
 * src/scripts/cleanup-expired-data.js
 *
 * Automated data-retention cleanup script implementing the policies
 * documented in docs/data-retention-policy.md.
 *
 * This script performs three cleanup tasks:
 *   1. Prune stale device tokens (not seen in 90 days)
 *   2. Redact IP addresses in admin_audit_log (older than 365 days)
 *   3. Delete old admin_audit_log entries (older than 2 years)
 *
 * Usage:
 *   node cleanup-expired-data.js [--dry-run]
 *
 * The --dry-run flag prints what would be deleted/redacted without
 * modifying the database.
 */
"use strict";

const pool = require("../db/pool");

const DEVICE_TOKEN_MAX_AGE_DAYS = 90;
const AUDIT_LOG_IP_REDACT_AGE_DAYS = 365;
const AUDIT_LOG_DELETE_AGE_DAYS = 730; // 2 years

async function pruneStaleDeviceTokens(client, { dryRun } = {}) {
  const result = await client.query(
    `DELETE FROM device_tokens
     WHERE last_seen_at < NOW() - INTERVAL '1 day' * $1
     RETURNING id, token, wallet_address, last_seen_at`,
    [DEVICE_TOKEN_MAX_AGE_DAYS],
  );

  const deleted = result.rowCount;
  if (dryRun && deleted > 0) {
    console.log(`[Dry Run] Would prune ${deleted} stale device token(s)`);
  } else if (deleted > 0) {
    console.log(`[Cleanup] Pruned ${deleted} stale device token(s)`);
  } else {
    console.log("[Cleanup] No stale device tokens to prune");
  }

  return deleted;
}

async function redactAuditLogIpAddresses(client, { dryRun } = {}) {
  const query = dryRun
    ? `SELECT COUNT(*) AS cnt FROM admin_audit_log
       WHERE ip_address IS NOT NULL
         AND ip_address != 'REDACTED'
         AND created_at < NOW() - INTERVAL '1 day' * $1`
    : `UPDATE admin_audit_log
       SET ip_address = 'REDACTED'
       WHERE ip_address IS NOT NULL
         AND ip_address != 'REDACTED'
         AND created_at < NOW() - INTERVAL '1 day' * $1`;

  const result = await client.query(query, [AUDIT_LOG_IP_REDACT_AGE_DAYS]);

  const count = dryRun ? parseInt(result.rows[0].cnt, 10) : result.rowCount;
  if (dryRun && count > 0) {
    console.log(`[Dry Run] Would redact IP addresses in ${count} audit log entry/entries`);
  } else if (count > 0) {
    console.log(`[Cleanup] Redacted IP addresses in ${count} audit log entry/entries`);
  } else {
    console.log("[Cleanup] No audit log IP addresses to redact");
  }

  return count;
}

async function deleteOldAuditLogEntries(client, { dryRun } = {}) {
  const result = await client.query(
    `DELETE FROM admin_audit_log
     WHERE created_at < NOW() - INTERVAL '1 day' * $1
     RETURNING id`,
    [AUDIT_LOG_DELETE_AGE_DAYS],
  );

  const deleted = result.rowCount;
  if (dryRun && deleted > 0) {
    console.log(`[Dry Run] Would delete ${deleted} old audit log entry/entries`);
  } else if (deleted > 0) {
    console.log(`[Cleanup] Deleted ${deleted} old audit log entry/entries`);
  } else {
    console.log("[Cleanup] No old audit log entries to delete");
  }

  return deleted;
}

async function runCleanup({ dryRun = false } = {}) {
  const client = await pool.connect();
  const results = { deviceTokensPruned: 0, auditIpsRedacted: 0, auditEntriesDeleted: 0 };

  try {
    if (dryRun) {
      console.log("[Dry Run] Running data-retention cleanup (no changes will be made)\n");
    } else {
      console.log("[Cleanup] Running data-retention cleanup\n");
    }

    results.deviceTokensPruned = await pruneStaleDeviceTokens(client, { dryRun });
    results.auditIpsRedacted = await redactAuditLogIpAddresses(client, { dryRun });
    results.auditEntriesDeleted = await deleteOldAuditLogEntries(client, { dryRun });

    console.log("\n[Cleanup] Summary:");
    console.log(`  Device tokens pruned:     ${results.deviceTokensPruned}`);
    console.log(`  Audit log IPs redacted:   ${results.auditIpsRedacted}`);
    console.log(`  Audit log entries deleted: ${results.auditEntriesDeleted}`);
  } catch (err) {
    console.error("[Cleanup] Error during data-retention cleanup:", err.message);
    throw err;
  } finally {
    client.release();
  }

  return results;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  try {
    await runCleanup({ dryRun });
    process.exitCode = 0;
  } catch {
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  pruneStaleDeviceTokens,
  redactAuditLogIpAddresses,
  deleteOldAuditLogEntries,
  runCleanup,
  DEVICE_TOKEN_MAX_AGE_DAYS,
  AUDIT_LOG_IP_REDACT_AGE_DAYS,
  AUDIT_LOG_DELETE_AGE_DAYS,
};
