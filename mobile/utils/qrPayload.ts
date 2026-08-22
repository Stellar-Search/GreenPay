/**
 * utils/qrPayload.ts
 * Defensive parser for GreenPay's own QR/deep-link donation format.
 *
 * Replaces the old ad-hoc `extractProjectId` that used to live in
 * `QRScannerScreen.tsx`, which accepted *any* URL carrying a `?projectId=`
 * query param regardless of host (e.g. `https://evil.com/?projectId=x`
 * would have passed). This module instead requires an exact allowlisted
 * host+path (or the exact custom-scheme form), and constrains the
 * projectId itself to a safe charset/length — nothing is inferred, nothing
 * "close enough" is accepted.
 *
 * Two entry points share one validator core so the QR path and the
 * deep-link path (`hooks/useDeepLink.ts`) can never drift apart:
 *   - `parseGreenPayDonationLink` — QR payloads (https + greenpay:// forms)
 *   - `parseGreenPayDeepLink`     — OS deep links (greenpay:// form only)
 *
 * Never throws; always resolves to a well-formed result object.
 */

const ALLOWED_HOST = 'greenpay.app';
const ALLOWED_PATH = '/donate';
const CUSTOM_SCHEME = 'greenpay://';
const MAX_RAW_LENGTH = 4000;

/** Safe charset/length for a project id: 1-64 chars of [a-zA-Z0-9_-]. */
const PROJECT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export type GreenPayLinkResult =
  | { ok: true; projectId: string }
  | { ok: false; reason: string };

export type GreenPayDeepLinkResult =
  | { ok: true; segment: 'donate' | 'project'; projectId: string }
  | { ok: false; reason: string };

function containsControlOrNullChars(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}

/** Shared raw-input prevalidation: type, length, control chars, trim. */
function validateRaw(
  raw: unknown,
): { ok: false; reason: string } | { ok: true; trimmed: string } {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'not-a-string' };
  }
  if (raw.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (raw.length > MAX_RAW_LENGTH) {
    return { ok: false, reason: 'too-long' };
  }
  if (containsControlOrNullChars(raw)) {
    return { ok: false, reason: 'invalid-characters' };
  }
  return { ok: true, trimmed: raw.trim() };
}

/**
 * Shared custom-scheme path parser: `greenpay://<segment>/<id>`.
 * The scheme must match exactly (no case variants); the segment must be in
 * the allowlist; the id must be the entire remainder with no query string,
 * fragment, or extra path segments, and must satisfy the shared project-id
 * charset/length constraint.
 */
function parseCustomSchemePath<S extends string>(
  trimmed: string,
  allowedSegments: readonly S[],
): { ok: false; reason: string } | { ok: true; segment: S; projectId: string } {
  const rest = trimmed.slice(CUSTOM_SCHEME.length);
  if (rest.length === 0) {
    return { ok: false, reason: 'invalid-path' };
  }
  const slash = rest.indexOf('/');
  if (slash === -1) {
    return { ok: false, reason: 'invalid-path' };
  }
  const segment = rest.slice(0, slash);
  const projectId = rest.slice(slash + 1);
  const matchedSegment = segment as S;
  if (!allowedSegments.includes(matchedSegment)) {
    return { ok: false, reason: 'invalid-path' };
  }
  if (projectId.length === 0 || /[/?#]/.test(projectId)) {
    return { ok: false, reason: 'invalid-project-id' };
  }
  if (!PROJECT_ID_RE.test(projectId)) {
    return { ok: false, reason: 'invalid-project-id' };
  }
  return { ok: true, segment: matchedSegment, projectId };
}

/**
 * Parses a scanned string as a GreenPay donation link. Accepts only:
 *   - `https://greenpay.app/donate?projectId=<id>` (exact host, exact path)
 *   - `greenpay://donate/<id>` (exact custom-scheme form)
 * with `<id>` constrained to `/^[a-zA-Z0-9_-]{1,64}$/`. Anything else
 * (wrong host, subdomain, path traversal, wrong scheme, look-alike/
 * confusable hosts) is rejected.
 */
export function parseGreenPayDonationLink(raw: unknown): GreenPayLinkResult {
  try {
    const pre = validateRaw(raw);
    if (!pre.ok) {
      return pre;
    }
    const trimmed = pre.trimmed;

    // Custom-scheme form: greenpay://donate/<id> — exact prefix match only,
    // no query string, no extra path segments.
    if (trimmed.toLowerCase().startsWith('greenpay://')) {
      if (!trimmed.startsWith(CUSTOM_SCHEME)) {
        return { ok: false, reason: 'invalid-path' };
      }
      const parsed = parseCustomSchemePath(trimmed, ['donate']);
      if (!parsed.ok) {
        return parsed;
      }
      return { ok: true, projectId: parsed.projectId };
    }

    // https form: exact host + exact path allowlist.
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return { ok: false, reason: 'unparseable' };
    }

    if (url.protocol !== 'https:') {
      return { ok: false, reason: 'invalid-scheme' };
    }
    // Exact hostname match — no subdomains, no "greenpay.app.evil.com",
    // no "evil-greenpay.app". Reject userinfo (e.g. https://greenpay.app@evil.com)
    // by requiring username/password to be empty too.
    if (
      url.hostname !== ALLOWED_HOST ||
      url.username !== '' ||
      url.password !== '' ||
      (url.port !== '' && url.port !== '443')
    ) {
      return { ok: false, reason: 'untrusted-host' };
    }
    if (url.pathname !== ALLOWED_PATH) {
      return { ok: false, reason: 'invalid-path' };
    }

    const projectId = url.searchParams.get('projectId');
    if (!projectId || !PROJECT_ID_RE.test(projectId)) {
      return { ok: false, reason: 'invalid-project-id' };
    }

    return { ok: true, projectId };
  } catch {
    return { ok: false, reason: 'unexpected-error' };
  }
}

/**
 * Parses an OS deep link (`greenpay://donate/<id>` or
 * `greenpay://project/<id>`) through the exact same allowlist/charset rules
 * as the QR format — this is the only parser `hooks/useDeepLink.ts` may use,
 * so the two paths can never enforce different trust levels. Anything else
 * (wrong scheme, case-mutated scheme, extra segments, query strings,
 * oversized or control-character ids) is rejected. Never throws.
 */
export function parseGreenPayDeepLink(raw: unknown): GreenPayDeepLinkResult {
  try {
    const pre = validateRaw(raw);
    if (!pre.ok) {
      return pre;
    }
    const trimmed = pre.trimmed;
    if (!trimmed.startsWith(CUSTOM_SCHEME)) {
      return { ok: false, reason: 'invalid-scheme' };
    }
    return parseCustomSchemePath(trimmed, ['donate', 'project']);
  } catch {
    return { ok: false, reason: 'unexpected-error' };
  }
}
