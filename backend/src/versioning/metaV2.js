/**
 * Worked v1-to-v2 representation adapter.
 *
 * Domain data still comes from routes/meta.js. Only its public representation
 * changes here, keeping the concurrent-version maintenance boundary visible.
 */
"use strict";

function metaV1ToV2(metadata) {
  return {
    service: {
      name: metadata.name,
      release: metadata.version,
      environment: metadata.environment,
    },
    runtime: {
      node: metadata.node,
      network: metadata.network,
      uptimeSeconds: metadata.uptimeSeconds,
      observedAt: metadata.timestamp,
    },
    api: {
      version: "v2",
      status: "experimental",
    },
  };
}

module.exports = { metaV1ToV2 };
