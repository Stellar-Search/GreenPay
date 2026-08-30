import { describe, expect, it, vi } from 'vitest';
import { recoverPopupSession, type PopupRecoveryClient } from '../popup-session';
import {
  PROJECT_CACHE_TTL_MS,
  STORAGE_KEYS,
  WALLET_SESSION_TTL_MS,
  WorkerSessionState,
  type StorageArea,
} from '../session-state';

const PUBLIC_KEY = 'GCFANSV7I32AGAS5N4EJEZRZCRGNDH32QDHP3A3BWFV66A7BK5PYTUUS';
const PROJECT = {
  id: 'project-1',
  name: 'Ocean Cleanup',
  description: 'Removing ocean plastic',
  category: 'Ocean Conservation',
  // Real checksum-valid Ed25519 public key — required now that isProject()
  // validates walletAddress with StrKey.isValidEd25519PublicKey rather than
  // only checking typeof === 'string' (fix for issue #339).
  walletAddress: 'GDUQ24STT6QESP4QW33O4KDVYMRTBHWZ3ZE6HXX5TCNWUZH6MRT7PADV',
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

  it('serializes concurrent setWallet and clearWallet mutations to prevent storage desync', async () => {
    class DelayedStorage extends MemoryStorage {
      constructor(private readonly delayMs: number = 20) {
        super();
      }

      override async set(items: Record<string, unknown>) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        await super.set(items);
      }

      override async remove(keys: string | string[]) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        await super.remove(keys);
      }
    }

    const sessionStorage = new DelayedStorage(15);
    const localStorage = new DelayedStorage(5);
    const worker = new WorkerSessionState(sessionStorage, localStorage, () => 50_000, 'worker-concurrent');

    const keyA = 'GCFANSV7I32AGAS5N4EJEZRZCRGNDH32QDHP3A3BWFV66A7BK5PYTUUS';
    const keyB = 'GDUQ24STT6QESP4QW33O4KDVYMRTBHWZ3ZE6HXX5TCNWUZH6MRT7PADV';

    // Interleave setWallet(A) then clearWallet() concurrently
    const [walletA] = await Promise.all([
      worker.setWallet(keyA),
      worker.clearWallet(),
    ]);

    expect(walletA.publicKey).toBe(keyA);

    // Final state must reflect the second operation (clearWallet)
    const snapshotAfterClear = await worker.snapshot(null);
    expect(snapshotAfterClear.wallet).toBeNull();
    expect(sessionStorage.values[STORAGE_KEYS.session]).toBeUndefined();

    // Now interleave clearWallet() then setWallet(B) concurrently
    await Promise.all([
      worker.clearWallet(),
      worker.setWallet(keyB),
    ]);

    const snapshotAfterSet = await worker.snapshot(null);
    expect(snapshotAfterSet.wallet?.publicKey).toBe(keyB);
    const stored = sessionStorage.values[STORAGE_KEYS.session] as Record<string, unknown>;
    expect((stored?.wallet as { publicKey: string })?.publicKey).toBe(keyB);
  });

  it('continues processing serialized mutation queue when an operation rejects', async () => {
    const sessionStorage = new MemoryStorage();
    const localStorage = new MemoryStorage();
    const worker = new WorkerSessionState(sessionStorage, localStorage, () => 60_000, 'worker-error');

    const invalidCall = worker.setWallet('invalid_key');
    const validCall = worker.setWallet(PUBLIC_KEY);

    await expect(invalidCall).rejects.toThrow('Invalid Stellar public key');
    const validWallet = await validCall;

    expect(validWallet.publicKey).toBe(PUBLIC_KEY);
    const snapshot = await worker.snapshot(null);
    expect(snapshot.wallet?.publicKey).toBe(PUBLIC_KEY);
  });
});
