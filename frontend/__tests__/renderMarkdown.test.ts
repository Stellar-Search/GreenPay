import fc from "fast-check";
import { renderMarkdown } from "../lib/safeMarkdown";

describe("renderMarkdown", () => {
  describe("Benign Input Rendering", () => {
    it("renders bold text correctly", () => {
      expect(renderMarkdown("**bold text**")).toBe("<strong>bold text</strong>");
    });

    it("renders italic text correctly", () => {
      expect(renderMarkdown("*italic text*")).toBe("<em>italic text</em>");
    });

    it("renders valid http and https links correctly", () => {
      expect(renderMarkdown("[Example](https://example.com)")).toBe(
        '<a href="https://example.com/" target="_blank" rel="noopener noreferrer nofollow" class="text-forest-600 hover:underline">Example</a>',
      );
      expect(renderMarkdown("[Example](http://example.com)")).toBe(
        '<a href="http://example.com/" target="_blank" rel="noopener noreferrer nofollow" class="text-forest-600 hover:underline">Example</a>',
      );
    });

    it("renders mailto links correctly", () => {
      expect(renderMarkdown("[Email Us](mailto:test@example.com)")).toBe(
        '<a href="mailto:test@example.com" target="_blank" rel="noopener noreferrer nofollow" class="text-forest-600 hover:underline">Email Us</a>',
      );
    });

    it("preserves single ampersands in URLs without double-escaping", () => {
      const output = renderMarkdown("[Link](https://example.com?a=1&b=2)");
      expect(output).toBe(
        '<a href="https://example.com/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer nofollow" class="text-forest-600 hover:underline">Link</a>',
      );
    });

    it("converts newlines to <br />", () => {
      expect(renderMarkdown("Hello\nWorld")).toBe("Hello<br />World");
    });
  });

  describe("Scheme Allowlist & Security Controls", () => {
    it("renders javascript: URLs as plain text instead of hyper-links", () => {
      const output = renderMarkdown("[Click Me](javascript:alert(1))");
      expect(output).not.toContain("<a ");
      expect(output).toBe("[Click Me](javascript:alert(1))");
    });

    it("renders data: URLs as plain text", () => {
      const output = renderMarkdown(
        "[Click Me](data:text/html,<script>alert(1)</script>)",
      );
      expect(output).not.toContain("<a ");
    });

    it("escapes quote characters in URLs so attributes cannot be terminated", () => {
      const output = renderMarkdown(
        '[Click](https://example.com" onfocus="alert" x=")',
      );
      expect(output).not.toContain("<a ");
      expect(output).not.toMatch(/href="[^\"]*"\s+onfocus=/);
    });

    it("renders malformed link payloads with quotes and no scheme as plain text", () => {
      const output = renderMarkdown('[Click](" onfocus="alert(1)" x=")');
      expect(output).not.toContain("<a ");
      expect(output).toContain("[Click](&quot; onfocus=&quot;alert(1)&quot; x=&quot;)");
    });

    it("escapes raw HTML script tags", () => {
      expect(renderMarkdown("<script>alert(1)</script>")).toBe(
        "&lt;script&gt;alert(1)&lt;/script&gt;",
      );
    });
  });

  describe("Property-Based Tests (fast-check)", () => {
    it("guarantees no input can inject script tags", () => {
      fc.assert(
        fc.property(fc.string(), (input) => {
          const rendered = renderMarkdown(input);
          expect(rendered.toLowerCase()).not.toContain("<script");
        }),
      );
    });

    it("guarantees href attributes only contain allowlisted schemes", () => {
      fc.assert(
        fc.property(fc.string(), (input) => {
          const rendered = renderMarkdown(input);
          const hrefMatches = rendered.match(/href="([^"]*)"/g) || [];
          for (const match of hrefMatches) {
            const hrefValue = match.slice(6, -1);
            const unescapedHref = hrefValue.replace(/&amp;/g, "&");
            const isValid = /^(?:https?:\/\/|mailto:)/i.test(unescapedHref);
            expect(isValid).toBe(true);
          }
        }),
      );
    });

    it("guarantees no input yields executable event handlers (on* attributes) outside plain text", () => {
      fc.assert(
        fc.property(fc.string(), (input) => {
          const rendered = renderMarkdown(input);
          const tags = rendered.match(/<[^>]+>/g) || [];
          for (const tag of tags) {
            expect(tag).not.toMatch(/\s+on[a-z]+=/i);
          }
        }),
      );
    });

    it("guarantees every generated element and attribute is allowlisted", () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 1000 }), (input) => {
          const container = document.createElement("div");
          container.innerHTML = renderMarkdown(input);
          for (const element of Array.from(container.querySelectorAll("*"))) {
            expect(["A", "STRONG", "EM", "BR"]).toContain(element.tagName);
            const allowedAttributes = element.tagName === "A"
              ? new Set(["href", "target", "rel", "class"])
              : new Set<string>();
            for (const attribute of Array.from(element.attributes)) {
              expect(allowedAttributes.has(attribute.name)).toBe(true);
              expect(attribute.name.toLowerCase().startsWith("on")).toBe(false);
            }
          }
        }),
        { numRuns: 1000 },
      );
    });

    it("keeps token-like control text inert", () => {
      const output = renderMarkdown("[\u0000TOK_0\u0000<img src=x onerror=alert(1)>](https://example.com)");
      const container = document.createElement("div");
      container.innerHTML = output;
      expect(container.querySelector("img")).toBeNull();
      expect(container.querySelector("a")?.textContent).toContain("<img src=x onerror=alert(1)>");
    });
  });
});
