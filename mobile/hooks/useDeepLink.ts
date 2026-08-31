/**
 * hooks/useDeepLink.ts
 *
 * Unified routing hook for deep links, universal web links, and push/local
 * notification taps.
 *
 * Supported URLs & Notifications:
 *   greenpay://project/123       → /projects/123
 *   greenpay://projects/123      → /projects/123
 *   greenpay://donate/<id>       → /donate/<id>
 *   greenpay://recurring/<id>    → /donate/<projectId>?recurringId=<id>
 *   greenpay://recurring         → /recurring
 *   greenpay://impact            → /impact
 *   greenpay://leaderboard       → /leaderboard
 *   greenpay://profile/<addr>    → /profile/<addr>
 *   Push/local notification taps (milestones, updates, donations, reminders)
 *
 * All inputs are strictly validated against an allowlist model (navigationDestinations.ts)
 * so no externally supplied value becomes a route directly.
 *
 * Cold-start versus warm-start handling:
 * - Cold-start URLs & notification responses are held in AppInitContext until
 *   AsyncStorage/SecureStore state is hydrated and navigation is ready.
 * - Warm-start events navigate immediately.
 */
import { useEffect, useCallback, useRef } from 'react';
import * as Linking from 'expo-linking';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useAppInit } from '../src/context/AppInitContext';
import {
  AppDestination,
  resolveDeepLinkDestination,
  resolveNotificationDestination,
  navigateToDestination,
} from '../utils/navigationDestinations';
import { setupNotificationChannel, setupNotificationListener } from '../utils/notifications';
import { getWalletPublicKey } from '../utils/walletKeyStorage';

export function useDeepLink() {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;

  const { queueDestination, onDestinationReady, queueDeepLink, onDeepLinkReady } = useAppInit();

  const handleDestination = useCallback(
    async (destination: AppDestination | null) => {
      if (!destination) return;
      await navigateToDestination(routerRef.current, destination);
    },
    []
  );

  const handleUrl = useCallback(
    async (url: string | null) => {
      if (!url) return;
      const destination = resolveDeepLinkDestination(url);
      if (destination) {
        await handleDestination(destination);
      }
    },
    [handleDestination]
  );

  const handleNotificationResponse = useCallback(
    async (response: Notifications.NotificationResponse | null) => {
      if (!response) return;
      const destination = resolveNotificationDestination(response);
      if (destination) {
        await handleDestination(destination);
      }
    },
    [handleDestination]
  );

  useEffect(() => {
    // 1. Ensure Android notification channel is initialized
    void setupNotificationChannel();

    // 2. Register destination handler for cold-start flush
    if (onDestinationReady) {
      onDestinationReady((dest) => {
        void handleDestination(dest);
      });
    } else if (onDeepLinkReady) {
      onDeepLinkReady((url) => {
        void handleUrl(url);
      });
    }

    // 3. Cold-start deep link detection
    Linking.getInitialURL().then((url) => {
      if (url) {
        const dest = resolveDeepLinkDestination(url);
        if (dest && queueDestination) {
          queueDestination(dest);
        } else if (queueDeepLink) {
          queueDeepLink(url);
        }
      }
    });

    // 4. Cold-start notification tap detection
    if (typeof Notifications.getLastNotificationResponseAsync === 'function') {
      Notifications.getLastNotificationResponseAsync().then((response) => {
        if (response) {
          const dest = resolveNotificationDestination(response);
          if (dest && queueDestination) {
            queueDestination(dest);
          }
        }
      });
    }

    // 5. Warm-start deep link listener
    const linkingSub = Linking.addEventListener('url', ({ url }) => {
      void handleUrl(url);
    });

    // 6. Push notification listener and token rotation
    const notifSub = setupNotificationListener({
      onNotificationResponse: (response) => {
        void handleNotificationResponse(response);
      },
      getWalletAddress: async () => {
        return await getWalletPublicKey();
      },
    });

    return () => {
      linkingSub.remove();
      notifSub.remove();
    };
  }, [
    handleDestination,
    handleUrl,
    handleNotificationResponse,
    onDestinationReady,
    onDeepLinkReady,
    queueDestination,
    queueDeepLink,
  ]);
}
