/**
 * e2e/csp.spec.ts
 *
 * Regression coverage for two CSP bugs that reached production undetected
 * because nothing asserted the *actual* header/HTML contract:
 *
 *   1. Nonce/static-optimization mismatch — Automatic Static Optimization let
 *      _document.tsx bake a stale nonce into prerendered HTML that didn't
 *      match the per-request nonce middleware.ts put on the CSP header,
 *      so every <script> tag failed the browser's nonce check and the site
 *      shipped with zero working JS. See _document.tsx for the fix
 *      (getInitialProps forces per-request SSR).
 *   2. Missing ws:// scheme — connect-src listed the API's http(s) origin
 *      but not its ws(s) counterpart, so lib/socket.ts's Socket.IO upgrade
 *      to the live donation feed was silently blocked while ordinary
 *      fetch() calls worked fine. See middleware.ts's apiOrigins.
 *
 * These are asserted against the *raw* server response (via Playwright's
 * `request` fixture) rather than a rendered `page`, because browsers hide
 * the `nonce` attribute from DOM inspection (getAttribute/outerHTML) once a
 * script node is parsed — the real value is only ever visible in the HTML
 * the server actually sent.
 */
import { test, expect } from "@playwright/test";

const MOCK_PROJECT_ID = "8d9ac19b-52eb-42f7-80d9-19a88ba59e43";
const MOCK_PUBLIC_KEY = "GDNNXUMEULKSN4PL3VOAN7NNSNM3EKDVTNGX66OWM2E7UJKKVWCUN3GZ";

// Every path middleware.ts applies CSP to, covering both the plain
// `frame-ancestors 'none'` branch and the `isWidget` branch.
const PAGES = [
  "/",
  `/projects/${MOCK_PROJECT_ID}`,
  `/donate/${MOCK_PROJECT_ID}`,
  `/donors/${MOCK_PUBLIC_KEY}`,
  `/widget/${MOCK_PROJECT_ID}`,
];

// Origins the frontend's client-side code actually opens connections to —
// see lib/stellar.ts (Horizon/Soroban/Friendbot), lib/priceContext.tsx
// (CoinGecko), and lib/api.ts + lib/socket.ts (the API's HTTP and
// WebSocket origins, driven by NEXT_PUBLIC_API_URL).
const REQUIRED_CONNECT_ORIGINS = [
  "https://horizon-testnet.stellar.org",
  "https://horizon.stellar.org",
  "https://soroban-testnet.stellar.org",
  "https://soroban.stellar.org",
  "https://friendbot.stellar.org",
  "https://api.coingecko.com",
  // NEXT_PUBLIC_API_URL=http://localhost:4000 in playwright.config.ts's
  // webServer env — both schemes must be present or the WebSocket upgrade
  // for the live donation feed silently fails while fetch() still works.
  "http://localhost:4000",
  "ws://localhost:4000",
];

async function fetchPage(request: import("@playwright/test").APIRequestContext, path: string) {
  const response = await request.get(path);
  expect(response.ok(), `${path} did not respond 200 OK`).toBeTruthy();
  const csp = response.headers()["content-security-policy"];
  expect(csp, `${path} is missing a Content-Security-Policy header`).toBeTruthy();
  const html = await response.text();
  return { csp, html };
}

function directive(csp: string, name: string): string[] {
  const match = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `) || d === name);
  return match ? match.slice(name.length).trim().split(/\s+/).filter(Boolean) : [];
}

test.describe("CSP nonce/script consistency", () => {
  for (const path of PAGES) {
    test(`every <script> tag's nonce matches the CSP header on ${path}`, async ({ request }) => {
      const { csp, html } = await fetchPage(request, path);

      const scriptSrc = directive(csp, "script-src");
      const nonceToken = scriptSrc.find((t) => t.startsWith("'nonce-"));
      expect(nonceToken, `${path}'s script-src has no nonce token: ${csp}`).toBeTruthy();
      const headerNonce = nonceToken!.slice("'nonce-".length, -1);
      expect(headerNonce.length).toBeGreaterThan(0);

      const scriptTags = html.match(/<script\b[^>]*>/gi) ?? [];
      expect(scriptTags.length, `${path} rendered no <script> tags at all`).toBeGreaterThan(0);

      const nonced = scriptTags.filter((tag) => /\bnonce=/.test(tag));
      expect(
        nonced.length,
        `${path} rendered no nonce-carrying <script> tags — every script would be ` +
          `blocked by CSP since 'unsafe-inline' is a no-op once 'strict-dynamic' is present`,
      ).toBeGreaterThan(0);

      for (const tag of nonced) {
        const attr = tag.match(/\bnonce=["']([^"']+)["']/);
        expect(attr, `malformed nonce attribute in ${path}: ${tag}`).toBeTruthy();
        expect(
          attr![1],
          `${path} has a <script> nonce that doesn't match the CSP header nonce — ` +
            `this is the exact static-optimization regression: a stale nonce baked ` +
            `into prerendered HTML no longer matches the per-request header, so the ` +
            `browser refuses to run every script on the page.\n  tag: ${tag}`,
        ).toBe(headerNonce);
      }
    });
  }
});

test.describe("CSP connect-src coverage", () => {
  for (const path of PAGES) {
    test(`connect-src covers every origin the app calls on ${path}`, async ({ request }) => {
      const { csp } = await fetchPage(request, path);
      const connectSrc = directive(csp, "connect-src");

      for (const origin of REQUIRED_CONNECT_ORIGINS) {
        expect(
          connectSrc,
          `${path}'s connect-src is missing ${origin} — a client-side call to it ` +
            `would be silently blocked.\n  connect-src: ${connectSrc.join(" ")}`,
        ).toContain(origin);
      }
    });
  }

  test("connect-src pairs every http(s) API origin with its ws(s) counterpart", async ({ request }) => {
    const { csp } = await fetchPage(request, "/");
    const connectSrc = directive(csp, "connect-src");

    const httpApiOrigins = connectSrc.filter(
      (o) => /^https?:\/\/localhost:4000$/.test(o),
    );
    expect(httpApiOrigins.length, `expected the API's http origin in connect-src: ${connectSrc.join(" ")}`).toBe(1);

    for (const httpOrigin of httpApiOrigins) {
      const wsOrigin = httpOrigin.replace(/^http/, "ws");
      expect(
        connectSrc,
        `connect-src has ${httpOrigin} but not its WebSocket counterpart ${wsOrigin} — ` +
          `this is the exact regression that silently broke the live donation feed's ` +
          `Socket.IO connection while ordinary fetch() calls kept working.\n  connect-src: ${connectSrc.join(" ")}`,
      ).toContain(wsOrigin);
    }
  });
});
