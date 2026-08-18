import { describe, expect, it, vi } from 'vitest';
import { recoverPopupSession, type PopupRecoveryClient } from '../popup-session';
import {
  PROJECT_CACHE_TTL_MS,
  STORAGE_KEYS,
  WALLET_SESSION_TTL_MS,
  WorkerSessionState,
  type StorageArea,
} from '../session-state';

// Real, checksum-valid Stellar public keys. The previous fixtures used
// `G${'A'.repeat(55)}`-style strings, which only matched the shape regex and
// are rejected by the StrKey-backed session validator.
const PUBLIC_KEY = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const PROJECT = {
  id: 'project-1',
  name: 'Ocean Cleanup',
  description: 'Removing ocean plastic',
  category: 'Ocean Conservation',
  walletAddress: 'GB2X5SMMHQ2XJPDUOPA36DLNKG4PHVJOUSTM6FJUR2LIDUBH7IQGO3P6',
};

class MemoryStorage implements StorageArea {
  readonly values: Record<string, unknown> = {};

  async get(keys?: string | string[] | Record<string, unknown> | null) {
    if (typeof keys === 'string') return { [keys]: this.values[keys] };
    if (Array.isArray(keys)) {
      return Object.fromEntries(keys.map((key) => [key, this.values[key]]));
    }
    return { ...this.values };
  }

  async set(items: Record<string, unknown>) {
    Object.assign(this.values, items);
  }

  async remove(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete this.values[key];
  }
}

describe('MV3 session recovery', () => {
  it('rehydrates wallet and project state after forced worker termination', async () => {
    const sessionStorage = new MemoryStorage();
    const localStorage = new MemoryStorage();
    const now = () => 10_000;

    const firstWorker = new WorkerSessionState(
      sessionStorage,
      localStorage,
      now,
      'worker-before-termination'
    );
    await firstWorker.setWallet(PUBLIC_KEY);
    await firstWorker.setProjects([PROJECT]);

    // Dropping the first instance simulates chrome://serviceworker-internals
    // terminating the worker. A new module instance gets the same storage.
    const restartedWorker = new WorkerSessionState(
      sessionStorage,
      localStorage,
      now,
      'worker-after-termination'
    );
    const refreshProjects = vi.fn();
    let rememberedWorker = '';

    const client: PopupRecoveryClient = {
      getPreviousWorkerInstanceId: async () => 'worker-before-termination',
      getRecoveryState: (previous) => restartedWorker.snapshot(previous),
      probeWallet: async () => PUBLIC_KEY,
      setWallet: (publicKey) => restartedWorker.setWallet(publicKey),
      clearWallet: () => restartedWorker.clearWallet(),
      refreshProjects,
      rememberWorkerInstanceId: async (workerId) => {
        rememberedWorker = workerId;
      },
    };

    const recovered = await recoverPopupSession(client);

    expect(recovered.workerRestarted).toBe(true);
    expect(recovered.wallet?.publicKey).toBe(PUBLIC_KEY);
    expect(recovered.projects).toEqual([PROJECT]);
    expect(recovered.needsWalletValidation).toBe(false);
    expect(refreshProjects).not.toHaveBeenCalled();
    expect(rememberedWorker).toBe('worker-after-termination');
  });

  it('invalidates a wallet session when Freighter is locked after restart', async () => {
    const sessionStorage = new MemoryStorage();
    const localStorage = new MemoryStorage();
    const worker = new WorkerSessionState(sessionStorage, localStorage, () => 20_000, 'worker-2');
    await worker.setWallet(PUBLIC_KEY);
    await worker.setProjects([PROJECT]);

    const client: PopupRecoveryClient = {
      getPreviousWorkerInstanceId: async () => 'worker-1',
      getRecoveryState: (previous) => worker.snapshot(previous),
      probeWallet: async () => null,
      setWallet: (publicKey) => worker.setWallet(publicKey),
      clearWallet: () => worker.clearWallet(),
      refreshProjects: async () => [],
      rememberWorkerInstanceId: async () => undefined,
    };

    const recovered = await recoverPopupSession(client);

    expect(recovered.wallet).toBeNull();
    expect(sessionStorage.values[STORAGE_KEYS.session]).toBeUndefined();
  });

  it('expires wallet and project caches using their independent TTLs', async () => {
    const sessionStorage = new MemoryStorage();
    const localStorage = new MemoryStorage();
    let currentTime = 1_000;
    const firstWorker = new WorkerSessionState(
      sessionStorage,
      localStorage,
      () => currentTime,
      'worker-1'
    );
    await firstWorker.setWallet(PUBLIC_KEY);
    await firstWorker.setProjects([PROJECT]);

    currentTime += Math.max(WALLET_SESSION_TTL_MS, PROJECT_CACHE_TTL_MS) + 1;
    // Expiry is enforced even if Chrome happens to keep this worker alive.
    const snapshot = await firstWorker.snapshot('worker-1');

    expect(snapshot.wallet).toBeNull();
    expect(snapshot.projects).toBeNull();
    expect(sessionStorage.values[STORAGE_KEYS.session]).toBeUndefined();
    expect(localStorage.values[STORAGE_KEYS.projects]).toBeUndefined();
  });

  it('discards data written with an incompatible schema', async () => {
    const sessionStorage = new MemoryStorage();
    const localStorage = new MemoryStorage();
    sessionStorage.values[STORAGE_KEYS.session] = {
      schemaVersion: 0,
      wallet: { publicKey: PUBLIC_KEY, network: 'TESTNET', validatedAt: 1 },
    };
    localStorage.values[STORAGE_KEYS.projects] = {
      schemaVersion: 0,
      projects: [PROJECT],
      cachedAt: 1,
    };

    const worker = new WorkerSessionState(sessionStorage, localStorage, () => 2, 'worker');
    const snapshot = await worker.snapshot(null);

    expect(snapshot.wallet).toBeNull();
    expect(snapshot.projects).toBeNull();
  });
});
