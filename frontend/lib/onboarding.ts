/**
 * lib/onboarding.ts — choosing a first-donation path, and talking to the
 * onboarding API.
 *
 * The path is chosen from what is *true about the donor's account*, not from
 * what they say about themselves. A wizard that asks "are you new to crypto?"
 * gets a worse answer than Horizon does, and asks the donor to self-diagnose a
 * problem they came here specifically to avoid understanding.
 */
import { csrfFetch, parseApiFetchResponse } from "./api";
import { getReserveStatus, type AccountReadiness } from "./stellar";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

export type OnboardingPathId =
  | "connected_wallet"
  | "sponsored_account"
  | "onramp"
  | "claimable_balance";

export type FunnelStage =
  | "donate_intent"
  | "path_offered"
  | "path_selected"
  | "tradeoff_acknowledged"
  | "account_ready"
  | "funds_available"
  | "donation_submitted"
  | "donation_confirmed"
  | "donation_recorded";

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
  providers?: Array<{ id: string; name: string; kind: string; disclosure: OnrampDisclosure }>;
  tradeoffs: PathTradeoffs;
}

export interface OnrampDisclosure {
  providerId: string;
  providerName: string;
  statements: string[];
  obligations: Record<string, string>;
  notes: string[];
}

export interface OnboardingPathsResponse {
  paths: OnboardingPathOption[];
  guarantee: string;
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

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await csrfFetch(`${API_BASE}/api/v1/onboarding${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return parseApiFetchResponse<T>(response);
}

async function get<T>(path: string): Promise<T> {
  const response = await csrfFetch(`${API_BASE}/api/v1/onboarding${path}`, { credentials: "include" });
  return parseApiFetchResponse<T>(response);
}

export function fetchOnboardingPaths(): Promise<OnboardingPathsResponse> {
  return get<OnboardingPathsResponse>("/paths");
}

export function fetchOnrampProviders() {
  return get<{ providers: Array<{ id: string; name: string; anchorUrl: string | null; disclosure: OnrampDisclosure }>; configured: boolean }>(
    "/onramp/providers",
  );
}

export function requestSponsorship(payload: {
  publicKey: string;
  sessionId: string;
  trustline?: boolean;
}): Promise<SponsorshipOffer> {
  return post<SponsorshipOffer>("/sponsorship", { ...payload, acknowledgedDisclosure: true });
}

export function quoteSponsorship(payload: { publicKey: string; sessionId?: string; trustline?: boolean }) {
  return post<{
    allowed: boolean;
    code?: string;
    message?: string;
    accountExists: boolean;
    quote: { lockedXlm: string; disclosure: string[]; recoverable: boolean };
  }>("/sponsorship/quote", payload);
}

export function submitSponsorship(id: string, signedXdr: string) {
  return post<{ id: string; state: string; transactionHash: string; deduplicated: boolean }>(
    `/sponsorship/${encodeURIComponent(id)}/submit`,
    { signedXdr },
  );
}

/**
 * Tells the backend a half-finished sponsorship can be released.
 *
 * Best-effort by design: it fires when the donor closes the flow, which is
 * exactly when a request is least likely to complete. The server-side sweeper
 * is what actually guarantees the capacity comes back — this just makes it
 * immediate in the common case.
 */
export function abandonSponsorship(id: string): Promise<unknown> {
  return post(`/sponsorship/${encodeURIComponent(id)}/abandon`, {}).catch(() => undefined);
}

export function requestUpgradeChallenge(payload: { fromAddress: string; toAddress: string }) {
  return post<{ upgradeId: string; nonce: string; message: string; expiresInMs: number }>(
    "/upgrade/challenge",
    payload,
  );
}

export function completeUpgrade(payload: {
  upgradeId: string;
  fromSignature: string;
  /**
   * The signed, unsubmittable challenge envelope from the destination wallet.
   * A wallet extension will not sign raw bytes, so control of the destination
   * is proved the SEP-10 way — see lib/challenge.ts.
   */
  toChallengeXdr: string;
}) {
  return post<{ upgradeId: string; state: string; migrated: number; canonicalAddress: string }>(
    "/upgrade/complete",
    payload,
  );
}

/**
 * The situation a donor is actually in, resolved from the network.
 *
 * `walletDetected` is the one input the network cannot supply — whether a
 * signing extension is present — so the caller passes it in.
 */
export interface DonorSituation {
  walletDetected: boolean;
  address: string | null;
  readiness: AccountReadiness;
  spendableXlm: string;
  recommendedPath: OnboardingPathId;
  /** Why this path, in words the donor can read. */
  reason: string;
}

/**
 * Picks the path that removes this donor's actual blocker.
 *
 * The ordering is the point: a donor who can already donate is never shown an
 * onboarding flow, because the fastest path for them is the one that existed
 * before any of this was built.
 */
export async function assessDonorSituation({
  walletDetected,
  address,
  amountXlm,
}: {
  walletDetected: boolean;
  address: string | null;
  amountXlm?: string;
}): Promise<DonorSituation> {
  if (!address) {
    return {
      walletDetected,
      address: null,
      readiness: "missing",
      spendableXlm: "0.0000000",
      // No address at all: with a wallet installed the fastest fix is to
      // connect it; without one, the donor needs both an account and funds.
      recommendedPath: walletDetected ? "connected_wallet" : "onramp",
      reason: walletDetected
        ? "You have a wallet — connect it and donate as usual."
        : "You have no wallet yet. We can set you up without one.",
    };
  }

  const status = await getReserveStatus(address, amountXlm);

  if (status.readiness === "unknown") {
    // Never guess when the network did not answer. Offering to sponsor an
    // account that already exists would lock the platform's reserve for
    // nothing, and telling the donor they are broke would be a lie.
    return {
      walletDetected,
      address,
      readiness: "unknown",
      spendableXlm: "0.0000000",
      recommendedPath: "connected_wallet",
      reason: "We couldn't reach the Stellar network to check your account. Try again in a moment.",
    };
  }

  if (status.readiness === "ready") {
    return {
      walletDetected,
      address,
      readiness: "ready",
      spendableXlm: status.spendableXlm,
      recommendedPath: "connected_wallet",
      reason: "Your account is funded and ready.",
    };
  }

  if (status.readiness === "missing") {
    return {
      walletDetected,
      address,
      readiness: "missing",
      spendableXlm: "0.0000000",
      recommendedPath: "sponsored_account",
      reason:
        "This address isn't a Stellar account yet. Stellar needs a minimum balance before an account can exist — GreenPay can cover that for you.",
    };
  }

  return {
    walletDetected,
    address,
    readiness: "reserve_locked",
    spendableXlm: status.spendableXlm,
    // The account exists, so sponsorship is not the fix — the donor needs
    // funds. Saying so plainly beats a flow that cannot help.
    recommendedPath: "onramp",
    reason:
      status.spendableXlm === "0.0000000"
        ? "Your account exists but its whole balance is locked as Stellar's minimum reserve, so it can't send anything yet."
        : `Your account can send ${status.spendableXlm} XLM — the rest is locked as Stellar's minimum reserve.`,
  };
}
