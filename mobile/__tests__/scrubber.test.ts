/**
 * __tests__/scrubber.test.ts
 * Property-based tests and unit tests for the scrubber utility.
 *
 * Feature: ota-updates-crash-reporting
 *
 * Four correctness properties:
 *   Property 1: Secret key scrubbing at arbitrary nesting depth
 *   Property 2: XDR envelope scrubbing at arbitrary nesting depth
 *   Property 3: Clean report round-trip (purity)
 *   Property 4: Scrubber idempotence
 *
 * Plus unit tests covering edge cases (null, undefined, numbers, booleans,
 * circular references, counter reset).
 */
import fc from 'fast-check';
import { scrubReport, getScrubCounters, resetScrubCounters } from '../utils/scrubber';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pattern used to detect un-scrubbed Stellar secret keys in output. */
const SECRET_KEY_RE = /^S[A-Z2-7]{55}$/;

/** Pattern used to detect un-scrubbed XDR envelope candidates in output. */
const XDR_BASE64_RE = /^[A-Za-z0-9+/]{100,}={0,2}$/;

/**
 * Recursively checks whether any string in `value` matches the given pattern.
 */
function containsPattern(value: unknown, pattern: RegExp): boolean {
  if (typeof value === 'string') return pattern.test(value);
  if (value === null || value === undefined) return false;
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsPattern(item, pattern));
  }
  return Object.values(value as Record<string, unknown>).some((v) =>
    containsPattern(v, pattern)
  );
}

/**
 * Recursively checks whether any string in `value` is a valid XDR envelope
 * (base64 ≥100 chars AND decoded first byte is 0x00 or 0x02).
 */
function containsXdrEnvelope(value: unknown): boolean {
  if (typeof value === 'string') {
    if (!XDR_BASE64_RE.test(value)) return false;
    try {
      const decoded = Buffer.from(value, 'base64');
      if (decoded.length === 0) return false;
      return decoded[0] === 0x00 || decoded[0] === 0x02;
    } catch {
      return false;
    }
  }
  if (value === null || value === undefined || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsXdrEnvelope(item));
  return Object.values(value as Record<string, unknown>).some((v) => containsXdrEnvelope(v));
}

/**
 * Sets a value at `path` (array of string keys) inside a (possibly nested)
 * plain-object `obj`, returning a NEW object at every level (immutable).
 * Intermediate levels that are not objects are replaced with objects.
 */
function deepSet(obj: Record<string, unknown>, path: string[], val: unknown): Record<string, unknown> {
  if (path.length === 0) return obj;
  const [head, ...rest] = path;
  if (rest.length === 0) {
    return { ...obj, [head]: val };
  }
  const child =
    obj[head] !== null && typeof obj[head] === 'object' && !Array.isArray(obj[head])
      ? (obj[head] as Record<string, unknown>)
      : {};
  return { ...obj, [head]: deepSet(child, rest, val) };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Generates exactly 55 uppercase base32 chars (A-Z, 2-7) prepended with 'S'.
 * Total length 56 — a syntactically valid Stellar secret key.
 */
const arbitraryStellarSecretKey = (): fc.Arbitrary<string> =>
  fc
    .stringOf(fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.split('')), {
      minLength: 55,
      maxLength: 55,
    })
    .map((body) => `S${body}`);

/**
 * Generates a byte array whose first byte is 0x00 or 0x02 (XDR
 * TransactionEnvelope discriminant) followed by at least 99 more bytes, then
 * base64-encodes the whole thing. The result is guaranteed to be ≥100 chars.
 */
const arbitraryXdrEnvelope = (): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.constantFrom(0x00, 0x02),
      fc.uint8Array({ minLength: 99, maxLength: 200 })
    )
    .map(([firstByte, rest]) => {
      const buf = Buffer.alloc(1 + rest.length);
      buf[0] = firstByte;
      buf.set(rest, 1);
      return buf.toString('base64');
    });

/**
 * A simple string that will never accidentally match either sensitive pattern.
 * Excludes the letter 'S' in first position followed by 55 base32 chars, and
 * excludes strings that look like long base64.
 */
const arbitrarySafeString = (): fc.Arbitrary<string> =>
  fc.string({ maxLength: 40 }).filter((s) => {
    // Not a secret key shape
    if (/^S[A-Z2-7]{55}$/.test(s)) return false;
    // Not a long base64 candidate whose first decoded byte might be 0x00 or 0x02
    if (/^[A-Za-z0-9+/]{100,}={0,2}$/.test(s)) {
      try {
        const d = Buffer.from(s, 'base64');
        if (d.length > 0 && (d[0] === 0x00 || d[0] === 0x02)) return false;
      } catch {
        // not valid base64 — safe to keep
      }
    }
    return true;
  });

/**
 * Generates a leaf value that is safe (no sensitive strings).
 */
const arbitrarySafeLeaf = (): fc.Arbitrary<unknown> =>
  fc.oneof(
    arbitrarySafeString(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.constant(undefined)
  );

/**
 * A simple crash-report-shaped object with safe (non-sensitive) values.
 * Avoids deep nesting to keep test performance reasonable; correctness at
 * depth is exercised by the injection helpers.
 */
const arbitraryCleanCrashReport = (): fc.Arbitrary<Record<string, unknown>> =>
  fc.record({
    message: arbitrarySafeString(),
    level: fc.constantFrom('info', 'warning', 'error', 'fatal'),
    extra: fc.record({
      screen: arbitrarySafeString(),
      userId: arbitrarySafeString(),
    }),
    breadcrumbs: fc.array(
      fc.record({
        category: arbitrarySafeString(),
        message: arbitrarySafeString(),
      }),
      { maxLength: 5 }
    ),
    tags: fc.record({
      env: fc.constantFrom('production', 'preview'),
    }),
  });

/**
 * Generates a random key-path of 1–4 string keys for use with `deepSet`.
 * Excludes prototype-poisoning keys (__proto__, constructor, prototype) to
 * avoid JavaScript engine special-casing that would silently swallow the
 * injected value and leave the counter at zero.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const arbitraryKeyPath = (): fc.Arbitrary<string[]> =>
  fc
    .array(
      fc
        .string({ minLength: 1, maxLength: 10 })
        .filter((s) => s.length > 0 && !UNSAFE_KEYS.has(s)),
      { minLength: 1, maxLength: 4 }
    );

/**
 * Arbitrary crash report that may or may not contain sensitive values (used
 * for idempotence testing).
 */
const arbitraryAnyReport = (): fc.Arbitrary<Record<string, unknown>> =>
  fc.oneof(
    arbitraryCleanCrashReport(),
    fc
      .tuple(arbitraryCleanCrashReport(), arbitraryKeyPath(), arbitraryStellarSecretKey())
      .map(([report, path, key]) => deepSet(report, path, key)),
    fc
      .tuple(arbitraryCleanCrashReport(), arbitraryKeyPath(), arbitraryXdrEnvelope())
      .map(([report, path, env]) => deepSet(report, path, env))
  );

// ---------------------------------------------------------------------------
// Property 1: Secret key scrubbing at arbitrary nesting depth
// Feature: ota-updates-crash-reporting, Property 1: Secret key scrubbing at arbitrary nesting depth
// Validates: Requirements 6.1, 6.3, 6.4, 7.1, 7.4
// ---------------------------------------------------------------------------
describe('Property 1: Secret key scrubbing at arbitrary nesting depth', () => {
  it('scrubReport removes all Stellar secret keys from any nesting depth and increments secretKeys counter', () => {
    // **Validates: Requirements 6.1, 6.3, 6.4, 7.1, 7.4**
    fc.assert(
      fc.property(
        arbitraryCleanCrashReport(),
        arbitraryKeyPath(),
        arbitraryStellarSecretKey(),
        (report, keyPath, secretKey) => {
          resetScrubCounters();
          const injected = deepSet(report, keyPath, secretKey);
          const scrubbed = scrubReport(injected);

          // No secret key pattern should survive in the output.
          expect(containsPattern(scrubbed, SECRET_KEY_RE)).toBe(false);
          // Counter must have been incremented.
          expect(getScrubCounters().secretKeys).toBeGreaterThan(0);
        }
      ),
      { numRuns: 500 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: XDR envelope scrubbing at arbitrary nesting depth
// Feature: ota-updates-crash-reporting, Property 2: XDR envelope scrubbing at arbitrary nesting depth
// Validates: Requirements 6.2, 6.3, 6.5, 7.2
// ---------------------------------------------------------------------------
describe('Property 2: XDR envelope scrubbing at arbitrary nesting depth', () => {
  it('scrubReport removes all XDR TransactionEnvelope base64 strings from any nesting depth and increments signedEnvelopes counter', () => {
    // **Validates: Requirements 6.2, 6.3, 6.5, 7.2**
    fc.assert(
      fc.property(
        arbitraryCleanCrashReport(),
        arbitraryKeyPath(),
        arbitraryXdrEnvelope(),
        (report, keyPath, envelope) => {
          resetScrubCounters();
          const injected = deepSet(report, keyPath, envelope);
          const scrubbed = scrubReport(injected);

          // No XDR envelope should survive in the output.
          expect(containsXdrEnvelope(scrubbed)).toBe(false);
          // Counter must have been incremented.
          expect(getScrubCounters().signedEnvelopes).toBeGreaterThan(0);
        }
      ),
      { numRuns: 500 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: Clean report round-trip (purity)
// Feature: ota-updates-crash-reporting, Property 3: Clean report round-trip
// Validates: Requirements 6.6, 7.3
// ---------------------------------------------------------------------------
describe('Property 3: Clean report round-trip (purity)', () => {
  it('scrubReport on a report with no sensitive values returns a deeply equal object and leaves counters at zero', () => {
    // **Validates: Requirements 6.6, 7.3**
    fc.assert(
      fc.property(arbitraryCleanCrashReport(), (report) => {
        resetScrubCounters();
        const scrubbed = scrubReport(report);

        // Output must be deeply equal to input.
        expect(scrubbed).toEqual(report);
        // Counters must remain at zero.
        expect(getScrubCounters()).toEqual({ secretKeys: 0, signedEnvelopes: 0 });
      }),
      { numRuns: 300 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4: Scrubber idempotence
// Feature: ota-updates-crash-reporting, Property 4: Scrubber idempotence
// Validates: Requirement 7.5
// ---------------------------------------------------------------------------
describe('Property 4: Scrubber idempotence', () => {
  it('scrubReport(scrubReport(x)) deeply equals scrubReport(x) for arbitrary reports', () => {
    // **Validates: Requirement 7.5**
    fc.assert(
      fc.property(arbitraryAnyReport(), (report) => {
        const once = scrubReport(report);
        const twice = scrubReport(once);
        expect(twice).toEqual(once);
      }),
      { numRuns: 300 }
    );
  });
});

// ---------------------------------------------------------------------------
// Unit tests — edge cases
// ---------------------------------------------------------------------------
describe('scrubber edge cases', () => {
  beforeEach(() => {
    resetScrubCounters();
  });

  it('passes null through unchanged', () => {
    expect(scrubReport(null)).toBeNull();
  });

  it('passes undefined through unchanged', () => {
    expect(scrubReport(undefined)).toBeUndefined();
  });

  it('passes numbers through unchanged', () => {
    expect(scrubReport(42)).toBe(42);
    expect(scrubReport(-3.14)).toBe(-3.14);
    expect(scrubReport(0)).toBe(0);
  });

  it('passes booleans through unchanged', () => {
    expect(scrubReport(true)).toBe(true);
    expect(scrubReport(false)).toBe(false);
  });

  it('passes empty objects through unchanged', () => {
    const obj = {};
    expect(scrubReport(obj)).toEqual({});
  });

  it('passes empty arrays through unchanged', () => {
    const arr: unknown[] = [];
    expect(scrubReport(arr)).toEqual([]);
  });

  it('does not increment counters for safe strings', () => {
    resetScrubCounters();
    scrubReport({ message: 'hello world', code: 42 });
    expect(getScrubCounters()).toEqual({ secretKeys: 0, signedEnvelopes: 0 });
  });

  it('redacts a Stellar secret key at the top level', () => {
    const key = 'S' + 'A'.repeat(55);
    const result = scrubReport({ key }) as Record<string, unknown>;
    expect(result.key).toBe('[REDACTED:secret_key]');
    expect(getScrubCounters().secretKeys).toBe(1);
  });

  it('redacts a secret key deeply nested in an object', () => {
    const key = 'S' + 'B'.repeat(55);
    const input = { a: { b: { c: key } } };
    const result = scrubReport(input) as typeof input;
    expect(result.a.b.c).toBe('[REDACTED:secret_key]');
    expect(getScrubCounters().secretKeys).toBe(1);
  });

  it('redacts a secret key inside an array', () => {
    const key = 'S' + 'C'.repeat(55);
    const input = { breadcrumbs: [{ message: key }] };
    const result = scrubReport(input) as typeof input;
    expect(result.breadcrumbs[0].message).toBe('[REDACTED:secret_key]');
  });

  it('redacts an XDR envelope at the top level', () => {
    // First byte 0x00, 99 more bytes → base64 ≥ 100 chars
    const buf = Buffer.alloc(100, 0x00);
    const envelope = buf.toString('base64');
    const result = scrubReport({ xdr: envelope }) as Record<string, unknown>;
    expect(result.xdr).toBe('[REDACTED:signed_envelope]');
    expect(getScrubCounters().signedEnvelopes).toBe(1);
  });

  it('does not redact a short base64 string (< 100 chars)', () => {
    const short = Buffer.alloc(10, 0x00).toString('base64'); // well under 100 chars
    const result = scrubReport({ data: short }) as Record<string, unknown>;
    expect(result.data).toBe(short);
  });

  it('does not redact a long base64 string whose first decoded byte is neither 0x00 nor 0x02', () => {
    // First byte 0xFF — not a TransactionEnvelope discriminant
    const buf = Buffer.alloc(100);
    buf[0] = 0xff;
    const b64 = buf.toString('base64');
    const result = scrubReport({ data: b64 }) as Record<string, unknown>;
    expect(result.data).toBe(b64);
  });

  it('does not mutate the input object', () => {
    const key = 'S' + 'D'.repeat(55);
    const input = { secret: key };
    const inputCopy = { secret: key };
    scrubReport(input);
    expect(input).toEqual(inputCopy);
  });

  it('does not mutate nested input arrays', () => {
    const key = 'S' + 'E'.repeat(55);
    const input = { items: [key, 'safe'] };
    const inputCopy = { items: [key, 'safe'] };
    scrubReport(input);
    expect(input).toEqual(inputCopy);
  });

  it('handles circular references without infinite-looping', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj['self'] = obj; // circular reference
    expect(() => scrubReport(obj)).not.toThrow();
  });

  it('resetScrubCounters resets both counters to zero', () => {
    const key = 'S' + 'F'.repeat(55);
    scrubReport({ key });
    expect(getScrubCounters().secretKeys).toBe(1);

    resetScrubCounters();
    expect(getScrubCounters()).toEqual({ secretKeys: 0, signedEnvelopes: 0 });
  });

  it('getScrubCounters returns a snapshot (not a live reference)', () => {
    resetScrubCounters();
    const snapshot = getScrubCounters();
    const key = 'S' + 'G'.repeat(55);
    scrubReport({ key });
    // Snapshot captured before the scrub should still show 0.
    expect(snapshot.secretKeys).toBe(0);
    expect(getScrubCounters().secretKeys).toBe(1);
  });

  it('correctly replaces both key types in a single report', () => {
    const secretKey = 'S' + 'H'.repeat(55);
    const buf = Buffer.alloc(100, 0x02);
    const xdrEnvelope = buf.toString('base64');

    resetScrubCounters();
    const result = scrubReport({ secretKey, xdrEnvelope }) as Record<string, unknown>;

    expect(result.secretKey).toBe('[REDACTED:secret_key]');
    expect(result.xdrEnvelope).toBe('[REDACTED:signed_envelope]');
    expect(getScrubCounters()).toEqual({ secretKeys: 1, signedEnvelopes: 1 });
  });
});
