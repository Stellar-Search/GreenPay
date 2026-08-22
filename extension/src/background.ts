import type { BackgroundRequest, BackgroundResponse } from './messages';
import {
  WorkerSessionState,
  type ProjectSummary,
  type StorageArea,
} from './session-state';

const API_BASE = 'https://api.stellar-greenpay.app';

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

  return {
    id: project.id,
    name: project.name,
    description: typeof project.description === 'string' ? project.description : '',
    category: typeof project.category === 'string' ? project.category : 'Other',
    walletAddress:
      typeof project.walletAddress === 'string' ? project.walletAddress : '',
  };
}

export async function fetchProjects(
  query?: string,
  state: WorkerSessionState = getDefaultState()
): Promise<ProjectSummary[]> {
  const params = new URLSearchParams({ limit: query ? '5' : '3' });
  if (query) params.set('search', query);
  const response = await fetch(`${API_BASE}/api/projects?${params}`);
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
  state: WorkerSessionState = getDefaultState()
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
          projects: await fetchProjects(request.query, state),
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

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(
    (
      request: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response: BackgroundResponse) => void
    ) => {
      void handleMessage(request, sender).then(sendResponse);
      return true;
    }
  );
}
