import { test, expect, type Page } from "@playwright/test";

const SEEDED_PROJECT_ID = "8d9ac19b-52eb-42f7-80d9-19a88ba59e43";
// Must be checksum-valid Stellar addresses: this suite ("No API Mocking")
// builds real transactions via @stellar/stellar-sdk (only Horizon/Soroban
// network calls are mocked), and the SDK validates every account id/
// destination locally before any request goes out. OWNER_WALLET matches the
// seeded project's own walletAddress (see backend/src/services/store.js),
// mirroring the app's convention that a project's admin authenticates with
// the same wallet that owns the project.
const OWNER_WALLET = "GDYO6GEXKXPU3UH5SWGTAVHMBBZZEKUHWHXUJ33PL2TJJVHZB7CG6BI5";
const DONOR_WALLET = "GCXHYSEGSNPZF7WLHFZFWEAUUIPHTPEL55HI5RMLZ4WCKU2TLFYHHZWN";
const DUMMY_TX_HASH = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

// Must match the fixture credentials set for the backend webServer in
// playwright.integration.config.ts (ADMIN_USERNAME/ADMIN_PASSWORD).
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "e2e-test-admin-password";

// Mock Freighter
async function mockFreighter(page: Page, publicKey: string) {
  await page.addInitScript((pk) => {
    (window as unknown as Record<string, unknown>).__test_publicKey__ = pk;
    (window as unknown as Record<string, unknown>).freighter = {
      isConnected: () => Promise.resolve({ isConnected: true }),
    };
    // Test seam (see lib/wallet.ts signTransactionWithWallet): without this,
    // signing falls through to the real Freighter extension postMessage
    // handshake, which doesn't exist in a headless browser and never resolves.
    (window as unknown as Record<string, unknown>).__test_signTransaction__ = (xdr: string) =>
      Promise.resolve({ signedXDR: xdr, error: null });
  }, publicKey);
}

// Mock Horizon/Stellar (since we don't hit the real network in E2E tests)
async function mockHorizon(page: Page) {
  await page.route("**/horizon-testnet.stellar.org/**", (route) => {
    const url = route.request().url();
    if (url.includes("/accounts/")) {
      return route.fulfill({ json: { account_id: DONOR_WALLET, sequence: "100" } });
    }
    if (url.includes("/transactions")) {
      return route.fulfill({
        json: {
          successful: true,
          hash: DUMMY_TX_HASH,
        },
      });
    }
    return route.fulfill({
      json: {
        _embedded: { records: [] },
        balances: [{ asset_type: "native", balance: "500.0000000" }],
      },
    });
  });

  await page.route("**/soroban-testnet.stellar.org/**", (route) => {
    const body = route.request().postDataJSON() as { id: unknown; method?: string };
    if (body?.method === "simulateTransaction") {
      return route.fulfill({
        json: {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            id: "1",
            latestLedger: 1000,
            transactionData: "AAAAAgAAAAAAAAAAAAAAAd4m2h8=",
            minResourceFee: "100000",
            cost: { cpuInsns: "0", memBytes: "0" },
            results: [{ xdr: "AAAAAQAAAAEAAAAAAAAAAQ==" }],
            events: [],
          },
        },
      });
    }
    return route.fulfill({ json: { jsonrpc: "2.0", id: body?.id, result: {} } });
  });
}

test.describe("E2E Integration Tests (No API Mocking)", () => {
  test.beforeEach(async ({ page }) => {
    page.on("console", (msg) => {
      console.log(`[BROWSER CONSOLE] [${msg.type()}] ${msg.text()}`);
    });
    page.on("pageerror", (err) => {
      console.log(`[BROWSER PAGE ERROR] ${err.message}`);
    });
    page.on("requestfailed", (req) => {
      console.log(`[BROWSER REQUEST FAILED] ${req.url()} - ${req.failure()?.errorText || "unknown"}`);
    });
  });

  test("1. Project Browsing Flow", async ({ page }) => {
    // Go to home page
    await page.goto("/");
    await expect(page.getByText("Fund the planet.").first()).toBeVisible();

    // Go to project listing — wait for the debounced listing fetch (300ms) to finish.
    const projectsResponse = page.waitForResponse(
      (resp) => resp.url().includes("/api/v1/projects") && resp.status() === 200,
    );
    await page.goto("/projects");
    await projectsResponse;
    await expect(page.getByText("Amazon Reforestation Initiative")).toBeVisible({ timeout: 10000 });

    // Navigate to details page
    await page.getByText("Amazon Reforestation Initiative").click();
    await expect(page).toHaveURL(new RegExp(`/projects/${SEEDED_PROJECT_ID}`));
    await expect(page.getByText("Amazon Reforestation Initiative").first()).toBeVisible();
  });

  test("2. Core Donation Flow", async ({ page }) => {
    // Navigate to the project detail page — this is where the donation form
    // actually lives (the /donate/[id] route is a QR-code share link only).
    await page.goto(`/projects/${SEEDED_PROJECT_ID}`);

    // Verify project name displays correctly (indicates the API envelope was unwrapped).
    // If the bug were present, it would display "Untitled Project"
    await expect(page.getByText("Amazon Reforestation Initiative").first()).toBeVisible();
    await expect(page.getByText("Untitled Project")).not.toBeVisible();

    // Connect wallet as donor. The wallet-connected donation form (DonateForm)
    // lives on the project detail page, not on /donate/[id] — that route is
    // the SEP-7 QR-code flow checked above and has no amount input or submit
    // button of its own.
    await mockFreighter(page, DONOR_WALLET);
    await mockHorizon(page);
    await page.goto(`/projects/${SEEDED_PROJECT_ID}`);

    // Baseline raised total, fetched directly from the API rather than
    // parsed off the page — the "Recent Donations" feed is populated only by
    // the backend's own Horizon indexer watching the real chain (see
    // backend/src/services/turrets.js), which a Horizon-mocked donation can
    // never reach. What a mocked donation *does* guarantee synchronously is
    // the project's raised total, updated by the command bus while
    // recording the donation (see storeProjectAggregate in
    // backend/src/eventSourcing/commandBus.js) — that's what we verify.
    const beforeRes = await page.request.get(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${SEEDED_PROJECT_ID}`);
    const raisedBefore = parseFloat((await beforeRes.json()).data.raisedXLM);

    // Fill donation form
    const form = page.locator(".card", { hasText: /make a donation/i });
    await expect(form.getByRole("heading", { name: /make a donation/i })).toBeVisible();
    await form.getByPlaceholder(/or enter custom amount/i).fill("25");

    // Click submit
    const donateBtn = form.getByRole("button", { name: /Donate/i });
    await expect(donateBtn).toBeEnabled();
    await donateBtn.click();

    // Verify success state (indicates recorded in Postgres)
    await expect(page.getByText("Thank you!")).toBeVisible();

    // The project's raised total reflects the donation immediately.
    await expect(async () => {
      const afterRes = await page.request.get(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${SEEDED_PROJECT_ID}`);
      const raisedAfter = parseFloat((await afterRes.json()).data.raisedXLM);
      expect(raisedAfter).toBeCloseTo(raisedBefore + 25, 5);
    }).toPass({ timeout: 5000 });
  });

  test("3. Admin Status Flow", async ({ page }) => {
    // Log in as platform admin — required for the status-change endpoint,
    // which only accepts a verified admin JWT (see backend/src/routes/projects.js).
    await page.goto("/admin/login");
    await page.getByLabel("Username").fill(ADMIN_USERNAME);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Log In" }).click();
    await expect(page).toHaveURL(/\/admin$/);

    // Connect wallet as project owner — still required to view this project's admin page.
    await mockFreighter(page, OWNER_WALLET);
    await page.goto(`/admin/${SEEDED_PROJECT_ID}`);

    // Verify page title and active status
    await expect(page.getByText("Project Admin")).toBeVisible();
    await expect(page.getByText("active", { exact: true })).toBeVisible();

    // Reject the project
    await page.getByPlaceholder("Provide a reason for this decision...").fill("Testing reject integration flow");
    const rejectBtn = page.getByRole("button", { name: "Reject" });
    await expect(rejectBtn).toBeEnabled();
    await rejectBtn.click();

    // Verify status changed to rejected
    await expect(page.getByText("rejected", { exact: true })).toBeVisible();
    await expect(page.getByText("Testing reject integration flow")).toBeVisible();

    // Approve it back to active
    const approveBtn = page.getByRole("button", { name: "Approve" });
    await expect(approveBtn).toBeEnabled();
    await approveBtn.click();

    // Verify status is back to active
    await expect(page.getByText("active", { exact: true })).toBeVisible();
  });
});
