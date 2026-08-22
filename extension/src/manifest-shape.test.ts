import { describe, expect, it } from 'vitest';
import chromeManifest from '../manifest.json';
import firefoxManifest from '../manifest.firefox.json';

describe.each([
  ['Chrome', chromeManifest],
  ['Firefox', firefoxManifest],
])('%s extension manifest shape', (_browser, manifest) => {
  it('uses the MV3 "action" key instead of the MV2 "browser_action" key', () => {
    expect(manifest).toHaveProperty('action');
    expect(manifest).not.toHaveProperty('browser_action');
    expect(typeof (manifest as Record<string, unknown>).action).toBe('object');
  });

  it('declares a valid manifest_version', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('includes a background entry', () => {
    expect(manifest).toHaveProperty('background');
  });

  it('declares permissions as an array with only required permissions', () => {
    expect(Array.isArray(manifest.permissions)).toBe(true);
    expect(manifest.permissions).toEqual(['storage']);
    expect(manifest.permissions).not.toContain('activeTab');
    expect(manifest.permissions).not.toContain('scripting');
  });
});

describe('Firefox-specific manifest shape', () => {
  it('includes browser_specific_settings with gecko strict_min_version >= 120', () => {
    const settings = (firefoxManifest as Record<string, unknown>)
      .browser_specific_settings as Record<string, unknown> | undefined;
    expect(settings).toBeDefined();

    const gecko = settings!.gecko as Record<string, unknown>;
    expect(gecko).toBeDefined();
    expect(gecko.strict_min_version).toBeDefined();

    const version = gecko.strict_min_version as string;
    const [major] = version.split('.').map(Number);
    expect(major).toBeGreaterThanOrEqual(120);
  });

  it('uses the MV3 "action" key', () => {
    expect(firefoxManifest).toHaveProperty('action');
    expect(firefoxManifest).not.toHaveProperty('browser_action');
  });
});
