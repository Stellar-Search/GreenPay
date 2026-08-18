import type { BackgroundRequest, BackgroundResponse } from './messages';
import {
  WorkerSessionState,
  type ProjectSummary,
} from './session-state';

const API_BASE = 'https://api.stellar-greenpay.app';
const sessionArea = chrome.storage.session ?? chrome.storage.local;
const state = new WorkerSessionState(sessionArea, chrome.storage.local);

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

async function fetchProjects(query?: string): Promise<ProjectSummary[]> {
  const params = new URLSearchParams({ limit: query ? '5' : '3' });
  if (query) params.set('search', query);
  const response = await fetch(`${API_BASE}/api/projects?${params}`);
  if (!response.ok) throw new Error(`Project request failed (${response.status})`);

  const payload = await response.json();
  const values = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload)
      ? payload
      : [];
  const projects = values
    .map(toProjectSummary)
    .filter((project: ProjectSummary | null): project is ProjectSummary => project !== null);

  // Search results are transient. Only the default popup list is durable.
  if (!query) await state.setProjects(projects);
  return projects;
}

async function handleMessage(request: BackgroundRequest): Promise<BackgroundResponse> {
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
          projects: await fetchProjects(request.query),
          sequence: request.sequence,
          query: request.query,
        };
      default:
        return { ok: false, error: 'Unsupported background request' };
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown background error',
    };
  }
}

chrome.runtime.onMessage.addListener(
  (
    request: BackgroundRequest,
    _sender,
    sendResponse: (response: BackgroundResponse) => void
  ) => {
    void handleMessage(request).then(sendResponse);
    return true;
  }
);
