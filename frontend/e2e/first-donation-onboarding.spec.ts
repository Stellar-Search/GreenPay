/**
 * e2e/first-donation-onboarding.spec.ts
 *
 * The funnel this feature exists to unblock, driven through a real browser.
 *
 * Two things are being proved. First, that a donor with no wallet extension
 * and no Stellar account can reach a state from which they can donate — the
 * headline acceptance criterion. Second, and just as important, that a donor
 * who *does* have a wallet still sees exactly what they saw before; a
 * conversion feature that degrades the path most donations already take is a
 * net loss however good its own numbers look.
 */
import { test, expect, type Page, type Route } from "@playwright/test";

const MOCK_PROJECT_ID = "8d9ac19b-52eb-42f7-80d9-19a88ba59e43";
const MOCK_WALLET = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

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

const ONBOARDING_PATHS = {
  guarantee:
    "GreenPay never holds your key and never holds your money. Every donation goes from an account you control straight to the project.",
  paths: [
    {
      id: "connected_wallet",
      title: "I already have a Stellar wallet",
      available: true,
      unchanged: true,
      requires: ["A wallet extension or app", "An account with XLM in it"],
      tradeoffs: { keep: ["Full control of your key."], giveUp: [] },
    },
    {
      id: "sponsored_account",
      title: "I have XLM coming, but no Stellar account yet",
      available: true,
      requires: ["A few seconds", "Somewhere to keep a key"],
      quote: {
        lockedXlm: "1.0000000",
        recoverable: true,
        disclosure: ["GreenPay locks 1.0000000 XLM of its own funds to create your account."],
      },
      limits: { maxDonationXlm: 250, maxLifetimeXlm: 1000 },
      tradeoffs: {
        keep: ["You can move your donation history and badges to a full wallet later, for free."],
        giveUp: [
          "Your key lives in this browser only. Clear your browser data, or use a different device, and it is gone.",
          "GreenPay does not have a copy of your key and cannot restore it. There is no password reset.",
        ],
        mitigation: ["Export your key now and store it somewhere safe."],
      },
    },
    {
      id: "onramp",
      title: "I have no wallet and no XLM",
      available: false,
      unavailableReason: "No fiat on-ramp provider is configured for this deployment.",
      tradeoffs: { keep: [], giveUp: [] },
    },
  ],
};

const ok = (data: unknown) => ({ json: { success: true, data } });

async function mockApi(page: Page) {
  await page.route("**/api/v1/**", (r: Route) => r.fulfill(ok([])));
  await page.route("**/horizon-testnet.stellar.org/**", (r) =>
    r.fulfill({
      json: {
        _embedded: { records: [] },
        balances: [{ asset_type: "native", balance: "500.0000000" }],
      },
    }),
  );

  await page.route("**/api/v1/onboarding/paths", (r) => r.fulfill(ok(ONBOARDING_PATHS)));
  await page.route("**/api/v1/onboarding/sessions", (r) =>
    r.fulfill(ok({ sessionId: "44444444-4444-4444-8444-444444444444" })),
  );
  await page.route("**/api/v1/onboarding/events", (r) => r.fulfill(ok({ recorded: true })));
  await page.route("**/api/v1/onboarding/onramp/providers", (r) =>
    r.fulfill(ok({ providers: [], configured: false })),
  );

  await page.route("**/api/v1/impact/**", (r) => r.fulfill(ok({})));
  await page.route("**/api/v1/profiles/**", (r) => r.fulfill(ok({})));
  await page.route("**/api/v1/donations/**", (r) => r.fulfill(ok([])));
  await page.route("**/api/v1/subscriptions/**", (r) => r.fulfill({ json: { success: true, count: 0 } }));
  await page.route("**/api/v1/updates/**", (r) => r.fulfill(ok([])));
  await page.route(`**/api/v1/projects/${MOCK_PROJECT_ID}/**`, (r) => r.fulfill(ok([])));
  await page.route(`**/api/v1/projects/${MOCK_PROJECT_ID}`, (r) => r.fulfill(ok(MOCK_PROJECT)));
}

/**
 * A browser with no wallet extension — the donor this whole feature is for.
 * `window.freighter` is deliberately absent rather than stubbed, so
 * `isFreighterInstalled` takes its real "not installed" branch.
 */
async function mockNoWallet(page: Page) {
  await page.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).freighter;
  });
}

/**
 * The project page renders WalletConnect twice — once in the sticky mobile bar
 * (`sm:hidden`) and once in the sidebar — so exactly one is visible at any
 * viewport. `:visible` picks whichever that is instead of guessing at an index.
 */
function noWalletLink(page: Page) {
  return page.locator("[data-testid=wallet-connect-no-wallet]:visible");
}

test.describe("a donor with no wallet", () => {
  test.beforeEach(async ({ page }) => {
    await mockNoWallet(page);
    await mockApi(page);
    await page.goto(`/projects/${MOCK_PROJECT_ID}`);
  });

  test("is offered a way to donate instead of only a link to install a wallet", async ({ page }) => {
    // The pre-change dead end: "No wallet? Install Freighter →" and nothing else.
    const noWallet = noWalletLink(page);
    await expect(noWallet).toBeVisible();
    await noWallet.click();

    await expect(page.getByTestId("first-donation-paths")).toBeVisible();
  });

  test("sees the trade-offs before any account is created", async ({ page }) => {
    await noWalletLink(page).click();
    await page.getByTestId("path-option-sponsored_account").click();

    const notice = page.getByTestId("tradeoff-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(/cannot restore it/i);
    await expect(notice).toContainText(/no password reset/i);
  });

  test("cannot proceed without explicitly acknowledging them", async ({ page }) => {
    await noWalletLink(page).click();
    await page.getByTestId("path-option-sponsored_account").click();

    await expect(page.getByTestId("tradeoff-continue")).toBeDisabled();
    await page.getByTestId("tradeoff-acknowledge").check();
    await expect(page.getByTestId("tradeoff-continue")).toBeEnabled();
  });

  test("is shown what the platform locks, and told it is not a gift", async ({ page }) => {
    await noWalletLink(page).click();
    await page.getByTestId("path-option-sponsored_account").click();

    await expect(page.getByTestId("tradeoff-notice")).toContainText("1.0000000 XLM");
    await expect(page.getByTestId("tradeoff-notice")).toContainText(/not a gift/i);
  });

  test("is told which paths this deployment cannot offer, rather than hitting a dead end", async ({ page }) => {
    await noWalletLink(page).click();

    const onramp = page.getByTestId("path-option-onramp");
    await expect(onramp).toBeDisabled();
    await expect(onramp).toContainText(/No fiat on-ramp provider is configured/i);
  });

  test("sees the non-custodial guarantee stated on the choice itself", async ({ page }) => {
    await noWalletLink(page).click();
    await expect(page.getByTestId("onboarding-guarantee")).toContainText(/never holds your key/i);
  });

  test("can get back to the ordinary wallet flow", async ({ page }) => {
    await noWalletLink(page).click();
    await page.getByTestId("path-option-connected_wallet").click();

    await expect(page.getByRole("heading", { name: /connect your wallet/i }).first()).toBeVisible();
  });
});

test.describe("the existing flow is untouched", () => {
  test("a donor with a wallet still sees the plain connect card", async ({ page }) => {
    await mockApi(page);
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).freighter = {
        isConnected: () => Promise.resolve({ isConnected: true }),
      };
    });
    await page.goto(`/projects/${MOCK_PROJECT_ID}`);

    await expect(page.getByRole("heading", { name: /connect your wallet/i }).first()).toBeVisible();
    // No onboarding flow appears unprompted for a donor who does not need it.
    await expect(page.getByTestId("first-donation-paths")).toHaveCount(0);
  });

  test("the dashboard connect card gains no onboarding affordance", async ({ page }) => {
    // Guided onboarding is opt-in per surface. The dashboard needs a specific
    // wallet, so a starter account would be the wrong answer there.
    await mockApi(page);
    await page.goto("/dashboard");

    await expect(page.getByRole("heading", { name: /connect your wallet/i })).toBeVisible();
    await expect(page.getByTestId("wallet-connect-no-wallet")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /install freighter/i })).toBeVisible();
  });
});
