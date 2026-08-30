import {
  getNetwork,
  getNetworkDetails,
  getUserInfo,
  isAllowed,
  setAllowed,
  signTransaction,
} from '@stellar/freighter-api';
import {
  Asset,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { isBadSequenceError } from './horizon-errors';
import type { BackgroundRequest, BackgroundResponse } from './messages';
import { activeManifest } from './network-config';
import { recoverPopupSession, type PopupRecoveryClient } from './popup-session';
import { SearchCoordinator } from './popup-search';
import {
  STORAGE_KEYS,
  isValidStellarAddress,
  type ProjectSummary,
  type RecoverySnapshot,
  type WalletSession,
} from './session-state';

export const server = new Horizon.Server(activeManifest.horizonUrl);
function getSessionArea(): StorageArea {
  if (typeof chrome !== 'undefined' && chrome.storage?.session) {
    return chrome.storage.session;
  }
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    return chrome.storage.local;
  }
  return undefined as unknown as StorageArea;
}

export function getElements() {
  if (typeof document === 'undefined') return null;
  return {
    connectBtn: document.getElementById('connect-btn') as HTMLButtonElement | null,
    walletInfo: document.getElementById('wallet-info') as HTMLDivElement | null,
    walletAddress: document.getElementById('wallet-address') as HTMLSpanElement | null,
    walletBalance: document.getElementById('wallet-balance') as HTMLHeadingElement | null,
    projectList: document.getElementById('project-list') as HTMLUListElement | null,
    projectCount: document.querySelector('.section-header .badge') as HTMLSpanElement | null,
    presetBtns: document.querySelectorAll<HTMLButtonElement>('.preset-btn'),
    customInput: document.getElementById('custom-amount-input') as HTMLInputElement | null,
    donateBtn: document.getElementById('donate-submit') as HTMLButtonElement | null,
    statusMsg: document.getElementById('status-message') as HTMLDivElement | null,
    searchInput: document.getElementById('project-search') as HTMLInputElement | null,
    searchDropdown: document.getElementById('search-dropdown') as HTMLUListElement | null,
  };
}

let currentWallet: WalletSession | null = null;
let currentProjects: ProjectSummary[] = [];
let activeProject: ProjectSummary | null = null;
let currentDonationAmount = 0;

export const DEFAULT_POPUP_SEND_TIMEOUT_MS = 10000;

export function setInteractive(enabled: boolean) {
  const els = getElements();
  if (els?.connectBtn) els.connectBtn.disabled = !enabled;
  if (els?.searchInput) els.searchInput.disabled = !enabled;
  if (els?.customInput) els.customInput.disabled = !enabled;
  els?.presetBtns?.forEach((button) => {
    button.disabled = !enabled;
  });
  const retryBtn = typeof document !== 'undefined' ? (document.getElementById('retry-projects-btn') as HTMLButtonElement | null) : null;
  if (retryBtn) {
    retryBtn.disabled = !enabled;
  }
  updateDonateButton();
}

export function showStatus(message: string, kind?: 'error' | 'success') {
  const els = getElements();
  if (!els?.statusMsg) return;
  els.statusMsg.textContent = message;
  els.statusMsg.className = `status-message${kind ? ` ${kind}` : ''}`;
}

export function updateDonateButton() {
  // Guard: the donate button must not arm against an invalid destination.
  // isValidStellarAddress performs the full StrKey checksum check — a
  // non-empty but checksum-invalid address that slipped through would cause
  // the Horizon operation to fail after the user has already confirmed in
  // Freighter.  Blocking it here provides the earliest possible feedback.
  const destinationOk = isValidStellarAddress(activeProject?.walletAddress);
  const els = getElements();
  if (!els?.donateBtn) return;
  els.donateBtn.disabled =
    (els.connectBtn ? els.connectBtn.disabled : false) ||
    !currentWallet ||
    !destinationOk ||
    currentDonationAmount <= 0;
}

export async function send(
  request: BackgroundRequest,
  timeoutMs = DEFAULT_POPUP_SEND_TIMEOUT_MS
): Promise<BackgroundResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Background request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([
      chrome.runtime.sendMessage(request) as Promise<BackgroundResponse>,
      timeoutPromise,
    ]);
    if (!response?.ok) {
      throw new Error(response?.error ?? 'The GreenPay service worker did not respond');
    }
    return response;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export async function probeWallet(): Promise<string | null> {
  try {
    if (!(await isAllowed())) return null;
    const info = await getUserInfo();
    return info.publicKey || null;
  } catch {
    return null;
  }
}

export const recoveryClient: PopupRecoveryClient = {
  async getPreviousWorkerInstanceId() {
    const sessionArea = getSessionArea();
    if (!sessionArea) return null;
    const stored = await sessionArea.get(STORAGE_KEYS.lastPopupWorker);
    const value = stored[STORAGE_KEYS.lastPopupWorker];
    return typeof value === 'string' ? value : null;
  },
  async getRecoveryState(previousWorkerInstanceId) {
    const response = await send({
      type: 'GET_RECOVERY_STATE',
      previousWorkerInstanceId,
    });
    if ('snapshot' in response) return response.snapshot;
    throw new Error('Invalid recovery response');
  },
  probeWallet,
  async setWallet(publicKey) {
    const response = await send({ type: 'SET_WALLET_SESSION', publicKey });
    if ('wallet' in response) return response.wallet;
    throw new Error('Invalid wallet response');
  },
  async clearWallet() {
    await send({ type: 'CLEAR_WALLET_SESSION' });
  },
  async refreshProjects() {
    const response = await send({ type: 'REFRESH_PROJECTS' });
    if ('projects' in response) return response.projects;
    throw new Error('Invalid project response');
  },
  async rememberWorkerInstanceId(workerInstanceId) {
    const sessionArea = getSessionArea();
    if (!sessionArea) return;
    await sessionArea.set({ [STORAGE_KEYS.lastPopupWorker]: workerInstanceId });
  },
};

export function renderWallet(wallet: WalletSession | null) {
  currentWallet = wallet;
  const els = getElements();
  if (els?.connectBtn) els.connectBtn.classList.toggle('hidden', wallet !== null);
  if (els?.walletInfo) els.walletInfo.classList.toggle('hidden', wallet === null);
  if (els?.walletAddress) {
    els.walletAddress.textContent = wallet
      ? `${wallet.publicKey.slice(0, 5)}...${wallet.publicKey.slice(-4)}`
      : '--';
  }
  if (els?.walletBalance) els.walletBalance.textContent = '0.00 XLM';
  updateDonateButton();
  if (wallet) void fetchBalance(wallet.publicKey);
}

export async function fetchBalance(publicKey: string) {
  try {
    const account = await server.loadAccount(publicKey);
    const balance = account.balances.find((item) => item.asset_type === 'native');
    const els = getElements();
    if (currentWallet?.publicKey === publicKey && balance && els?.walletBalance) {
      els.walletBalance.textContent = `${Number.parseFloat(balance.balance).toFixed(2)} XLM`;
    }
  } catch {
    const els = getElements();
    if (currentWallet?.publicKey === publicKey && els?.walletBalance) {
      els.walletBalance.textContent = '0.00 XLM';
    }
  }
}

export function selectProject(project: ProjectSummary) {
  activeProject = project;
  const els = getElements();
  if (els?.projectList) {
    els.projectList.querySelectorAll<HTMLElement>('.project-item').forEach((item) => {
      item.classList.toggle('active', item.dataset.projectId === project.id);
    });
  }
  updateDonateButton();
}

export async function retryLoadProjects() {
  setInteractive(false);
  showStatus('Loading projects…');
  try {
    const projects = await recoveryClient.refreshProjects();
    renderProjects(projects);
    showStatus('');
  } catch (error) {
    renderProjects([]);
    showStatus(
      error instanceof Error ? `Failed to load projects: ${error.message}` : 'Failed to load projects.',
      'error'
    );
  } finally {
    setInteractive(true);
  }
}

export function renderProjects(projects: ProjectSummary[]) {
  currentProjects = projects;
  activeProject = null;
  const els = getElements();
  if (!els?.projectList) return;
  els.projectList.innerHTML = '';
  if (els.projectCount) els.projectCount.textContent = String(projects.length);

  if (projects.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'glass-panel project-item empty-state';

    const message = document.createElement('span');
    message.className = 'project-desc';
    message.textContent = 'Projects are temporarily unavailable.';

    const retryBtn = document.createElement('button');
    retryBtn.id = 'retry-projects-btn';
    retryBtn.className = 'btn glow-btn';
    retryBtn.textContent = 'Retry';
    retryBtn.type = 'button';
    retryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void retryLoadProjects();
    });

    empty.append(message, retryBtn);
    els.projectList.appendChild(empty);
    return;
  }

  projects.forEach((project, index) => {
    const item = document.createElement('li');
    item.className = `glass-panel project-item${index === 0 ? ' active' : ''}`;
    item.dataset.projectId = project.id;

    const avatar = document.createElement('div');
    avatar.className = 'project-avatar';
    const info = document.createElement('div');
    info.className = 'project-info';
    const name = document.createElement('div');
    name.className = 'project-name';
    name.textContent = project.name;
    const description = document.createElement('div');
    description.className = 'project-desc';
    description.textContent = project.description || project.category;
    info.append(name, description);
    item.append(avatar, info);
    item.addEventListener('click', () => selectProject(project));
    els.projectList!.appendChild(item);

    if (index === 0) activeProject = project;
  });
  updateDonateButton();
}

export function renderSearchResults(
  projects: ProjectSummary[],
  sequence?: number,
  query?: string
) {
  if (sequence !== undefined && sequence !== searchCoordinator.getLatestSequence()) {
    return;
  }
  const els = getElements();
  if (
    query !== undefined &&
    (query !== searchCoordinator.getLatestQuery() || query !== els?.searchInput?.value.trim())
  ) {
    return;
  }
  if (!els?.searchDropdown) return;
  els.searchDropdown.innerHTML = '';
  if (projects.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'search-no-results';
    empty.textContent = 'No projects found';
    els.searchDropdown.appendChild(empty);
  } else {
    projects.forEach((project) => {
      const item = document.createElement('li');
      const info = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'search-result-name';
      name.textContent = project.name;
      const category = document.createElement('div');
      category.className = 'search-result-cat';
      category.textContent = project.category;
      info.append(name, category);
      item.appendChild(info);
      item.addEventListener('mousedown', (event) => {
        event.preventDefault();
        if (!currentProjects.some(({ id }) => id === project.id)) {
          renderProjects([project, ...currentProjects].slice(0, 3));
        }
        selectProject(project);
        if (els.searchInput) els.searchInput.value = project.name;
        els.searchDropdown?.classList.add('hidden');
      });
      els.searchDropdown.appendChild(item);
    });
  }
  els.searchDropdown.classList.remove('hidden');
}

export const searchCoordinator = new SearchCoordinator({
  send,
  renderSearchResults,
  hideDropdown: () => {
    const els = getElements();
    els?.searchDropdown?.classList.add('hidden');
  },
  getCurrentQuery: () => {
    const els = getElements();
    return els?.searchInput?.value ?? '';
  },
});

export async function connectWallet() {
  setInteractive(false);
  showStatus('Connecting…');
  try {
    if (!(await isAllowed())) await setAllowed();
    const publicKey = await probeWallet();
    if (!publicKey) throw new Error('Freighter is locked or access was not granted.');

    const response = await send({ type: 'SET_WALLET_SESSION', publicKey });
    if (!('wallet' in response)) throw new Error('Invalid wallet response');
    renderWallet(response.wallet);
    showStatus('');
  } catch (error) {
    renderWallet(null);
    showStatus(error instanceof Error ? error.message : 'Failed to connect wallet.', 'error');
  } finally {
    setInteractive(true);
  }
}

export async function verifyFreighterNetwork(): Promise<void> {
  let checked = false;
  try {
    const details = await getNetworkDetails();
    if (details && typeof details === 'object') {
      if (details.networkPassphrase) {
        checked = true;
        if (details.networkPassphrase !== activeManifest.networkPassphrase) {
          throw new Error(
            `Freighter is connected to "${details.network || 'another network'}", but GreenPay requires "${activeManifest.network.toUpperCase()}". Please switch networks in Freighter.`
          );
        }
        return;
      }
      if (details.network) {
        checked = true;
        const activeUpper = activeManifest.network.toUpperCase();
        const freighterUpper = details.network.toUpperCase();
        const isMatch =
          freighterUpper === activeUpper ||
          (activeUpper === 'MAINNET' && freighterUpper === 'PUBLIC') ||
          (activeUpper === 'TESTNET' && freighterUpper === 'TESTNET');
        if (!isMatch) {
          throw new Error(
            `Freighter is connected to "${details.network}", but GreenPay requires "${activeUpper}". Please switch networks in Freighter.`
          );
        }
        return;
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('switch networks')) {
      throw error;
    }
  }

  if (!checked) {
    try {
      const network = await getNetwork();
      if (network && typeof network === 'string') {
        const activeUpper = activeManifest.network.toUpperCase();
        const freighterUpper = network.toUpperCase();
        const isMatch =
          freighterUpper === activeUpper ||
          (activeUpper === 'MAINNET' && freighterUpper === 'PUBLIC') ||
          (activeUpper === 'TESTNET' && freighterUpper === 'TESTNET');
        if (!isMatch) {
          throw new Error(
            `Freighter is connected to "${network}", but GreenPay requires "${activeUpper}". Please switch networks in Freighter.`
          );
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('switch networks')) {
        throw error;
      }
    }
  }
}

export async function buildDonationTransaction(project: ProjectSummary, amount: number) {
  if (!currentWallet) throw new Error('Connect your wallet first.');
  await verifyFreighterNetwork();
  const account = await server.loadAccount(currentWallet.publicKey);
  const transaction = new TransactionBuilder(account, {
    fee: (await server.fetchBaseFee()).toString(),
    networkPassphrase: activeManifest.networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: project.walletAddress,
        asset: Asset.native(),
        amount: amount.toFixed(7),
      })
    )
    .setTimeout(30)
    .build();
  return transaction.toXDR();
}

export async function submitDonation(
  project: ProjectSummary,
  amount: number,
  retryCount = 0
): Promise<{ hash: string }> {
  if (!currentWallet) throw new Error('Connect your wallet first.');
  const expectedPublicKey = currentWallet.publicKey;

  const xdr = await buildDonationTransaction(project, amount);
  const signedXdr = await signTransaction(xdr, {
    networkPassphrase: activeManifest.networkPassphrase,
    network: activeManifest.network.toUpperCase(),
    accountToSign: expectedPublicKey,
  });

  if (!signedXdr || typeof signedXdr !== 'string') {
    throw new Error('Signing was cancelled or returned an empty transaction.');
  }

  const transaction = TransactionBuilder.fromXDR(signedXdr, activeManifest.networkPassphrase);

  if (transaction.source !== expectedPublicKey) {
    throw new Error('Transaction source account does not match active session wallet.');
  }

  const keypair = Keypair.fromPublicKey(expectedPublicKey);
  const isSignedByExpectedAccount = transaction.signatures.some((sig) => {
    try {
      return keypair.verify(transaction.hash(), sig.signature());
    } catch {
      return false;
    }
  });

  if (!isSignedByExpectedAccount) {
    throw new Error('Transaction was signed with a different account than expected.');
  }

  const currentPublicKey = await probeWallet();
  if (currentPublicKey && currentPublicKey !== expectedPublicKey) {
    await recoveryClient.clearWallet();
    renderWallet(null);
    throw new Error('Wallet account changed during signing. Reconnect to continue.');
  }

  try {
    return await server.submitTransaction(transaction);
  } catch (error) {
    if (isBadSequenceError(error) && retryCount === 0) {
      showStatus('Sequence number changed — rebuilding transaction…');
      return submitDonation(project, amount, retryCount + 1);
    }
    throw error;
  }
}

export async function donate() {
  if (!currentWallet || !activeProject || currentDonationAmount <= 0) return;
  setInteractive(false);
  showStatus('Confirm the donation in Freighter…');
  try {
    await verifyFreighterNetwork();
    const currentPublicKey = await probeWallet();
    if (currentPublicKey !== currentWallet.publicKey) {
      await recoveryClient.clearWallet();
      renderWallet(null);
      throw new Error('Wallet account changed or was locked. Reconnect to continue.');
    }

    const result = await submitDonation(activeProject, currentDonationAmount);
    showStatus(`Donation sent! ${result.hash.slice(0, 12)}…`, 'success');
  } catch (error) {
    showStatus(error instanceof Error ? error.message : 'Donation failed.', 'error');
  } finally {
    setInteractive(true);
  }
}

export async function bootstrap() {
  setInteractive(false);
  showStatus('Restoring session…');
  try {
    const snapshot: RecoverySnapshot = await recoverPopupSession(recoveryClient);
    renderWallet(snapshot.wallet);
    renderProjects(snapshot.projects ?? []);
    showStatus('');
  } catch (error) {
    renderWallet(null);
    renderProjects([]);
    showStatus(
      error instanceof Error ? `Session recovery failed: ${error.message}` : 'Session recovery failed.',
      'error'
    );
  } finally {
    setInteractive(true);
  }
}

export function setupEventListeners() {
  const els = getElements();
  if (!els) return;

  if (els.connectBtn) els.connectBtn.addEventListener('click', () => void connectWallet());
  if (els.donateBtn) els.donateBtn.addEventListener('click', () => void donate());
  if (els.customInput) {
    els.customInput.addEventListener('input', () => {
      els.presetBtns?.forEach((button) => button.classList.remove('active'));
      currentDonationAmount = Number.parseFloat(els.customInput!.value) || 0;
      updateDonateButton();
    });
  }
  if (els.presetBtns) {
    for (const button of els.presetBtns) {
      button.addEventListener('click', () => {
        els.presetBtns.forEach((item) => item.classList.remove('active'));
        button.classList.add('active');
        if (els.customInput) els.customInput.value = '';
        currentDonationAmount = Number.parseFloat(button.dataset.amount ?? '0');
        updateDonateButton();
      });
    }
  }
  if (els.searchInput) {
    els.searchInput.addEventListener('input', () => {
      searchCoordinator.handleInput(els.searchInput!.value);
    });
    els.searchInput.addEventListener('blur', () => {
      setTimeout(() => els.searchDropdown?.classList.add('hidden'), 150);
    });
  }
}

if (typeof document !== 'undefined' && document.getElementById('connect-btn')) {
  setupEventListeners();
  void bootstrap();
}
