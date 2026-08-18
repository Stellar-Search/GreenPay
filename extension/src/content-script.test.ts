// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  highlightAddresses,
  initContentScript,
  resetContentScriptForTest,
  sanitizeStellarAddress,
} from './content-script';

// A real, checksum-valid Stellar public key (from Stellar's docs). The old
// fixture used `G${'A'.repeat(55)}`, which only matched the shape regex and is
// rejected by the StrKey-backed sanitizer.
const ADDRESS = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

// Shape-valid but checksum-invalid — the class of value the sanitizer must
// reject even though it matches the scanning regex.
const SHAPE_ONLY_ADDRESS = `G${'A'.repeat(55)}`;

describe('content script hostile-page hardening', () => {
  const sendMessage = vi.fn();

  beforeEach(() => {
    resetContentScriptForTest();
    document.body.replaceChildren();
    sendMessage.mockReset();
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage,
      },
    });
  });

  afterEach(() => {
    resetContentScriptForTest();
    vi.unstubAllGlobals();
  });

  it('accepts only complete, checksum-valid Stellar addresses at the message boundary', () => {
    expect(sanitizeStellarAddress(ADDRESS)).toBe(ADDRESS);
    expect(sanitizeStellarAddress(SHAPE_ONLY_ADDRESS)).toBeNull();
    expect(sanitizeStellarAddress(`${ADDRESS}<script>alert(1)</script>`)).toBeNull();
    expect(sanitizeStellarAddress(`javascript:${ADDRESS}`)).toBeNull();
    expect(sanitizeStellarAddress({ toString: () => ADDRESS })).toBeNull();
  });

  it('keeps adjacent malicious markup inert while highlighting host text', () => {
    const hook = document.createElement('div');
    hook.textContent = `${ADDRESS}<img src=x onerror="globalThis.pwned=true"><script>globalThis.pwned=true</script>`;
    document.body.appendChild(hook);

    highlightAddresses(hook);

    const highlighted = hook.querySelector<HTMLSpanElement>('.greenpay-address');
    expect(highlighted?.textContent).toBe(ADDRESS);
    expect(hook.querySelector('img')).toBeNull();
    expect(hook.querySelector('script')).toBeNull();
    expect(hook.textContent).toContain('<img src=x onerror=');
  });

  it('sends the validated capture even if the hostile page rewrites injected DOM', () => {
    const hook = document.createElement('div');
    hook.textContent = ADDRESS;
    document.body.appendChild(hook);
    highlightAddresses(hook);

    const highlighted = hook.querySelector<HTMLSpanElement>('.greenpay-address');
    expect(highlighted).not.toBeNull();

    highlighted!.textContent = '<img src=x onerror=alert(1)>';
    highlighted!.dataset.address = 'javascript:alert(1)';
    highlighted!.click();

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith({
      action: 'openDonatePopup',
      address: ADDRESS,
    });
  });

  it('handles malicious dynamically-added text without recursive re-highlighting', async () => {
    initContentScript();
    const hook = document.createElement('div');
    hook.textContent = `${ADDRESS}<svg onload="globalThis.pwned=true">`;
    document.body.appendChild(hook);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(hook.querySelectorAll('.greenpay-address')).toHaveLength(1);
    expect(hook.querySelector('svg')).toBeNull();
    hook.querySelector<HTMLSpanElement>('.greenpay-address')!.click();
    expect(sendMessage).toHaveBeenCalledWith({
      action: 'openDonatePopup',
      address: ADDRESS,
    });
  });
});
