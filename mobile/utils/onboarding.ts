/**
 * utils/onboarding.ts
 *
 * Choosing a first-donation path on mobile, and talking to the onboarding API.
 *
 * The path is chosen from what is true about the donor's account on the
 * network, not from what they tell us about themselves. Asking "are you new to
 * crypto?" gets a worse answer than Horizon does, and asks the donor to
 * diagnose the problem they opened the app to avoid understanding.
 */
import { Horizon } from '@stellar/stellar-sdk';
import { apiGet, apiPost } from './api';
import { getConfiguredHorizonUrl } from './stellarNetwork';

const StellarServer = (require('@stellar/stellar-sdk') as any).Server || Horizon.Server;

export type OnboardingPathId =
  | 'connected_wallet'
  | 'sponsored_account'
  | 'onramp'
  | 'claimable_balance';

export type FunnelStage =
  | 'donate_intent'
  | 'path_offered'
  | 'path_selected'
  | 'tradeoff_acknowledged'
  | 'account_ready'
  | 'funds_available'
  | 'donation_submitted'
  | 'donation_confirmed'
  | 'donation_recorded';

export type AccountReadiness = 'ready' | 'reserve_locked' | 'missing' | 'unknown';

/** 1 XLM in stroops. Reserve arithmetic never touches floating point. */
export const STROOPS_PER_XLM = BigInt(10_000_000);

/**
 * The network base reserve — 0.5 XLM today, changeable by validator vote,
 * which is why it is named rather than inlined. An account's minimum balance
 * is (2 + subentries + sponsoring - sponsored) × this.
 */
export const BASE_RESERVE_STROOPS = BigInt(5_000_000);

export function stroopsToXlmString(stroops: bigint): string {
  const negative = stroops < BigInt(0);
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_XLM;
  const fraction = (abs % STROOPS_PER_XLM).toString().padStart(7, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export function xlmStringToStroops(xlm: string): bigint {
  const text = String(xlm).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new Error(`Not a decimal XLM amount: "${xlm}"`);
  }
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const stroops =
    BigInt(whole) * STROOPS_PER_XLM + BigInt(fraction.slice(0, 7).padEnd(7, '0'));
  return negative ? -stroops : stroops;
}

export interface ReserveStatus {
  readiness: AccountReadiness;
  exists: boolean;
  balanceStroops: bigint;
  minimumBalanceStroops: bigint;
  spendableStroops: bigint;
  spendableXlm: string;
  shortfallXlm?: string;
}

/**
 * Pure form of the base-reserve boundary, so it can be tested without a
 * network and shared with whatever fetched the account.
 *
 * A naive balance check is why donors see `tx_insufficient_balance` after
 * being told they had enough: an account holding 1.4 XLM with a USDC
 * trustline has 1.5 XLM locked and can send precisely nothing.
 */
export function evaluateReserve({
  balanceStroops,
  numSubEntries = 0,
  numSponsoring = 0,
  numSponsored = 0,
  feeStroops = BigInt(100),
  amountStroops = BigInt(0),
}: {
  balanceStroops: bigint;
  numSubEntries?: number;
  numSponsoring?: number;
  numSponsored?: number;
  feeStroops?: bigint;
  amountStroops?: bigint;
}): ReserveStatus {
  // The protocol's own formula. numSponsored subtracts, which is the point of
  // sponsorship: an account whose base entries are sponsored has a minimum
  // balance of zero and can spend down to nothing.
  const entries =
    BigInt(2) + BigInt(numSubEntries) + BigInt(numSponsoring) - BigInt(numSponsored);
  const minimumBalanceStroops =
    (entries < BigInt(0) ? BigInt(0) : entries) * BASE_RESERVE_STROOPS;

  const raw = balanceStroops - minimumBalanceStroops - feeStroops;
  const spendableStroops = raw < BigInt(0) ? BigInt(0) : raw;

  const sufficient =
    amountStroops > BigInt(0)
      ? spendableStroops >= amountStroops
      : spendableStroops > BigInt(0);

  return {
    readiness: sufficient ? 'ready' : 'reserve_locked',
    exists: true,
    balanceStroops,
    minimumBalanceStroops,
    spendableStroops,
    spendableXlm: stroopsToXlmString(spendableStroops),
    shortfallXlm:
      amountStroops > BigInt(0) && !sufficient
        ? stroopsToXlmString(amountStroops - spendableStroops)
        : undefined,
  };
}

const MISSING_ACCOUNT: ReserveStatus = {
  readiness: 'missing',
  exists: false,
  balanceStroops: BigInt(0),
  minimumBalanceStroops: BigInt(0),
  spendableStroops: BigInt(0),
  spendableXlm: '0.0000000',
};

const UNKNOWN_ACCOUNT: ReserveStatus = { ...MISSING_ACCOUNT, readiness: 'unknown' };

/** Reads an account and answers whether it can send `amountXlm`. */
export async function getReserveStatus(
  publicKey: string,
  amountXlm?: string,
  server: { loadAccount: (key: string) => Promise<any> } = new StellarServer(getConfiguredHorizonUrl()),
): Promise<ReserveStatus> {
  let account: any;
  try {
    account = await server.loadAccount(publicKey);
  } catch (err: any) {
    const status = err?.response?.status ?? err?.status;
    if (status === 404) return MISSING_ACCOUNT;
    // Anything else is a network problem, not an answer about the account.
    // Reporting it as "missing" would offer to sponsor an account that already
    // exists and lock the platform's reserve for nothing.
    return UNKNOWN_ACCOUNT;
  }

  const native = (account.balances || []).find((b: any) => b.asset_type === 'native');
  return evaluateReserve({
    balanceStroops: xlmStringToStroops(native ? native.balance : '0'),
    numSubEntries: account.subentry_count ?? 0,
    numSponsoring: account.num_sponsoring ?? 0,
    numSponsored: account.num_sponsored ?? 0,
    amountStroops: amountXlm ? xlmStringToStroops(amountXlm) : BigInt(0),
  });
}

export interface DonorSituation {
  address: string | null;
  readiness: AccountReadiness;
  spendableXlm: string;
  recommendedPath: OnboardingPathId;
  reason: string;
}

/**
 * Picks the path that removes this donor's actual blocker.
 *
 * The ordering is the point: a donor who can already donate is never routed
 * into an onboarding flow, because the fastest path for them is the one that
 * existed before any of this was built.
 */
export async function assessDonorSituation({
  address,
  amountXlm,
  server,
}: {
  address: string | null;
  amountXlm?: string;
  server?: { loadAccount: (key: string) => Promise<any> };
}): Promise<DonorSituation> {
  if (!address) {
    return {
      address: null,
      readiness: 'missing',
      spendableXlm: '0.0000000',
      recommendedPath: 'sponsored_account',
      reason: 'You don’t have a Stellar account yet. We can set one up for you.',
    };
  }

  const status = await getReserveStatus(address, amountXlm, server);

  if (status.readiness === 'unknown') {
    return {
      address,
      readiness: 'unknown',
      spendableXlm: '0.0000000',
      recommendedPath: 'connected_wallet',
      reason: 'We couldn’t reach the Stellar network to check your account. Try again in a moment.',
    };
  }

  if (status.readiness === 'ready') {
    return {
      address,
      readiness: 'ready',
      spendableXlm: status.spendableXlm,
      recommendedPath: 'connected_wallet',
      reason: 'Your account is funded and ready.',
    };
  }

  if (status.readiness === 'missing') {
    return {
      address,
      readiness: 'missing',
      spendableXlm: '0.0000000',
      recommendedPath: 'sponsored_account',
      reason:
        'This address isn’t a Stellar account yet. Stellar needs a minimum balance before an account can exist — GreenPay can cover that for you.',
    };
  }

  return {
    address,
    readiness: 'reserve_locked',
    spendableXlm: status.spendableXlm,
    // The account exists, so sponsorship cannot help — the donor needs funds.
    recommendedPath: 'onramp',
    reason:
      status.spendableXlm === '0.0000000'
        ? 'Your account exists but its whole balance is locked as Stellar’s minimum reserve, so it can’t send anything yet.'
        : `Your account can send ${status.spendableXlm} XLM — the rest is locked as Stellar’s minimum reserve.`,
  };
}

// ── API ─────────────────────────────────────────────────────────────────────

export interface PathTradeoffs {
  keep: string[];
  giveUp: string[];
  mitigation?: string[];
}

export interface OnboardingPathOption {
  id: OnboardingPathId;
  title: string;
  available: boolean;
  unavailableReason?: string | null;
  unchanged?: boolean;
  requires?: string[];
  quote?: { lockedXlm: string; disclosure: string[]; recoverable: boolean };
  limits?: { maxDonationXlm: number; maxLifetimeXlm: number };
  tradeoffs: PathTradeoffs;
}

export function fetchOnboardingPaths() {
  return apiGet<{ paths: OnboardingPathOption[]; guarantee: string }>(
    '/api/v1/onboarding/paths',
  );
}

export interface SponsorshipOffer {
  id: string;
  state: string;
  xdr: string;
  networkPassphrase: string;
  sponsorPublicKey: string;
  quote: { lockedXlm: string; disclosure: string[]; recoverable: boolean };
  expiresAt: string;
}

export function requestSponsorship(payload: {
  publicKey: string;
  sessionId: string;
  trustline?: boolean;
}) {
  return apiPost<SponsorshipOffer>('/api/v1/onboarding/sponsorship', {
    ...payload,
    acknowledgedDisclosure: true,
  });
}

export function submitSponsorship(id: string, signedXdr: string) {
  return apiPost<{ id: string; state: string; transactionHash: string }>(
    `/api/v1/onboarding/sponsorship/${encodeURIComponent(id)}/submit`,
    { signedXdr },
  );
}

/**
 * Best-effort release of a half-finished sponsorship.
 *
 * It fires when the donor leaves the flow, which is exactly when a request is
 * least likely to complete — so the server-side sweeper is what actually
 * guarantees the capacity comes back. This just makes it immediate in the
 * common case, and never surfaces its own failure to the donor.
 */
export function abandonSponsorship(id: string): Promise<unknown> {
  return apiPost(`/api/v1/onboarding/sponsorship/${encodeURIComponent(id)}/abandon`, {}).catch(
    () => undefined,
  );
}
