// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundRequest, BackgroundResponse } from '../messages';

vi.mock('@stellar/freighter-api', () => ({
  isAllowed: vi.fn().mockResolvedValue(false),
  setAllowed: vi.fn().mockResolvedValue(true),
  getUserInfo: vi.fn().mockResolvedValue({ publicKey: '' }),
  signTransaction: vi.fn().mockResolvedValue(''),
}));

import {
  bootstrap,
  renderProjects,
  retryLoadProjects,
  send,
  setInteractive,
} from '../popup';
import type { ProjectSummary } from '../session-state';

describe('Popup session recovery, timeout, and retry affordance', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <header>
        <button id="connect-btn">Connect Wallet</button>
        <div id="wallet-info" class="hidden">
          <span id="wallet-address">--</span>
          <h2 id="wallet-balance">0.00 XLM</h2>
        </div>
      </header>
      <main>
        <div class="section-header">
          <span class="badge">0</span>
        </div>
        <input type="text" id="project-search" />
        <ul id="search-dropdown" class="hidden"></ul>
        <ul id="project-list"></ul>
        <button class="preset-btn" data-amount="1">1 XLM</button>
        <input type="number" id="custom-amount-input" />
        <button id="donate-submit" disabled>Donate</button>
        <div id="status-message"></div>
      </main>
    `;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('exits disabled state and renders retry affordance when background fetch hangs/fails', async () => {
    const sendMessage = vi.fn().mockImplementation((request: BackgroundRequest): Promise<BackgroundResponse> => {
      if (request.type === 'GET_RECOVERY_STATE') {
        return Promise.resolve({
          ok: true,
          snapshot: {
            workerInstanceId: 'worker-1',
            workerRestarted: false,
            wallet: null,
            projects: null, // Forces refreshProjects
            needsWalletValidation: false,
          },
        });
      }
      if (request.type === 'REFRESH_PROJECTS') {
        // Backend hung / timed out
        return Promise.resolve({
          ok: false,
          error: 'Project request timed out after 5000ms',
        });
      }
      return Promise.resolve({ ok: true });
    });

    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage,
      },
      storage: {
        session: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
    });

    await bootstrap();

    const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement;
    expect(connectBtn.disabled).toBe(false);

    const projectList = document.getElementById('project-list') as HTMLUListElement;
    const retryBtn = document.getElementById('retry-projects-btn') as HTMLButtonElement;
    expect(retryBtn).not.toBeNull();
    expect(retryBtn.disabled).toBe(false);
    expect(projectList.textContent).toContain('Projects are temporarily unavailable.');
  });

  it('allows clicking retry button to re-fetch projects successfully', async () => {
    let callCount = 0;
    const sampleProjects: ProjectSummary[] = [
      {
        id: 'p1',
        name: 'Reforestation Hub',
        description: 'Planting native trees',
        category: 'Forestry',
        walletAddress: 'GDUQ24STT6QESP4QW33O4KDVYMRTBHWZ3ZE6HXX5TCNWUZH6MRT7PADV',
      },
    ];

    const sendMessage = vi.fn().mockImplementation((request: BackgroundRequest): Promise<BackgroundResponse> => {
      if (request.type === 'GET_RECOVERY_STATE') {
        return Promise.resolve({
          ok: true,
          snapshot: {
            workerInstanceId: 'worker-1',
            workerRestarted: false,
            wallet: null,
            projects: null,
            needsWalletValidation: false,
          },
        });
      }
      if (request.type === 'REFRESH_PROJECTS') {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: false,
            error: 'Backend temporary failure',
          });
        }
        return Promise.resolve({
          ok: true,
          projects: sampleProjects,
        });
      }
      return Promise.resolve({ ok: true });
    });

    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage,
      },
      storage: {
        session: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
    });

    await bootstrap();

    const retryBtn = document.getElementById('retry-projects-btn') as HTMLButtonElement;
    expect(retryBtn).not.toBeNull();

    // Click retry
    await retryLoadProjects();

    const projectItems = document.querySelectorAll('.project-item');
    expect(projectItems).toHaveLength(1);
    expect(document.querySelector('.project-name')?.textContent).toBe('Reforestation Hub');
  });

  it('popup send() times out when chrome.runtime.sendMessage never settles', async () => {
    const neverEndingSendMessage = vi.fn().mockImplementation(() => new Promise(() => {}));

    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: neverEndingSendMessage,
      },
    });

    await expect(send({ type: 'CLEAR_WALLET_SESSION' }, 50)).rejects.toThrow(
      'Background request timed out after 50ms'
    );
  });
});
