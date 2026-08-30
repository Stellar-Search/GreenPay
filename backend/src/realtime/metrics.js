/**
 * src/realtime/metrics.js
 *
 * Per-pod counters for the live feed.
 *
 * This exists because of how the bug it accompanies stayed hidden: cross-pod
 * delivery was broken for months while every pod reported itself healthy, no
 * request errored and no test failed. Aggregate numbers cannot show that —
 * "300 clients connected" looks identical whether one pod holds all 300 or six
 * pods hold fifty each and only one of them ever receives a broadcast. So each
 * counter is reported per instance, and the instance id is part of the payload.
 *
 * `fanoutObserved` is the specific signal: it counts broadcasts this pod
 * received from the shared adapter but did not originate. On a healthy
 * multi-replica deployment it climbs on every pod. A pod with sockets connected
 * and `fanoutObserved` pinned at zero while other pods are emitting is the
 * failure mode, visible directly.
 */
"use strict";

const { INSTANCE_ID } = require("./eventLog");

const counters = {
  connectionsOpened: 0,
  connectionsClosed: 0,
  eventsPublished: 0,
  fanoutObserved: 0,
  publishFailures: 0,
  replayRequests: 0,
  replayResets: 0,
};

let currentConnections = 0;
let peakConnections = 0;

function connectionOpened() {
  counters.connectionsOpened += 1;
  currentConnections += 1;
  if (currentConnections > peakConnections) peakConnections = currentConnections;
}

function connectionClosed() {
  counters.connectionsClosed += 1;
  if (currentConnections > 0) currentConnections -= 1;
}

function eventPublished() {
  counters.eventsPublished += 1;
}

function publishFailed() {
  counters.publishFailures += 1;
}

function fanoutObserved() {
  counters.fanoutObserved += 1;
}

function replayRequested(wasReset) {
  counters.replayRequests += 1;
  if (wasReset) counters.replayResets += 1;
}

function snapshot() {
  return {
    instanceId: INSTANCE_ID,
    currentConnections,
    peakConnections,
    ...counters,
  };
}

/** Test seam: counters are process-global, so suites must be able to zero them. */
function reset() {
  for (const key of Object.keys(counters)) counters[key] = 0;
  currentConnections = 0;
  peakConnections = 0;
}

module.exports = {
  connectionOpened,
  connectionClosed,
  eventPublished,
  publishFailed,
  fanoutObserved,
  replayRequested,
  snapshot,
  reset,
};
