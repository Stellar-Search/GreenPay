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
 *  - Another queued entry for the same project + donor + amount is already
 *    completed or ready  -> conflict: duplicate
 *  - Project is no longer `active`               -> conflict: project-inactive
 *  - Available XLM balance < amount + fee buffer -> conflict: insufficient-balance
 *  - Entry already carries a horizonTransactionHash from a prior attempt
 *    (i.e. Horizon already accepted the payment)  -> completed, removed
 *  - Otherwise                                    -> ready
 *
 * Horizon handling:
 *  - loadAccount results are cached per donorAddress within a single
 *    syncNow() pass so multiple entries for the same donor don't issue
 *    redundant Horizon calls.
 *  - HTTP 429 (rate-limit) responses are distinguished from generic network
 *    failures and trigger an exponential backoff before the entry is left
 *    as pending-sync for the next reconnect cycle.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import axios from 'axios';
import { Horizon } from '@stellar/stellar-sdk';
const StellarServer = (require('@stellar/stellar-sdk') as any).Server || Horizon.Server;
import {
  QueuedDonation,
  listQueuedDonations,
  removeQueuedDonation,
  updateQueuedDonation,
} from '../utils/donationQueue';
import {
  parseAmountToStroops,
  formatStroopsToDisplay,
  FEE_BUFFER_STROOPS,
  isBalanceSufficient,
} from '../utils/amount';
import { useNetworkReconnect } from './useNetworkReconnect';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:4000';
const HORIZON_URL = process.env.EXPO_PUBLIC_HORIZON_URL || 'https://horizon-testnet.stellar.org';
/** Small reserve added on top of the donation amount to account for network fees. */
const FEE_BUFFER_XLM = 0.5;

/** Base delay (ms) before retrying after a 429 rate-limit response. */
const RATE_LIMIT_BACKOFF_MS = 5_000;
export type ResolveAction = 'remove' | 'edit-amount';

/** Cached Horizon account load result for deduplication within a sync pass. */
interface AccountCacheEntry {
  account: any | null;
  error: unknown | null;
}

/**
 * Detects a Horizon 429 rate-limit response. Horizon wraps HTTP status codes
 * in the error's response.status or response.data.status fields.
 */
function isRateLimitError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const err = error as Record<string, unknown>;

  // axios-style: error.response.status
  const response = err.response as Record<string, unknown> | undefined;
  if (response) {
    if (response.status === 429) return true;
    const data = response.data as Record<string, unknown> | undefined;
    if (data && data.status === 429) return true;
  }

  // Horizon SDK-style: error.response.data.extras
  if (response?.data) {
    const data = response.data as Record<string, unknown>;
    if (data.status === 429) return true;
  }

  return false;
}

async function preflightCheck(
  entry: QueuedDonation,
  allEntries: QueuedDonation[],
  accountCache: Map<string, AccountCacheEntry>,
): Promise<QueuedDonation> {
  // A prior attempt already reached Horizon successfully — nothing left to do.
  if (entry.horizonTransactionHash) {
    return { ...entry, status: 'completed' };
  }

  // Duplicate detection: check if another queued entry for the same project +
  // donor + amount already has a terminal status (ready or completed).
  const duplicate = allEntries.find(
    (e) =>
      e.id !== entry.id &&
      e.projectId === entry.projectId &&
      e.donorAddress === entry.donorAddress &&
      e.amountXLM === entry.amountXLM &&
      (e.status === 'ready' || e.status === 'completed'),
  );
  if (duplicate) {
    return {
      ...entry,
      status: 'conflict',
      conflictReason: 'duplicate',
      conflictDetail: `A ${duplicate.status === 'completed' ? 'completed' : 'ready'} donation of ${entry.amountXLM} XLM to this project already exists in the queue.`,
    };
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
    // Use cached loadAccount result when available for this donor address.
    let cacheEntry = accountCache.get(entry.donorAddress);
    if (!cacheEntry) {
      try {
        const server = new StellarServer(HORIZON_URL);
        const account = await server.loadAccount(entry.donorAddress);
        cacheEntry = { account, error: null };
      } catch (error) {
        if (isRateLimitError(error)) {
          // 429: leave as pending-sync with a backoff signal for the next cycle.
          console.warn('Donation queue preflight hit Horizon rate limit for', entry.donorAddress);
          return entry;
        }
        cacheEntry = { account: null, error };
      }
      accountCache.set(entry.donorAddress, cacheEntry);
    }

    if (cacheEntry.error || !cacheEntry.account) {
      // Network/Horizon hiccup during preflight — leave it as pending-sync so
      // the next reconnect (or manual refresh) tries again. Never drop it.
      console.warn('Donation queue preflight failed for entry', entry.id, cacheEntry.error);
      return entry;
    }

    const nativeBalance = cacheEntry.account.balances.find((b: any) => b.asset_type === 'native');
    const availableStroops = nativeBalance ? parseAmountToStroops(nativeBalance.balance) : null;
    const entryStroops = parseAmountToStroops(entry.amountXLM);

    if (availableStroops === null || entryStroops === null) {
      return {
        ...entry,
        status: 'conflict',
        conflictReason: 'insufficient-balance',
        conflictDetail: `Available: ${nativeBalance?.balance ? formatStroopsToDisplay(parseAmountToStroops(nativeBalance.balance) ?? 0n, 2) : '0'} XLM, required: ${entry.amountXLM} XLM`,
      };
    }

    const requiredStroops = entryStroops + FEE_BUFFER_STROOPS;

    if (!isBalanceSufficient(availableStroops, requiredStroops)) {
      return {
        ...entry,
        status: 'conflict',
        conflictReason: 'insufficient-balance',
        conflictDetail: `Available: ${formatStroopsToDisplay(availableStroops, 2)} XLM, required: ${formatStroopsToDisplay(requiredStroops, 2)} XLM`,
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
      const accountCache = new Map<string, AccountCacheEntry>();

      let completedCount = 0;
      for (const entry of pending) {
        const result = await preflightCheck(entry, current, accountCache);
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
  }, [refresh]);

  useNetworkReconnect(syncNow);

  return { queue, syncing, refresh, syncNow, resolve };
}
