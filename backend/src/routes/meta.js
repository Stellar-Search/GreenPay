/**
 * src/routes/meta.js
 *
 * Lightweight, dependency-free service metadata endpoint. Useful for
 * operators and clients to detect the running version, environment and
 * Stellar network without hitting a mutating route.
 */
"use strict";

const express = require("express");
const router = express.Router();
const { name, version } = require("../../package.json");

router.get("/", (req, res) => {
  res.json({
    name,
    version,
    environment: process.env.NODE_ENV || "development",
    network: process.env.STELLAR_NETWORK || "testnet",
    node: process.version,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
