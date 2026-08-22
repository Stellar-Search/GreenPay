/**
 * src/schemas/projects.js
 *
 * Declarative request schemas for project mutating routes.
 * Mirrors docs/openapi.yml `/api/projects/{id}/status` (updateProjectStatus).
 */
"use strict";

const { z } = require("zod");
const { stellarPublicKey } = require("./common");

const VALID_STATUSES = ["active", "rejected", "paused"];

const ProjectStatusUpdateSchema = z.object({
  status: z.enum(VALID_STATUSES, { required_error: "status is required" }),
  reason: z.string().max(500).optional().nullable(),
  // Optional, and never used for authorization or attribution: the route
  // authenticates with a platform-admin JWT and audits the verified token
  // subject, because anything in the body is attacker-controlled. It is still
  // accepted (and format-checked when present) so existing clients that send
  // it are not rejected.
  adminAddress: stellarPublicKey.optional().nullable(),
});

module.exports = { ProjectStatusUpdateSchema, VALID_STATUSES };
