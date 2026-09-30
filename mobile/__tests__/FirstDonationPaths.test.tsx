/**
 * __tests__/FirstDonationPaths.test.tsx
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { FirstDonationPaths } from '../src/components/FirstDonationPaths';
import * as onboarding from '../utils/onboarding';
import * as starter from '../utils/starterAccount';
import { Account, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

jest.mock('../utils/onboarding', () => {
  const actual = jest.requireActual('../utils/onboarding');
  return {
    ...actual,
    fetchOnboardingPaths: jest.fn(),
    assessDonorSituation: jest.fn(),
    requestSponsorship: jest.fn(),
    submitSponsorship: jest.fn(),
    abandonSponsorship: jest.fn().mockResolvedValue(undefined),
  };
});

jest.mock('../utils/funnel', () => ({
  track: jest.fn(),
  getSessionId: jest.fn().mockResolvedValue('44444444-4444-4444-8444-444444444444'),
}));

/**
 * Jest's 5s default is not enough for the *first* test in this suite.
 *
 * It is not the assertion that is slow — locally the first test takes ~340ms
 * and the rest ~90ms. The difference is the one-off cost of loading the React
 * Native module graph plus @stellar/stellar-sdk through the jest-expo
 * transform, which the first test to run happens to pay for. On a two-core CI
 * runner with several suites executing in parallel, that one-off cost is
 * amplified past 5s and the suite fails for a reason that has nothing to do
 * with the code under test.
 *
 * Same reasoning as QRScannerScreen.test.tsx, which raises it for the same
 * reason. Kept generous enough never to flake, and still short enough that a
 * genuine hang fails the build rather than hanging it.
 */
jest.setTimeout(30000);

const fetchOnboardingPaths = onboarding.fetchOnboardingPaths as jest.Mock;
const assessDonorSituation = onboarding.assessDonorSituation as jest.Mock;
const requestSponsorship = onboarding.requestSponsorship as jest.Mock;
const submitSponsorship = onboarding.submitSponsorship as jest.Mock;
const abandonSponsorship = onboarding.abandonSponsorship as jest.Mock;

const PATHS = {
  guarantee: 'GreenPay never holds your key and never holds your money.',
  paths: [
    {
      id: 'connected_wallet',
      title: 'I already have a Stellar wallet',
      available: true,
      unchanged: true,
      requires: ['A Stellar address'],
      tradeoffs: { keep: ['Full control.'], giveUp: [] },
    },
    {
      id: 'sponsored_account',
      title: 'I have XLM coming, but no Stellar account yet',
      available: true,
      requires: ['A few seconds'],
      limits: { maxDonationXlm: 250, maxLifetimeXlm: 1000 },
      tradeoffs: { keep: [], giveUp: ['The key exists on this device only.'] },
    },
    {
      id: 'onramp',
      title: 'I have no wallet and no XLM',
      available: false,
      unavailableReason: 'No fiat on-ramp provider is configured for this deployment.',
      tradeoffs: { keep: [], giveUp: [] },
    },
  ],
};

/**
 * The sponsorship offer fixture, built once.
 *
 * `beforeEach` needs it for all 23 tests and the value is identical every
 * time, so the ed25519 keygen and transaction build happen on first use rather
 * than 23 times over. `expiresAt` is the one field recomputed per call, since a
 * fixed timestamp would drift into the past during a slow run and trip the
 * expiry branch.
 */
let cachedOffer: { xdr: string; sponsorPublicKey: string } | null = null;

function offer() {
  if (!cachedOffer) {
    const sponsor = Keypair.random();
    cachedOffer = {
      sponsorPublicKey: sponsor.publicKey(),
      xdr: new TransactionBuilder(new Account(sponsor.publicKey(), '1'), {
        fee: '300',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(Operation.bumpSequence({ bumpTo: '0' }))
        .setTimeout(900)
        .build()
        .toXDR(),
    };
  }

  return {
    id: 'sponsorship-1',
    state: 'awaiting_signature',
    xdr: cachedOffer.xdr,
    networkPassphrase: Networks.TESTNET,
    sponsorPublicKey: cachedOffer.sponsorPublicKey,
    quote: { lockedXlm: '1.0000000', disclosure: [], recoverable: true },
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
  };
}

beforeEach(async () => {
  jest.clearAllMocks();
  await starter.forgetStarterAccount();
  fetchOnboardingPaths.mockResolvedValue(PATHS);
  assessDonorSituation.mockResolvedValue({
    address: null,
    readiness: 'missing',
    spendableXlm: '0.0000000',
    recommendedPath: 'sponsored_account',
    reason: 'You don’t have a Stellar account yet.',
  });
  requestSponsorship.mockResolvedValue(offer());
  submitSponsorship.mockResolvedValue({ id: 'sponsorship-1', state: 'active', transactionHash: 'abc' });
});

describe('the choice', () => {
  it('explains the donor’s situation rather than asking them to diagnose it', async () => {
    const { getByTestId } = render(<FirstDonationPaths onAccountReady={jest.fn()} />);
    await waitFor(() =>
      expect(getByTestId('mobile-donor-situation').props.children).toMatch(
        /don’t have a Stellar account yet/i,
      ),
    );
  });

  it('marks the recommended path without hiding the others', async () => {
    const { getByText, getByTestId } = render(<FirstDonationPaths onAccountReady={jest.fn()} />);
    await waitFor(() => expect(getByTestId('mobile-path-sponsored_account')).toBeTruthy());
    expect(getByText('Suggested')).toBeTruthy();
    expect(getByTestId('mobile-path-connected_wallet')).toBeTruthy();
  });

  it('puts each path’s headline cost on the choice itself', async () => {
    // A donor should not have to open a path to learn what it costs them.
    const { getByText } = render(<FirstDonationPaths onAccountReady={jest.fn()} />);
    await waitFor(() => expect(getByText('The key exists on this device only.')).toBeTruthy());
  });

  it('shows the donation cap on the sponsored option', async () => {
    const { getByText } = render(<FirstDonationPaths onAccountReady={jest.fn()} />);
    await waitFor(() => expect(getByText('Up to 250 XLM per donation.')).toBeTruthy());
  });

  it('says why an unavailable path is unavailable, rather than offering a dead end', async () => {
    const { getByText } = render(<FirstDonationPaths onAccountReady={jest.fn()} />);
    await waitFor(() =>
      expect(getByText('No fiat on-ramp provider is configured for this deployment.')).toBeTruthy(),
    );
  });

  it('restates the non-custodial guarantee', async () => {
    const { getByTestId } = render(<FirstDonationPaths onAccountReady={jest.fn()} />);
    await waitFor(() =>
      expect(getByTestId('mobile-onboarding-guarantee').props.children).toMatch(
        /never holds your key/i,
      ),
    );
  });

  it('hands a donor who picks the wallet path straight back', async () => {
    const onUseExistingWallet = jest.fn();
    const { getByTestId } = render(
      <FirstDonationPaths onAccountReady={jest.fn()} onUseExistingWallet={onUseExistingWallet} />,
    );
    await waitFor(() => expect(getByTestId('mobile-path-connected_wallet')).toBeTruthy());

    fireEvent.press(getByTestId('mobile-path-connected_wallet'));
    expect(onUseExistingWallet).toHaveBeenCalled();
  });

  it('keeps working when the paths request fails', async () => {
    // An API outage must not blank the screen for a donor who could have
    // donated with an address they already have.
    fetchOnboardingPaths.mockRejectedValue(new Error('down'));
    const { getByText } = render(<FirstDonationPaths onAccountReady={jest.fn()} />);
    await waitFor(() => expect(getByText('Enter a Stellar address to donate.')).toBeTruthy());
  });
});

describe('the disclosure gate', () => {
  async function openDisclosure() {
    const utils = render(<FirstDonationPaths onAccountReady={jest.fn()} />);
    await waitFor(() => expect(utils.getByTestId('mobile-path-sponsored_account')).toBeTruthy());
    fireEvent.press(utils.getByTestId('mobile-path-sponsored_account'));
    await waitFor(() => expect(utils.getByTestId('mobile-tradeoff-notice')).toBeTruthy());
    return utils;
  }

  it('shows the trade-offs before any key exists', async () => {
    const { getByText } = await openDisclosure();
    expect(getByText(/does not have a copy of it/i)).toBeTruthy();
    // Declining at this point must cost nothing, so nothing was created.
    await expect(starter.loadStarterAccount()).resolves.toBeNull();
  });

  it('states the reserve the platform locks, and that it is not a gift', async () => {
    const { getByText } = await openDisclosure();
    expect(getByText(/GreenPay locks 1.0000000 XLM/)).toBeTruthy();
    expect(getByText(/not a gift/i)).toBeTruthy();
  });

  it('does not request a sponsorship until the donor acknowledges', async () => {
    const { getByTestId } = await openDisclosure();
    fireEvent.press(getByTestId('mobile-tradeoff-continue'));
    expect(requestSponsorship).not.toHaveBeenCalled();
  });

  it('proceeds once the donor acknowledges', async () => {
    const { getByTestId } = await openDisclosure();
    fireEvent(getByTestId('mobile-tradeoff-acknowledge'), 'valueChange', true);
    fireEvent.press(getByTestId('mobile-tradeoff-continue'));

    await waitFor(() => expect(requestSponsorship).toHaveBeenCalled());
  });

  it('has nothing to release when the donor backs out at the disclosure', async () => {
    const { getByTestId } = await openDisclosure();
    fireEvent.press(getByTestId('mobile-tradeoff-cancel'));

    expect(requestSponsorship).not.toHaveBeenCalled();
    expect(abandonSponsorship).not.toHaveBeenCalled();
  });
});

describe('the sponsored setup', () => {
  async function runSetup() {
    const onAccountReady = jest.fn();
    const utils = render(<FirstDonationPaths onAccountReady={onAccountReady} />);
    await waitFor(() => expect(utils.getByTestId('mobile-path-sponsored_account')).toBeTruthy());
    fireEvent.press(utils.getByTestId('mobile-path-sponsored_account'));
    await waitFor(() => expect(utils.getByTestId('mobile-tradeoff-notice')).toBeTruthy());
    fireEvent(utils.getByTestId('mobile-tradeoff-acknowledge'), 'valueChange', true);
    fireEvent.press(utils.getByTestId('mobile-tradeoff-continue'));
    return { ...utils, onAccountReady };
  }

  it('creates the key on the device and sends only the public key', async () => {
    await runSetup();
    await waitFor(() => expect(requestSponsorship).toHaveBeenCalled());

    const payload = requestSponsorship.mock.calls[0][0];
    expect(payload.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
    const account = await starter.loadStarterAccount();
    expect(JSON.stringify(payload)).not.toContain(account!.secret);
  });

  it('submits a transaction the donor’s key has signed', async () => {
    await runSetup();
    await waitFor(() => expect(submitSponsorship).toHaveBeenCalled());
    expect(submitSponsorship.mock.calls[0][1]).toEqual(expect.any(String));
  });

  it('offers the key for export before anything else', async () => {
    const { getByTestId, getByText } = await runSetup();
    await waitFor(() => expect(getByTestId('mobile-starter-ready')).toBeTruthy());
    expect(getByText('Save your key now')).toBeTruthy();
    expect(getByText(/only copy/i)).toBeTruthy();
  });

  it('keeps the key hidden until the donor asks for it', async () => {
    const { getByTestId, queryByTestId } = await runSetup();
    await waitFor(() => expect(getByTestId('mobile-starter-ready')).toBeTruthy());
    expect(queryByTestId('mobile-starter-secret')).toBeNull();

    fireEvent.press(getByTestId('mobile-starter-reveal'));
    await waitFor(() => expect(getByTestId('mobile-starter-secret')).toBeTruthy());
  });

  it('hands the new address to the caller', async () => {
    const { getByTestId, onAccountReady } = await runSetup();
    await waitFor(() => expect(getByTestId('mobile-starter-ready')).toBeTruthy());

    fireEvent.press(getByTestId('mobile-starter-continue'));
    const account = await starter.loadStarterAccount();
    expect(onAccountReady).toHaveBeenCalledWith(account!.publicKey);
  });

  it('does not try to abandon a sponsorship that succeeded', async () => {
    const { getByTestId, unmount } = await runSetup();
    await waitFor(() => expect(getByTestId('mobile-starter-ready')).toBeTruthy());
    unmount();
    expect(abandonSponsorship).not.toHaveBeenCalled();
  });

  it('releases the reserved capacity when the sponsorship fails mid-flow', async () => {
    submitSponsorship.mockRejectedValue(new Error('The account could not be created (tx_bad_seq).'));
    const { getByTestId } = await runSetup();

    await waitFor(() => expect(getByTestId('mobile-starter-error')).toBeTruthy());
    expect(abandonSponsorship).toHaveBeenCalledWith('sponsorship-1');
  });

  it('never reports success when the request failed', async () => {
    requestSponsorship.mockRejectedValue(new Error('Treasury exhausted.'));
    const { getByTestId, onAccountReady } = await runSetup();

    await waitFor(() => expect(getByTestId('mobile-starter-error')).toBeTruthy());
    expect(onAccountReady).not.toHaveBeenCalled();
  });

  it('releases the capacity when the donor leaves mid-flow', async () => {
    // The server sweeper guarantees this eventually; unmounting makes it
    // immediate, which is the difference between minutes and seconds of
    // capacity held for a donor who already left.
    submitSponsorship.mockImplementation(() => new Promise(() => {}));
    const { unmount } = await runSetup();

    await waitFor(() => expect(submitSponsorship).toHaveBeenCalled());
    unmount();
    expect(abandonSponsorship).toHaveBeenCalledWith('sponsorship-1');
  });

  it('reuses an existing key rather than overwriting one that may hold XLM', async () => {
    const existing = await starter.createStarterAccount(true);
    await runSetup();

    await waitFor(() => expect(requestSponsorship).toHaveBeenCalled());
    expect(requestSponsorship.mock.calls[0][0].publicKey).toBe(existing.publicKey);
  });
});
