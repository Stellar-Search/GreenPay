/**
 * e2e/graph-visualizer-perf.spec.ts
 *
 * Lifecycle check for TransactionGraphVisualizer (resolves #352): mounting
 * and unmounting the /network page twenty times must not leak WebGL
 * contexts toward the browser's limit, now that cleanup calls
 * `forceContextLoss()`.
 *
 * The picking algorithm's cost and allocation behavior at fifty-thousand
 * nodes is benchmarked separately in lib/__tests__/graphPicking.bench.test.ts,
 * as a plain-JS micro-benchmark against the same ScreenBucketGrid class this
 * component uses. That's deliberate: it isolates the CPU cost the issue is
 * about from WebGL draw-call/rasterization cost, which is GPU-bound and,
 * on software-rendered headless Chromium, was observed to make individual
 * pointer/wheel events take seconds regardless of scene size — not
 * something a live-interaction e2e test here could measure meaningfully or
 * reliably.
 */
import { test, expect, type Page } from "@playwright/test";

const ok = (data: unknown) => ({ json: { success: true, data } });

/** Minimal catch-all so any page visited during the mount/unmount loop renders without error. */
async function mockApi(page: Page) {
  await page.route("**/api/v1/**", (r) => r.fulfill(ok([])));
  await page.route("**/horizon-testnet.stellar.org/**", (r) =>
    r.fulfill({ json: { _embedded: { records: [] }, balances: [] } })
  );
  await page.route("**/api/v1/stats/global", (r) =>
    r.fulfill(ok({ totalDonations: 0, totalXLMRaised: "0", publishedImpactClaims: 0, verifiedImpactClaims: 0 }))
  );
  await page.route("**/api/v1/stats/categories", (r) => r.fulfill(ok([])));
  await page.route("**/api/v1/projects?**", (r) => r.fulfill(ok([])));
  await page.route("**/api/v1/projects", (r) => r.fulfill(ok([])));
  await page.route("**/api/v1/projects/featured", (r) => r.fulfill({ status: 404, json: { success: false } }));
}

/** Deterministically synthesize a graph of the given size — no randomness, so runs are reproducible. */
function buildMockGraph(nodeCount: number, edgeCount: number) {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: `GNODE${String(i).padStart(8, "0")}STELLARWALLETADDRESSPADXXXXXXX`.slice(0, 56),
    totalIn: (i * 37) % 5000,
    totalOut: (i * 53) % 3000,
    degree: 1 + (i % 40),
  }));
  const edges = Array.from({ length: edgeCount }, (_, i) => ({
    source: nodes[i % nodeCount].id,
    target: nodes[(i * 7919 + 1) % nodeCount].id,
    amount: (i % 500) + 1,
    type: i % 5 === 0 ? "escrow" : "donation",
    txHash: `tx${i}`,
  }));
  return { nodes, edges };
}

async function mockNetworkGraph(page: Page, nodeCount: number, edgeCount: number) {
  const graph = buildMockGraph(nodeCount, edgeCount);
  // lib/api.ts rewrites `/api/*` calls to the versioned `/api/v1/*` prefix.
  // Registered after mockApi()'s catch-all so this more specific route wins
  // (Playwright resolves overlapping routes in reverse registration order).
  await page.route("**/api/v1/network/graph**", (r) => r.fulfill(ok(graph)));
}

test.describe("TransactionGraphVisualizer lifecycle (#352)", () => {
  test("mounting and unmounting the network page twenty times does not exhaust WebGL contexts", async ({ page }) => {
    // 20 real mount/unmount cycles, each waiting for a fresh WebGL context —
    // inherently slow under software-rendered headless Chromium.
    test.setTimeout(180_000);
    await mockApi(page);
    await mockNetworkGraph(page, 200, 400);

    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error" || /webgl/i.test(msg.text())) {
        consoleErrors.push(msg.text());
      }
    });
    page.on("pageerror", (err) => consoleErrors.push(err.message));

    for (let i = 0; i < 20; i++) {
      await page.goto("/network");
      await expect(page.locator("canvas")).toBeVisible({ timeout: 10_000 });
      await page.goto("about:blank");
    }

    await page.goto("/network");
    await expect(page.locator("canvas")).toBeVisible({ timeout: 10_000 });

    const contextLossErrors = consoleErrors.filter((m) => /webgl context|lose_context|context lost/i.test(m));
    expect(
      contextLossErrors,
      `WebGL context errors after 20 mount/unmount cycles:\n${contextLossErrors.join("\n")}`
    ).toHaveLength(0);
  });
});
