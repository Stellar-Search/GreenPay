/**
 * lib/freighterResult.ts — validated adapter for @stellar/freighter-api responses
 *
 * Freighter API calls have returned either a bare primitive (e.g. `getPublicKey()`
 * resolving to a `string`) or an object carrying the same value under a named field
 * (e.g. `{ publicKey: string }`), depending on the installed extension/package
 * version. These helpers are the single place that normalizes both shapes; any
 * other shape is a genuine contract break and throws rather than silently
 * producing `undefined`.
 */

export class UnexpectedFreighterResponseError extends Error {
  constructor(call: string, received: unknown) {
    super(`Unexpected response shape from Freighter API call "${call}": ${describe(received)}`);
    this.name = "UnexpectedFreighterResponseError";
  }
}

function describe(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Accepts a bare boolean, or an object exposing `field` as a boolean. */
export function extractBoolean(call: string, result: unknown, field: string): boolean {
  if (typeof result === "boolean") return result;
  if (result && typeof result === "object") {
    const value = (result as Record<string, unknown>)[field];
    if (typeof value === "boolean") return value;
  }
  throw new UnexpectedFreighterResponseError(call, result);
}

/**
 * Accepts a bare string, or an object exposing one of `fields` as a string.
 * `fields` are checked in order and the first present, non-empty match wins —
 * mirroring the pre-existing `result?.a || result?.b` fallback behavior.
 */
export function extractString(call: string, result: unknown, fields: string[]): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    for (const field of fields) {
      const value = (result as Record<string, unknown>)[field];
      if (typeof value === "string" && value) return value;
    }
  }
  throw new UnexpectedFreighterResponseError(call, result);
}
