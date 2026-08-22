/**
 * __tests__/donationQueue.test.ts
 * Unit tests for the AsyncStorage-backed offline donation queue.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  DONATION_QUEUE_KEY,
  enqueueDonation,
  listQueuedDonations,
  updateQueuedDonation,
  removeQueuedDonation,
  getQueuedDonation,
} from '../utils/donationQueue';

describe('donationQueue', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
  });

  it('starts empty', async () => {
    const list = await listQueuedDonations();
    expect(list).toEqual([]);
  });

  it('enqueues a donation intent without a secret key field', async () => {
    const entry = await enqueueDonation({
      projectId: 'proj-1',
      projectName: 'Amazon Reforestation',
      donorAddress: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
      amountXLM: '5.0000000',
      message: 'Keep it green',
    });

    expect(entry.id).toEqual(expect.any(String));
    expect(entry.status).toBe('pending-sync');
    expect(entry.projectId).toBe('proj-1');
    expect(entry.donorAddress).toBe('GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN');
    expect(entry).not.toHaveProperty('secretKey');

    const raw = await AsyncStorage.getItem(DONATION_QUEUE_KEY);
    expect(raw).toContain('proj-1');
    expect(raw).not.toMatch(/S[A-Z0-9]{55}/); // never persist anything secret-key-shaped
  });

  it('lists queued donations, most recent first', async () => {
    await enqueueDonation({
      projectId: 'proj-1',
      projectName: 'Project One',
      donorAddress: 'GABC',
      amountXLM: '1',
    });
    await enqueueDonation({
      projectId: 'proj-2',
      projectName: 'Project Two',
      donorAddress: 'GABC',
      amountXLM: '2',
    });

    const list = await listQueuedDonations();
    expect(list).toHaveLength(2);
    expect(list[0].projectId).toBe('proj-2');
    expect(list[1].projectId).toBe('proj-1');
  });

  it('updates a queued donation in place', async () => {
    const entry = await enqueueDonation({
      projectId: 'proj-1',
      projectName: 'Project One',
      donorAddress: 'GABC',
      amountXLM: '1',
    });

    const updated = await updateQueuedDonation(entry.id, {
      status: 'conflict',
      conflictReason: 'insufficient-balance',
      conflictDetail: 'Available: 0.50 XLM, required: 1.50 XLM',
    });

    expect(updated).toHaveLength(1);
    expect(updated[0].status).toBe('conflict');
    expect(updated[0].conflictReason).toBe('insufficient-balance');

    const list = await listQueuedDonations();
    expect(list[0].conflictDetail).toBe('Available: 0.50 XLM, required: 1.50 XLM');
  });

  it('removes a queued donation', async () => {
    const first = await enqueueDonation({
      projectId: 'proj-1',
      projectName: 'Project One',
      donorAddress: 'GABC',
      amountXLM: '1',
    });
    await enqueueDonation({
      projectId: 'proj-2',
      projectName: 'Project Two',
      donorAddress: 'GABC',
      amountXLM: '2',
    });

    const remaining = await removeQueuedDonation(first.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].projectId).toBe('proj-2');

    const list = await listQueuedDonations();
    expect(list).toHaveLength(1);
  });

  it('gets a single queued donation by id', async () => {
    const first = await enqueueDonation({
      projectId: 'proj-1',
      projectName: 'Project One',
      donorAddress: 'GABC',
      amountXLM: '1',
    });
    await enqueueDonation({
      projectId: 'proj-2',
      projectName: 'Project Two',
      donorAddress: 'GABC',
      amountXLM: '2',
    });

    const found = await getQueuedDonation(first.id);
    expect(found?.projectId).toBe('proj-1');

    const missing = await getQueuedDonation('does-not-exist');
    expect(missing).toBeUndefined();
  });

  it('recovers gracefully from corrupted storage', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('not-json');
    const list = await listQueuedDonations();
    expect(list).toEqual([]);
  });

  it('survives concurrent enqueue + update without losing either write', async () => {
    const first = await enqueueDonation({
      projectId: 'proj-1',
      projectName: 'Project One',
      donorAddress: 'GABC',
      amountXLM: '1',
    });

    // Fire enqueue and update concurrently — both must survive.
    const [, updated] = await Promise.all([
      enqueueDonation({
        projectId: 'proj-2',
        projectName: 'Project Two',
        donorAddress: 'GABC',
        amountXLM: '2',
      }),
      updateQueuedDonation(first.id, {
        status: 'conflict',
        conflictReason: 'insufficient-balance',
      }),
    ]);

    const list = await listQueuedDonations();
    expect(list).toHaveLength(2);

    const enqueued = list.find((e) => e.projectId === 'proj-2');
    expect(enqueued).toBeDefined();

    const patched = list.find((e) => e.id === first.id);
    expect(patched?.status).toBe('conflict');
    expect(patched?.conflictReason).toBe('insufficient-balance');
  });

  it('survives concurrent enqueue + remove without losing either write', async () => {
    const first = await enqueueDonation({
      projectId: 'proj-1',
      projectName: 'Project One',
      donorAddress: 'GABC',
      amountXLM: '1',
    });

    const [, removed] = await Promise.all([
      enqueueDonation({
        projectId: 'proj-2',
        projectName: 'Project Two',
        donorAddress: 'GABC',
        amountXLM: '2',
      }),
      removeQueuedDonation(first.id),
    ]);

    const list = await listQueuedDonations();
    expect(list).toHaveLength(1);
    expect(list[0].projectId).toBe('proj-2');
  });

  it('serializes a mid-loop enqueue during batch update', async () => {
    // Seed 3 entries.
    const e1 = await enqueueDonation({ projectId: 'p1', projectName: 'P1', donorAddress: 'GA', amountXLM: '1' });
    const e2 = await enqueueDonation({ projectId: 'p2', projectName: 'P2', donorAddress: 'GA', amountXLM: '2' });
    const e3 = await enqueueDonation({ projectId: 'p3', projectName: 'P3', donorAddress: 'GA', amountXLM: '3' });

    // Simulate a batch update (like syncNow does) interleaved with a new enqueue.
    const batchUpdate = (async () => {
      const results: any[] = [];
      for (const entry of [e1, e2, e3]) {
        results.push(await updateQueuedDonation(entry.id, { status: 'ready' }));
        // This fires mid-loop — the serialization must ensure the new entry
        // is not lost by the next iteration's read.
        if (entry.id === e2.id) {
          await enqueueDonation({ projectId: 'p-new', projectName: 'New', donorAddress: 'GA', amountXLM: '5' });
        }
      }
      return results;
    })();

    await batchUpdate;

    const list = await listQueuedDonations();
    // All 4 entries must exist and none clobbered.
    expect(list).toHaveLength(4);
    expect(list.filter((e) => e.status === 'ready')).toHaveLength(3);
    expect(list.find((e) => e.projectId === 'p-new')).toBeDefined();
  });
});
