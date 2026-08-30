/**
 * e2e/donation-rollback.spec.ts
 *
 * A Soroban `donate()` call can pass simulation and still fail during real
 * execution (e.g. a checked-arithmetic overflow panic), or the network can
 * report `successful: false` for reasons unrelated to the contract. Before the
 * fix in lib/stellar.ts / components/DonateForm.tsx, the donate flow treated a
 * successful Horizon *submission* as a successful *donation* — showing the
 * "Thank you!" screen, a new badge, and persisting the donation to the backend
 * (which feeds the leaderboard/donation totals) without ever checking whether
 * the transaction actually executed.
 *
 * These tests mock the Horizon + Soroban RPC layer to simulate a donation
 * that lands on-chain but fails execution, and one where the outcome can't be
 * determined at all, and assert:
 *  - the optimistic "success" UI (thank-you screen, badge) never appears,
 *  - the backend is never told a donation happened (so totals/leaderboard
 *    are never corrupted),
 *  - a distinguishing, kind-appropriate error message is shown.
 *
 * All XDR fixtures below were generated offline with the exact
 * @stellar/stellar-sdk version this app is pinned to (see the note above each
 * constant) so they parse exactly the way the real RPC/Horizon response
 * parsers expect.
 */
import { test, expect, type Page, type Route } from "@playwright/test";

// ── Mock data ───────────────────────────────────────────────────────────────

const MOCK_PROJECT_ID = "8d9ac19b-52eb-42f7-80d9-19a88ba59e43";
// A real, checksum-valid ed25519 public key (test-only, no funds/authority) —
// the donate flow builds a real Stellar TransactionBuilder client-side, which
// validates the destination's StrKey checksum before any network call happens.
const MOCK_WALLET     = "GDXZGJFT2SHNKNCDXIFBO3MIJ2MZSMNFLUR6MJWW2PZMRGDHK43CJHHX";
// A real, checksum-valid ed25519 keypair (test-only, no funds/authority) —
// needed because the donate flow constructs a real Stellar `Account`/
// `TransactionBuilder` client-side, which validates the StrKey checksum.
const DONOR_PUBLIC_KEY = "GADLBIZDEM65S7J6H6OWGBYAZ476D6IGVBBC5H2G4KS3NLQOSCPYAIQ3";

const MOCK_PROJECT = {
  id: MOCK_PROJECT_ID,
  name: "Amazon Reforestation Initiative",
  description: "Planting 1 million native trees in the Brazilian Amazon.",
  category: "Reforestation",
  location: "Brazil, South America",
  walletAddress: MOCK_WALLET,
  goalXLM: "50000",
  raisedXLM: "18420",
  donorCount: 147,
  co2OffsetKg: 245000,
  co2_per_xlm: 100,
  status: "active",
  verified: true,
  onChainVerified: true,
  tags: ["reforestation", "amazon"],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const ok = (data: unknown) => ({ json: { success: true, data } });

// A syntactically-valid TransactionEnvelope for a `donate()` invokeHostFunction
// call, built offline against a dummy account/contract. getTransaction's
// parser requires a well-formed envelope XDR, but nothing in the app reads its
// contents — only resultXdr/resultMetaXdr/diagnosticEventsXdr matter for the
// failure-classification logic under test.
const ENVELOPE_XDR =
  "AAAAAgAAAAAGsKMjIz3ZfT4/nWMHAM8/4fkGqEIun0bipbauDpCfgAAPQkAAAAAAAAAAZQAAAAEAAAAAAAAAAAAAAABqaixeAAAAAAAAAAEAAAAAAAAAGAAAAAAAAAABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEAAAAGZG9uYXRlAAAAAAAFAAAAEgAAAAECAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgAAABIAAAAAAAAAAAawoyMjPdl9Pj+dYwcAzz/h+QaoQi6fRuKltq4OkJ+AAAAADgAAACQ4ZDlhYzE5Yi01MmViLTQyZjctODBkOS0xOWE4OGJhNTllNDMAAAAKAAAAAAAAAAAAAAABKgXyAAAAAAMAAAAAAAAAAAAAAAAAAAAA";

// TransactionResult: txFAILED with a single invokeHostFunction op result of
// `invokeHostFunctionTrapped` — the XDR shape of a contract panic.
const RESULT_XDR_FAILED = "AAAAAAAPQkD/////AAAAAQAAAAAAAAAY/////gAAAAA=";

// TransactionMeta v3 carrying one diagnostic event whose data string contains
// "overflow", so extractPanicReason() in lib/stellar.ts has something to find.
const RESULT_META_XDR =
  "AAAAAwAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAARERERERERERERERERERERERERERERERERERERERERERAAAAAgAAAAAAAAABAAAADwAAAAVlcnJvcgAAAAAAAA4AAABTSG9zdEVycm9yOiBFcnJvcihDb250cmFjdCwgI292ZXJmbG93KSBkb25hdGlvbiB0b3RhbCBleGNlZWRzIGkxMjggY2hlY2tlZC1hZGQgbGltaXQA";

const DIAGNOSTIC_EVENTS_XDR = [
  "AAAAAAAAAAAAAAABEREREREREREREREREREREREREREREREREREREREREREAAAACAAAAAAAAAAEAAAAPAAAABWVycm9yAAAAAAAADgAAAFNIb3N0RXJyb3I6IEVycm9yKENvbnRyYWN0LCAjb3ZlcmZsb3cpIGRvbmF0aW9uIHRvdGFsIGV4Y2VlZHMgaTEyOCBjaGVja2VkLWFkZCBsaW1pdAA=",
];

// Minimal SorobanTransactionData + a void ScVal return value — enough for
// rpc.assembleTransaction() to accept the simulateTransaction response as a
// success and build the transaction that gets signed & submitted.
const TRANSACTION_DATA_XDR = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABhqA=";
const SIMULATE_RETVAL_XDR = "AAAAAQ==";

const FAILED_TX_HASH = "a".repeat(64);

// ── Mocking helpers ─────────────────────────────────────────────────────────

async function mockApi(page: Page, recordedDonations: unknown[]) {
  // NOTE: lib/api.ts installs an axios interceptor that rewrites every
  // `/api/*` request path to `/api/v1/*` before it goes out (see "issue #204"
  // in lib/api.ts) — so the *actual* network requests Playwright sees are all
  // under `/api/v1/...` even though the source calls `/api/projects/...` etc.
  // Route patterns below target the real `/api/v1/...` paths so the specific
  // handlers actually take precedence over the catch-all.
  await page.route("**/api/**", (r: Route) => r.fulfill(ok([])));
  await page.route("**/api/v1/impact/**",        (r) => r.fulfill(ok({})));
  await page.route("**/api/v1/stats/categories", (r) => r.fulfill(ok([])));
  await page.route("**/api/v1/stats/global",     (r) => r.fulfill(ok({ totalDonations: 1, totalXLMRaised: "100", publishedImpactClaims: 1, verifiedImpactClaims: 0 })));
  await page.route("**/api/v1/leaderboard**",    (r) => r.fulfill(ok([])));
  await page.route("**/api/v1/profiles/**",      (r) => r.fulfill(ok({ publicKey: DONOR_PUBLIC_KEY, totalDonatedXLM: "0", projectsSupported: 0, badges: [] })));
  await page.route("**/api/v1/donations",        (r) => {
    recordedDonations.push(r.request().postDataJSON());
    return r.fulfill(ok({ id: "d1" }));
  });
  await page.route("**/api/v1/donations/**",     (r) => r.fulfill(ok([])));
  await page.route(`**/api/v1/updates/${MOCK_PROJECT_ID}`,          (r) => r.fulfill(ok([])));
  await page.route(`**/api/v1/projects/${MOCK_PROJECT_ID}/matching`, (r) => r.fulfill(ok([])));
  await page.route(`**/api/v1/subscriptions/${MOCK_PROJECT_ID}/count`, (r) => r.fulfill({ json: { success: true, count: 0 } }));
  await page.route(`**/api/v1/projects/${MOCK_PROJECT_ID}/**`, (r) => r.fulfill(ok([])));
  await page.route(`**/api/v1/projects/${MOCK_PROJECT_ID}`,    (r) => r.fulfill(ok(MOCK_PROJECT)));
  await page.route("**/api/v1/projects",         (r) => r.fulfill(ok([MOCK_PROJECT])));
}

/** Test seam matching pages/_app.tsx's __test_publicKey__ pattern (see greenpay.spec.ts). */
async function mockFreighter(page: Page, publicKey = DONOR_PUBLIC_KEY) {
  await page.addInitScript((pk) => {
    (window as unknown as Record<string, unknown>).__test_publicKey__ = pk;
    (window as unknown as Record<string, unknown>).freighter = {
      isConnected: () => Promise.resolve({ isConnected: true }),
    };
  }, publicKey);
}

/**
 * Test seam matching lib/wallet.ts's __test_signTransaction__ hook — bypasses
 * the real Freighter postMessage handshake entirely by resolving with the
 * unsigned XDR as-is. Fine here since Horizon submission is mocked below, so
 * nothing ever actually verifies a signature.
 */
async function mockSignTransaction(page: Page, opts: { rejected?: boolean } = {}) {
  await page.addInitScript((rejected) => {
    (window as unknown as Record<string, unknown>).__test_signTransaction__ = (xdr: string) =>
      rejected
        ? Promise.resolve({ signedXDR: null, error: "Transaction rejected.", rejected: true })
        : Promise.resolve({ signedXDR: xdr, error: null });
  }, opts.rejected ?? false);
}

/**
 * Horizon: account lookup + transaction submission.
 *
 * Playwright resolves overlapping routes in reverse insertion order (the
 * most-recently-added handler wins), so the broad catch-all must be
 * registered FIRST and the specific handlers AFTER it — same convention as
 * greenpay.spec.ts's mockApi.
 */
async function mockHorizon(page: Page, submitResponse: (route: Route) => Promise<void> | void) {
  await page.route("**/horizon-testnet.stellar.org/**", (route) =>
    route.fulfill({ json: { _embedded: { records: [] }, balances: [{ asset_type: "native", balance: "500.0000000" }] } }),
  );
  await page.route("**/horizon-testnet.stellar.org/accounts/**", (route) =>
    route.fulfill({ json: { account_id: DONOR_PUBLIC_KEY, sequence: "100" } }),
  );
  await page.route("**/horizon-testnet.stellar.org/transactions", (route) => submitResponse(route));
}

/** Soroban RPC: simulateTransaction (always succeeds) + getTransaction (mockable). */
async function mockSorobanRpc(page: Page, getTransactionResult: Record<string, unknown>) {
  await page.route("**/soroban-testnet.stellar.org/**", async (route) => {
    const body = route.request().postDataJSON() as { id: unknown; method?: string };
    if (body?.method === "simulateTransaction") {
      return route.fulfill({
        json: {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            id: "1",
            latestLedger: 1000,
            transactionData: TRANSACTION_DATA_XDR,
            minResourceFee: "100000",
            cost: { cpuInsns: "0", memBytes: "0" },
            results: [{ xdr: SIMULATE_RETVAL_XDR }],
            events: [],
          },
        },
      });
    }
    if (body?.method === "getTransaction") {
      return route.fulfill({ json: { jsonrpc: "2.0", id: body.id, result: getTransactionResult } });
    }
    return route.fulfill({ json: { jsonrpc: "2.0", id: body?.id, result: {} } });
  });
}

async function donate(page: Page, amount = "50") {
  await page.goto(`/projects/${MOCK_PROJECT_ID}`);
  const form = page.locator(".card", { hasText: /make a donation/i });
  await expect(form.getByRole("heading", { name: /make a donation/i })).toBeVisible();
  await form.getByPlaceholder(/or enter custom amount/i).fill(amount);
  await form.getByRole("button", { name: /Donate/ }).click();
  return form;
}

// ── Tests ───────────────────────────────────────────────────────────────────

test.describe("Donation rollback on transaction failure", () => {
  test("contract execution failure: reverts optimistic UI and shows a panic-specific message", async ({ page }) => {
    const recordedDonations: unknown[] = [];
    await mockFreighter(page);
    await mockSignTransaction(page);
    await mockApi(page, recordedDonations);
    await mockHorizon(page, (route) =>
      route.fulfill({
        json: {
          hash: FAILED_TX_HASH,
          ledger: 1234,
          successful: false,
          envelope_xdr: ENVELOPE_XDR,
          result_xdr: RESULT_XDR_FAILED,
          result_meta_xdr: RESULT_META_XDR,
          paging_token: "123456789",
        },
      }),
    );
    await mockSorobanRpc(page, {
      status: "FAILED",
      latestLedger: 1050,
      latestLedgerCloseTime: 1234567890,
      oldestLedger: 900,
      oldestLedgerCloseTime: 1234560000,
      ledger: 1040,
      createdAt: 1234567800,
      applicationOrder: 1,
      feeBump: false,
      envelopeXdr: ENVELOPE_XDR,
      resultXdr: RESULT_XDR_FAILED,
      resultMetaXdr: RESULT_META_XDR,
      diagnosticEventsXdr: DIAGNOSTIC_EVENTS_XDR,
    });

    const form = await donate(page);

    // The distinguishing execution-failure message must appear, ideally with
    // the extracted panic reason surfaced.
    const banner = form.getByTestId("donate-error-execution-failed");
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText(/didn.t go through/i);
    await expect(banner).toContainText(/overflow/i);
    await expect(banner.getByRole("link", { name: /view the failed transaction/i })).toBeVisible();

    // The optimistic "success" UI must never appear.
    await expect(page.getByText(/thank you!/i)).toHaveCount(0);
    await expect(page.getByText(/congrats! you earned a new badge/i)).toHaveCount(0);

    // The backend must never be told a donation happened — this is exactly
    // the state that would otherwise leak into the donation total / leaderboard.
    expect(recordedDonations).toHaveLength(0);

    // The project's on-page raised total is untouched (no optimistic bump).
    await expect(page.getByText(/18,420 XLM raised/i).first()).toBeVisible();
  });

  test("ambiguous network failure: shows a 'couldn't confirm' message, not a false success or failure", async ({ page }) => {
    const recordedDonations: unknown[] = [];
    await mockFreighter(page);
    await mockSignTransaction(page);
    await mockApi(page, recordedDonations);
    await mockHorizon(page, (route) =>
      // Horizon submission itself errors out with no result_codes — e.g. a
      // request timeout — so the outcome can never be determined.
      route.fulfill({ status: 504, json: { title: "Timeout", status: 504 } }),
    );
    await mockSorobanRpc(page, { status: "NOT_FOUND", latestLedger: 1, latestLedgerCloseTime: 1, oldestLedger: 1, oldestLedgerCloseTime: 1 });

    const form = await donate(page);

    const banner = form.getByTestId("donate-error-network-unknown");
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText(/couldn.t confirm/i);

    await expect(page.getByText(/thank you!/i)).toHaveCount(0);
    expect(recordedDonations).toHaveLength(0);
  });

  test("wallet rejection: quiet state, not presented as an error", async ({ page }) => {
    const recordedDonations: unknown[] = [];
    await mockFreighter(page);
    await mockSignTransaction(page, { rejected: true });
    await mockApi(page, recordedDonations);
    // Building the transaction still needs a valid account + simulation even
    // though signing will be rejected before submission.
    await mockHorizon(page, (route) => route.fulfill({ json: {} }));
    await mockSorobanRpc(page, { status: "NOT_FOUND" });

    const form = await donate(page);

    const banner = form.getByTestId("donate-error-wallet-rejected");
    await expect(banner).toBeVisible({ timeout: 15_000 });
    // Must not use the scary red "execution failed" / "network unknown" styling.
    await expect(form.getByTestId("donate-error-execution-failed")).toHaveCount(0);
    await expect(form.getByTestId("donate-error-network-unknown")).toHaveCount(0);

    expect(recordedDonations).toHaveLength(0);
  });
});
