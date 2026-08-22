import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  handleMessage,
  isTrustedExtensionSender,
  parseBackgroundRequest,
} from '../background';
import {
  STORAGE_KEYS,
  WorkerSessionState,
  type StorageArea,
} from '../session-state';

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

const EXTENSION_ID = 'test-extension-id';
const VALID_PUBLIC_KEY = `G${'A'.repeat(55)}`;

describe('Background Sender Validation & Runtime Parsing', () => {
  let originalChrome: unknown;

  beforeEach(() => {
    originalChrome = (globalThis as unknown as { chrome: unknown }).chrome;
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        id: EXTENSION_ID,
      },
    };
  });

  afterEach(() => {
    (globalThis as unknown as { chrome: unknown }).chrome = originalChrome;
  });

  describe('isTrustedExtensionSender', () => {
    it('accepts extension page sender where sender.id matches and sender.tab is undefined', () => {
      const popupSender: chrome.runtime.MessageSender = {
        id: EXTENSION_ID,
        url: `chrome-extension://${EXTENSION_ID}/popup.html`,
      };
      expect(isTrustedExtensionSender(popupSender)).toBe(true);
    });

    it('rejects content-script sender where sender.tab is defined', () => {
      const contentScriptSender: chrome.runtime.MessageSender = {
        id: EXTENSION_ID,
        tab: {
          id: 123,
          index: 0,
          pinned: false,
          highlighted: false,
          windowId: 1,
          active: true,
          incognito: false,
          selected: true,
          discarded: false,
          autoDiscardable: true,
          groupId: -1,
          url: 'https://malicious-page.com',
        },
        url: 'https://malicious-page.com',
      };
      expect(isTrustedExtensionSender(contentScriptSender)).toBe(false);
    });

    it('rejects sender with mismatched extension ID', () => {
      const foreignSender: chrome.runtime.MessageSender = {
        id: 'foreign-extension-id',
      };
      expect(isTrustedExtensionSender(foreignSender)).toBe(false);
    });

    it('rejects undefined or missing sender', () => {
      expect(isTrustedExtensionSender(undefined)).toBe(false);
    });
  });

  describe('parseBackgroundRequest', () => {
    it('parses valid GET_RECOVERY_STATE requests', () => {
      expect(
        parseBackgroundRequest({
          type: 'GET_RECOVERY_STATE',
          previousWorkerInstanceId: 'worker-123',
        })
      ).toEqual({
        type: 'GET_RECOVERY_STATE',
        previousWorkerInstanceId: 'worker-123',
      });

      expect(
        parseBackgroundRequest({
          type: 'GET_RECOVERY_STATE',
          previousWorkerInstanceId: null,
        })
      ).toEqual({
        type: 'GET_RECOVERY_STATE',
        previousWorkerInstanceId: null,
      });

      expect(
        parseBackgroundRequest({
          type: 'GET_RECOVERY_STATE',
        })
      ).toEqual({
        type: 'GET_RECOVERY_STATE',
        previousWorkerInstanceId: null,
      });
    });

    it('parses valid SET_WALLET_SESSION requests', () => {
      expect(
        parseBackgroundRequest({
          type: 'SET_WALLET_SESSION',
          publicKey: VALID_PUBLIC_KEY,
        })
      ).toEqual({
        type: 'SET_WALLET_SESSION',
        publicKey: VALID_PUBLIC_KEY,
      });
    });

    it('parses valid CLEAR_WALLET_SESSION requests', () => {
      expect(
        parseBackgroundRequest({
          type: 'CLEAR_WALLET_SESSION',
        })
      ).toEqual({
        type: 'CLEAR_WALLET_SESSION',
      });
    });

    it('parses valid REFRESH_PROJECTS requests', () => {
      expect(
        parseBackgroundRequest({
          type: 'REFRESH_PROJECTS',
          query: 'solar',
          sequence: 3,
        })
      ).toEqual({
        type: 'REFRESH_PROJECTS',
        query: 'solar',
        sequence: 3,
      });

      expect(
        parseBackgroundRequest({
          type: 'REFRESH_PROJECTS',
        })
      ).toEqual({
        type: 'REFRESH_PROJECTS',
      });
    });

    it('rejects malformed payloads and non-objects', () => {
      expect(parseBackgroundRequest(null)).toBeNull();
      expect(parseBackgroundRequest(undefined)).toBeNull();
      expect(parseBackgroundRequest('SET_WALLET_SESSION')).toBeNull();
      expect(parseBackgroundRequest(123)).toBeNull();
      expect(parseBackgroundRequest({})).toBeNull();
      expect(parseBackgroundRequest({ type: 'UNKNOWN_TYPE' })).toBeNull();
    });

    it('rejects invalid field types for specific request types', () => {
      // SET_WALLET_SESSION requires string publicKey
      expect(parseBackgroundRequest({ type: 'SET_WALLET_SESSION' })).toBeNull();
      expect(parseBackgroundRequest({ type: 'SET_WALLET_SESSION', publicKey: 123 })).toBeNull();
      expect(parseBackgroundRequest({ type: 'SET_WALLET_SESSION', publicKey: null })).toBeNull();

      // GET_RECOVERY_STATE requires previousWorkerInstanceId to be string | null | undefined
      expect(
        parseBackgroundRequest({
          type: 'GET_RECOVERY_STATE',
          previousWorkerInstanceId: 123,
        })
      ).toBeNull();

      // REFRESH_PROJECTS requires query to be string if present
      expect(
        parseBackgroundRequest({
          type: 'REFRESH_PROJECTS',
          query: 123,
        })
      ).toBeNull();

      // REFRESH_PROJECTS requires sequence to be number if present
      expect(
        parseBackgroundRequest({
          type: 'REFRESH_PROJECTS',
          sequence: 'first',
        })
      ).toBeNull();

      expect(
        parseBackgroundRequest({
          type: 'REFRESH_PROJECTS',
          sequence: NaN,
        })
      ).toBeNull();
    });
  });

  describe('handleMessage execution with sender verification and state isolation', () => {
    let sessionStorage: MemoryStorage;
    let localStorage: MemoryStorage;
    let workerState: WorkerSessionState;

    beforeEach(() => {
      sessionStorage = new MemoryStorage();
      localStorage = new MemoryStorage();
      workerState = new WorkerSessionState(
        sessionStorage,
        localStorage,
        () => 10_000,
        'test-worker'
      );
    });

    const trustedSender: chrome.runtime.MessageSender = {
      id: EXTENSION_ID,
    };

    const contentScriptSender: chrome.runtime.MessageSender = {
      id: EXTENSION_ID,
      tab: {
        id: 1,
        index: 0,
        pinned: false,
        highlighted: false,
        windowId: 1,
        active: true,
        incognito: false,
        selected: true,
        discarded: false,
        autoDiscardable: true,
        groupId: -1,
      },
    };

    it('accepts SET_WALLET_SESSION from trusted popup sender and updates session state', async () => {
      const response = await handleMessage(
        { type: 'SET_WALLET_SESSION', publicKey: VALID_PUBLIC_KEY },
        trustedSender,
        workerState
      );

      expect(response.ok).toBe(true);
      if (response.ok && 'wallet' in response) {
        expect(response.wallet.publicKey).toBe(VALID_PUBLIC_KEY);
      }

      const snapshot = await workerState.snapshot(null);
      expect(snapshot.wallet?.publicKey).toBe(VALID_PUBLIC_KEY);
      expect(sessionStorage.values[STORAGE_KEYS.session]).toBeDefined();
    });

    it('rejects SET_WALLET_SESSION from content-script sender and does NOT mutate state', async () => {
      const response = await handleMessage(
        { type: 'SET_WALLET_SESSION', publicKey: VALID_PUBLIC_KEY },
        contentScriptSender,
        workerState
      );

      expect(response.ok).toBe(false);
      if (!response.ok) {
        expect(response.error).toContain('Unauthorized sender');
      }

      const snapshot = await workerState.snapshot(null);
      expect(snapshot.wallet).toBeNull();
      expect(sessionStorage.values[STORAGE_KEYS.session]).toBeUndefined();
    });

    it('accepts CLEAR_WALLET_SESSION from trusted popup sender and clears session state', async () => {
      await workerState.setWallet(VALID_PUBLIC_KEY);

      const response = await handleMessage(
        { type: 'CLEAR_WALLET_SESSION' },
        trustedSender,
        workerState
      );

      expect(response.ok).toBe(true);
      const snapshot = await workerState.snapshot(null);
      expect(snapshot.wallet).toBeNull();
      expect(sessionStorage.values[STORAGE_KEYS.session]).toBeUndefined();
    });

    it('rejects CLEAR_WALLET_SESSION from content-script sender and preserves existing session state', async () => {
      await workerState.setWallet(VALID_PUBLIC_KEY);

      const response = await handleMessage(
        { type: 'CLEAR_WALLET_SESSION' },
        contentScriptSender,
        workerState
      );

      expect(response.ok).toBe(false);
      if (!response.ok) {
        expect(response.error).toContain('Unauthorized sender');
      }

      const snapshot = await workerState.snapshot(null);
      expect(snapshot.wallet?.publicKey).toBe(VALID_PUBLIC_KEY);
      expect(sessionStorage.values[STORAGE_KEYS.session]).toBeDefined();
    });

    it('accepts GET_RECOVERY_STATE from trusted popup sender', async () => {
      await workerState.setWallet(VALID_PUBLIC_KEY);

      const response = await handleMessage(
        { type: 'GET_RECOVERY_STATE', previousWorkerInstanceId: 'previous-worker' },
        trustedSender,
        workerState
      );

      expect(response.ok).toBe(true);
      if (response.ok && 'snapshot' in response) {
        expect(response.snapshot.workerRestarted).toBe(true);
        expect(response.snapshot.wallet?.publicKey).toBe(VALID_PUBLIC_KEY);
      }
    });

    it('rejects GET_RECOVERY_STATE from content-script sender', async () => {
      const response = await handleMessage(
        { type: 'GET_RECOVERY_STATE', previousWorkerInstanceId: null },
        contentScriptSender,
        workerState
      );

      expect(response.ok).toBe(false);
      if (!response.ok) {
        expect(response.error).toContain('Unauthorized sender');
      }
    });

    it('rejects requests from sender with untrusted extension ID', async () => {
      const foreignSender: chrome.runtime.MessageSender = {
        id: 'attacker-extension-id',
      };

      const response = await handleMessage(
        { type: 'SET_WALLET_SESSION', publicKey: VALID_PUBLIC_KEY },
        foreignSender,
        workerState
      );

      expect(response.ok).toBe(false);
      if (!response.ok) {
        expect(response.error).toContain('Unauthorized sender');
      }
      expect(sessionStorage.values[STORAGE_KEYS.session]).toBeUndefined();
    });

    it('rejects malformed payloads even from trusted sender', async () => {
      const response = await handleMessage(
        { type: 'SET_WALLET_SESSION', publicKey: 12345 },
        trustedSender,
        workerState
      );

      expect(response.ok).toBe(false);
      if (!response.ok) {
        expect(response.error).toContain('Invalid or malformed request payload');
      }
      expect(sessionStorage.values[STORAGE_KEYS.session]).toBeUndefined();
    });

    it('returns error when payload contains invalid Stellar public key during setWallet', async () => {
      const response = await handleMessage(
        { type: 'SET_WALLET_SESSION', publicKey: 'invalid-stellar-key' },
        trustedSender,
        workerState
      );

      expect(response.ok).toBe(false);
      if (!response.ok) {
        expect(response.error).toContain('Invalid Stellar public key');
      }
      expect(sessionStorage.values[STORAGE_KEYS.session]).toBeUndefined();
    });
  });
});
