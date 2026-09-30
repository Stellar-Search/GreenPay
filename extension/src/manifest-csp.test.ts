import { describe, expect, it } from 'vitest';
import chromeManifest from '../manifest.json';
import firefoxManifest from '../manifest.firefox.json';
import { activeManifest, getConnectSrcUrls } from './network-config';

const REQUIRED_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
];

describe.each([
  ['Chrome', chromeManifest],
  ['Firefox', firefoxManifest],
])('%s extension manifest CSP', (_browser, manifest) => {
  it('locks extension-rendered pages to packaged code and non-executable content', () => {
    const policy = manifest.content_security_policy.extension_pages;

    for (const directive of REQUIRED_DIRECTIVES) {
      expect(policy).toContain(directive);
    }
    expect(policy).not.toContain("'unsafe-inline'");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).not.toMatch(/script-src[^;]*https?:/);
  });

  it('asserts connect-src includes all endpoints from active network configuration', () => {
    const policy = manifest.content_security_policy.extension_pages;
    const connectUrls = getConnectSrcUrls(activeManifest);

    for (const url of connectUrls) {
      expect(policy).toContain(url);
    }
  });
});

