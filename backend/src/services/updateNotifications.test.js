"use strict";

jest.mock("../db/pool", () => ({ query: jest.fn() }));
jest.mock("./email", () => ({
  enqueueUpdateNotifications: jest.fn().mockResolvedValue(undefined),
  enqueueUpdateRemovalNotifications: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("./push", () => ({
  sendUpdatePushNotifications: jest.fn().mockResolvedValue(undefined),
  sendUpdateRemovalPushNotifications: jest.fn().mockResolvedValue(undefined),
}));

const pool = require("../db/pool");
const email = require("./email");
const push = require("./push");
const {
  dispatchPublicationNotifications,
  dispatchRemovalNotifications,
} = require("./updateNotifications");

const project = { id: "project-1", name: "Reef Cleanup" };
const update = { id: "update-1", title: "Field report", body: "Progress" };

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockReset();
});

it("retries only a publication channel that has not already accepted the event", async () => {
  pool.query.mockResolvedValueOnce({
    rows: [{ email_notified_at: "2026-08-28T10:00:00Z", push_notified_at: null }],
  });
  pool.query.mockResolvedValue({ rows: [] });

  await dispatchPublicationNotifications({ project, update });

  expect(email.enqueueUpdateNotifications).not.toHaveBeenCalled();
  expect(push.sendUpdatePushNotifications).toHaveBeenCalledWith({ project, update });
  expect(pool.query).toHaveBeenCalledWith(
    expect.stringContaining("push_notified_at = NOW()"),
    [update.id],
  );
  expect(pool.query).toHaveBeenCalledWith(
    expect.stringContaining("notified_at = COALESCE"),
    [update.id],
  );
});

it("persists a successful email handoff but leaves failed push eligible for retry", async () => {
  pool.query.mockResolvedValueOnce({
    rows: [{ email_notified_at: null, push_notified_at: null }],
  });
  pool.query.mockResolvedValue({ rows: [] });
  push.sendUpdatePushNotifications.mockRejectedValueOnce(new Error("push queue unavailable"));

  await expect(dispatchPublicationNotifications({ project, update }))
    .rejects.toThrow("push queue unavailable");

  expect(email.enqueueUpdateNotifications).toHaveBeenCalledTimes(1);
  expect(pool.query).toHaveBeenCalledWith(
    expect.stringContaining("email_notified_at = NOW()"),
    [update.id],
  );
  expect(pool.query).not.toHaveBeenCalledWith(
    expect.stringContaining("push_notified_at = NOW()"),
    expect.anything(),
  );
  expect(pool.query).not.toHaveBeenCalledWith(
    expect.stringContaining("notified_at = COALESCE"),
    expect.anything(),
  );
});

it("sends removal follow-up only through channels that carried the update", async () => {
  pool.query.mockResolvedValueOnce({
    rows: [{
      email_notified_at: "2026-08-28T10:00:00Z",
      push_notified_at: null,
      removal_email_notified_at: null,
      removal_push_notified_at: null,
    }],
  });
  pool.query.mockResolvedValue({ rows: [] });

  await dispatchRemovalNotifications({ project, update, reason: "Unsupported claim" });

  expect(email.enqueueUpdateRemovalNotifications).toHaveBeenCalledWith({
    project,
    update,
    reason: "Unsupported claim",
  });
  expect(push.sendUpdateRemovalPushNotifications).not.toHaveBeenCalled();
  expect(pool.query).toHaveBeenCalledWith(
    expect.stringContaining("removal_email_notified_at = NOW()"),
    [update.id],
  );
});

it("does not duplicate a removal follow-up that was already queued", async () => {
  pool.query.mockResolvedValueOnce({
    rows: [{
      email_notified_at: "2026-08-28T10:00:00Z",
      push_notified_at: "2026-08-28T10:00:00Z",
      removal_email_notified_at: "2026-08-28T10:05:00Z",
      removal_push_notified_at: "2026-08-28T10:05:00Z",
    }],
  });

  await dispatchRemovalNotifications({ project, update, reason: "Unsupported claim" });

  expect(email.enqueueUpdateRemovalNotifications).not.toHaveBeenCalled();
  expect(push.sendUpdateRemovalPushNotifications).not.toHaveBeenCalled();
  expect(pool.query).toHaveBeenCalledTimes(1);
});
