/**
 * src/services/onboarding/maintenance.js
 *
 * The two background sweeps the onboarding paths depend on.
 *
 * Both exist because a donor walking away is normal, not exceptional. A
 * sponsorship offer that is never co-signed holds treasury capacity, and an
 * onboarding session left open forever counts as "still deciding" and quietly
 * inflates the conversion rate the whole feature is judged on. Neither is a
 * failure to alert on; both just need collecting.
 *
 * The timers are unref'd so a test process, a migration run, or a CLI script
 * that happens to load the server module is never held open by them.
 */
"use strict";

const pool = require("../../db/pool");
const { logger: rootLogger } = require("../../utils/logger");
const { sweepExpiredSponsorships } = require("./sponsoredAccounts");
const { sweepAbandonedSessions } = require("./funnel");

const logger = rootLogger.child({ service: "onboarding-maintenance" });

/** Half the signature window, so no offer holds capacity much past expiry. */
const SPONSORSHIP_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** Sessions are only interesting in aggregate, so hourly is plenty. */
const SESSION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let timers = [];

async function runSweeps(dbPool = pool) {
  const results = { sponsorships: 0, sessions: 0 };
  try {
    results.sponsorships = await sweepExpiredSponsorships(dbPool);
  } catch (err) {
    // A failed sweep must not stop the other one, and must not crash the
    // process: the worst case is capacity held until the next tick.
    logger.error({ msg: "sponsorship sweep failed", error: err.message });
  }
  try {
    results.sessions = await sweepAbandonedSessions({}, dbPool);
  } catch (err) {
    logger.error({ msg: "session sweep failed", error: err.message });
  }
  return results;
}

function startOnboardingMaintenance({
  dbPool = pool,
  sponsorshipIntervalMs = SPONSORSHIP_SWEEP_INTERVAL_MS,
  sessionIntervalMs = SESSION_SWEEP_INTERVAL_MS,
} = {}) {
  stopOnboardingMaintenance();

  const sponsorshipTimer = setInterval(() => {
    sweepExpiredSponsorships(dbPool).catch((err) =>
      logger.error({ msg: "sponsorship sweep failed", error: err.message }),
    );
  }, sponsorshipIntervalMs);

  const sessionTimer = setInterval(() => {
    sweepAbandonedSessions({}, dbPool).catch((err) =>
      logger.error({ msg: "session sweep failed", error: err.message }),
    );
  }, sessionIntervalMs);

  timers = [sponsorshipTimer, sessionTimer];
  for (const timer of timers) {
    if (typeof timer.unref === "function") timer.unref();
  }

  logger.info({ msg: "onboarding maintenance started" });
  return timers;
}

function stopOnboardingMaintenance() {
  for (const timer of timers) clearInterval(timer);
  timers = [];
}

module.exports = {
  SPONSORSHIP_SWEEP_INTERVAL_MS,
  SESSION_SWEEP_INTERVAL_MS,
  runSweeps,
  startOnboardingMaintenance,
  stopOnboardingMaintenance,
};
