/**
 * src/utils/logger.test.js
 *
 * Unit tests for the structured logger.
 *
 * The most important test here is the REDACTION GUARD — the acceptance
 * criteria for issue #374 requires a test that asserts no log line can
 * contain a Stellar private key or a full signed transaction envelope.
 */
"use strict";

const {
  logger,
  runWithCorrelationId,
  getCorrelationId,
  redactValue,
  redactFields,
  REDACTED,
  MAX_FIELD_BYTES,
} = require("./logger");

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Capture a single log emission from the logger.
 * Intercepts process.stdout.write and process.stderr.write for one call.
 *
 * @param {function(): void} fn  Synchronous function that triggers one log line.
 * @returns {{ parsed: object, raw: string }} The emitted JSON and its raw form.
 */
function captureLog(fn) {
  const chunks = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);

  process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
  process.stderr.write = (chunk) => { chunks.push(chunk); return true; };

  try {
    fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }

  if (chunks.length === 0) throw new Error("No log output captured");
  const raw = chunks[0];
  return { raw, parsed: JSON.parse(raw) };
}

// ── redactValue ──────────────────────────────────────────────────────────────

describe("redactValue", () => {
  test("returns non-string values unchanged", () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue(true)).toBe(true);
    expect(redactValue(null)).toBe(null);
    expect(redactValue({ a: 1 })).toEqual({ a: 1 });
  });

  test("passes through ordinary short strings", () => {
    expect(redactValue("hello world")).toBe("hello world");
    expect(redactValue("abc-123-uuid")).toBe("abc-123-uuid");
  });

  // ── GUARD: Stellar private key ───────────────────────────────────────────
  test("[GUARD] redacts a Stellar private key (SABCD...)", () => {
    // Real-shape secret key — 56 chars starting with S, base-32 alphabet (S + 55 chars).
    const privateKey = "SABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";
    expect(redactValue(privateKey)).toBe(REDACTED);
  });

  test("[GUARD] redacts a string that embeds a private key within longer text", () => {
    const embeds = "actor=SABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW;ok";
    expect(redactValue(embeds)).toBe(REDACTED);
  });

  test("[GUARD] does not redact a normal Stellar public key (G...)", () => {
    // Public keys start with G — must NOT be redacted.
    const publicKey = "GDYO6GEXKXPU3UH5SWGTAVHMBBZZEKUHWHXUJ33PL2TJJVHZB7CG6BI5";
    expect(redactValue(publicKey)).toBe(publicKey);
  });

  // ── GUARD: oversized string (signed transaction envelope heuristic) ──────
  test("[GUARD] redacts a string longer than MAX_FIELD_BYTES (signed envelope)", () => {
    // Simulate a base-64 signed XDR envelope exceeding the threshold.
    const largeEnvelope = "A".repeat(MAX_FIELD_BYTES + 1);
    expect(redactValue(largeEnvelope)).toBe(REDACTED);
  });

  test("does NOT redact a string exactly at MAX_FIELD_BYTES", () => {
    const borderline = "B".repeat(MAX_FIELD_BYTES);
    expect(redactValue(borderline)).toBe(borderline);
  });
});

// ── redactFields ─────────────────────────────────────────────────────────────

describe("redactFields", () => {
  test("redacts key-material fields while leaving safe fields untouched", () => {
    const privateKey = "SABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";
    const input = {
      correlationId: "abc-123",
      actorKey: privateKey,
      amount: 10,
    };
    const result = redactFields(input);
    expect(result.correlationId).toBe("abc-123");
    expect(result.actorKey).toBe(REDACTED);
    expect(result.amount).toBe(10);
  });

  test("redacts oversized field values", () => {
    const huge = "X".repeat(MAX_FIELD_BYTES + 100);
    const result = redactFields({ payload: huge, id: "ok" });
    expect(result.payload).toBe(REDACTED);
    expect(result.id).toBe("ok");
  });
});

// ── Structured output shape ───────────────────────────────────────────────────

describe("logger output shape", () => {
  test("each line is valid JSON with required fields", () => {
    const { parsed } = captureLog(() =>
      logger.info({ msg: "test message", foo: "bar" })
    );
    expect(parsed).toMatchObject({
      level: "info",
      time: expect.any(String),
      service: expect.any(String),
      msg: "test message",
      foo: "bar",
    });
    // time must be a valid ISO timestamp
    expect(() => new Date(parsed.time).toISOString()).not.toThrow();
  });

  test("warn and error go to stderr, info to stdout", () => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);

    process.stdout.write = (c) => { stdoutChunks.push(c); return true; };
    process.stderr.write = (c) => { stderrChunks.push(c); return true; };

    try {
      logger.info({ msg: "info" });
      logger.warn({ msg: "warn" });
      logger.error({ msg: "err" });
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }

    expect(stdoutChunks).toHaveLength(1);
    expect(stderrChunks).toHaveLength(2);
  });

  test("correlationId appears in log when set via runWithCorrelationId", async () => {
    let parsed;
    await runWithCorrelationId("trace-abc-999", () => {
      const { parsed: p } = captureLog(() => logger.info({ msg: "inside context" }));
      parsed = p;
    });
    expect(parsed.correlationId).toBe("trace-abc-999");
  });

  test("correlationId is absent from log when no context is set", () => {
    // Run outside any ALS context.
    const { parsed } = captureLog(() => logger.info({ msg: "outside context" }));
    expect(parsed).not.toHaveProperty("correlationId");
  });

  test("child logger inherits bound fields and correlation id", async () => {
    const child = logger.child({ service: "event-store" });
    let parsed;
    await runWithCorrelationId("cid-child-test", () => {
      const { parsed: p } = captureLog(() => child.info({ msg: "child log" }));
      parsed = p;
    });
    expect(parsed.service).toBe("event-store");
    expect(parsed.correlationId).toBe("cid-child-test");
  });
});

// ── getCorrelationId ──────────────────────────────────────────────────────────

describe("getCorrelationId", () => {
  test("returns undefined outside any context", () => {
    expect(getCorrelationId()).toBeUndefined();
  });

  test("returns the correlation id inside a runWithCorrelationId call", async () => {
    let id;
    await runWithCorrelationId("my-id-42", () => {
      id = getCorrelationId();
    });
    expect(id).toBe("my-id-42");
  });
});

// ── GUARD: full end-to-end — no private key appears in any log line ──────────

describe("[GUARD] no key material in serialised log lines", () => {
  test("a Stellar private key passed as a field value is never written to output", () => {
    const privateKey = "SABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";
    const { raw } = captureLog(() =>
      logger.info({ msg: "signing", secretKey: privateKey })
    );
    expect(raw).not.toContain(privateKey);
    expect(raw).toContain(REDACTED);
  });

  test("a signed transaction envelope (large string) is never written to output", () => {
    const envelope = "A".repeat(MAX_FIELD_BYTES + 500);
    const { raw } = captureLog(() =>
      logger.error({ msg: "submission failed", envelope })
    );
    expect(raw).not.toContain(envelope);
    expect(raw).toContain(REDACTED);
  });
});
