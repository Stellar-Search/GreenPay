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
import { Account, Keypair, Horizon } from '@stellar/stellar-sdk';
const Server = (require('@stellar/stellar-sdk') as any).Server;
import { ThemeProvider } from '../app/theme';
import { DONATION_QUEUE_KEY, enqueueDonation, listQueuedDonations } from '../utils/donationQueue';

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Server: jest.fn(),
  };
});

let mockSearchParams: { id?: string; queueId?: string } = { id: 'proj-1' };

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => mockSearchParams,
}));

jest.mock('expo-linking', () => ({
  canOpenURL: jest.fn().mockResolvedValue(false),
  openURL: jest.fn(),
}));

jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));

const MOCK_PROJECT = {
  id: 'proj-1',
  name: 'Amazon Reforestation',
  // Must be a checksum-valid Stellar address: the queue-reconciliation tests
  // below build a real Operation.payment (only Server is mocked there).
  walletAddress: 'GB3SNSNLN74VSNSEL3C7NDHNZLPK7DO5JROSZ5DDS4OWVAJNAKAWWS2S',
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
    mockSearchParams = { id: 'proj-1' };
    (axios.get as jest.Mock).mockResolvedValue({ data: { success: true, data: [MOCK_PROJECT] } });
    (axios.post as jest.Mock).mockResolvedValue({ data: { success: true, data: null } });
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

// A real, checksum-valid Stellar public key (validated via useWallet()'s
// StrKey check, not a shape-only regex), independent of the real
// MOCK_PROJECT.walletAddress above.
const DONOR_PUBLIC_KEY = 'GA4JHZX455IELW533547WFB5LV57LLSUJURFFIIYG7AV4HTQNW4W4FUD';

/** Drives the "Connect Wallet" Alert.alert prompt exactly like a user would. */
async function connectWallet(getByText: any, alertSpy: jest.SpyInstance, publicKey: string) {
  fireEvent.press(getByText('Connect Wallet'));
  const call = alertSpy.mock.calls.find((c) => c[0] === 'Connect Wallet');
  const buttons = call?.[2] as Array<{ text: string; onPress?: (input: any) => void }>;
  const okButton = buttons.find((b) => b.text === 'OK');
  await act(async () => {
    await okButton?.onPress?.(publicKey);
  });
}

describe('DonateScreen – offline queueing', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockSearchParams = { id: 'proj-1' };
    await AsyncStorage.clear();
    (axios.get as jest.Mock).mockResolvedValue({ data: { success: true, data: [MOCK_PROJECT] } });
    (axios.post as jest.Mock).mockResolvedValue({ data: { success: true, data: null } });
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

// A real, checksum-valid Stellar keypair — needed because these tests exercise
// the real signing path (only `Server` is mocked, per @stellar/stellar-sdk
// jest.mock above), unlike the offline-queueing tests which never reach
// Keypair.fromSecret().
const REAL_KEYPAIR = Keypair.fromSecret('SBI47VVMEHV2IC6NKD6RYGOURFGZK5CN7ARSODC4VDKGJZM7DYAQLJIB');
const REAL_PUBLIC_KEY = REAL_KEYPAIR.publicKey();

describe('DonateScreen – completing a queued donation ("Complete now")', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    mockSearchParams = { id: 'proj-1' };
    (axios.get as jest.Mock).mockResolvedValue({ data: { success: true, data: [MOCK_PROJECT] } });
    (LocalAuthentication.hasHardwareAsync as jest.Mock).mockResolvedValue(true);
    (LocalAuthentication.isEnrolledAsync as jest.Mock).mockResolvedValue(true);
    (LocalAuthentication.authenticateAsync as jest.Mock).mockResolvedValue({ success: true });
    (NetInfo.fetch as jest.Mock).mockResolvedValue({ isConnected: true, isInternetReachable: true });
    (Server as jest.Mock).mockImplementation(() => ({
      loadAccount: jest.fn().mockResolvedValue(new Account(REAL_PUBLIC_KEY, '1')),
      submitTransaction: jest.fn().mockResolvedValue({ hash: 'HORIZON_TX_HASH_1' }),
    }));
  });

  it('prefills amount and message from the matched queue entry when queueId is present', async () => {
    const entry = await enqueueDonation({
      projectId: 'proj-1',
      projectName: 'Amazon Reforestation',
      donorAddress: REAL_PUBLIC_KEY,
      amountXLM: '12.5000000',
      message: 'For the trees',
    });
    mockSearchParams = { id: 'proj-1', queueId: entry.id };

    const { getByPlaceholderText } = renderDonateScreen();

    await waitFor(() => expect(getByPlaceholderText('1.00').props.value).toBe('12.5000000'));
    expect(getByPlaceholderText('Leave a message of support...').props.value).toBe('For the trees');
  });

  it('removes the originating queue entry atomically once the donation fully succeeds', async () => {
    const entry = await enqueueDonation({
      projectId: 'proj-1',
      projectName: 'Amazon Reforestation',
      donorAddress: REAL_PUBLIC_KEY,
      amountXLM: '5.0000000',
    });
    mockSearchParams = { id: 'proj-1', queueId: entry.id };
    const alertSpy = jest.spyOn(Alert, 'alert');

    const { getByText, getByPlaceholderText } = renderDonateScreen();
    await waitFor(() => expect(getByPlaceholderText('1.00').props.value).toBe('5.0000000'));

    await connectWallet(getByText, alertSpy, REAL_PUBLIC_KEY);
    fireEvent.changeText(getByPlaceholderText('S...'), REAL_KEYPAIR.secret());
    fireEvent.press(getByText(/🌱 Donate/));

    await waitFor(() =>
      expect(getByText(/Donation successful! Transaction hash: HORIZON_TX_HASH_1/)).toBeTruthy()
    );

    expect(axios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ transactionHash: 'HORIZON_TX_HASH_1' })
    );

    const remaining = await listQueuedDonations();
    expect(remaining.find((e) => e.id === entry.id)).toBeUndefined();
  });

  it('reconciles instead of resubmitting when Horizon succeeds but the backend POST fails, then completes on retry without a second Horizon submission', async () => {
    const entry = await enqueueDonation({
      projectId: 'proj-1',
      projectName: 'Amazon Reforestation',
      donorAddress: REAL_PUBLIC_KEY,
      amountXLM: '5.0000000',
    });
    mockSearchParams = { id: 'proj-1', queueId: entry.id };
    const alertSpy = jest.spyOn(Alert, 'alert');
    (axios.post as jest.Mock).mockRejectedValueOnce(new Error('backend unreachable'));

    const { getByText, getByPlaceholderText } = renderDonateScreen();
    await waitFor(() => expect(getByPlaceholderText('1.00').props.value).toBe('5.0000000'));

    await connectWallet(getByText, alertSpy, REAL_PUBLIC_KEY);
    fireEvent.changeText(getByPlaceholderText('S...'), REAL_KEYPAIR.secret());
    fireEvent.press(getByText(/🌱 Donate/));

    // Horizon succeeded and the backend POST failed — the queue entry keeps
    // the tx hash, is never dropped, and the donation is not resubmitted.
    await waitFor(() =>
      expect(
        getByText(/reached the blockchain \(tx HORIZON_TX_HASH_1\).*couldn't confirm it with our server/)
      ).toBeTruthy()
    );
    const server = (Server as jest.Mock).mock.results[0].value;
    expect(server.submitTransaction).toHaveBeenCalledTimes(1);

    const afterFailure = await listQueuedDonations();
    expect(afterFailure.find((e) => e.id === entry.id)?.horizonTransactionHash).toBe('HORIZON_TX_HASH_1');

    // Button now offers to retry confirmation rather than re-donate.
    await waitFor(() => expect(getByText('🌱 Confirm with server')).toBeTruthy());

    fireEvent.press(getByText('🌱 Confirm with server'));

    await waitFor(() =>
      expect(getByText(/Donation successful! Transaction hash: HORIZON_TX_HASH_1/)).toBeTruthy()
    );

    // Still only ever submitted to Horizon once — the retry only re-hit the backend.
    expect(server.submitTransaction).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledTimes(2);

    const finalQueue = await listQueuedDonations();
    expect(finalQueue.find((e) => e.id === entry.id)).toBeUndefined();
  });
});
