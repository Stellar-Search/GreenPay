"use strict";

const { metaV1ToV2 } = require("./metaV2");

test("v2 metadata adapter is deterministic and leaves its input untouched", () => {
  const v1 = Object.freeze({
    name: "service",
    version: "1.2.3",
    environment: "test",
    network: "testnet",
    node: "v20.0.0",
    uptimeSeconds: 12,
    timestamp: "2026-08-28T00:00:00.000Z",
  });

  expect(metaV1ToV2(v1)).toEqual({
    service: { name: "service", release: "1.2.3", environment: "test" },
    runtime: {
      node: "v20.0.0",
      network: "testnet",
      uptimeSeconds: 12,
      observedAt: "2026-08-28T00:00:00.000Z",
    },
    api: { version: "v2", status: "experimental" },
  });
});
