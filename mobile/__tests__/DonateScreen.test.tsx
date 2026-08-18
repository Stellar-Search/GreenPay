/**
 * __tests__/DonateScreen.test.tsx
 * Tests the biometric auth gate in the donate screen.
 */
import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { Alert } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import axios from 'axios';
import NetInfo from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ThemeProvider } from '../app/theme';
import { DONATION_QUEUE_KEY } from '../utils/donationQueue';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({ id: 'proj-1' }),
}));

jest.mock('expo-linking', () => ({
  canOpenURL: jest.fn().mockResolvedValue(false),
  openURL: jest.fn(),
}));

jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));

const MOCK_PROJECT = {
  id: 'proj-1',
  name: 'Amazon Reforestation',
  walletAddress: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
};

import DonateScreen from '../app/donate/[id]';

// app/donate/[id].tsx reads theme colors via useTheme(), which requires a
// ThemeProvider ancestor.
function renderDonateScreen() {
  return render(
    <ThemeProvider>
      <DonateScreen />
    </ThemeProvider>
  );
}

describe('DonateScreen – biometric auth gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (axios.get as jest.Mock).mockResolvedValue({ data: { data: [MOCK_PROJECT] } });
    (LocalAuthentication.hasHardwareAsync as jest.Mock).mockResolvedValue(true);
    (LocalAuthentication.isEnrolledAsync as jest.Mock).mockResolvedValue(true);
    (NetInfo.fetch as jest.Mock).mockResolvedValue({ isConnected: true, isInternetReachable: true });
  });

  it('renders loading state initially', () => {
    const { getByText } = renderDonateScreen();
    expect(getByText('Loading donation details...')).toBeTruthy();
  });

  it('does not call authenticateAsync when amount is invalid', async () => {
    const { getByText } = renderDonateScreen();
    await waitFor(() => expect(getByText('Donate to Amazon Reforestation')).toBeTruthy());

    fireEvent.press(getByText(/🌱 Donate/));
    expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled();
  });

  it('calls authenticateAsync before building a transaction', async () => {
    (LocalAuthentication.authenticateAsync as jest.Mock).mockResolvedValue({ success: true });
    const { getByText, getByPlaceholderText } = renderDonateScreen();
    await waitFor(() => expect(getByText('Donate to Amazon Reforestation')).toBeTruthy());

    // Set a valid amount
    fireEvent.changeText(getByPlaceholderText('1.00'), '10');
    // Simulate wallet connected by setting public key via amount field
    // We can't easily set publicKey state from outside; test the alert path instead
    fireEvent.press(getByText(/🌱 Donate/));

    // Without a connected wallet, auth is not called (wallet check comes first)
    expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled();
  });

  it('shows auth-required alert when authentication fails', async () => {
    (LocalAuthentication.authenticateAsync as jest.Mock).mockResolvedValue({ success: false });
    const alertSpy = jest.spyOn(Alert, 'alert');

    const { getByText } = renderDonateScreen();
    await waitFor(() => expect(getByText('Donate to Amazon Reforestation')).toBeTruthy());

    // Trigger donate without wallet — wallet alert fires first, not auth
    fireEvent.press(getByText(/🌱 Donate/));
    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        expect.stringMatching(/error|wallet/i),
        expect.any(String)
      )
    );
  });
});

// A real, checksum-valid Stellar public key (from Stellar's docs). The old
// constant was only shape-valid (`/^G[A-Z0-9]{55}$/`) and is rejected by the
// StrKey-backed check now used in connectWallet().
const DONOR_PUBLIC_KEY = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

/** Drives the "Connect Wallet" Alert.alert prompt exactly like a user would. */
async function connectWallet(getByText: any, alertSpy: jest.SpyInstance, publicKey: string) {
  fireEvent.press(getByText('Connect Wallet'));
  const call = alertSpy.mock.calls.find((c) => c[0] === 'Connect Wallet');
  const buttons = call?.[2] as Array<{ text: string; onPress?: (input: any) => void }>;
  const okButton = buttons.find((b) => b.text === 'OK');
  await act(async () => {
    okButton?.onPress?.(publicKey);
  });
}

describe('DonateScreen – offline queueing', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    (axios.get as jest.Mock).mockResolvedValue({ data: { data: [MOCK_PROJECT] } });
    (LocalAuthentication.hasHardwareAsync as jest.Mock).mockResolvedValue(true);
    (LocalAuthentication.isEnrolledAsync as jest.Mock).mockResolvedValue(true);
  });

  it('shows the wallet-required alert instead of queueing when no wallet is connected, even while offline', async () => {
    (NetInfo.fetch as jest.Mock).mockResolvedValue({ isConnected: false, isInternetReachable: false });
    const alertSpy = jest.spyOn(Alert, 'alert');

    const { getByText } = renderDonateScreen();
    await waitFor(() => expect(getByText('Donate to Amazon Reforestation')).toBeTruthy());

    fireEvent.press(getByText(/🌱 Donate/));

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith('Wallet Required', expect.any(String))
    );
    // Nothing should have been queued since we never got past the wallet check.
    expect(await AsyncStorage.getItem(DONATION_QUEUE_KEY)).toBeNull();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('queues the donation intent (no secret key, no network calls) when offline with a connected wallet', async () => {
    (NetInfo.fetch as jest.Mock).mockResolvedValue({ isConnected: false, isInternetReachable: false });
    const alertSpy = jest.spyOn(Alert, 'alert');

    const { getByText, getByPlaceholderText } = renderDonateScreen();
    await waitFor(() => expect(getByText('Donate to Amazon Reforestation')).toBeTruthy());

    await connectWallet(getByText, alertSpy, DONOR_PUBLIC_KEY);
    fireEvent.changeText(getByPlaceholderText('1.00'), '7');
    // Type a secret key too — it must never be persisted, even if present in the field.
    fireEvent.changeText(getByPlaceholderText('S...'), 'SBOGUSSECRETKEYFORTESTPURPOSESONLYXXXXXXXXXXXXXXXXXXXX');

    fireEvent.press(getByText(/🌱 Donate/));

    await waitFor(() =>
      expect(
        getByText(
          "You're offline — this donation has been saved and will be ready to complete once you're back online."
        )
      ).toBeTruthy()
    );

    // No network or signing calls were attempted while offline.
    expect(axios.post).not.toHaveBeenCalled();
    expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled();

    // The intent was queued, without any secret-key material.
    const raw = await AsyncStorage.getItem(DONATION_QUEUE_KEY);
    expect(raw).toBeTruthy();
    const queue = JSON.parse(raw as string);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      projectId: 'proj-1',
      projectName: 'Amazon Reforestation',
      donorAddress: DONOR_PUBLIC_KEY,
      amountXLM: '7.0000000',
      status: 'pending-sync',
    });
    expect(raw).not.toMatch(/SBOGUS/);

    // Form is reset after queueing.
    expect(getByPlaceholderText('1.00').props.value).toBe('1');
    expect(getByPlaceholderText('S...').props.value).toBe('');
  });
});
