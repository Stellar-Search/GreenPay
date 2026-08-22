import {
  getUserInfo,
  isAllowed,
  setAllowed,
  signTransaction,
} from '@stellar/freighter-api';
import {
  Asset,
  Horizon,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { isBadSequenceError } from './horizon-errors';
import type { BackgroundRequest, BackgroundResponse } from './messages';
import { recoverPopupSession, type PopupRecoveryClient } from './popup-session';
import { SearchCoordinator } from './popup-search';
import {
  STORAGE_KEYS,
  type ProjectSummary,
  type RecoverySnapshot,
  type WalletSession,
} from './session-state';

const server = new Horizon.Server('https://horizon-testnet.stellar.org');
const sessionArea = chrome.storage.session ?? chrome.storage.local;

const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement;
const walletInfo = document.getElementById('wallet-info') as HTMLDivElement;
const walletAddress = document.getElementById('wallet-address') as HTMLSpanElement;
const walletBalance = document.getElementById('wallet-balance') as HTMLHeadingElement;
const projectList = document.getElementById('project-list') as HTMLUListElement;
const projectCount = document.querySelector('.section-header .badge') as HTMLSpanElement;
const presetBtns = document.querySelectorAll<HTMLButtonElement>('.preset-btn');
const customInput = document.getElementById('custom-amount-input') as HTMLInputElement;
const donateBtn = document.getElementById('donate-submit') as HTMLButtonElement;
const statusMsg = document.getElementById('status-message') as HTMLDivElement;
const searchInput = document.getElementById('project-search') as HTMLInputElement;
const searchDropdown = document.getElementById('search-dropdown') as HTMLUListElement;

let currentWallet: WalletSession | null = null;
let currentProjects: ProjectSummary[] = [];
let activeProject: ProjectSummary | null = null;
let currentDonationAmount = 0;

function setInteractive(enabled: boolean) {
  connectBtn.disabled = !enabled;
  searchInput.disabled = !enabled;
  customInput.disabled = !enabled;
  presetBtns.forEach((button) => {
    button.disabled = !enabled;
  });
  updateDonateButton();
}

function showStatus(message: string, kind?: 'error' | 'success') {
  statusMsg.textContent = message;
  statusMsg.className = `status-message${kind ? ` ${kind}` : ''}`;
}

function updateDonateButton() {
  donateBtn.disabled =
    connectBtn.disabled ||
    !currentWallet ||
    !activeProject?.walletAddress ||
    currentDonationAmount <= 0;
}

async function send(request: BackgroundRequest): Promise<BackgroundResponse> {
  const response = (await chrome.runtime.sendMessage(request)) as BackgroundResponse;
  if (!response?.ok) {
    throw new Error(response?.error ?? 'The GreenPay service worker did not respond');
  }
  return response;
}

async function probeWallet(): Promise<string | null> {
  try {
    if (!(await isAllowed())) return null;
    const info = await getUserInfo();
    return info.publicKey || null;
  } catch {
    return null;
  }
}

const recoveryClient: PopupRecoveryClient = {
  async getPreviousWorkerInstanceId() {
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
    await sessionArea.set({ [STORAGE_KEYS.lastPopupWorker]: workerInstanceId });
  },
};

function renderWallet(wallet: WalletSession | null) {
  currentWallet = wallet;
  connectBtn.classList.toggle('hidden', wallet !== null);
  walletInfo.classList.toggle('hidden', wallet === null);
  walletAddress.textContent = wallet
    ? `${wallet.publicKey.slice(0, 5)}...${wallet.publicKey.slice(-4)}`
    : '--';
  walletBalance.textContent = '0.00 XLM';
  updateDonateButton();
  if (wallet) void fetchBalance(wallet.publicKey);
}

async function fetchBalance(publicKey: string) {
  try {
    const account = await server.loadAccount(publicKey);
    const balance = account.balances.find((item) => item.asset_type === 'native');
    if (currentWallet?.publicKey === publicKey && balance) {
      walletBalance.textContent = `${Number.parseFloat(balance.balance).toFixed(2)} XLM`;
    }
  } catch {
    if (currentWallet?.publicKey === publicKey) walletBalance.textContent = '0.00 XLM';
  }
}

function selectProject(project: ProjectSummary) {
  activeProject = project;
  projectList.querySelectorAll<HTMLElement>('.project-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.projectId === project.id);
  });
  updateDonateButton();
}

function renderProjects(projects: ProjectSummary[]) {
  currentProjects = projects;
  activeProject = null;
  projectList.innerHTML = '';
  projectCount.textContent = String(projects.length);

  if (projects.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'glass-panel project-item';
    empty.textContent = 'Projects are temporarily unavailable.';
    projectList.appendChild(empty);
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
    projectList.appendChild(item);

    if (index === 0) activeProject = project;
  });
  updateDonateButton();
}

function renderSearchResults(
  projects: ProjectSummary[],
  sequence?: number,
  query?: string
) {
  if (sequence !== undefined && sequence !== searchCoordinator.getLatestSequence()) {
    return;
  }
  if (
    query !== undefined &&
    (query !== searchCoordinator.getLatestQuery() || query !== searchInput.value.trim())
  ) {
    return;
  }
  searchDropdown.innerHTML = '';
  if (projects.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'search-no-results';
    empty.textContent = 'No projects found';
    searchDropdown.appendChild(empty);
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
        searchInput.value = project.name;
        searchDropdown.classList.add('hidden');
      });
      searchDropdown.appendChild(item);
    });
  }
  searchDropdown.classList.remove('hidden');
}

const searchCoordinator = new SearchCoordinator({
  send,
  renderSearchResults,
  hideDropdown: () => searchDropdown.classList.add('hidden'),
  getCurrentQuery: () => searchInput.value,
});

async function connectWallet() {
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

async function buildDonationTransaction(project: ProjectSummary, amount: number) {
  if (!currentWallet) throw new Error('Connect your wallet first.');
  const account = await server.loadAccount(currentWallet.publicKey);
  const transaction = new TransactionBuilder(account, {
    fee: (await server.fetchBaseFee()).toString(),
    networkPassphrase: Networks.TESTNET,
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

async function submitDonation(
  project: ProjectSummary,
  amount: number,
  retryCount = 0
): Promise<{ hash: string }> {
  const xdr = await buildDonationTransaction(project, amount);
  const signedXdr = await signTransaction(xdr, {
    networkPassphrase: Networks.TESTNET,
  });
  const transaction = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);

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

async function donate() {
  if (!currentWallet || !activeProject || currentDonationAmount <= 0) return;
  setInteractive(false);
  showStatus('Confirm the donation in Freighter…');
  try {
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

async function bootstrap() {
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

connectBtn.addEventListener('click', () => void connectWallet());
donateBtn.addEventListener('click', () => void donate());
customInput.addEventListener('input', () => {
  presetBtns.forEach((button) => button.classList.remove('active'));
  currentDonationAmount = Number.parseFloat(customInput.value) || 0;
  updateDonateButton();
});
for (const button of presetBtns) {
  button.addEventListener('click', () => {
    presetBtns.forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    customInput.value = '';
    currentDonationAmount = Number.parseFloat(button.dataset.amount ?? '0');
    updateDonateButton();
  });
}
searchInput.addEventListener('input', () => {
  searchCoordinator.handleInput(searchInput.value);
});
searchInput.addEventListener('blur', () => {
  setTimeout(() => searchDropdown.classList.add('hidden'), 150);
});

void bootstrap();
