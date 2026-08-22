/**
 * hooks/useCachedResource.ts
 *
 * Shared fetch + AsyncStorage pattern so screens cannot silently drop
 * getCachedData().isStale. Callers always receive isStale / cachedAt and
 * render StaleCacheBanner; a reconnect (same NetInfo signal as
 * useDonationSync) reloads without waiting for pull-to-refresh.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getCachedData, setCachedData } from '../utils/cache';
import { useNetworkReconnect } from './useNetworkReconnect';

export interface CachedResource<T> {
  data: T | null;
  isStale: boolean;
  cachedAt: number | null;
  fromCache: boolean;
  loading: boolean;
  refreshing: boolean;
  error: boolean;
  reload: (isPullRefresh?: boolean) => Promise<void>;
}

export function useCachedResource<T>(
  cacheKey: string,
  fetcher: () => Promise<T>,
): CachedResource<T> {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const [data, setData] = useState<T | null>(null);
  const [isStale, setIsStale] = useState(false);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);

  const reload = useCallback(
    async (isPullRefresh = false) => {
      if (isPullRefresh) setRefreshing(true);
      setError(false);

      try {
        const fresh = await fetcherRef.current();
        setData(fresh);
        setIsStale(false);
        setCachedAt(Date.now());
        setFromCache(false);
        await setCachedData(cacheKey, fresh);
      } catch {
        const cached = await getCachedData<T>(cacheKey);
        if (cached) {
          setData(cached.data);
          setIsStale(cached.isStale);
          setCachedAt(cached.timestamp);
          setFromCache(true);
        } else {
          setError(true);
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [cacheKey],
  );

  useEffect(() => {
    reload();
  }, [reload]);

  useNetworkReconnect(() => {
    reload();
  });

  return { data, isStale, cachedAt, fromCache, loading, refreshing, error, reload };
}
