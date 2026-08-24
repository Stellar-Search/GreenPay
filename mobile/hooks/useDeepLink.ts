/**
 * hooks/useDeepLink.ts
 * Handles greenpay:// deep links and navigates to the correct screen.
 *
 * Supported URLs:
 *   greenpay://project/123       → /projects/123
 *   greenpay://donate/<id>       → /donate/<id>
 *   greenpay://recurring/<id>    → /donate/<projectId>?recurringId=<id>
 *                                  (monthly due reminder — donor must re-sign)
 *
 * Validated by `parseGreenPayDeepLink` (utils/qrPayload.ts), the same
 * allowlist/charset rules enforced on the QR path.
 *
 * Fix for issue #32 — deep-link / hydration race condition:
 * cold-start URLs go through AppInitContext.queueDeepLink until hydrated;
 * warm-start URLs navigate immediately.
 */
import { useEffect, useCallback } from 'react';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { useAppInit } from '../src/context/AppInitContext';
import { parseGreenPayDeepLink } from '../utils/qrPayload';
import { getRecurringDonation } from '../utils/recurringDonations';

export function useDeepLink() {
  const router = useRouter();
  const { queueDeepLink, onDeepLinkReady } = useAppInit();

  const handleUrl = useCallback(
    async (url: string | null) => {
      if (!url) return;
      const parsed = parseGreenPayDeepLink(url);
      if (!parsed.ok) return;

      if (parsed.segment === 'project') {
        router.push(`/projects/${parsed.projectId}`);
        return;
      }

      if (parsed.segment === 'recurring') {
        const entry = await getRecurringDonation(parsed.projectId);
        if (!entry || entry.status !== 'active') return;
        router.push({
          pathname: '/donate/[id]',
          params: {
            id: entry.projectId,
            recurringId: entry.id,
            amount: entry.amountXLM,
          },
        });
        return;
      }

      router.push(`/donate/${parsed.projectId}`);
    },
    [router],
  );

  useEffect(() => {
    onDeepLinkReady((url) => {
      void handleUrl(url);
    });

    Linking.getInitialURL().then((url) => {
      if (url) queueDeepLink(url);
    });

    const subscription = Linking.addEventListener('url', ({ url }) => {
      void handleUrl(url);
    });
    return () => subscription.remove();
  }, [handleUrl, onDeepLinkReady, queueDeepLink]);
}
