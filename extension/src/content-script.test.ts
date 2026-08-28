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

const ADDRESS = 'GDUQ24STT6QESP4QW33O4KDVYMRTBHWZ3ZE6HXX5TCNWUZH6MRT7PADV';
const SECOND_ADDRESS = 'GCFANSV7I32AGAS5N4EJEZRZCRGNDH32QDHP3A3BWFV66A7BK5PYTUUS';
const THIRD_ADDRESS = 'GDYO6GEXKXPU3UH5SWGTAVHMBBZZEKUHWHXUJ33PL2TJJVHZB7CG6BI5';
const FOURTH_ADDRESS = 'GDUQ24STT6QESP4QW33O4KDVYMRTBHWZ3ZE6HXX5TCNWUZH6MRT7PADV';
const FIFTH_ADDRESS = 'GCFANSV7I32AGAS5N4EJEZRZCRGNDH32QDHP3A3BWFV66A7BK5PYTUUS';

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

  it('accepts only complete Stellar-shaped addresses at the message boundary', () => {
    expect(sanitizeStellarAddress(ADDRESS)).toBe(ADDRESS);
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

  it('positions tooltip consistently with stubbed getBoundingClientRect and non-zero scroll/body offsets', () => {
    const hook = document.createElement('div');
    hook.textContent = ADDRESS;
    document.body.appendChild(hook);
    highlightAddresses(hook);

    const span = hook.querySelector<HTMLSpanElement>('.greenpay-address');
    expect(span).not.toBeNull();

    vi.spyOn(span!, 'getBoundingClientRect').mockReturnValue({
      left: 150,
      top: 250,
      width: 100,
      height: 20,
      right: 250,
      bottom: 270,
      x: 150,
      y: 250,
      toJSON: () => {},
    });

    vi.spyOn(document.body, 'getBoundingClientRect').mockReturnValue({
      left: -40,
      top: -90,
      width: 1000,
      height: 2000,
      right: 960,
      bottom: 1910,
      x: -40,
      y: -90,
      toJSON: () => {},
    });

    span!.dispatchEvent(new MouseEvent('mouseenter'));

    const tooltip = document.body.querySelector<HTMLDivElement>('.greenpay-tooltip');
    expect(tooltip).not.toBeNull();

    // Computed left: 150 - (-40) + 50 = 240px
    // Computed top: 250 - (-90) = 340px
    expect(tooltip!.style.left).toBe('240px');
    expect(tooltip!.style.top).toBe('340px');

    // Conflicting CSS declarations removed
    expect(tooltip!.style.bottom).toBe('');
    expect(tooltip!.style.transform).toBe('');
    expect(tooltip!.style.marginBottom).toBe('');
  });
});

