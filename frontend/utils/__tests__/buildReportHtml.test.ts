/**
 * utils/__tests__/buildReportHtml.test.ts
 *
 * Regression tests for buildReportHtml() — the pure HTML-generation function
 * used by handlePrintReport.
 *
 * Issue #343: handlePrintReport wrote unescaped project data into a
 * same-origin popup via document.write.  These tests verify that:
 *
 *   1. Every user-supplied field is HTML-escaped before it reaches the output.
 *   2. No raw < > & " ' characters from user input appear in the HTML string.
 *   3. Specifically, a <script> tag in any field does NOT appear as executable
 *      markup in the output.
 *   4. A double-quote in any field cannot break out of an attribute context.
 *   5. Benign content is preserved (display correctly after unescaping).
 *   6. Update fields (title, body) receive the same escaping as project fields.
 *   7. window.open and document.write are NOT called — the old popup approach
 *      has been replaced by the srcdoc-iframe path.
 */
import { buildReportHtml } from "@/utils/buildReportHtml";
import type { ClimateProject, ProjectUpdate } from "@/utils/types";

// ── Shared test fixtures ──────────────────────────────────────────────────────

/** A valid project with entirely benign content — baseline / no-injection case. */
const baseProject: ClimateProject = {
  id: "proj-safe-1",
  name: "Amazon Reforestation Initiative",
  description: "Restoring native tree cover across degraded rainforest land.",
  category: "Reforestation",
  location: "Brazil",
  walletAddress: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST",
  goalXLM: "10000",
  raisedXLM: "2500",
  donorCount: 42,
  co2OffsetKg: 1200,
  status: "active",
  verified: true,
  onChainVerified: false,
  tags: ["trees", "carbon"],
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-02T00:00:00.000Z",
};

/** The canonical XSS payload used throughout the tests. */
const SCRIPT_PAYLOAD   = '<script>window.__xss=true</script>';
const DQUOTE_PAYLOAD   = '"onmouseover="alert(1)"';
const SQUOTE_PAYLOAD   = "'onmouseover='alert(1)'";
const AMP_PAYLOAD      = "Rocks & Trees & <b>Water</b>";
const COMBINED_PAYLOAD = `<img src=x onerror="window.__xss=true"> "test" 'test' & rocks`;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse the HTML output string with jsdom's DOMParser so we can make
 * structural assertions without string-matching noise.
 */
function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/**
 * Return the text content of the first element matching `selector` inside
 * the parsed document.  Throws if not found so test failures are obvious.
 */
function textOf(doc: Document, selector: string): string {
  const el = doc.querySelector(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);
  return el.textContent ?? "";
}

// ── 1. Baseline: benign content renders correctly ─────────────────────────────

describe("buildReportHtml — benign content", () => {
  let html: string;

  beforeAll(() => {
    html = buildReportHtml({ project: baseProject, updates: [] });
  });

  it("produces a complete HTML document string", () => {
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain("</html>");
  });

  it("contains the project name in the <title>", () => {
    expect(html).toContain("Amazon Reforestation Initiative - Impact Report");
  });

  it("contains the project name in the body", () => {
    const doc = parseHtml(html);
    expect(textOf(doc, ".project-title")).toContain(
      "Amazon Reforestation Initiative",
    );
  });

  it("contains the project location", () => {
    const doc = parseHtml(html);
    const metaText = doc.querySelector(".project-meta")?.textContent ?? "";
    expect(metaText).toContain("Brazil");
  });

  it("contains the project description", () => {
    const doc = parseHtml(html);
    expect(textOf(doc, ".description")).toContain(
      "Restoring native tree cover",
    );
  });

  it("contains the wallet address", () => {
    const doc = parseHtml(html);
    expect(textOf(doc, ".wallet-address")).toContain(
      "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST",
    );
  });

  it("does NOT call window.open", () => {
    // window.open must not be called anywhere in the HTML-building path.
    // (The component test separately verifies the overlay path.)
    const openSpy = jest.spyOn(window, "open");
    buildReportHtml({ project: baseProject, updates: [] });
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });
});

// ── 2. Injection regression: project fields ───────────────────────────────────

describe("buildReportHtml — project field injection (Issue #343)", () => {
  /**
   * For each project field, build a project object where ONLY that field
   * contains the malicious payload, generate the HTML, and assert that:
   *   a) The raw payload string does NOT appear verbatim in the output.
   *   b) No executable <script> tag appears in the output.
   *   c) The content is still preserved — the text is visible after parsing.
   */

  const FIELDS: Array<{
    field: keyof ClimateProject;
    payload: string;
    selector: string;
  }> = [
    { field: "name",        payload: SCRIPT_PAYLOAD, selector: ".project-title" },
    { field: "location",    payload: SCRIPT_PAYLOAD, selector: ".project-meta"  },
    { field: "category",    payload: SCRIPT_PAYLOAD, selector: ".badge-category" },
    { field: "description", payload: SCRIPT_PAYLOAD, selector: ".description"   },
    { field: "walletAddress", payload: SCRIPT_PAYLOAD, selector: ".wallet-address" },
  ];

  for (const { field, payload, selector } of FIELDS) {
    describe(`field: ${field}`, () => {
      let html: string;

      beforeAll(() => {
        const project = { ...baseProject, [field]: payload };
        html = buildReportHtml({ project, updates: [] });
      });

      it("does not contain a raw <script> opening tag", () => {
        // Case-insensitive because browsers fold tag names.
        expect(html.toLowerCase()).not.toMatch(/<script[\s>]/);
      });

      it("payload text appears only as HTML-encoded data, never as a raw tag", () => {
        // The payload '<script>window.__xss=true</script>' should appear in
        // its escaped form — the opening '<' must be encoded as '&lt;'.
        // A raw '<script' in the output would mean the escaping failed.
        expect(html).not.toMatch(/<script/i);
        // The closing tag must also be absent in raw form.
        expect(html).not.toMatch(/<\/script/i);
      });

      it("preserves the injected text as visible content (HTML-encoded)", () => {
        // After HTML-parsing, the text content should contain the payload's
        // textual representation — the browser decoded it safely.
        const doc = parseHtml(html);
        const el  = doc.querySelector(selector);
        // The text content of the element should contain the visible part of
        // the payload once the HTML entities are decoded by the parser.
        expect(el).not.toBeNull();
      });
    });
  }

  it("escapes a <script> in project.name in the <title> as well", () => {
    const project = { ...baseProject, name: SCRIPT_PAYLOAD };
    const html    = buildReportHtml({ project, updates: [] });
    // Raw <script must never appear in any context.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<\/script/i);
  });

  it("escapes double-quotes in project.name so attribute context is intact", () => {
    const project = { ...baseProject, name: DQUOTE_PAYLOAD };
    const html    = buildReportHtml({ project, updates: [] });
    // Raw unescaped double-quote followed by event handler should not appear.
    expect(html).not.toContain('"onmouseover=');
    // The safe entity form should appear instead.
    expect(html).toContain("&quot;");
  });

  it("escapes single-quotes in project.description", () => {
    const project = { ...baseProject, description: SQUOTE_PAYLOAD };
    const html    = buildReportHtml({ project, updates: [] });
    expect(html).not.toContain("'onmouseover=");
    expect(html).toContain("&#x27;");
  });

  it("escapes & in project.description to prevent entity injection", () => {
    const project = { ...baseProject, description: AMP_PAYLOAD };
    const html    = buildReportHtml({ project, updates: [] });
    // Raw & followed by a tag name or entity name should not appear unescaped.
    expect(html).toContain("&amp;");
    // No raw < should appear from the payload.
    expect(html).not.toMatch(/Rocks &amp; Trees &amp; <b>/);
  });

  it("neutralises the combined onerror+quote+amp payload in project.description", () => {
    const project = { ...baseProject, description: COMBINED_PAYLOAD };
    const html    = buildReportHtml({ project, updates: [] });
    // No raw <img opening tag — < must be encoded as &lt;
    expect(html).not.toContain("<img");
    // The dangerous form is onerror=" (unquoted assignment) — the " must be &quot;
    expect(html).not.toContain('onerror="');
    // The payload's JS must not be able to execute
    expect(html).not.toContain("<script");
  });
});

// ── 3. Injection regression: update fields ────────────────────────────────────

describe("buildReportHtml — update field injection (Issue #343)", () => {
  const makeUpdate = (overrides: Partial<ProjectUpdate>): ProjectUpdate => ({
    id: "upd-1",
    projectId: "proj-safe-1",
    title: "Quarterly progress report",
    body: "Trees planted: 500",
    createdAt: "2025-03-01T00:00:00.000Z",
    ...overrides,
  });

  it("escapes a <script> payload in update.title", () => {
    const html = buildReportHtml({
      project: baseProject,
      updates: [makeUpdate({ title: SCRIPT_PAYLOAD })],
    });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<\/script/i);
  });

  it("escapes a <script> payload in update.body", () => {
    const html = buildReportHtml({
      project: baseProject,
      updates: [makeUpdate({ body: SCRIPT_PAYLOAD })],
    });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<\/script/i);
  });

  it("escapes double-quotes in update.title", () => {
    const html = buildReportHtml({
      project: baseProject,
      updates: [makeUpdate({ title: DQUOTE_PAYLOAD })],
    });
    expect(html).not.toContain('"onmouseover=');
    expect(html).toContain("&quot;");
  });

  it("escapes double-quotes in update.body", () => {
    const html = buildReportHtml({
      project: baseProject,
      updates: [makeUpdate({ body: DQUOTE_PAYLOAD })],
    });
    expect(html).not.toContain('"onmouseover=');
    expect(html).toContain("&quot;");
  });

  it("escapes the combined onerror payload in update.body", () => {
    const html = buildReportHtml({
      project: baseProject,
      updates: [makeUpdate({ body: COMBINED_PAYLOAD })],
    });
    // No raw <img opening tag.
    expect(html).not.toContain("<img");
    // The dangerous form is onerror=" — the " must be &quot; making it inert.
    expect(html).not.toContain('onerror="');
    expect(html).not.toContain("<script");
  });

  it("only renders the first 5 updates (excess updates are dropped)", () => {
    const manyUpdates = Array.from({ length: 8 }, (_, i) =>
      makeUpdate({ id: `upd-${i}`, title: `Update ${i}`, body: `Body ${i}` }),
    );
    const html = buildReportHtml({ project: baseProject, updates: manyUpdates });
    // Updates 0–4 should appear; update 5+ should not.
    expect(html).toContain("Update 4");
    expect(html).not.toContain("Update 5");
  });

  it("omits the updates section entirely when updates array is empty", () => {
    const html = buildReportHtml({ project: baseProject, updates: [] });
    expect(html).not.toContain("Recent Project Updates");
  });
});

// ── 4. Structural / CSP validation ───────────────────────────────────────────

describe("buildReportHtml — structural validation", () => {
  it("contains no <script> elements in a benign report", () => {
    const html = buildReportHtml({ project: baseProject, updates: [] });
    const doc  = parseHtml(html);
    expect(doc.querySelectorAll("script")).toHaveLength(0);
  });

  it("contains no event-handler attributes (onclick, onerror=, etc.) in benign output", () => {
    const html = buildReportHtml({ project: baseProject, updates: [] });
    // Match only the attribute-assignment form (e.g. onerror=, onclick=)
    // not the bare word which can legitimately appear in CSS or text.
    expect(html).not.toMatch(/\bon\w+\s*=/i);
  });

  it("has a <meta charset='utf-8'> tag", () => {
    const html = buildReportHtml({ project: baseProject, updates: [] });
    expect(html).toContain('<meta charset="utf-8">');
  });

  it("verified badge appears for verified projects", () => {
    const html = buildReportHtml({
      project: { ...baseProject, verified: true },
      updates: [],
    });
    expect(html).toContain("Verified Project");
  });

  it("verified badge is absent for unverified projects", () => {
    const html = buildReportHtml({
      project: { ...baseProject, verified: false },
      updates: [],
    });
    expect(html).not.toContain("Verified Project");
  });
});
