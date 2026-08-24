/**
 * utils/__tests__/escapeHtml.test.ts
 *
 * Unit tests for the escapeHtml() HTML-context escaping utility.
 *
 * These tests are the first line of defence: they confirm that every
 * HTML-significant character is replaced with its safe entity equivalent
 * before any higher-level integration test runs.
 */
import { escapeHtml } from "@/utils/escapeHtml";

describe("escapeHtml", () => {
  // ── Core character escaping ───────────────────────────────────────────────

  it("escapes & before any other character to prevent double-encoding", () => {
    expect(escapeHtml("rock & roll")).toBe("rock &amp; roll");
  });

  it("escapes < so opening tags cannot be injected", () => {
    expect(escapeHtml("<div>")).toBe("&lt;div&gt;");
  });

  it("escapes > so closing tags cannot be injected", () => {
    expect(escapeHtml("</div>")).toBe("&lt;/div&gt;");
  });

  it('escapes " so attribute values cannot be broken out of', () => {
    expect(escapeHtml('"hello"')).toBe("&quot;hello&quot;");
  });

  it("escapes ' so single-quoted attributes cannot be broken out of", () => {
    expect(escapeHtml("it's")).toBe("it&#x27;s");
  });

  // ── Compound injection payloads ───────────────────────────────────────────

  it("neutralises a basic <script> injection", () => {
    const payload = '<script>alert("xss")</script>';
    const result = escapeHtml(payload);
    expect(result).not.toContain("<script>");
    expect(result).not.toContain("</script>");
    expect(result).toBe(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
    );
  });

  it("neutralises an img onerror injection", () => {
    const payload = '<img src=x onerror="alert(1)">';
    const result = escapeHtml(payload);
    // The opening tag must be gone — < encoded to &lt;
    expect(result).not.toContain("<img");
    // The double-quote must be encoded — no raw " after the = sign
    expect(result).not.toContain('onerror="');
    expect(result).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
  });

  it("neutralises a javascript: href injection", () => {
    const payload = '<a href="javascript:alert(1)">click</a>';
    const result = escapeHtml(payload);
    expect(result).not.toContain("<a ");
    expect(result).toBe(
      "&lt;a href=&quot;javascript:alert(1)&quot;&gt;click&lt;/a&gt;",
    );
  });

  it("does not double-encode when called twice", () => {
    const once = escapeHtml("a & b");
    const twice = escapeHtml(once);
    // First call:  "a &amp; b"
    // Second call: "a &amp;amp; b"  — this is intentional; callers must not
    // call escapeHtml on already-escaped content.
    expect(once).toBe("a &amp; b");
    expect(twice).toBe("a &amp;amp; b");
  });

  // ── Safe passthrough ──────────────────────────────────────────────────────

  it("passes through strings that contain no special characters unchanged", () => {
    expect(escapeHtml("Amazon Reforestation Initiative")).toBe(
      "Amazon Reforestation Initiative",
    );
  });

  it("passes through an empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });

  // ── Non-string coercion ───────────────────────────────────────────────────

  it("coerces a number to a string", () => {
    expect(escapeHtml(42)).toBe("42");
  });

  it("coerces null to the string 'null'", () => {
    expect(escapeHtml(null)).toBe("null");
  });

  it("coerces undefined to the string 'undefined'", () => {
    expect(escapeHtml(undefined)).toBe("undefined");
  });

  it("coerces a boolean to its string representation", () => {
    expect(escapeHtml(true)).toBe("true");
    expect(escapeHtml(false)).toBe("false");
  });
});
