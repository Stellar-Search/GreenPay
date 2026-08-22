/**
 * __tests__/deepLinkFuzz.test.ts
 * Property-based (fuzz) tests for the deep-link parser used by
 * `hooks/useDeepLink.ts` (greenpay://donate/<id> and greenpay://project/<id>).
 *
 * Mirrors qrFuzz.test.ts: the parser sits between "arbitrary bytes delivered
 * by the OS linking layer" and "a route the app might navigate to", so it
 * must (a) never throw, no matter how hostile or malformed the input, and
 * (b) always resolve to a well-formed result object. On success it must also
 * satisfy the same charset/length constraint as the QR path, so the two
 * paths can never enforce different trust levels.
 */
import fc from 'fast-check';
import { parseGreenPayDeepLink, GreenPayDeepLinkResult } from '../utils/qrPayload';

const PROJECT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function isWellFormed(result: GreenPayDeepLinkResult): boolean {
  if (result === null || typeof result !== 'object') return false;
  if (result.ok === true) {
    return (
      typeof result.projectId === 'string' &&
      result.projectId.length > 0 &&
      (result.segment === 'donate' || result.segment === 'project')
    );
  }
  if (result.ok === false) {
    return typeof (result as any).reason === 'string' && (result as any).reason.length > 0;
  }
  return false;
}

describe('deep-link parser fuzzing: never throws, always well-formed', () => {
  it('never throws on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (input) => {
        let result: GreenPayDeepLinkResult;
        expect(() => {
          result = parseGreenPayDeepLink(input);
        }).not.toThrow();
        expect(isWellFormed(result!)).toBe(true);
      }),
      { numRuns: 300 }
    );
  });

  it('never throws on arbitrary unicode (including confusables)', () => {
    fc.assert(
      fc.property(fc.fullUnicodeString({ maxLength: 300 }), (input) => {
        let result: GreenPayDeepLinkResult;
        expect(() => {
          result = parseGreenPayDeepLink(input);
        }).not.toThrow();
        expect(isWellFormed(result!)).toBe(true);
      }),
      { numRuns: 300 }
    );
  });

  it('never throws on non-string input of any type', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        let result: GreenPayDeepLinkResult;
        expect(() => {
          result = parseGreenPayDeepLink(input as any);
        }).not.toThrow();
        expect(isWellFormed(result!)).toBe(true);
      }),
      { numRuns: 200 }
    );
  });

  it('never throws on greenpay://donate/ plus garbage', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (garbage) => {
        const input = `greenpay://donate/${garbage}`;
        let result: GreenPayDeepLinkResult;
        expect(() => {
          result = parseGreenPayDeepLink(input);
        }).not.toThrow();
        expect(isWellFormed(result!)).toBe(true);
      }),
      { numRuns: 300 }
    );
  });

  it('never throws on greenpay://project/ plus garbage', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (garbage) => {
        const input = `greenpay://project/${garbage}`;
        let result: GreenPayDeepLinkResult;
        expect(() => {
          result = parseGreenPayDeepLink(input);
        }).not.toThrow();
        expect(isWellFormed(result!)).toBe(true);
      }),
      { numRuns: 300 }
    );
  });

  it('never throws on extremely long strings', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 4001, maxLength: 20000 }), (input) => {
        let result: GreenPayDeepLinkResult;
        expect(() => {
          result = parseGreenPayDeepLink(input);
        }).not.toThrow();
        expect(isWellFormed(result!)).toBe(true);
        expect(result!.ok).toBe(false);
      }),
      { numRuns: 50 }
    );
  });

  it('never throws on strings containing control/null characters', () => {
    const controlChar = fc.integer({ min: 0, max: 31 }).map((code) => String.fromCharCode(code));
    fc.assert(
      fc.property(
        fc.string({ maxLength: 100 }),
        controlChar,
        fc.string({ maxLength: 100 }),
        (prefix, ctrl, suffix) => {
          const input = `${prefix}${ctrl}${suffix}`;
          let result: GreenPayDeepLinkResult;
          expect(() => {
            result = parseGreenPayDeepLink(input);
          }).not.toThrow();
          expect(isWellFormed(result!)).toBe(true);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('only resolves ok when the projectId satisfies the shared charset/length rule', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant('donate'), fc.constant('project')),
        fc.string({ maxLength: 300 }),
        (segment, garbage) => {
          const input = `greenpay://${segment}/${garbage}`;
          const result = parseGreenPayDeepLink(input);
          if (result.ok) {
            expect(result.segment).toBe(segment);
            expect(result.projectId).toMatch(PROJECT_ID_RE);
          }
        }
      ),
      { numRuns: 300 }
    );
  });
});

describe('Hand-picked adversarial deep-link cases', () => {
  it('accepts the two canonical deep-link forms', () => {
    expect(parseGreenPayDeepLink('greenpay://donate/proj-123')).toEqual({
      ok: true,
      segment: 'donate',
      projectId: 'proj-123',
    });
    expect(parseGreenPayDeepLink('greenpay://project/42')).toEqual({
      ok: true,
      segment: 'project',
      projectId: '42',
    });
  });

  it('rejects path traversal in the project id', () => {
    expect(parseGreenPayDeepLink('greenpay://donate/../../etc/passwd')).toEqual({
      ok: false,
      reason: 'invalid-project-id',
    });
  });

  it('rejects a percent-encoded slash smuggled into the id', () => {
    expect(parseGreenPayDeepLink('greenpay://donate/abc%2Fdef')).toEqual({
      ok: false,
      reason: 'invalid-project-id',
    });
  });

  it('rejects extra path segments and query strings', () => {
    expect(parseGreenPayDeepLink('greenpay://donate/abc/extra')).toEqual({
      ok: false,
      reason: 'invalid-project-id',
    });
    expect(parseGreenPayDeepLink('greenpay://donate/abc?evil=1')).toEqual({
      ok: false,
      reason: 'invalid-project-id',
    });
  });

  it('rejects an id over the max allowed length (65 chars)', () => {
    expect(parseGreenPayDeepLink(`greenpay://donate/${'a'.repeat(65)}`)).toEqual({
      ok: false,
      reason: 'invalid-project-id',
    });
  });

  it('rejects an id containing a control character', () => {
    const ctrl = String.fromCharCode(2);
    expect(parseGreenPayDeepLink(`greenpay://donate/abc${ctrl}`)).toEqual({
      ok: false,
      reason: 'invalid-characters',
    });
  });

  it('rejects a host-shaped segment (greenpay://evil.com/...)', () => {
    expect(parseGreenPayDeepLink('greenpay://evil.com/donate/x')).toEqual({
      ok: false,
      reason: 'invalid-path',
    });
  });

  it('rejects an unknown segment', () => {
    expect(parseGreenPayDeepLink('greenpay://unknown/123')).toEqual({
      ok: false,
      reason: 'invalid-path',
    });
  });

  it('rejects a non-custom-scheme input (https look-alike)', () => {
    expect(parseGreenPayDeepLink('https://greenpay.app/donate?projectId=x')).toEqual({
      ok: false,
      reason: 'invalid-scheme',
    });
  });

  it('rejects a case-mutated scheme', () => {
    expect(parseGreenPayDeepLink('GREENPAY://donate/abc')).toEqual({
      ok: false,
      reason: 'invalid-scheme',
    });
  });
});