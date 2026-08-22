/**
 * src/middleware/validate.js
 *
 * Central request-validation helpers built on Zod.
 *
 * Two ways to use it:
 *   1. `validate(schema, { source })` — Express middleware that validates
 *      req.body / req.query / req.params against a schema and short-circuits
 *      with 400 on failure. This is the preferred pattern for new routes.
 *   2. `validateBody(schema, value)` — parse a raw value inside a handler
 *      (used by handlers that are unit-tested in isolation) and throw a
 *      `ValidationError` (status 400) on failure.
 *
 * Rejections flow through the shared API error middleware so clients receive
 * one stable error envelope.
 */
"use strict";

const { ZodError } = require("zod");
const { createApiError } = require("./apiEnvelope");

class ValidationError extends Error {
  constructor(message, issues) {
    super(message);
    this.name = "ValidationError";
    this.status = 400;
    this.code = "VALIDATION_FAILED";
    this.issues = issues;
    this.details = { issues };
  }
}

function firstIssueMessage(error) {
  const issue = error.issues && error.issues[0];
  return issue ? issue.message : "Invalid request";
}

/**
 * Parse `value` with `schema`. Throws a ValidationError (status 400) on
 * failure so callers can `catch (e) { next(e); }` like any other error.
 */
function validateBody(schema, value) {
  try {
    return schema.parse(value);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new ValidationError(firstIssueMessage(err), err.issues);
    }
    throw err;
  }
}

/**
 * Express middleware factory. Validates `req[source]` (default "body") and
 * replaces it with the (stripped/coerced) parsed value so downstream
 * handlers always see validated, normalized data.
 */
function validate(schema, { source = "body", stripUnknown = true } = {}) {
  return (req, res, next) => {
    try {
      const parsed = schema.parse(req[source]);
      if (stripUnknown) {
        req[source] = parsed;
      }
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        return next(createApiError(400, "VALIDATION_FAILED", firstIssueMessage(err), { issues: err.issues }));
      }
      next(err);
    }
  };
}

module.exports = { ValidationError, validateBody, validate };
