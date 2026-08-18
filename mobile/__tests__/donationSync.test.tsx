/**
 * __tests__/donationSync.test.tsx
 * Integration tests for the offline-donation reconnect sync engine
 * (hooks/useDonationSync.ts).
 *
 * Scenario under test: a donation is queued while offline, then the world
 * changes underneath it (project deactivated, balance drops) before the
 * device reconnects. The sync engine must surface a conflict — never
 * silently drop the entry, and never silently resubmit a payment.
 */
import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react-native';
import { Alert } from 'react-native';
import axios from 'axios';
import NetInfo from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useDonationSync } from '../hooks/useDonationSync';
import { DONATION_QUEUE_KEY, enqueueDonation, listQueuedDonations } from '../utils/donationQueue';

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Server: jest.fn(),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Server } = require('@stellar/stellar-sdk');

const ACTIVE_PROJECT = {
  id: 'proj-1',
  name: 'Amazon Reforestation',
  status: 'active',
  walletAddress: 'GPROJECTWALLET0000000000000000000000000000000000000000',
};
const DONOR_ADDRESS = 'GDONOR00000000000000000000000000000000000000000000000';

function mockHorizonAccount(nativeBalance: string) {
  return { balances: [{ asset_type: 'native', balance: nativeBalance }] };
}

describe('useDonationSync — reconnect conflict resolution', () => {
  let reconnectListener: ((state: any) => void) | undefined;

  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    reconnectListener = undefined;

    (NetInfo.addEventListener as jest.Mock).mockImplementation((cb: (state: any) => void) => {
      reconnectListener = cb;
      return jest.fn();
    });
    (NetInfo.fetch as jest.Mock).mockResolvedValue({ isConnected: true, isInternetReachable: true });

    (axios.get as jest.Mock).mockResolvedValue({ data: { data: [ACTIVE_PROJECT] } });

    (Server as jest.Mock).mockImplementation(() => ({
      loadAccount: jest.fn().mockResolvedValue(mockHorizonAccount('1000')),
    }));
  });

  async function goOfflineThenOnline() {
    await act(async () => {
      reconnectListener?.({ isConnected: false, isInternetReachable: false });
    });
    await act(async () => {
      reconnectListener?.({ isConnected: true, isInternetReachable: true });
    });
  }

  it('marks a clean, unchanged entry as ready (no conflict) on reconnect', async () => {
    await enqueueDonation({
      projectId: ACTIVE_PROJECT.id,
      projectName: ACTIVE_PROJECT.name,
      donorAddress: DONOR_ADDRESS,
      amountXLM: '5.0000000',
    });

    const { result } = renderHook(() => useDonationSync());
    await waitFor(() => expect(result.current.queue).toHaveLength(1));
    expect(result.current.queue[0].status).toBe('pending-sync');

    await goOfflineThenOnline();

    await waitFor(() => expect(result.current.queue[0].status).toBe('ready'));
    expect(result.current.queue).toHaveLength(1);
    expect(result.current.queue[0].conflictReason).toBeUndefined();
  });

  it('flags project-inactive conflict when the project is deactivated before reconnect', async () => {
    await enqueueDonation({
      projectId: ACTIVE_PROJECT.id,
      projectName: ACTIVE_PROJECT.name,
      donorAddress: DONOR_ADDRESS,
      amountXLM: '5.0000000',
    });

    const { result } = renderHook(() => useDonationSync());
    await waitFor(() => expect(result.current.queue).toHaveLength(1));

    // The project goes inactive while the device is still offline.
    (axios.get as jest.Mock).mockResolvedValue({
      data: { data: [{ ...ACTIVE_PROJECT, status: 'inactive' }] },
    });

    await goOfflineThenOnline();

    await waitFor(() => expect(result.current.queue[0].status).toBe('conflict'));
    expect(result.current.queue[0].conflictReason).toBe('project-inactive');
    // Never silently dropped:
    expect(result.current.queue).toHaveLength(1);
  });

  it('flags insufficient-balance conflict when the balance drops before reconnect', async () => {
    await enqueueDonation({
      projectId: ACTIVE_PROJECT.id,
      projectName: ACTIVE_PROJECT.name,
      donorAddress: DONOR_ADDRESS,
      amountXLM: '10.0000000',
    });

    const { result } = renderHook(() => useDonationSync());
    await waitFor(() => expect(result.current.queue).toHaveLength(1));

    // Balance drops below amount + fee buffer while offline.
    (Server as jest.Mock).mockImplementation(() => ({
      loadAccount: jest.fn().mockResolvedValue(mockHorizonAccount('2')),
    }));

    await goOfflineThenOnline();

    await waitFor(() => expect(result.current.queue[0].status).toBe('conflict'));
    expect(result.current.queue[0].conflictReason).toBe('insufficient-balance');
    expect(result.current.queue[0].conflictDetail).toEqual(expect.stringContaining('2.00'));
    // Never silently dropped:
    expect(result.current.queue).toHaveLength(1);
  });

  it('treats an entry with a recorded Horizon hash as already completed, removes it, and tells the user', async () => {
    const entry = await enqueueDonation({
      projectId: ACTIVE_PROJECT.id,
      projectName: ACTIVE_PROJECT.name,
      donorAddress: DONOR_ADDRESS,
      amountXLM: '5.0000000',
    });

    // Simulate a prior attempt that actually reached Horizon before the app
    // was interrupted (e.g. the backend POST failed after submission).
    const all = await listQueuedDonations();
    await AsyncStorage.setItem(
      DONATION_QUEUE_KEY,
      JSON.stringify(
        all.map((e) => (e.id === entry.id ? { ...e, horizonTransactionHash: 'deadbeef' } : e))
      )
    );

    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    const { result } = renderHook(() => useDonationSync());
    await waitFor(() => expect(result.current.queue).toHaveLength(1));

    await goOfflineThenOnline();

    // Removed from the queue — not left dangling, not resubmitted.
    await waitFor(() => expect(result.current.queue).toHaveLength(0));
    expect(alertSpy).toHaveBeenCalledWith(
      'Donation already completed',
      expect.stringContaining('already gone through')
    );
  });

  it('does not retry indefinitely: a single reconnect only runs preflight once per entry', async () => {
    await enqueueDonation({
      projectId: ACTIVE_PROJECT.id,
      projectName: ACTIVE_PROJECT.name,
      donorAddress: DONOR_ADDRESS,
      amountXLM: '5.0000000',
    });

    const { result } = renderHook(() => useDonationSync());
    await waitFor(() => expect(result.current.queue).toHaveLength(1));

    await goOfflineThenOnline();
    await waitFor(() => expect(result.current.queue[0].status).toBe('ready'));

    const projectsCallsAfterFirstSync = (axios.get as jest.Mock).mock.calls.length;

    // A further reconnect with nothing pending should not re-check a
    // resolved ("ready") entry again.
    await goOfflineThenOnline();
    await waitFor(() => expect(result.current.queue[0].status).toBe('ready'));

    expect((axios.get as jest.Mock).mock.calls.length).toBe(projectsCallsAfterFirstSync);
  });

  it('deduplicates loadAccount calls per donorAddress within a single sync pass', async () => {
    const sameDonor = 'GDONOR00000000000000000000000000000000000000000000000';
    const projects = [
      { id: 'proj-1', name: 'Project One', status: 'active' },
      { id: 'proj-2', name: 'Project Two', status: 'active' },
      { id: 'proj-3', name: 'Project Three', status: 'active' },
    ];
    (axios.get as jest.Mock).mockResolvedValue({ data: { data: projects } });

    await enqueueDonation({ projectId: 'proj-1', projectName: 'Project One', donorAddress: sameDonor, amountXLM: '1' });
    await enqueueDonation({ projectId: 'proj-2', projectName: 'Project Two', donorAddress: sameDonor, amountXLM: '2' });
    await enqueueDonation({ projectId: 'proj-3', projectName: 'Project Three', donorAddress: sameDonor, amountXLM: '3' });

    const loadAccountMock = jest.fn().mockResolvedValue(mockHorizonAccount('1000'));
    (Server as jest.Mock).mockImplementation(() => ({ loadAccount: loadAccountMock }));

    const { result } = renderHook(() => useDonationSync());
    await waitFor(() => expect(result.current.queue).toHaveLength(3));

    await goOfflineThenOnline();

    await waitFor(() => {
      const statuses = result.current.queue.map((e: any) => e.status);
      expect(statuses.every((s: string) => s === 'ready')).toBe(true);
    });

    // 3 entries with the same donor address should produce only 1 loadAccount call.
    expect(loadAccountMock).toHaveBeenCalledTimes(1);
  });

  it('flags duplicate entry when same project + donor + amount already has a ready entry', async () => {
    const entry1 = await enqueueDonation({
      projectId: ACTIVE_PROJECT.id,
      projectName: ACTIVE_PROJECT.name,
      donorAddress: DONOR_ADDRESS,
      amountXLM: '5.0000000',
    });

    // Manually set the first entry to 'ready' to simulate it already being validated.
    await AsyncStorage.setItem(
      DONATION_QUEUE_KEY,
      JSON.stringify([{ ...entry1, status: 'ready' }])
    );

    // Enqueue a second identical donation while the first is already ready.
    await enqueueDonation({
      projectId: ACTIVE_PROJECT.id,
      projectName: ACTIVE_PROJECT.name,
      donorAddress: DONOR_ADDRESS,
      amountXLM: '5.0000000',
    });

    const { result } = renderHook(() => useDonationSync());
    await waitFor(() => expect(result.current.queue).toHaveLength(2));

    await goOfflineThenOnline();

    await waitFor(() => {
      const duplicate = result.current.queue.find((e: any) => e.conflictReason === 'duplicate');
      expect(duplicate).toBeDefined();
      expect(duplicate.status).toBe('conflict');
    });
  });

  it('distinguishes Horizon 429 rate-limit from generic network failure', async () => {
    await enqueueDonation({
      projectId: ACTIVE_PROJECT.id,
      projectName: ACTIVE_PROJECT.name,
      donorAddress: DONOR_ADDRESS,
      amountXLM: '5.0000000',
    });

    // Simulate a 429 rate-limit response from Horizon.
    const rateLimitError = {
      response: { status: 429, data: { status: 429, title: 'Rate Limit Exceeded' } },
    };
    (Server as jest.Mock).mockImplementation(() => ({
      loadAccount: jest.fn().mockRejectedValue(rateLimitError),
    }));

    const { result } = renderHook(() => useDonationSync());
    await waitFor(() => expect(result.current.queue).toHaveLength(1));

    await goOfflineThenOnline();

    // On 429, the entry should remain pending-sync (not conflict) for the next cycle.
    await waitFor(() => {
      expect(result.current.queue[0].status).toBe('pending-sync');
    });
  });
});
