import type { BackgroundRequest, BackgroundResponse } from './messages';
import {
  WorkerSessionState,
  isValidStellarAddress,
  type ProjectSummary,
  type StorageArea,
} from './session-state';

const API_BASE = 'https://api.stellar-greenpay.app';
const API_CLIENT_HEADERS = Object.freeze({
  'X-Client-Name': 'extension',
  'X-Client-Version': '1.0.0',
  'X-Client-API-Version': '1',
});

let defaultState: WorkerSessionState | null = null;

export function getDefaultState(): WorkerSessionState {
  if (!defaultState) {
    const sessionArea =
      typeof chrome !== 'undefined' && chrome.storage?.session
        ? chrome.storage.session
        : typeof chrome !== 'undefined' && chrome.storage?.local
        ? chrome.storage.local
        : (undefined as unknown as StorageArea);
    const localArea =
      typeof chrome !== 'undefined' && chrome.storage?.local
        ? chrome.storage.local
        : (undefined as unknown as StorageArea);
    defaultState = new WorkerSessionState(sessionArea, localArea);
  }
  return defaultState;
}

type ApiEnvelope<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string } };

function toProjectSummary(value: unknown): ProjectSummary | null {
  if (typeof value !== 'object' || value === null) return null;
  const project = value as Record<string, unknown>;
  if (typeof project.id !== 'string' || typeof project.name !== 'string') return null;

  // walletAddress is the payment destination — validate the full StrKey
  // checksum at ingestion time.  A project whose walletAddress is absent,
  // non-string, or fails the checksum is dropped entirely so it never
  // reaches the project cache or the Operation.payment() call.
  if (!isValidStellarAddress(project.walletAddress)) return null;

  return {
    id: project.id,
    name: project.name,
    description: typeof project.description === 'string' ? project.description : '',
    category: typeof project.category === 'string' ? project.category : 'Other',
    walletAddress: project.walletAddress,
  };
}

export const DEFAULT_FETCH_TIMEOUT_MS = 5000;
export const DEFAULT_FETCH_RETRIES = 1;

export async function fetchProjects(
  query?: string,
  state: WorkerSessionState = getDefaultState(),
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  maxRetries = DEFAULT_FETCH_RETRIES
): Promise<ProjectSummary[]> {
  const params = new URLSearchParams({ limit: query ? '5' : '3' });
  if (query) params.set('search', query);
  const url = `${API_BASE}/api/v1/projects?${params}`;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: API_CLIENT_HEADERS,
      });
      clearTimeout(timer);

      const payload = (await response.json()) as ApiEnvelope<unknown[]>;

      if (payload.success === false) {
        throw new Error(`${payload.error.code}: ${payload.error.message}`);
      }

      if (!response.ok) throw new Error(`Project request failed (${response.status})`);

      const values = Array.isArray(payload.data) ? payload.data : [];
      const projects = values
        .map(toProjectSummary)
        .filter((project: ProjectSummary | null): project is ProjectSummary => project !== null);

      // Search results are transient. Only the default popup list is durable.
      if (!query) await state.setProjects(projects);
      return projects;
    } catch (error) {
      clearTimeout(timer);
      const isTimeout =
        controller.signal.aborted ||
        (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'));

      if (isTimeout) {
        lastError = new Error(`Project request timed out after ${timeoutMs}ms`);
      } else {
        lastError = error;
      }

      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Validates that a message sender originates strictly from an extension page
 * (e.g., popup) and not from content scripts or external extensions.
 * In Chrome MV3, extension pages have sender.id === chrome.runtime.id and sender.tab === undefined,
 * whereas content scripts have sender.tab defined.
 */
export function isTrustedExtensionSender(
  sender?: chrome.runtime.MessageSender,
  expectedExtensionId?: string
): boolean {
  if (!sender) return false;
  const runtimeId =
    expectedExtensionId ??
    (typeof chrome !== 'undefined' && chrome.runtime?.id
      ? chrome.runtime.id
      : undefined);

  if (!runtimeId || sender.id !== runtimeId) return false;
  if (sender.tab !== undefined) return false;
  return true;
}

/**
 * Validates and sanitizes raw message payloads at runtime.
 * Guarantees discriminator and field types rather than relying on erased compile-time types.
 */
export function parseBackgroundRequest(raw: unknown): BackgroundRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.type !== 'string') return null;

  switch (obj.type) {
    case 'GET_RECOVERY_STATE': {
      const prevId = obj.previousWorkerInstanceId;
      if (prevId !== null && typeof prevId !== 'string' && prevId !== undefined) {
        return null;
      }
      return {
        type: 'GET_RECOVERY_STATE',
        previousWorkerInstanceId: typeof prevId === 'string' ? prevId : null,
      };
    }
    case 'SET_WALLET_SESSION': {
      if (typeof obj.publicKey !== 'string') {
        return null;
      }
      return {
        type: 'SET_WALLET_SESSION',
        publicKey: obj.publicKey,
      };
    }
    case 'CLEAR_WALLET_SESSION': {
      return {
        type: 'CLEAR_WALLET_SESSION',
      };
    }
    case 'REFRESH_PROJECTS': {
      const query = obj.query;
      const sequence = obj.sequence;
      if (query !== undefined && typeof query !== 'string') {
        return null;
      }
      if (
        sequence !== undefined &&
        (typeof sequence !== 'number' || Number.isNaN(sequence))
      ) {
        return null;
      }
      return {
        type: 'REFRESH_PROJECTS',
        ...(typeof query === 'string' ? { query } : {}),
        ...(typeof sequence === 'number' ? { sequence } : {}),
      };
    }
    default:
      return null;
  }
}

export async function handleMessage(
  rawRequest: unknown,
  sender?: chrome.runtime.MessageSender,
  state: WorkerSessionState = getDefaultState(),
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  fetchRetries = DEFAULT_FETCH_RETRIES
): Promise<BackgroundResponse> {
  if (!isTrustedExtensionSender(sender)) {
    return { ok: false, error: 'Unauthorized sender' };
  }

  const request = parseBackgroundRequest(rawRequest);
  if (!request) {
    return { ok: false, error: 'Invalid or malformed request payload' };
  }

  try {
    switch (request.type) {
      case 'GET_RECOVERY_STATE':
        return {
          ok: true,
          snapshot: await state.snapshot(request.previousWorkerInstanceId),
        };
      case 'SET_WALLET_SESSION':
        return { ok: true, wallet: await state.setWallet(request.publicKey) };
      case 'CLEAR_WALLET_SESSION':
        await state.clearWallet();
        return { ok: true };
      case 'REFRESH_PROJECTS':
        return {
          ok: true,
          projects: await fetchProjects(request.query, state, fetchTimeoutMs, fetchRetries),
          sequence: request.sequence,
          query: request.query,
        };
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown background error',
    };
  }
}

export function onMessageListener(
  request: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: BackgroundResponse) => void
): boolean {
  if (!isTrustedExtensionSender(sender) || !parseBackgroundRequest(request)) {
    return false;
  }

  void handleMessage(request, sender)
    .then((response) => {
      try {
        sendResponse(response);
      } catch {
        // Port may have closed if sender disconnected before response
      }
    })
    .catch((error) => {
      // Prevent unhandled promise rejection if sendResponse or handleMessage throws
      console.warn('GreenPay service worker message error:', error);
    });

  return true;
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(onMessageListener);
}
