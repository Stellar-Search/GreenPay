// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  highlightAddresses,
  initContentScript,
  resetContentScriptForTest,
  sanitizeStellarAddress,
  GENERATED_NODES,
  ACTIVE_TOOLTIPS,
} from './content-script';

// Real, checksum-valid Stellar public keys. The old fixtures used
// `G${'A'.repeat(55)}` etc., which only matched the shape regex and are
// rejected by the StrKey-backed sanitizer.
const ADDRESS = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const SECOND_ADDRESS = 'GDQCDHD4ZRSKWEEX2KDATJRVD5WUJEAYWWKEW5COFQKUHRYR2D3VH5VE';
const THIRD_ADDRESS = 'GDCK7PXQBWBSPBKZTSCTO6RE67CHS6M3LLEPETS3VHTYVNZRMRF3RRBA';
const FOURTH_ADDRESS = 'GDE7DDKCF7XGTD4K3TI2GVKIZ7DMA3YJBQKNE6JTXCSJDMC532KXAJ54';
const FIFTH_ADDRESS = 'GCADBC2WG33DDAN3EJ4SPXLK6T4UBLBAJCO2QBK2BQ4WUAZSNSV65MTG';

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

  it('highlights every original mixed sibling exactly once', () => {
    const hook = document.createElement('div');
    const emphasized = document.createElement('em');
    emphasized.textContent = SECOND_ADDRESS;
    const strong = document.createElement('strong');
    strong.textContent = FOURTH_ADDRESS;

    hook.append(
      document.createTextNode(`lead ${ADDRESS} tail`),
      emphasized,
      document.createTextNode(`middle ${THIRD_ADDRESS} gap`),
      strong,
      document.createTextNode(`end ${FIFTH_ADDRESS}`)
    );
    document.body.appendChild(hook);

    highlightAddresses(hook);

    const highlightedAddresses = Array.from(
      hook.querySelectorAll<HTMLSpanElement>('.greenpay-address'),
      span => span.textContent
    );
    expect(highlightedAddresses).toEqual([
      ADDRESS,
      SECOND_ADDRESS,
      THIRD_ADDRESS,
      FOURTH_ADDRESS,
      FIFTH_ADDRESS,
    ]);
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

  it('excludes tooltip nodes from re-scanning and performs no additional regex scanning when tooltip mounts/unmounts', async () => {
    initContentScript();
    const hook = document.createElement('div');
    hook.textContent = ADDRESS;
    document.body.appendChild(hook);

    // Wait for observer
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const span = hook.querySelector<HTMLSpanElement>('.greenpay-address');
    expect(span).not.toBeNull();

    // Spy on RegExp.prototype.exec, filtering for the Stellar address regex specifically
    const originalExec = RegExp.prototype.exec;
    let stellarRegexCallCount = 0;
    const execSpy = vi.spyOn(RegExp.prototype, 'exec').mockImplementation(function (this: RegExp, string: string) {
      if (this.source === '\\bG[A-Z2-7]{55}\\b') {
        stellarRegexCallCount++;
      }
      return originalExec.call(this, string);
    });

    // Hover over the span to trigger tooltip creation and mounting
    span!.dispatchEvent(new MouseEvent('mouseenter'));

    const tooltip = document.body.querySelector('.greenpay-tooltip');
    expect(tooltip).not.toBeNull();

    // Verify the tooltip itself is registered in GENERATED_NODES
    expect(GENERATED_NODES.has(tooltip!)).toBe(true);

    // Wait for the MutationObserver microtask to flush (which runs on tooltip addition)
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // Verify no additional address regex scanning was performed due to the tooltip mounting
    expect(stellarRegexCallCount).toBe(0);

    // Move mouse out to unmount
    span!.dispatchEvent(new MouseEvent('mouseleave'));
    expect(document.body.querySelector('.greenpay-tooltip')).toBeNull();

    // Wait for observer flush
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(stellarRegexCallCount).toBe(0);

    execSpy.mockRestore();
  });

  it('cleans up tooltip when the originating span is detached from the DOM', async () => {
    initContentScript();
    const hook = document.createElement('div');
    hook.textContent = ADDRESS;
    document.body.appendChild(hook);

    // Wait for observer
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const span = hook.querySelector<HTMLSpanElement>('.greenpay-address');
    expect(span).not.toBeNull();

    // Trigger hover to mount tooltip
    span!.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.body.querySelector('.greenpay-tooltip')).not.toBeNull();
    expect(ACTIVE_TOOLTIPS.has(span!)).toBe(true);

    // Now remove the parent container/span from the document
    hook.remove();

    // Wait for the MutationObserver to notice the removal and trigger cleanup
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // The tooltip should be cleaned up from the body and removed from active tooltips
    expect(document.body.querySelector('.greenpay-tooltip')).toBeNull();
    expect(ACTIVE_TOOLTIPS.has(span!)).toBe(false);
  });
});
