/**
 * utils/scrubber.ts
 * Security-critical pure function that redacts Stellar secret keys and signed
 * XDR TransactionEnvelopes from arbitrary report objects before they are
 * forwarded to any external service.
 *
 * Design constraints:
 *   - Zero imports from React Native, Expo, or any network module.
 *   - Never mutates input; always returns a new object or array.
 *   - Uses a Set of visited objects to guard against circular references.
 *   - Exposes scrub-event counters and a reset hook for testing (Req 6.4, 6.5).
 */

export interface ScrubCounters {
  secretKeys: number;
  signedEnvelopes: number;
}

// ---------------------------------------------------------------------------
// Module-level mutable counters (the only permitted side effect).
// ---------------------------------------------------------------------------
let _counters: ScrubCounters = { secretKeys: 0, signedEnvelopes: 0 };

/**
 * Returns a snapshot of the counters since the last reset.
 * This is a test hook — do not use it for production logic.
 */
export function getScrubCounters(): Readonly<ScrubCounters> {
  return { ..._counters };
}

/** Resets both counters to zero. Call between tests. */
export function resetScrubCounters(): void {
  _counters = { secretKeys: 0, signedEnvelopes: 0 };
}

// ---------------------------------------------------------------------------
// Detection patterns
// ---------------------------------------------------------------------------

/** Stellar secret key: S + exactly 55 uppercase base32 characters. */
const SECRET_KEY_RE = /^S[A-Z2-7]{55}$/;

/**
 * XDR TransactionEnvelope candidate: well-formed base64, length ≥ 100.
 * The XDR header-byte check is performed after decoding.
 */
const XDR_BASE64_RE = /^[A-Za-z0-9+/]{100,}={0,2}$/;

/**
 * Returns `true` when `s` looks like a base64-encoded Stellar
 * TransactionEnvelope — i.e. length ≥ 100, well-formed base64, and the
 * first decoded byte is 0x00 or 0x02 (the XDR union discriminant values
 * for TransactionEnvelope in the Stellar XDR schema).
 */
function isXdrEnvelope(s: string): boolean {
  if (!XDR_BASE64_RE.test(s)) return false;
  try {
    const decoded = Buffer.from(s, 'base64');
    if (decoded.length === 0) return false;
    const firstByte = decoded[0];
    return firstByte === 0x00 || firstByte === 0x02;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Core scrub logic
// ---------------------------------------------------------------------------

/**
 * Scrubs a single string value, incrementing the appropriate counter and
 * returning the redaction placeholder if the value matches a sensitive pattern.
 */
function scrubString(s: string): string {
  if (SECRET_KEY_RE.test(s)) {
    _counters.secretKeys += 1;
    return '[REDACTED:secret_key]';
  }
  if (isXdrEnvelope(s)) {
    _counters.signedEnvelopes += 1;
    return '[REDACTED:signed_envelope]';
  }
  return s;
}

/**
 * Recursively walks `value` and replaces any sensitive string values.
 * Uses a `Set` of visited objects to guard against circular references.
 * Never mutates input — returns new objects/arrays wherever changes are needed.
 */
function walkValue<T>(value: T, visited: Set<object>): T {
  // Primitives that pass through unchanged.
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return scrubString(value) as unknown as T;
  }

  if (typeof value !== 'object') {
    // numbers, booleans, symbols, bigints, functions — pass through unchanged
    return value;
  }

  // Circular reference guard.
  if (visited.has(value as object)) return value;
  visited.add(value as object);

  if (Array.isArray(value)) {
    let changed = false;
    const result: unknown[] = value.map((item) => {
      const scrubbed = walkValue(item, visited);
      if (scrubbed !== item) changed = true;
      return scrubbed;
    });
    // Return the original array reference if nothing changed (preserves deep
    // equality for the clean round-trip property).
    return (changed ? result : value) as unknown as T;
  }

  // Plain object (or class instance treated as a record).
  const obj = value as Record<string, unknown>;
  let changed = false;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const scrubbed = walkValue(obj[key], visited);
    result[key] = scrubbed;
    if (scrubbed !== obj[key]) changed = true;
  }

  return (changed ? result : value) as unknown as T;
}

/**
 * Recursively walks `value`, replacing any sensitive strings with redaction
 * placeholders. Returns a new object; never mutates the input. Pass-through
 * for `null`, `undefined`, numbers, and booleans.
 *
 * @param value - Any value — typically a Sentry event object.
 * @returns The scrubbed value (same type as input).
 */
export function scrubReport<T>(value: T): T {
  const visited = new Set<object>();
  return walkValue(value, visited);
}
