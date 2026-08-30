"use strict";

const pool = require("../db/pool");
const {
  enqueueUpdateNotifications,
  enqueueUpdateRemovalNotifications,
} = require("./email");
const {
  sendUpdatePushNotifications,
  sendUpdateRemovalPushNotifications,
} = require("./push");

/**
 * Queue each publication channel independently and persist each successful
 * handoff. A retry therefore only queues a channel that has not accepted the
 * event yet, avoiding duplicate email when push temporarily fails (and vice
 * versa).
 */
async function dispatchPublicationNotifications({ project, update }) {
  const stateResult = await pool.query(
    `SELECT email_notified_at, push_notified_at
     FROM project_updates WHERE id = $1`,
    [update.id],
  );
  const state = stateResult.rows[0];
  if (!state) return;

  let emailNotified = Boolean(state.email_notified_at);
  let pushNotified = Boolean(state.push_notified_at);

  if (!emailNotified) {
    await enqueueUpdateNotifications({ project, update });
    await pool.query(
      "UPDATE project_updates SET email_notified_at = NOW() WHERE id = $1 AND email_notified_at IS NULL",
      [update.id],
    );
    emailNotified = true;
  }

  if (!pushNotified) {
    await sendUpdatePushNotifications({ project, update });
    await pool.query(
      "UPDATE project_updates SET push_notified_at = NOW() WHERE id = $1 AND push_notified_at IS NULL",
      [update.id],
    );
    pushNotified = true;
  }

  if (emailNotified && pushNotified) {
    await pool.query(
      "UPDATE project_updates SET notified_at = COALESCE(notified_at, NOW()) WHERE id = $1",
      [update.id],
    );
  }
}

/**
 * Notify only channels that previously carried the update. The removed body
 * is deliberately omitted by the channel templates; recipients get the title,
 * moderation reason, and a link to current project information.
 */
async function dispatchRemovalNotifications({ project, update, reason }) {
  const stateResult = await pool.query(
    `SELECT email_notified_at, push_notified_at,
            removal_email_notified_at, removal_push_notified_at
     FROM project_updates WHERE id = $1`,
    [update.id],
  );
  const state = stateResult.rows[0];
  if (!state) return;

  if (state.email_notified_at && !state.removal_email_notified_at) {
    await enqueueUpdateRemovalNotifications({ project, update, reason });
    await pool.query(
      `UPDATE project_updates SET removal_email_notified_at = NOW()
       WHERE id = $1 AND removal_email_notified_at IS NULL`,
      [update.id],
    );
  }

  if (state.push_notified_at && !state.removal_push_notified_at) {
    await sendUpdateRemovalPushNotifications({ project, update, reason });
    await pool.query(
      `UPDATE project_updates SET removal_push_notified_at = NOW()
       WHERE id = $1 AND removal_push_notified_at IS NULL`,
      [update.id],
    );
  }
}

module.exports = {
  dispatchPublicationNotifications,
  dispatchRemovalNotifications,
};
