import { NextResponse, type NextRequest } from 'next/server'

const STELLAR_CONNECT = [
  'https://horizon-testnet.stellar.org',
  'https://horizon.stellar.org',
  'https://soroban-testnet.stellar.org',
  'https://soroban.stellar.org',
  'https://friendbot.stellar.org',
].join(' ')

function buildCsp(nonce: string, isWidget: boolean): string {
  // API origin: 'self' covers same-origin deploys. When the backend lives on
  // a different origin (local dev, or a separate API subdomain in
  // production), NEXT_PUBLIC_API_URL names it explicitly — allowlist that
  // origin too, in every environment, or every API call gets CSP-blocked.
  // lib/socket.ts also opens a Socket.IO (WebSocket) connection to this same
  // host for the live donation feed — CSP matches ws(s):// as a distinct
  // scheme from http(s):// for the *same* host, so both must be listed or
  // the WebSocket upgrade gets silently blocked while plain fetch works fine.
  const apiOrigins = (() => {
    if (!process.env.NEXT_PUBLIC_API_URL) return []
    try {
      const { protocol, host } = new URL(process.env.NEXT_PUBLIC_API_URL)
      const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:'
      return [`${protocol}//${host}`, `${wsProtocol}//${host}`]
    } catch {
      return []
    }
  })()

  const connectSrc = [
    "'self'",
    STELLAR_CONNECT,
    'https://api.coingecko.com',
    ...apiOrigins,
  ].join(' ')

  // Next.js dev mode's React Refresh runtime evaluates code via eval() to
  // apply hot-reloaded modules. That's blocked by a strict script-src with
  // no 'unsafe-eval', which is fine (even desirable) in production but
  // breaks local dev entirely (blank page, EvalError in console). Scope the
  // exception to non-production so prod CSP is untouched.
  const isDev = process.env.NODE_ENV !== 'production'

  const directives = [
    "default-src 'self'",
    // nonce tags the Next.js script injection; strict-dynamic propagates trust to bundles
    // it loads; unsafe-inline is a no-op in CSP3 but keeps CSP2 browsers working.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    `connect-src ${connectSrc}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    isWidget ? "frame-ancestors *" : "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ]

  return directives.join('; ')
}

export function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID())
  const isWidget = request.nextUrl.pathname.startsWith('/widget/')
  const csp = buildCsp(nonce, isWidget)

  const requestHeaders = new Headers(request.headers)
  // x-nonce is read in pages/_document.tsx to stamp <Head> and <NextScript>
  requestHeaders.set('x-nonce', nonce)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('Content-Security-Policy', csp)

  return response
}

export const config = {
  // Skip static assets — CSP is only meaningful on HTML responses.
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|ico|svg|webp)$).*)'],
}
