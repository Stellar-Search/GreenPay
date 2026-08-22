/**
 * utils/donationQueue.ts
 * AsyncStorage-backed queue of pending donation *intents* created while the
 * device is offline.
 *
 * IMPORTANT — security: entries in this queue never contain a Stellar secret
 * key. Only the donation intent (project, amount, donor public address,
 * optional message) is persisted. Signing always happens later, live, when
 * the user re-opens the donate screen and re-enters their secret key — see
 * docs/offline-donation-sync.md for the full rationale.
 *
 * Concurrency: every read-modify-write mutator is serialized through a
 * module-level promise chain so concurrent calls (e.g. enqueueDonation
 * firing while syncNow is mid-loop) never clobber each other's writes.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const DONATION_QUEUE_KEY = 'greenpay_donation_queue';

export type QueuedDonationStatus = 'pending-sync' | 'ready' | 'conflict' | 'completed';
export type ConflictReason = 'insufficient-balance' | 'project-inactive' | 'duplicate';

export interface QueuedDonation {
  /** Client-generated identifier. Never sent to Horizon as a memo/reference on its own. */
  id: string;
  projectId: string;
  projectName: string;
  /** Stellar public address of the donor. Never a secret key. */
  donorAddress: string;
  amountXLM: string;
  message?: string;
  createdAt: number;
  status: QueuedDonationStatus;
  conflictReason?: ConflictReason;
  conflictDetail?: string;
  /** Set only if a prior attempt is known to have reached Horizon successfully. */
  horizonTransactionHash?: string;
}

function generateId(): string {
  return `donation_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Serializes all read-modify-write mutations through a single promise chain.
 * Each call waits for the previous mutation to complete before reading,
 * preventing lost writes from concurrent callers.
 */
let mutationChain: Promise<unknown> = Promise.resolve();

function enqueueMutation<T>(fn: () => Promise<T>): Promise<T> {
  const result = mutationChain.then(fn, fn);
  mutationChain = result.then(() => {}, () => {});
  return result;
}

export async function listQueuedDonations(): Promise<QueuedDonation[]> {
  try {
    const raw = await AsyncStorage.getItem(DONATION_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function getQueuedDonation(id: string): Promise<QueuedDonation | undefined> {
  const all = await listQueuedDonations();
  return all.find((entry) => entry.id === id);
}

async function saveQueuedDonations(queue: QueuedDonation[]): Promise<void> {
  await AsyncStorage.setItem(DONATION_QUEUE_KEY, JSON.stringify(queue));
}

export async function enqueueDonation(input: {
  projectId: string;
  projectName: string;
  donorAddress: string;
  amountXLM: string;
  message?: string;
}): Promise<QueuedDonation> {
  return enqueueMutation(async () => {
    const entry: QueuedDonation = {
      id: generateId(),
      projectId: input.projectId,
      projectName: input.projectName,
      donorAddress: input.donorAddress,
      amountXLM: input.amountXLM,
      message: input.message?.trim() || undefined,
      createdAt: Date.now(),
      status: 'pending-sync',
    };
    const all = await listQueuedDonations();
    await saveQueuedDonations([entry, ...all]);
    return entry;
  });
}

export async function updateQueuedDonation(
  id: string,
  patch: Partial<Omit<QueuedDonation, 'id'>>
): Promise<QueuedDonation[]> {
  return enqueueMutation(async () => {
    const all = await listQueuedDonations();
    const updated = all.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
    await saveQueuedDonations(updated);
    return updated;
  });
}

export async function removeQueuedDonation(id: string): Promise<QueuedDonation[]> {
  return enqueueMutation(async () => {
    const all = await listQueuedDonations();
    const updated = all.filter((entry) => entry.id !== id);
    await saveQueuedDonations(updated);
    return updated;
  });
}
