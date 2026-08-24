/**
 * src/routes/network.js
 * GET /api/network/graph — aggregates the on-chain transaction graph (wallet
 * addresses as nodes, donations + escrow releases as edges) for the WebGL
 * network visualizer.
 */
"use strict";
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");

const MAX_EDGES = 50000;

// GET /api/network/graph?limit=50000
router.get("/graph", async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || MAX_EDGES, MAX_EDGES);

    const [donationEdges, escrowEdges] = await Promise.all([
      pool.query(
        `SELECT d.donor_address AS source, p.wallet_address AS target,
                d.amount AS amount, d.transaction_hash AS "txHash",
                'donation' AS type, d.created_at AS "createdAt"
         FROM donations d
         JOIN projects p ON p.id = d.project_id
         WHERE d.status = 'committed'
         ORDER BY d.created_at DESC
         LIMIT $1`,
        [limit],
      ),
      pool.query(
        `SELECT client_public_key AS source, freelancer_public_key AS target,
                amount_escrow_xlm AS amount, release_transaction_hash AS "txHash",
                'escrow' AS type, updated_at AS "createdAt"
         FROM jobs
         WHERE status = 'completed' AND release_transaction_hash IS NOT NULL
         ORDER BY updated_at DESC
         LIMIT $1`,
        [limit],
      ),
    ]);

    const edges = [...donationEdges.rows, ...escrowEdges.rows].slice(0, limit);

    const nodes = new Map();
    const touchNode = (address) => {
      if (!nodes.has(address)) {
        nodes.set(address, { id: address, totalIn: 0, totalOut: 0, degree: 0 });
      }
      return nodes.get(address);
    };

    for (const edge of edges) {
      const amount = parseFloat(edge.amount) || 0;
      const source = touchNode(edge.source);
      const target = touchNode(edge.target);
      source.totalOut += amount;
      source.degree += 1;
      target.totalIn += amount;
      target.degree += 1;
    }

    res.json({
      nodes: Array.from(nodes.values()),
      edges: edges.map((e) => ({
        source: e.source,
        target: e.target,
        amount: parseFloat(e.amount) || 0,
        type: e.type,
        txHash: e.txHash,
      })),
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
