// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Account,
  Asset,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { activeManifest } from '../network-config';

// Mock freighter-api functions
const mockIsAllowed = vi.fn();
const mockSetAllowed = vi.fn();
const mockGetUserInfo = vi.fn();
const mockSignTransaction = vi.fn();
const mockGetNetworkDetails = vi.fn();
const mockGetNetwork = vi.fn();

vi.mock('@stellar/freighter-api', () => ({
  isAllowed: (...args: unknown[]) => mockIsAllowed(...args),
  setAllowed: (...args: unknown[]) => mockSetAllowed(...args),
  getUserInfo: (...args: unknown[]) => mockGetUserInfo(...args),
  signTransaction: (...args: unknown[]) => mockSignTransaction(...args),
  getNetworkDetails: (...args: unknown[]) => mockGetNetworkDetails(...args),
  getNetwork: (...args: unknown[]) => mockGetNetwork(...args),
}));

import {
  buildDonationTransaction,
  donate,
  renderProjects,
  renderWallet,
  server,
  setupEventListeners,
  submitDonation,
  verifyFreighterNetwork,
} from '../popup';
import type { ProjectSummary } from '../session-state';

describe('Popup transaction signing, account pinning, and network verification', () => {
  const accountKp1 = Keypair.random();
  const accountKp2 = Keypair.random();
  const projectKp = Keypair.random();

  const sampleProject: ProjectSummary = {
    id: 'proj-1',
    name: 'Ocean Cleanup Initiative',
    description: 'Removing plastic from oceans',
    category: 'Ocean',
    walletAddress: projectKp.publicKey(),
  };

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
        <button id="preset-5" class="preset-btn active" data-amount="5">5 XLM</button>
        <input type="number" id="custom-amount-input" />
        <button id="donate-submit" disabled>Donate</button>
        <div id="status-message"></div>
      </main>
    `;

    setupEventListeners();
    const presetBtn = document.getElementById('preset-5') as HTMLButtonElement;
    presetBtn.click();

    // Setup default Freighter mocks matching active network
    mockIsAllowed.mockResolvedValue(true);
    mockSetAllowed.mockResolvedValue(true);
    mockGetUserInfo.mockResolvedValue({ publicKey: accountKp1.publicKey() });
    mockGetNetworkDetails.mockResolvedValue({
      network: activeManifest.network.toUpperCase(),
      networkUrl: activeManifest.horizonUrl,
      networkPassphrase: activeManifest.networkPassphrase,
    });
    mockGetNetwork.mockResolvedValue(activeManifest.network.toUpperCase());

    // Mock server methods
    vi.spyOn(server, 'loadAccount').mockResolvedValue(
      new Account(accountKp1.publicKey(), '100') as unknown as Horizon.AccountResponse
    );
    vi.spyOn(server, 'fetchBaseFee').mockResolvedValue(100);
    vi.spyOn(server, 'submitTransaction').mockResolvedValue({
      hash: 'abcdef1234567890abcdef1234567890',
    } as unknown as Horizon.HorizonApi.SubmitTransactionResponse);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('verifyFreighterNetwork', () => {
    it('succeeds when Freighter networkPassphrase matches active manifest', async () => {
      mockGetNetworkDetails.mockResolvedValue({
        network: activeManifest.network.toUpperCase(),
        networkPassphrase: activeManifest.networkPassphrase,
      });

      await expect(verifyFreighterNetwork()).resolves.toBeUndefined();
    });

    it('rejects when Freighter networkPassphrase does not match active manifest', async () => {
      mockGetNetworkDetails.mockResolvedValue({
        network: 'PUBLIC',
        networkPassphrase: 'Public Global Stellar Network ; September 2015',
      });

      await expect(verifyFreighterNetwork()).rejects.toThrow(
        /Freighter is connected to "PUBLIC", but GreenPay requires/
      );
    });

    it('rejects when getNetwork returns a mismatched network name', async () => {
      mockGetNetworkDetails.mockRejectedValue(new Error('not supported'));
      mockGetNetwork.mockResolvedValue('MAINNET');

      await expect(verifyFreighterNetwork()).rejects.toThrow(
        /Freighter is connected to "MAINNET", but GreenPay requires/
      );
    });
  });

  describe('buildDonationTransaction', () => {
    it('throws when no wallet is connected', async () => {
      renderWallet(null);
      await expect(buildDonationTransaction(sampleProject, 5)).rejects.toThrow(
        'Connect your wallet first.'
      );
    });

    it('verifies Freighter network before building transaction', async () => {
      renderWallet({
        publicKey: accountKp1.publicKey(),
        network: activeManifest.network.toUpperCase(),
        validatedAt: Date.now(),
      });

      mockGetNetworkDetails.mockResolvedValue({
        network: 'PUBLIC',
        networkPassphrase: 'wrong passphrase',
      });

      await expect(buildDonationTransaction(sampleProject, 5)).rejects.toThrow(
        /Freighter is connected to/
      );
    });

    it('builds valid transaction with activeManifest passphrase', async () => {
      renderWallet({
        publicKey: accountKp1.publicKey(),
        network: activeManifest.network.toUpperCase(),
        validatedAt: Date.now(),
      });

      const xdr = await buildDonationTransaction(sampleProject, 5);
      expect(typeof xdr).toBe('string');
      const tx = TransactionBuilder.fromXDR(xdr, activeManifest.networkPassphrase);
      expect(tx.source).toBe(accountKp1.publicKey());
    });
  });

  describe('submitDonation and account pinning', () => {
    it('pins expected signing account when calling Freighter signTransaction', async () => {
      renderWallet({
        publicKey: accountKp1.publicKey(),
        network: activeManifest.network.toUpperCase(),
        validatedAt: Date.now(),
      });

      mockSignTransaction.mockImplementation(async (xdr: string, opts: unknown) => {
        const tx = TransactionBuilder.fromXDR(xdr, activeManifest.networkPassphrase);
        tx.sign(accountKp1);
        return tx.toXDR();
      });

      const result = await submitDonation(sampleProject, 5);
      expect(result.hash).toBe('abcdef1234567890abcdef1234567890');

      expect(mockSignTransaction).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          accountToSign: accountKp1.publicKey(),
          networkPassphrase: activeManifest.networkPassphrase,
          network: activeManifest.network.toUpperCase(),
        })
      );
    });

    it('detects signer/source mismatch when transaction was signed with different account', async () => {
      renderWallet({
        publicKey: accountKp1.publicKey(),
        network: activeManifest.network.toUpperCase(),
        validatedAt: Date.now(),
      });

      // Freighter signed with accountKp2 instead of pinned accountKp1
      mockSignTransaction.mockImplementation(async (xdr: string) => {
        const tx = TransactionBuilder.fromXDR(xdr, activeManifest.networkPassphrase);
        tx.sign(accountKp2);
        return tx.toXDR();
      });

      await expect(submitDonation(sampleProject, 5)).rejects.toThrow(
        'Transaction was signed with a different account than expected.'
      );
      expect(server.submitTransaction).not.toHaveBeenCalled();
    });

    it('rejects before submission when wallet account changed during signing', async () => {
      renderWallet({
        publicKey: accountKp1.publicKey(),
        network: activeManifest.network.toUpperCase(),
        validatedAt: Date.now(),
      });

      const sendMessage = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('chrome', {
        runtime: { sendMessage },
        storage: { session: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined) } },
      });

      // Wallet switched to accountKp2 during sign step
      mockSignTransaction.mockImplementation(async (xdr: string) => {
        mockGetUserInfo.mockResolvedValue({ publicKey: accountKp2.publicKey() });
        const tx = TransactionBuilder.fromXDR(xdr, activeManifest.networkPassphrase);
        tx.sign(accountKp1);
        return tx.toXDR();
      });

      await expect(submitDonation(sampleProject, 5)).rejects.toThrow(
        'Wallet account changed during signing. Reconnect to continue.'
      );
      expect(server.submitTransaction).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'CLEAR_WALLET_SESSION' })
      );
    });
  });

  describe('donate flow integration', () => {
    it('aborts donation if account switched between probe and sign', async () => {
      renderWallet({
        publicKey: accountKp1.publicKey(),
        network: activeManifest.network.toUpperCase(),
        validatedAt: Date.now(),
      });
      renderProjects([sampleProject]);

      const sendMessage = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('chrome', {
        runtime: { sendMessage },
        storage: { session: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined) } },
      });

      // Switch active account before donate check
      mockGetUserInfo.mockResolvedValue({ publicKey: accountKp2.publicKey() });

      await donate();

      const statusMsg = document.getElementById('status-message');
      expect(statusMsg?.textContent).toContain('Wallet account changed or was locked.');
      expect(server.submitTransaction).not.toHaveBeenCalled();
    });

    it('aborts donation if Freighter is on wrong network', async () => {
      renderWallet({
        publicKey: accountKp1.publicKey(),
        network: activeManifest.network.toUpperCase(),
        validatedAt: Date.now(),
      });
      renderProjects([sampleProject]);

      mockGetNetworkDetails.mockResolvedValue({
        network: 'PUBLIC',
        networkPassphrase: 'Public Global Stellar Network ; September 2015',
      });

      await donate();

      const statusMsg = document.getElementById('status-message');
      expect(statusMsg?.textContent).toContain('Freighter is connected to "PUBLIC"');
      expect(server.submitTransaction).not.toHaveBeenCalled();
    });
  });
});
