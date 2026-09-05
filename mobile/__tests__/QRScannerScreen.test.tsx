/**
 * __tests__/QRScannerScreen.test.tsx
 * Tests for the QR scanner screen's routing/validation logic — the core
 * financial-safety behavior is that nothing reaches navigation unless it
 * is both well-formed AND (for SEP-7 payment URIs) matches a known, active
 * GreenPay project's wallet address.
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import axios from 'axios';
import { Keypair, Networks } from '@stellar/stellar-sdk';

const mockReplace = jest.fn();
const mockBack = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, back: mockBack, push: jest.fn() }),
}));

import { QRScannerScreen } from '../src/screens/QRScannerScreen';

jest.setTimeout(15000);

const ACTIVE_DESTINATION = Keypair.random().publicKey();
const INACTIVE_DESTINATION = Keypair.random().publicKey();

const MOCK_PROJECTS = [
  { id: 'proj-active', walletAddress: ACTIVE_DESTINATION, status: 'active' },
  { id: 'proj-inactive', walletAddress: INACTIVE_DESTINATION, status: 'inactive' },
];

async function renderScanner() {
  const utils = render(<QRScannerScreen />);
  await waitFor(() => expect(utils.getByTestId('mock-barcode-scanner')).toBeTruthy());
  return utils;
}

async function scan(utils: ReturnType<typeof render>, data: string) {
  fireEvent(utils.getByTestId('mock-barcode-scanner'), 'barCodeScanned', { data, type: 'qr' });
  await waitFor(() => expect(true).toBe(true)); // flush microtasks
}

describe('QRScannerScreen', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    (axios.get as jest.Mock).mockResolvedValue({ data: { success: true, data: MOCK_PROJECTS } });
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('navigates to the donate screen for a valid GreenPay https link', async () => {
    const utils = await renderScanner();
    await scan(utils, 'https://greenpay.app/donate?projectId=proj-active');

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/donate/proj-active'), { timeout: 15000 });
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('navigates to the donate screen for a valid GreenPay custom-scheme link', async () => {
    const utils = await renderScanner();
    await scan(utils, 'greenpay://donate/proj-active');

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/donate/proj-active'));
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('navigates to the donate screen for a SEP-7 URI matching a known active project', async () => {
    const utils = await renderScanner();
    await scan(utils, `web+stellar:pay?destination=${ACTIVE_DESTINATION}`);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/donate/proj-active'));
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('rejects a SEP-7 URI whose destination matches only an inactive project', async () => {
    const utils = await renderScanner();
    await scan(utils, `web+stellar:pay?destination=${INACTIVE_DESTINATION}`);

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(mockReplace).not.toHaveBeenCalled();
    const [, message] = alertSpy.mock.calls[0];
    expect(message).toMatch(/doesn't match a known GreenPay project/);
  });

  it('rejects a SEP-7 URI with a checksum-valid but unmatched destination', async () => {
    const unmatched = Keypair.random().publicKey();
    const utils = await renderScanner();
    await scan(utils, `web+stellar:pay?destination=${unmatched}`);

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('rejects malformed/garbage input without crashing or navigating', async () => {
    const utils = await renderScanner();
    await expect(scan(utils, 'complete garbage !!! not a url')).resolves.not.toThrow();

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('rejects an arbitrary-host URL carrying a projectId query param', async () => {
    const utils = await renderScanner();
    await scan(utils, 'https://evil.com/?projectId=proj-active');

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('rejects a wrong-network SEP-7 URI', async () => {
    const utils = await renderScanner();
    await scan(
      utils,
      `web+stellar:pay?destination=${ACTIVE_DESTINATION}&network_passphrase=${encodeURIComponent(
        Networks.PUBLIC
      )}`
    );

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(mockReplace).not.toHaveBeenCalled();
    const [, message] = alertSpy.mock.calls[0];
    expect(message).toMatch(/different Stellar network/);
  });

  it('does not navigate anywhere when the /api/projects lookup fails', async () => {
    (axios.get as jest.Mock).mockRejectedValue(new Error('network error'));
    const utils = await renderScanner();
    await scan(utils, `web+stellar:pay?destination=${ACTIVE_DESTINATION}`);

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
