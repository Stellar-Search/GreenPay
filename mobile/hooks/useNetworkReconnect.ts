/**
 * hooks/useNetworkReconnect.ts
 *
 * Shared NetInfo "went from offline to online" signal. useDonationSync already
 * listened for this to flush the donation queue; cached screens use the same
 * transition to refresh stale project data instead of waiting for pull-to-refresh.
 */
import { useEffect, useRef } from 'react';
import NetInfo from '@react-native-community/netinfo';

export function useNetworkReconnect(onReconnect: () => void): void {
  const wasOnlineRef = useRef<boolean | null>(null);
  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;

  useEffect(() => {
    NetInfo.fetch().then((state: { isConnected?: boolean | null }) => {
      wasOnlineRef.current = state?.isConnected !== false;
    });

    const unsubscribe = NetInfo.addEventListener((state: { isConnected?: boolean | null }) => {
      const isOnline = state?.isConnected !== false;
      if (isOnline && wasOnlineRef.current === false) {
        onReconnectRef.current();
      }
      wasOnlineRef.current = isOnline;
    });

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, []);
}
