/**
 * escapeHtml.ts
 *
 * Escapes the five characters that have special meaning in HTML so that
 * arbitrary user-supplied strings can be safely interpolated into an HTML
 * document string without creating injection vectors.
 *
 * Covered characters and their replacements:
 *   &  →  &amp;   (must be first to avoid double-escaping)
 *   <  →  &lt;    (closes any open tag / terminates a script block)
 *   >  →  &gt;    (defense-in-depth; closes tags in legacy parsers)
 *   "  →  &quot;  (breaks out of double-quoted attribute values)
 *   '  →  &#x27;  (breaks out of single-quoted attribute values)
 *
 * Why not DOMParser / innerHTML?
 * This utility is called inside handlePrintReport which runs *before* the
 * popup document exists, so no DOM node is available to leverage.  The
 * five-character map is the canonical approach recommended by OWASP for
 * HTML-context escaping and covers every code path in the print template.
 *
 * @param value - Any value; non-strings are coerced with String() first.
 * @returns The HTML-safe string.
 */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}
