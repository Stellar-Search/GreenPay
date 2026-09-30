/**
 * __tests__/recurringDonations.test.ts
 * Cycle math and completion for monthly giving (no auto-signing).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import {
  computeNextDueDate,
  createRecurringDonation,
  completeRecurringCycle,
  cancelRecurringDonation,
  loadRecurringDonations,
  RECURRING_DONATIONS_KEY,
} from '../utils/recurringDonations';

jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: jest.fn().mockResolvedValue('notif-1'),
  cancelScheduledNotificationAsync: jest.fn().mockResolvedValue(undefined),
  getPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  requestPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  setNotificationHandler: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
}));

const store = (AsyncStorage as any).__store as Record<string, string>;

describe('recurringDonations', () => {
  beforeEach(() => {
    Object.keys(store).forEach((k) => delete store[k]);
    jest.clearAllMocks();
    (AsyncStorage.getItem as jest.Mock).mockImplementation((key: string) =>
      Promise.resolve(store[key] ?? null),
    );
    (AsyncStorage.setItem as jest.Mock).mockImplementation((key: string, value: string) => {
      store[key] = value;
      return Promise.resolve();
    });
  });

  it('clamps Jan 31 → Feb without permanently degrading the anchor day', () => {
    const jan31 = '2026-01-31T09:00:00.000Z';
    const feb = computeNextDueDate(jan31, 31, 1);
    expect(feb.startsWith('2026-02-28')).toBe(true);
    const mar = computeNextDueDate(feb, 31, 1);
    expect(mar.startsWith('2026-03-31')).toBe(true);
  });

  it('creates a schedule with nextDueDate one month out and a reminder', async () => {
    const created = await createRecurringDonation({
      projectId: 'proj-1',
      projectName: 'Amazon',
      amountXLM: '5.0000000',
      durationMonths: 3,
    });

    expect(created.status).toBe('active');
    expect(created.remainingMonths).toBe(3);
    expect(created.notificationId).toBe('notif-1');
    expect(new Date(created.nextDueDate).getTime()).toBeGreaterThan(Date.now());
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalled();
    expect(store[RECURRING_DONATIONS_KEY]).toContain('proj-1');
  });

  it('decrements remainingMonths and completes at zero', async () => {
    const created = await createRecurringDonation({
      projectId: 'proj-1',
      projectName: 'Amazon',
      amountXLM: '2.0000000',
      durationMonths: 2,
    });

    const afterFirst = await completeRecurringCycle(created.id);
    expect(afterFirst?.remainingMonths).toBe(1);
    expect(afterFirst?.status).toBe('active');
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalled();

    const afterSecond = await completeRecurringCycle(created.id);
    expect(afterSecond?.remainingMonths).toBe(0);
    expect(afterSecond?.status).toBe('completed');

    const all = await loadRecurringDonations();
    expect(all.find((d) => d.id === created.id)?.status).toBe('completed');
  });

  it('cancel clears the scheduled reminder', async () => {
    const created = await createRecurringDonation({
      projectId: 'proj-1',
      projectName: 'Amazon',
      amountXLM: '1.0000000',
      durationMonths: null,
    });
    await cancelRecurringDonation(created.id);
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('notif-1');
    const all = await loadRecurringDonations();
    expect(all[0].status).toBe('cancelled');
  });
});
