/**
 * hooks/useRecurringReminders.ts
 *
 * Refreshes recurring donation reminder schedules when the app becomes active.
 * Notification response routing is unified into useDeepLink and navigationDestinations.
 */
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { rescheduleAllRecurringReminders } from '../utils/recurringDonations';

export function useRecurringReminders() {
  useEffect(() => {
    let alive = true;

    (async () => {
      if (alive) await rescheduleAllRecurringReminders();
    })();

    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void rescheduleAllRecurringReminders();
      }
    });

    return () => {
      alive = false;
      appStateSub.remove();
    };
  }, []);
}
