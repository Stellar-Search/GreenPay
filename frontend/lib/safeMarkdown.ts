/**
 * Deliberately small markdown renderer for donor-facing project updates.
 *
 * This is a security boundary: input is never interpreted as HTML, generated
 * tags come from a fixed allowlist, and link destinations are normalized
 * through URL parsing before they reach an attribute.
 */

const LINK_PATTERN = /\[([^\]\n]{1,500})\]\(([^)\n]{1,2048})\)/g;
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderPlain(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/\n/g, "<br />");
}

function normalizeHref(rawValue: string): string | null {
  const value = rawValue.trim();
  if (!value || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol.toLowerCase())) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/** Render bold, italic, absolute allowlisted links, and line breaks. */
export function renderMarkdown(text: string): string {
  if (!text) return "";

  const output: string[] = [];
  let cursor = 0;
  LINK_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    const index = match.index ?? cursor;
    output.push(renderPlain(text.slice(cursor, index)));
    const href = normalizeHref(match[2]);
    if (!href) {
      output.push(renderPlain(match[0]));
    } else {
      output.push(
        `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer nofollow" class="text-forest-600 hover:underline">${renderPlain(match[1])}</a>`,
      );
    }
    cursor = index + match[0].length;
  }
  output.push(renderPlain(text.slice(cursor)));
  return output.join("");
}
