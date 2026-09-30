/**
 * __tests__/appJsonConfig.test.ts
 * Validates that app.json contains the required OTA and Sentry configuration.
 *
 * Validates: Requirements 1.1, 1.5, 10.3
 */
import appJson from '../app.json';

const expoConfig = appJson.expo;

describe('app.json — runtimeVersion policy', () => {
  it('uses fingerprintExperimental runtime version policy', () => {
    expect(expoConfig.runtimeVersion).toBeDefined();
    expect((expoConfig.runtimeVersion as { policy: string }).policy).toBe(
      'fingerprintExperimental'
    );
  });
});

describe('app.json — plugins', () => {
  const plugins = expoConfig.plugins as Array<string | [string, unknown]>;

  /**
   * Returns the plugin entry for the given name (handles both bare string
   * entries and [name, config] tuple entries).
   */
  function findPlugin(name: string) {
    return plugins.find((p) => (Array.isArray(p) ? p[0] === name : p === name));
  }

  it('includes the expo-updates plugin', () => {
    const plugin = findPlugin('expo-updates');
    expect(plugin).toBeDefined();
  });

  it('includes the @sentry/react-native/expo plugin', () => {
    const plugin = findPlugin('@sentry/react-native/expo');
    expect(plugin).toBeDefined();
  });

  it('expo-updates plugin has a url field', () => {
    const plugin = findPlugin('expo-updates') as [string, { url: string }];
    expect(Array.isArray(plugin)).toBe(true);
    expect(plugin[1]).toHaveProperty('url');
    expect(typeof plugin[1].url).toBe('string');
    expect(plugin[1].url.length).toBeGreaterThan(0);
  });

  it('expo-updates plugin has checkAutomatically set to ON_LOAD', () => {
    const plugin = findPlugin('expo-updates') as [string, { checkAutomatically: string }];
    expect(plugin[1].checkAutomatically).toBe('ON_LOAD');
  });

  it('@sentry/react-native/expo plugin has organization and project fields', () => {
    const plugin = findPlugin('@sentry/react-native/expo') as [
      string,
      { organization: string; project: string }
    ];
    expect(Array.isArray(plugin)).toBe(true);
    expect(plugin[1]).toHaveProperty('organization');
    expect(plugin[1]).toHaveProperty('project');
  });
});
