/**
 * hooks/useDonationSync.ts
 * Sync engine for the offline donation queue (see utils/donationQueue.ts).
 *
 * On reconnect, every `pending-sync` entry gets a one-shot *preflight
 * validation* — never an automatic payment submission. Because secret keys
 * are never persisted, this hook cannot sign or submit a transaction on the
 * user's behalf; it can only tell the user whether the queued intent is
 * still safe to complete ("ready"), or whether something changed underneath
 * it ("conflict"), so the user can make an informed decision when they
 * re-enter their secret key on the normal donate screen.
 *
 * Conflict rules:
 *  - Project is no longer `active`               -> conflict: project-inactive
 *  - Available XLM balance < amount + fee buffer -> conflict: insufficient-balance
 *  - Entry already carries a horizonTransactionHash from a prior attempt
 *    (i.e. Horizon already accepted the payment)  -> completed, removed
 *  - Otherwise                                    -> ready
 *
 * The preflight runs once per reconnect event (or manual pull-to-refresh)
 * per entry — there is no background retry loop, so entries never get stuck
 * silently retrying forever; they simply sit in `ready` or `conflict` until
 * the user acts via the sync-conflicts screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import axios from 'axios';
import NetInfo from '@react-native-community/netinfo';
import { createHorizonClient } from '@greenpay/stellar-client';
import {
  QueuedDonation,
  listQueuedDonations,
  removeQueuedDonation,
  updateQueuedDonation,
} from '../utils/donationQueue';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:4000';
const HORIZON_URL = process.env.EXPO_PUBLIC_HORIZON_URL || 'https://horizon-testnet.stellar.org';

/** Small reserve added on top of the donation amount to account for network fees. */
const FEE_BUFFER_XLM = 0.5;

export type ResolveAction = 'remove' | 'edit-amount';

async function preflightCheck(entry: QueuedDonation): Promise<QueuedDonation> {
  // A prior attempt already reached Horizon successfully — nothing left to do.
  if (entry.horizonTransactionHash) {
    return { ...entry, status: 'completed' };
  }

  try {
    const projectsRes = await axios.get(`${API_URL}/api/projects`);
    const list = Array.isArray(projectsRes.data?.data) ? projectsRes.data.data : [];
    const project = list.find((p: any) => p.id === entry.projectId);

    if (!project || project.status !== 'active') {
      return {
        ...entry,
        status: 'conflict',
        conflictReason: 'project-inactive',
        conflictDetail: 'This project is no longer accepting donations.',
      };
    }

    const server = createHorizonClient(HORIZON_URL);
    const account = await server.loadAccount(entry.donorAddress);
    const nativeBalance = account.balances.find((b: any) => b.asset_type === 'native');
    const available = nativeBalance ? parseFloat(nativeBalance.balance) : 0;
    const required = parseFloat(entry.amountXLM) + FEE_BUFFER_XLM;

    if (Number.isNaN(available) || available < required) {
      return {
        ...entry,
        status: 'conflict',
        conflictReason: 'insufficient-balance',
        conflictDetail: `Available: ${Number.isNaN(available) ? '0' : available.toFixed(2)} XLM, required: ${required.toFixed(2)} XLM`,
      };
    }

    return {
      ...entry,
      status: 'ready',
      conflictReason: undefined,
      conflictDetail: undefined,
    };
  } catch (error) {
    // Network/Horizon hiccup during preflight — leave it as pending-sync so
    // the next reconnect (or manual refresh) tries again. Never drop it.
    console.warn('Donation queue preflight failed for entry', entry.id, error);
    return entry;
  }
}

export function useDonationSync() {
  const [queue, setQueue] = useState<QueuedDonation[]>([]);
  const [syncing, setSyncing] = useState(false);
  const wasOnlineRef = useRef<boolean | null>(null);
  const syncingRef = useRef(false);

  const refresh = useCallback(async () => {
    const list = await listQueuedDonations();
    setQueue(list);
    return list;
  }, []);

  const syncNow = useCallback(async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const current = await listQueuedDonations();
      const pending = current.filter((entry) => entry.status === 'pending-sync');

      let completedCount = 0;
      for (const entry of pending) {
        const result = await preflightCheck(entry);
        if (result.status === 'completed') {
          await removeQueuedDonation(entry.id);
          completedCount += 1;
        } else if (
          result.status !== entry.status ||
          result.conflictReason !== entry.conflictReason ||
          result.conflictDetail !== entry.conflictDetail
        ) {
          await updateQueuedDonation(entry.id, {
            status: result.status,
            conflictReason: result.conflictReason,
            conflictDetail: result.conflictDetail,
          });
        }
      }

      if (completedCount > 0) {
        Alert.alert(
          'Donation already completed',
          completedCount === 1
            ? 'One of your queued donations had already gone through — no need to resubmit it.'
            : `${completedCount} of your queued donations had already gone through — no need to resubmit them.`
        );
      }
    } finally {
      await refresh();
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [refresh]);

  const resolve = useCallback(
    async (id: string, action: ResolveAction, payload?: { amountXLM?: string }) => {
      if (action === 'remove') {
        await removeQueuedDonation(id);
      } else if (action === 'edit-amount' && payload?.amountXLM) {
        await updateQueuedDonation(id, {
          amountXLM: payload.amountXLM,
          status: 'pending-sync',
          conflictReason: undefined,
          conflictDetail: undefined,
        });
      }
      await refresh();
    },
    [refresh]
  );

  useEffect(() => {
    refresh();

    NetInfo.fetch().then((state: any) => {
      wasOnlineRef.current = state?.isConnected !== false;
    });

    const unsubscribe = NetInfo.addEventListener((state: any) => {
      const isOnline = state?.isConnected !== false;
      if (isOnline && wasOnlineRef.current === false) {
        syncNow();
      }
      wasOnlineRef.current = isOnline;
    });

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { queue, syncing, refresh, syncNow, resolve };
}
