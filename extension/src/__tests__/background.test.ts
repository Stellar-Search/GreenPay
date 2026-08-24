import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchProjects,
  handleMessage,
  isTrustedExtensionSender,
  onMessageListener,
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
const VALID_PUBLIC_KEY = 'GDUQ24STT6QESP4QW33O4KDVYMRTBHWZ3ZE6HXX5TCNWUZH6MRT7PADV';

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

  describe('fetchProjects Timeout, AbortController, and Retries', () => {
    let originalFetch: typeof globalThis.fetch;
    let sessionStorage: MemoryStorage;
    let localStorage: MemoryStorage;
    let workerState: WorkerSessionState;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      sessionStorage = new MemoryStorage();
      localStorage = new MemoryStorage();
      workerState = new WorkerSessionState(
        sessionStorage,
        localStorage,
        () => 10_000,
        'test-worker'
      );
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('aborts and surfaces a structured timeout error when fetch never resolves', async () => {
      // Simulate a hung / never-resolving network request
      globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              const abortError = new Error('The operation was aborted');
              abortError.name = 'AbortError';
              reject(abortError);
            });
          }
        });
      });

      // Bounded timeout of 50ms with 0 retries
      await expect(fetchProjects('solar', workerState, 50, 0)).rejects.toThrow(
        'Project request timed out after 50ms'
      );
    });

    it('surfaces structured timeout error through handleMessage REFRESH_PROJECTS', async () => {
      globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              const abortError = new Error('The operation was aborted');
              abortError.name = 'AbortError';
              reject(abortError);
            });
          }
        });
      });

      const trustedSender: chrome.runtime.MessageSender = { id: EXTENSION_ID };
      const response = await handleMessage(
        { type: 'REFRESH_PROJECTS', query: 'solar', sequence: 1 },
        trustedSender,
        workerState,
        50,
        0
      );

      expect(response.ok).toBe(false);
      if (!response.ok) {
        expect(response.error).toContain('timed out');
      }
    });

    it('retries bounded number of times and succeeds if second attempt resolves', async () => {
      let attempts = 0;
      globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        attempts++;
        if (attempts === 1) {
          return new Promise((_resolve, reject) => {
            if (init?.signal) {
              init.signal.addEventListener('abort', () => {
                const abortError = new Error('The operation was aborted');
                abortError.name = 'AbortError';
                reject(abortError);
              });
            }
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: [
              {
                id: 'proj-1',
                name: 'Solar Power',
                description: 'Clean energy',
                category: 'Energy',
                walletAddress: VALID_PUBLIC_KEY,
              },
            ],
          }),
        } as unknown as Response);
      });

      const projects = await fetchProjects('solar', workerState, 30, 1);
      expect(attempts).toBe(2);
      expect(projects).toHaveLength(1);
      expect(projects[0].name).toBe('Solar Power');
    });
  });

  describe('onMessageListener Port & Error Boundary Handling', () => {
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

    it('returns false for unhandled / unrecognized request types to prevent holding ports open', () => {
      const trustedSender: chrome.runtime.MessageSender = { id: EXTENSION_ID };
      const sendResponse = vi.fn();

      const result = onMessageListener({ type: 'UNRECOGNIZED_ACTION' }, trustedSender, sendResponse);
      expect(result).toBe(false);
      expect(sendResponse).not.toHaveBeenCalled();
    });

    it('returns false for untrusted sender origins', () => {
      const contentScriptSender: chrome.runtime.MessageSender = {
        id: EXTENSION_ID,
        tab: { id: 1 } as chrome.tabs.Tab,
      };
      const sendResponse = vi.fn();

      const result = onMessageListener(
        { type: 'CLEAR_WALLET_SESSION' },
        contentScriptSender,
        sendResponse
      );
      expect(result).toBe(false);
      expect(sendResponse).not.toHaveBeenCalled();
    });

    it('returns true for handled request types from trusted sender', () => {
      const trustedSender: chrome.runtime.MessageSender = { id: EXTENSION_ID };
      const sendResponse = vi.fn();

      const result = onMessageListener(
        { type: 'CLEAR_WALLET_SESSION' },
        trustedSender,
        sendResponse
      );
      expect(result).toBe(true);
    });

    it('safely catches errors when sendResponse throws because the popup closed mid-flight', async () => {
      const trustedSender: chrome.runtime.MessageSender = { id: EXTENSION_ID };
      const throwingSendResponse = vi.fn().mockImplementation(() => {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      });

      // Spy on console.warn
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = onMessageListener(
        { type: 'CLEAR_WALLET_SESSION' },
        trustedSender,
        throwingSendResponse
      );

      expect(result).toBe(true);
      // Allow async chain to execute
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(throwingSendResponse).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});
