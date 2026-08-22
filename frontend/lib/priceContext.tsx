/**
 * lib/priceContext.tsx — Global XLM/USD price context.
 * Fetches every 5 minutes from CoinGecko free API; fails silently.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

interface PriceContextValue {
  xlmUsd: number | null;
  lastFetchedAt: Date | null;
}

const PriceContext = createContext<PriceContextValue>({ xlmUsd: null, lastFetchedAt: null });

export function PriceProvider({ children }: { children: ReactNode }) {
  const [xlmUsd, setXlmUsd] = useState<number | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);

  useEffect(() => {
    let timeoutId: NodeJS.Timeout;
    const controller = new AbortController();

    const fetchPrice = () => {
      fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd",
        { signal: controller.signal },
      )
        .then((res) => {
          if (!res.ok) return;
          return res.json();
        })
        .then((data) => {
          const price = data?.stellar?.usd;
          if (typeof price === "number" && price > 0) {
            setXlmUsd(price);
            setLastFetchedAt(new Date());
          }
        })
        .catch(() => {
          // Fail silently — USD equivalents simply won't render or will use stale data
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            timeoutId = setTimeout(fetchPrice, 5 * 60 * 1000);
          }
        });
    };

    fetchPrice();

    return () => {
      controller.abort();
      clearTimeout(timeoutId);
    };
  }, []);

  return (
    <PriceContext.Provider value={{ xlmUsd, lastFetchedAt }}>
      {children}
    </PriceContext.Provider>
  );
}

export function useXlmPrice(): number | null {
  return useContext(PriceContext).xlmUsd;
}

export function useXlmPriceInfo(): PriceContextValue {
  return useContext(PriceContext);
}
