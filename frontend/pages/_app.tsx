import NextApp, { type AppContext, type AppInitialProps, type AppProps } from "next/app";
import { useState, useEffect } from "react";
import Head from "next/head";
import { Toaster } from "sonner";
import Navbar from "@/components/Navbar";
import { PriceProvider } from "@/lib/priceContext";
import { I18nProvider, type Locale } from "@/lib/i18n";
import { connectWallet, getConnectedPublicKey } from "@/lib/wallet";
import "@/styles/globals.css";

function parseCookie(cookieString: string | undefined, name: string): string | undefined {
  if (!cookieString) return undefined;
  const cookies = cookieString.split(";").map(c => c.trim());
  for (const cookie of cookies) {
    const [key, value] = cookie.split("=");
    if (key === name) return decodeURIComponent(value);
  }
  return undefined;
}

// Custom getInitialProps opts every page out of Automatic Static
// Optimization, forcing per-request server rendering. This is required so
// _document.tsx's getInitialProps sees a real `ctx.req` on every page load
// and can thread the per-request CSP nonce (set by middleware.ts) onto
// <Head> and <NextScript> — a statically-generated page bakes a stale
// getInitialProps result at build time with no request, so its script tags
// end up nonce-less and get blocked by the strict-dynamic CSP at runtime.
App.getInitialProps = async (appContext: AppContext): Promise<AppInitialProps & { userLocale?: Locale }> => {
  const initialProps = await NextApp.getInitialProps(appContext);
  
  let userLocale: Locale = "en";
  if (appContext.ctx.req) {
    const cookieHeader = appContext.ctx.req.headers.cookie;
    const localeFromCookie = parseCookie(cookieHeader, "NEXT_LOCALE");
    if (localeFromCookie === "en" || localeFromCookie === "es" || localeFromCookie === "ar") {
      userLocale = localeFromCookie;
    }
  }
  
  return {
    ...initialProps,
    userLocale,
  };
};

interface AppPropsWithLocale extends AppProps {
  userLocale?: Locale;
}

export default function App({ Component, pageProps, userLocale }: AppPropsWithLocale) {
  const [publicKey, setPublicKey] = useState<string | null>(null);

  useEffect(() => {
    // Test seam: e2e tests inject a public key via window.addInitScript
    // so the wallet-gated UI renders without driving the real Freighter
    // postMessage handshake. Untouched in production.
    const testPk = (typeof window !== "undefined"
      ? (window as unknown as { __test_publicKey__?: unknown }).__test_publicKey__
      : undefined);
    if (typeof testPk === "string" && testPk.length > 0) {
      setPublicKey(testPk);
      return;
    }
    getConnectedPublicKey().then(pk => { if (pk) setPublicKey(pk); });
  }, []);

  const handleConnect = async () => {
    const { publicKey: pk } = await connectWallet();
    if (pk) setPublicKey(pk);
  };

  return (
    <I18nProvider initialLocale={userLocale}>
      <Head>
        <title>Stellar GreenPay — Climate Donations on Stellar</title>
        <meta name="description" content="Donate XLM directly to verified climate projects. Every transaction tracked on-chain via Soroban smart contracts." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <Toaster position="top-right" richColors closeButton />
      <div className="min-h-screen bg-[#f0f7f0]">
        <Navbar publicKey={publicKey} onConnect={handleConnect} onDisconnect={() => setPublicKey(null)} />
        <main>
          <Component {...pageProps} publicKey={publicKey} onConnect={handleConnect} />
        </main>
      </div>
    </I18nProvider>
  );
}
