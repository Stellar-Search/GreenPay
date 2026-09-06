/**
 * src/middleware/correlationId.test.js
 */
"use strict";

const { randomUUID: uuid } = require("crypto");
const {
  correlationIdMiddleware,
  sanitiseCorrelationId,
  MAX_CORRELATION_ID_LENGTH,
} = require("./correlationId");
const { getCorrelationId } = require("../utils/logger");

// ── sanitiseCorrelationId ─────────────────────────────────────────────────────

describe("sanitiseCorrelationId", () => {
  test("returns null for undefined / null / empty inputs", () => {
    expect(sanitiseCorrelationId(undefined)).toBeNull();
    expect(sanitiseCorrelationId(null)).toBeNull();
    expect(sanitiseCorrelationId("")).toBeNull();
    expect(sanitiseCorrelationId("   ")).toBeNull();
  });

  test("trims surrounding whitespace from a valid header", () => {
    expect(sanitiseCorrelationId("  abc-123  ")).toBe("abc-123");
  });

  test("returns null when length exceeds MAX_CORRELATION_ID_LENGTH", () => {
    const tooLong = "a".repeat(MAX_CORRELATION_ID_LENGTH + 1);
    expect(sanitiseCorrelationId(tooLong)).toBeNull();
  });

  test("accepts a value exactly at MAX_CORRELATION_ID_LENGTH", () => {
    const borderline = "a".repeat(MAX_CORRELATION_ID_LENGTH);
    expect(sanitiseCorrelationId(borderline)).toBe(borderline);
  });

  test("returns null for values containing newlines (log-injection guard)", () => {
    expect(sanitiseCorrelationId("id\nmalicious")).toBeNull();
    expect(sanitiseCorrelationId("id\rmalicious")).toBeNull();
  });

  test("returns null for values containing NUL bytes", () => {
    expect(sanitiseCorrelationId("id\x00evil")).toBeNull();
  });

  test("takes the first element when given an array", () => {
    expect(sanitiseCorrelationId(["first", "second"])).toBe("first");
  });

  test("returns null when array element itself is invalid", () => {
    expect(sanitiseCorrelationId(["id\ninjected", "ok"])).toBeNull();
  });

  test("accepts a standard UUID v4", () => {
    const id = uuid();
    expect(sanitiseCorrelationId(id)).toBe(id);
  });
});

// ── correlationIdMiddleware ───────────────────────────────────────────────────

/**
 * Build a minimal Express-like mock.
 */
function makeReqRes(headerValue) {
  const req = {
    headers: headerValue !== undefined ? { "x-correlation-id": headerValue } : {},
    correlationId: undefined,
  };
  const responseHeaders = {};
  const res = {
    setHeader: (name, value) => { responseHeaders[name] = value; },
    headers: responseHeaders,
  };
  return { req, res };
}

describe("correlationIdMiddleware", () => {
  test("adopts the X-Correlation-ID header when present and valid", (done) => {
    const { req, res } = makeReqRes("client-generated-id-001");

    correlationIdMiddleware(req, res, () => {
      expect(req.correlationId).toBe("client-generated-id-001");
      expect(res.headers["X-Correlation-ID"]).toBe("client-generated-id-001");
      done();
    });
  });

  test("generates a UUID when X-Correlation-ID header is absent", (done) => {
    const { req, res } = makeReqRes(undefined);

    correlationIdMiddleware(req, res, () => {
      expect(typeof req.correlationId).toBe("string");
      expect(req.correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
      expect(res.headers["X-Correlation-ID"]).toBe(req.correlationId);
      done();
    });
  });

  test("generates a fresh UUID when the header value is invalid (too long)", (done) => {
    const { req, res } = makeReqRes("x".repeat(MAX_CORRELATION_ID_LENGTH + 1));

    correlationIdMiddleware(req, res, () => {
      // Must be a generated UUID, not the oversized header value.
      expect(req.correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
      done();
    });
  });

  test("makes correlationId visible via getCorrelationId() inside next()", (done) => {
    const { req, res } = makeReqRes("als-propagation-test");

    correlationIdMiddleware(req, res, () => {
      // getCorrelationId reads from AsyncLocalStorage — must match req.correlationId.
      expect(getCorrelationId()).toBe("als-propagation-test");
      done();
    });
  });

  test("correlation id is not visible outside the middleware call boundary", () => {
    // Outside any ALS context the store is empty.
    expect(getCorrelationId()).toBeUndefined();
  });

  test("echoes the id in the X-Correlation-ID response header", (done) => {
    const { req, res } = makeReqRes("echo-me-456");

    correlationIdMiddleware(req, res, () => {
      expect(res.headers["X-Correlation-ID"]).toBe("echo-me-456");
      done();
    });
  });
});
