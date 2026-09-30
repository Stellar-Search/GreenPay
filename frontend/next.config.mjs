/** @type {import('next').NextConfig} */

// ---------------------------------------------------------------------------
// Content Security Policy
// ---------------------------------------------------------------------------
// The LIVE CSP (with a per-request nonce) is generated dynamically in
// middleware.ts.  The constants below are the canonical allowlist reference
// and provide a static fallback for any edge-case that bypasses middleware
// (e.g. raw static-file serving without Next.js runtime).
//
// connect-src covers:
//   • Stellar Horizon (testnet + mainnet) — REST API + EventSource streaming
//   • Soroban RPC (testnet + mainnet)     — Soroban simulate/send calls
//   • Stellar Friendbot                    — testnet account funding
//   • CoinGecko                            — XLM/USD spot price
//
// In production set NEXT_PUBLIC_API_URL to your deployed backend; the 'self'
// origin already covers same-domain backends.  In local dev middleware.ts
// also appends http://localhost:4000.
// ---------------------------------------------------------------------------

const STELLAR_CONNECT = [
  'https://horizon-testnet.stellar.org',
  'https://horizon.stellar.org',
  'https://soroban-testnet.stellar.org',
  'https://soroban.stellar.org',
  'https://friendbot.stellar.org',
].join(' ')

function buildStaticCsp(allowFraming = false) {
  const frameAncestors = allowFraming ? "frame-ancestors *" : "frame-ancestors 'none'"
  return [
    "default-src 'self'",
    // Static fallback uses unsafe-inline; middleware.ts replaces this with a
    // nonce + strict-dynamic pair which achieves an A grade on csp-evaluator.
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    `connect-src 'self' ${STELLAR_CONNECT} https://api.coingecko.com`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    frameAncestors,
    "upgrade-insecure-requests",
  ].join('; ')
}

const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained `.next/standalone` server so the production image
  // copies build artifacts instead of reinstalling dependencies, and so the
  // container runs `node server.js` directly as PID 1 (SIGTERM from `docker
  // stop` reaches the server, enabling a graceful shutdown).
  output: 'standalone',
  // `intl-messageformat` (ICU plural/number formatting used by lib/i18n.tsx)
  // and its `@formatjs/*` dependencies ship ESM-only packages with no CJS
  // entry point. Next.js needs to know to run these through its own
  // compiler rather than requiring them as-is.
  transpilePackages: [
    'intl-messageformat',
    '@formatjs/fast-memoize',
    '@formatjs/icu-messageformat-parser',
    '@formatjs/icu-skeleton-parser',
  ],
  webpack: (config) => {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, net: false, tls: false }
    return config
  },
  async headers() {
    return [
      {
        // Applied to every route.  middleware.ts overrides Content-Security-Policy
        // with the nonce-stamped version for all HTML responses.
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: buildStaticCsp(false) },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      {
        // Widget pages are intentionally embeddable by third-party sites.
        // Override frame-ancestors and X-Frame-Options for this route.
        source: '/widget/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: buildStaticCsp(true) },
          // X-Frame-Options has no "allow all" value; rely on CSP frame-ancestors
          // for modern browsers and omit the legacy header for widget routes.
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        ],
      },
    ]
  },
}

export default nextConfig
