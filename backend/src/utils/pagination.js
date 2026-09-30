"use strict";

const { createApiError } = require("../middleware/apiEnvelope");

const CURSOR_VERSION = "v1";

/**
 * Encodes a sort key object into an opaque, versioned cursor string.
 * Format: v1.<base64url_json>
 *
 * @param {Record<string, any>} payload
 * @returns {string}
 */
function encodeCursor(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Cursor payload must be an object");
  }
  const jsonStr = JSON.stringify(payload);
  const base64 = Buffer.from(jsonStr, "utf8").toString("base64url");
  return `${CURSOR_VERSION}.${base64}`;
}

/**
 * Decodes an opaque cursor string into a sort key payload object.
 *
 * Supports:
 * - Versioned cursors: `v1.<base64url>`
 * - Legacy ISO date strings (v0 fallback for backward compatibility)
 *
 * @param {string} [cursorStr]
 * @returns {Record<string, any>|null}
 */
function decodeCursor(cursorStr) {
  if (!cursorStr || typeof cursorStr !== "string") {
    return null;
  }

  const trimmed = cursorStr.trim();
  if (!trimmed) {
    return null;
  }

  // Versioned cursor check (e.g. v1.xxxx)
  if (/^v\d+\./.test(trimmed)) {
    const dotIndex = trimmed.indexOf(".");
    const version = trimmed.substring(0, dotIndex);
    const encodedPayload = trimmed.substring(dotIndex + 1);

    if (version !== CURSOR_VERSION) {
      throw createApiError(
        400,
        "UNSUPPORTED_CURSOR_VERSION",
        `Unsupported cursor version '${version}'. Expected '${CURSOR_VERSION}'.`
      );
    }

    try {
      const jsonStr = Buffer.from(encodedPayload, "base64url").toString("utf8");
      const parsed = JSON.parse(jsonStr);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Decoded payload is not an object");
      }
      return parsed;
    } catch {
      throw createApiError(
        400,
        "INVALID_CURSOR",
        "Invalid or malformed pagination cursor"
      );
    }
  }

  // Check if it's a legacy ISO timestamp or numeric offset fallback
  const isoDate = new Date(trimmed);
  if (!isNaN(isoDate.getTime())) {
    return { createdAt: isoDate.toISOString(), v0: true };
  }

  throw createApiError(
    400,
    "INVALID_CURSOR",
    "Invalid or malformed pagination cursor format"
  );
}

/**
 * Formats a paginated query result and constructs response metadata.
 *
 * @param {object} options
 * @param {Array<object>} options.rows - The fetched rows (expected up to limit + 1)
 * @param {number} options.limit - Requested page limit
 * @param {function(object): Record<string, any>} options.getCursorPayload - Helper to extract cursor payload from a row
 * @param {number|null} [options.totalCount=null] - Total items if calculated (null if omitted)
 * @param {boolean} [options.isTotalExact=false] - Whether totalCount is exact
 * @returns {{ data: Array<object>, meta: object }}
 */
function formatPaginatedResponse({
  rows,
  limit,
  getCursorPayload,
  totalCount = null,
  isTotalExact = false,
}) {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor = null;
  if (hasMore && data.length > 0) {
    const lastRow = data[data.length - 1];
    const payload = getCursorPayload(lastRow);
    nextCursor = encodeCursor(payload);
  }

  const meta = {
    nextCursor,
    hasMore,
    pagination: {
      nextCursor,
      hasMore,
      limit,
      totalCount,
      isTotalExact,
    },
  };

  return { data, meta };
}

module.exports = {
  CURSOR_VERSION,
  encodeCursor,
  decodeCursor,
  formatPaginatedResponse,
};
