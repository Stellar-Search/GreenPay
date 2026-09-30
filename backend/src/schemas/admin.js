/**
 * src/schemas/admin.js
 *
 * Declarative request/query schemas for admin actions.
 * Mirrors docs/openapi.yml `/api/admin/*` definitions.
 */
"use strict";

const { z } = require("zod");

const AdminLoginSchema = z.object({
  username: z.string().min(1, "username is required"),
  password: z.string().min(1, "password is required"),
});

const AdminRefreshSchema = z.object({
  refreshToken: z.string().min(1, "refreshToken is required"),
});

const AdminAuditQuerySchema = z
  .object({
    actor: z.string().optional(),
    action: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
    cursor: z.string().optional(),
    offset: z.coerce.number().int().min(0).max(10000).optional().default(0),
  })
  .strip();

module.exports = {
  AdminLoginSchema,
  AdminRefreshSchema,
  AdminAuditQuerySchema,
};
