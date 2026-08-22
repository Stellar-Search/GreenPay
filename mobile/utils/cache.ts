/**
 * utils/cache.ts
 * AsyncStorage caching utility for offline support
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export interface CachedResult<T> {
  data: T;
  isStale: boolean;
  timestamp: number;
}

export async function getCachedData<T>(key: string): Promise<CachedResult<T> | null> {
  try {
    const cached = await AsyncStorage.getItem(key);
    if (!cached) return null;

    const entry: CacheEntry<T> = JSON.parse(cached);
    const isStale = Date.now() - entry.timestamp > CACHE_TTL_MS;
    return { data: entry.data, isStale, timestamp: entry.timestamp };
  } catch {
    return null;
  }
}

export async function setCachedData<T>(key: string, data: T): Promise<void> {
  try {
    const entry: CacheEntry<T> = { data, timestamp: Date.now() };
    await AsyncStorage.setItem(key, JSON.stringify(entry));
  } catch (error) {
    console.warn('Cache write failed:', error);
  }
}

/** Human-readable age of a cache timestamp, for the stale-data banner. */
export function formatCacheAge(timestamp: number, now = Date.now()): string {
  const elapsedMs = Math.max(0, now - timestamp);
  const minutes = Math.floor(elapsedMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}
