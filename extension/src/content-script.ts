import { isValidStellarAddress } from './stellar-address';

const STELLAR_ADDRESS_REGEX = /\bG[A-Z2-7]{55}\b/g;
const GENERATED_NODES = new WeakSet<Node>();

/**
 * Host-page values are untrusted. The scanning regex above is only a cheap
 * candidate pre-filter for highlighting; this is the authoritative gate: only
 * a value with a valid StrKey checksum may cross the extension messaging
 * boundary.
 */
export function sanitizeStellarAddress(value: unknown): string | null {
  if (typeof value !== 'string' || !isValidStellarAddress(value)) {
    return null;
  }

  return value;
}

function createTooltip(): HTMLDivElement {
  const tooltip = document.createElement('div');
  tooltip.className = 'greenpay-tooltip';
  tooltip.textContent = 'Donate to this address via GreenPay';
  tooltip.style.cssText = `
    position: absolute;
    background: #1a1a1a;
    color: #fff;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    z-index: 10000;
    pointer-events: none;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    margin-bottom: 8px;
  `;
  return tooltip;
}

export function highlightAddresses(node: Node): void {
  // Do not process UI that this content script inserted. In addition to avoiding
  // duplicate highlights, the WeakSet cannot be spoofed with host-controlled
  // classes or data attributes.
  if (GENERATED_NODES.has(node)) return;

  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent;
    if (!text) return;

    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let foundAddress = false;

    STELLAR_ADDRESS_REGEX.lastIndex = 0;
    while ((match = STELLAR_ADDRESS_REGEX.exec(text)) !== null) {
      const address = sanitizeStellarAddress(match[0]);
      if (!address) continue;
      foundAddress = true;

      if (match.index > lastIndex) {
        fragment.appendChild(
          document.createTextNode(text.substring(lastIndex, match.index))
        );
      }

      const span = document.createElement('span');
      GENERATED_NODES.add(span);
      span.className = 'greenpay-address';
      // textContent is deliberate: host-controlled text must never be parsed as
      // HTML, even if it contains markup immediately beside an address.
      span.textContent = address;
      span.style.cssText = `
        background: linear-gradient(135deg, #4CAF50, #2E7D32);
        color: white;
        padding: 2px 6px;
        border-radius: 4px;
        cursor: pointer;
        font-weight: 600;
        display: inline-block;
        position: relative;
        margin: 0 2px;
        transition: all 0.2s ease;
      `;

      let tooltip: HTMLDivElement | null = null;

      span.addEventListener('mouseenter', () => {
        tooltip = createTooltip();
        const rect = span.getBoundingClientRect();
        tooltip.style.left = rect.left + rect.width / 2 + 'px';
        tooltip.style.top = rect.top + window.scrollY + 'px';
        document.body.appendChild(tooltip);
      });

      span.addEventListener('mouseleave', () => {
        if (tooltip && tooltip.parentNode) {
          tooltip.parentNode.removeChild(tooltip);
        }
        tooltip = null;
      });

      span.addEventListener('click', () => {
        // Use the validated immutable capture, never mutable DOM state. A hostile
        // page can rewrite the shared span after it has been inserted.
        chrome.runtime.sendMessage({
          action: 'openDonatePopup',
          address
        });
      });

      fragment.appendChild(span);
      lastIndex = STELLAR_ADDRESS_REGEX.lastIndex;
    }

    if (!foundAddress) return;

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
    }

    if (node.parentNode) {
      node.parentNode.replaceChild(fragment, node);
    }
  } else if (
    node.nodeType === Node.ELEMENT_NODE &&
    !['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME'].includes(
      (node as HTMLElement).tagName
    )
  ) {
    node.childNodes.forEach(child => highlightAddresses(child));
  }
}

let observer: MutationObserver | null = null;
let initialized = false;

export function initContentScript(): void {
  if (initialized || !document.body) return;
  initialized = true;

  highlightAddresses(document.body);

  observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
          highlightAddresses(node);
        }
      });
    });
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

/**
 * Test hook for cleaning up the observer between isolated DOM fixtures.
 */
export function resetContentScriptForTest(): void {
  observer?.disconnect();
  observer = null;
  initialized = false;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initContentScript, { once: true });
} else {
  initContentScript();
}
