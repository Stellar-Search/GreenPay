/**
 * components/StaleCacheBanner.tsx
 *
 * Visible whenever a screen is serving getCachedData() instead of a live
 * fetch. isStale (10-minute TTL) tightens the copy so week-old fundraising
 * totals are not presented as current.
 */
import { View, Text, StyleSheet } from 'react-native';
import { formatCacheAge } from '../utils/cache';

export function StaleCacheBanner({
  cachedAt,
  isStale,
}: {
  cachedAt: number;
  isStale: boolean;
}) {
  const age = formatCacheAge(cachedAt);
  const message = isStale
    ? `Showing cached data from ${age} — fundraising totals may be out of date`
    : `Showing cached data from ${age}`;

  return (
    <View
      style={[styles.banner, isStale ? styles.stale : styles.fresh]}
      accessibilityRole="alert"
      testID="stale-cache-banner"
    >
      <Text style={styles.text}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    padding: 8,
    alignItems: 'center',
  },
  fresh: {
    backgroundColor: '#f5a623',
  },
  stale: {
    backgroundColor: '#c47b16',
  },
  text: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
});
