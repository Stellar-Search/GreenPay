/**
 * hooks/useDeepLink.ts
 * Handles greenpay:// deep links and navigates to the correct screen.
 *
 * Supported URLs:
 *   greenpay://project/123       → /projects/123
 *   greenpay://donate/G...ABC    → /donate/G...ABC
 *
 * Both forms are validated by `parseGreenPayDeepLink` (utils/qrPayload.ts),
 * the same allowlist/charset rules enforced on the QR path — malformed,
 * oversized, or control-character params are rejected without navigating.
 *
 * Fix for issue #32 — deep-link / hydration race condition
 * ─────────────────────────────────────────────────────────
 * Previously, Linking.getInitialURL() was awaited fire-and-forget inside a
 * useEffect, so router.push() could fire before Redux / AsyncStorage hydration
 * completed, causing crashes or blank screens on cold start.
 *
 * Now:
 *  1. Cold-start URLs are passed to AppInitContext.queueDeepLink(), which
 *     holds them until isHydrated === true.
 *  2. The navigation handler is registered via AppInitContext.onDeepLinkReady()
 *     so it is only ever invoked after the root state is fully loaded.
 *  3. Warm-start URLs (app already open) bypass the queue because hydration
 *     is already complete by definition.
 */
import { useEffect, useCallback } from 'react';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { useAppInit } from '../src/context/AppInitContext';
import { parseGreenPayDeepLink } from '../utils/qrPayload';

export function useDeepLink() {
  const router = useRouter();
  const { queueDeepLink, onDeepLinkReady } = useAppInit();

  /** Validate a greenpay:// URL through the shared parser, then navigate. */
  const handleUrl = useCallback(
    (url: string | null) => {
      if (!url) return;
      const parsed = parseGreenPayDeepLink(url);
      if (!parsed.ok) return;

      if (parsed.segment === 'project') {
        router.push(`/projects/${parsed.projectId}`);
      } else {
        router.push(`/donate/${parsed.projectId}`);
      }
    },
    [router],
  );

  useEffect(() => {
    // Register our navigation handler with the init context.
    // It will be called only after isHydrated === true.
    onDeepLinkReady(handleUrl);

    // Fetch the cold-start URL and hand it to the queue.
    // AppInitContext will hold it until hydration is complete.
    Linking.getInitialURL().then((url) => {
      if (url) queueDeepLink(url);
    });

    // Handle links received while the app is already open (warm start).
    // Hydration is guaranteed to be complete by the time this fires.
    const subscription = Linking.addEventListener('url', ({ url }) => handleUrl(url));
    return () => subscription.remove();
  }, [handleUrl, onDeepLinkReady, queueDeepLink]);
}
