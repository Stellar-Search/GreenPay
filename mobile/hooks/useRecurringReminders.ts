/**
 * hooks/useRecurringReminders.ts
 *
 * Wires local due-date notifications into navigation, and refreshes schedules
 * when the app becomes active. Tapping a reminder opens greenpay://recurring/<id>
 * so the donor can re-enter their secret and sign — never auto-pays.
 */
import { useEffect } from 'react';
import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import {
  getRecurringDonation,
  rescheduleAllRecurringReminders,
  requestNotificationPermissionsIfNeeded,
} from '../utils/recurringDonations';

export function useRecurringReminders() {
  const router = useRouter();

  useEffect(() => {
    let alive = true;

    (async () => {
      await requestNotificationPermissionsIfNeeded();
      if (alive) await rescheduleAllRecurringReminders();
    })();

    const responseSub = Notifications.addNotificationResponseReceivedListener(
      async (response) => {
        const data = response.notification.request.content.data as {
          recurringId?: string;
          projectId?: string;
          url?: string;
        };
        const recurringId = data?.recurringId;
        if (!recurringId) return;

        const entry = await getRecurringDonation(recurringId);
        if (!entry || entry.status !== 'active') return;

        router.push({
          pathname: '/donate/[id]',
          params: {
            id: entry.projectId,
            recurringId: entry.id,
            amount: entry.amountXLM,
          },
        });
      },
    );

    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        rescheduleAllRecurringReminders();
      }
    });

    return () => {
      alive = false;
      responseSub.remove();
      appStateSub.remove();
    };
  }, [router]);
}
