/**
 * __tests__/cache.test.ts
 * Tests for the AsyncStorage cache utility.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getCachedData, setCachedData, formatCacheAge } from '../utils/cache';

const store = (AsyncStorage as any).__store as Record<string, string>;

describe('cache utility', () => {
  beforeEach(() => {
    // Clear the in-memory store without wiping mock implementations
    Object.keys(store).forEach((k) => delete store[k]);
    jest.clearAllMocks();
    // Re-apply implementations after clearAllMocks
    (AsyncStorage.getItem as jest.Mock).mockImplementation((key: string) =>
      Promise.resolve(store[key] ?? null)
    );
    (AsyncStorage.setItem as jest.Mock).mockImplementation((key: string, value: string) => {
      store[key] = value;
      return Promise.resolve();
    });
  });

  it('returns null when key is not in cache', async () => {
    expect(await getCachedData('missing')).toBeNull();
  });

  it('stores and retrieves data', async () => {
    await setCachedData('key1', { foo: 'bar' });
    const result = await getCachedData<{ foo: string }>('key1');
    expect(result).not.toBeNull();
    expect(result!.data).toEqual({ foo: 'bar' });
  });

  it('isStale is false for fresh data', async () => {
    await setCachedData('key2', [1, 2, 3]);
    const result = await getCachedData<number[]>('key2');
    expect(result!.isStale).toBe(false);
  });

  it('isStale is true for expired data (>10 min)', async () => {
    const timestamp = Date.now() - 11 * 60 * 1000;
    const expired = JSON.stringify({ data: 'old', timestamp });
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(expired);
    const result = await getCachedData<string>('old-key');
    expect(result!.isStale).toBe(true);
    expect(result!.data).toBe('old');
    expect(result!.timestamp).toBe(timestamp);
  });

  it('returns null on corrupt cache entry', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue('not-json{{{');
    expect(await getCachedData('corrupt')).toBeNull();
  });
});

describe('formatCacheAge', () => {
  const now = 1_700_000_000_000;

  it('describes recent, hourly, and multi-day ages', () => {
    expect(formatCacheAge(now - 30_000, now)).toBe('just now');
    expect(formatCacheAge(now - 60_000, now)).toBe('1 minute ago');
    expect(formatCacheAge(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(formatCacheAge(now - 60 * 60_000, now)).toBe('1 hour ago');
    expect(formatCacheAge(now - 3 * 60 * 60_000, now)).toBe('3 hours ago');
    expect(formatCacheAge(now - 24 * 60 * 60_000, now)).toBe('1 day ago');
    expect(formatCacheAge(now - 3 * 24 * 60 * 60_000, now)).toBe('3 days ago');
  });
});
