/**
 * utils/recurringDonations.ts
 * AsyncStorage-backed monthly recurring donations for mobile.
 *
 * Security posture (no auto-signing):
 * Secret keys are never persisted on device. Recurring "payments" are therefore
 * reminders only — when nextDueDate arrives we fire a local push notification
 * that deep-links into the donate screen so the donor re-enters their secret
 * key and signs. Auto-debit is intentionally impossible under this model;
 * see mobile/docs/recurring-donations.md.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';

export const RECURRING_DONATIONS_KEY = 'greenpay_recurring_donations';

export interface RecurringDonation {
  id: string;
  projectId: string;
  projectName: string;
  amountXLM: string;
  startDate: string;
  nextDueDate: string;
  /** Calendar day (1-31) of the original start; used when advancing months. */
  anchorDay: number;
  durationMonths: number | null;
  remainingMonths: number | null;
  status: 'active' | 'cancelled' | 'completed';
  createdAt: string;
  /** expo-notifications identifier for the scheduled due reminder, if any. */
  notificationId?: string | null;
}

export async function loadRecurringDonations(): Promise<RecurringDonation[]> {
  try {
    const raw = await AsyncStorage.getItem(RECURRING_DONATIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(hydrateDonation) : [];
  } catch {
    return [];
  }
}

export async function saveRecurringDonations(donations: RecurringDonation[]): Promise<void> {
  await AsyncStorage.setItem(RECURRING_DONATIONS_KEY, JSON.stringify(donations));
}

function hydrateDonation(d: RecurringDonation): RecurringDonation {
  if (d.anchorDay) return d;
  return {
    ...d,
    anchorDay: new Date(d.nextDueDate || d.startDate).getUTCDate(),
  };
}

/** Days in a UTC year/month (monthIndex0 is 0-11). */
export function daysInMonth(year: number, monthIndex0: number): number {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

export function clampDayToMonth(year: number, monthIndex0: number, day: number): number {
  return Math.min(day, daysInMonth(year, monthIndex0));
}

/**
 * Advance `fromIso` by `monthsToAdvance` calendar months, clamping to
 * `anchorDay` so Jan-31 does not permanently become Feb-28 forever after.
 */
export function computeNextDueDate(
  fromIso: string,
  anchorDay: number,
  monthsToAdvance = 1,
): string {
  const from = new Date(fromIso);
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const totalMonths = year * 12 + month + monthsToAdvance;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12;
  const day = clampDayToMonth(targetYear, targetMonth, anchorDay);
  const hour = from.getUTCHours();
  const minute = from.getUTCMinutes();
  return new Date(Date.UTC(targetYear, targetMonth, day, hour, minute, 0)).toISOString();
}

export function buildRecurringDeepLink(id: string): string {
  return `greenpay://recurring/${id}`;
}

async function cancelScheduledNotification(notificationId?: string | null): Promise<void> {
  if (!notificationId) return;
  try {
    await Notifications.cancelScheduledNotificationAsync(notificationId);
  } catch (error) {
    console.warn('Failed to cancel recurring reminder', error);
  }
}

export async function requestNotificationPermissionsIfNeeded(): Promise<boolean> {
  try {
    const { status: existing } = await Notifications.getPermissionsAsync();
    if (existing === 'granted') return true;
    const { status } = await Notifications.requestPermissionsAsync();
    return status === 'granted';
  } catch {
    return false;
  }
}

/**
 * Schedule (or replace) a local notification that fires at nextDueDate and
 * deep-links into the donate flow for this recurring entry.
 */
export async function scheduleRecurringDueNotification(
  donation: RecurringDonation,
): Promise<string | null> {
  if (donation.status !== 'active') return null;

  await cancelScheduledNotification(donation.notificationId);

  const due = new Date(donation.nextDueDate).getTime();
  const delayMs = Math.max(due - Date.now(), 5_000);
  const seconds = Math.max(1, Math.ceil(delayMs / 1000));

  try {
    const notificationId = await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Monthly donation due',
        body: `Your ${donation.amountXLM} XLM donation to ${donation.projectName} is due — tap to sign.`,
        data: {
          url: buildRecurringDeepLink(donation.id),
          recurringId: donation.id,
          projectId: donation.projectId,
        },
      },
      // Seconds-from-now local trigger — no auto-signing, just a reminder.
      trigger: { seconds },
    });
    return notificationId;
  } catch (error) {
    console.warn('Failed to schedule recurring reminder', error);
    return null;
  }
}

export async function createRecurringDonation(input: {
  projectId: string;
  projectName: string;
  amountXLM: string;
  durationMonths: number | null;
}): Promise<RecurringDonation> {
  const now = new Date();
  const nowIso = now.toISOString();
  const anchorDay = now.getUTCDate();
  // First reminder is one month out — the donor can still make a one-off
  // donation on the donate screen right now.
  const nextDueDate = computeNextDueDate(nowIso, anchorDay, 1);

  const donation: RecurringDonation = {
    id: `rec_${Math.random().toString(36).slice(2, 10)}_${Date.now()}`,
    projectId: input.projectId,
    projectName: input.projectName,
    amountXLM: input.amountXLM,
    startDate: nowIso,
    nextDueDate,
    anchorDay,
    durationMonths: input.durationMonths,
    remainingMonths: input.durationMonths,
    status: 'active',
    createdAt: nowIso,
    notificationId: null,
  };

  const notificationId = await scheduleRecurringDueNotification(donation);
  donation.notificationId = notificationId;

  const all = await loadRecurringDonations();
  await saveRecurringDonations([donation, ...all]);
  return donation;
}

export async function cancelRecurringDonation(id: string): Promise<void> {
  const all = await loadRecurringDonations();
  const target = all.find((d) => d.id === id);
  if (target) await cancelScheduledNotification(target.notificationId);

  const updated = all.map((d) =>
    d.id === id ? { ...d, status: 'cancelled' as const, notificationId: null } : d,
  );
  await saveRecurringDonations(updated);
}

export async function getRecurringDonation(id: string): Promise<RecurringDonation | null> {
  const all = await loadRecurringDonations();
  return all.find((d) => d.id === id) ?? null;
}

/**
 * After the donor manually signs a due cycle, advance the schedule.
 * remainingMonths null = ongoing. At 0 → status completed and reminder cleared.
 */
export async function completeRecurringCycle(id: string): Promise<RecurringDonation | null> {
  const all = await loadRecurringDonations();
  let result: RecurringDonation | null = null;

  const updated: RecurringDonation[] = [];
  for (const d of all) {
    if (d.id !== id || d.status !== 'active') {
      updated.push(d);
      continue;
    }

    const nextRemaining =
      d.remainingMonths === null ? null : Math.max(d.remainingMonths - 1, 0);
    const completed = nextRemaining === 0;
    const next: RecurringDonation = {
      ...d,
      remainingMonths: nextRemaining,
      status: completed ? 'completed' : 'active',
      nextDueDate: completed
        ? d.nextDueDate
        : computeNextDueDate(d.nextDueDate, d.anchorDay, 1),
      notificationId: null,
    };

    await cancelScheduledNotification(d.notificationId);
    if (!completed) {
      next.notificationId = await scheduleRecurringDueNotification(next);
    }

    result = next;
    updated.push(next);
  }

  await saveRecurringDonations(updated);
  return result;
}

/** Active entries whose nextDueDate is at or before now. */
export async function getDueRecurringDonations(
  now = new Date(),
): Promise<RecurringDonation[]> {
  const all = await loadRecurringDonations();
  return all.filter(
    (d) => d.status === 'active' && new Date(d.nextDueDate).getTime() <= now.getTime(),
  );
}

/**
 * Re-schedule reminders for every active entry (e.g. after app update or
 * notification permission grant). Idempotent: cancels prior ids first.
 */
export async function rescheduleAllRecurringReminders(): Promise<void> {
  const all = await loadRecurringDonations();
  const updated: RecurringDonation[] = [];
  for (const d of all) {
    if (d.status !== 'active') {
      updated.push(d);
      continue;
    }
    const notificationId = await scheduleRecurringDueNotification(d);
    updated.push({ ...d, notificationId });
  }
  await saveRecurringDonations(updated);
}
