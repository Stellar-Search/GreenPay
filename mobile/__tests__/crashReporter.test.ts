/**
 * __tests__/crashReporter.test.ts
 * Unit tests for the crashReporter utility.
 *
 * @sentry/react-native is resolved to __mocks__/@sentry/react-native.js via
 * moduleNameMapper, so no native binaries are required.
 *
 * Validates: Requirements 5.4, 5.6, 5.7
 */
import * as Sentry from '@sentry/react-native';

// We need to reload the module between tests to reset the `initialised` flag.
// Using the exported _resetForTesting() helper is cleaner than jest.resetModules.
import { initCrashReporter, recordBreadcrumb, _resetForTesting } from '../utils/crashReporter';

const mockSentry = Sentry as jest.Mocked<typeof Sentry>;

beforeEach(() => {
  jest.clearAllMocks();
  _resetForTesting();
});

// ---------------------------------------------------------------------------
// Idempotence: Sentry.init called exactly once
// ---------------------------------------------------------------------------
describe('initCrashReporter — idempotence', () => {
  it('calls Sentry.init exactly once even when invoked twice', () => {
    initCrashReporter({ dsn: 'https://key@sentry.io/123', updateId: null, runtimeVersion: null, dryRun: false });
    initCrashReporter({ dsn: 'https://key@sentry.io/123', updateId: null, runtimeVersion: null, dryRun: false });

    expect(mockSentry.init).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// dryRun mode: enabled: false
// ---------------------------------------------------------------------------
describe('initCrashReporter — dryRun mode', () => {
  it('initialises Sentry with enabled:false when dryRun is true', () => {
    initCrashReporter({ dsn: 'https://key@sentry.io/123', updateId: null, runtimeVersion: null, dryRun: true });

    expect(mockSentry.init).toHaveBeenCalledTimes(1);
    const initArg = (mockSentry.init as jest.Mock).mock.calls[0][0];
    expect(initArg.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Production mode: enabled: true
// ---------------------------------------------------------------------------
describe('initCrashReporter — production mode', () => {
  it('initialises Sentry with enabled:true when dryRun is false and DSN is present', () => {
    initCrashReporter({ dsn: 'https://key@sentry.io/456', updateId: null, runtimeVersion: null, dryRun: false });

    const initArg = (mockSentry.init as jest.Mock).mock.calls[0][0];
    expect(initArg.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Metadata: updateId → release, runtimeVersion → dist
// ---------------------------------------------------------------------------
describe('initCrashReporter — metadata attachment', () => {
  it('maps updateId to release and runtimeVersion to dist in Sentry config', () => {
    initCrashReporter({
      dsn: 'https://key@sentry.io/789',
      updateId: 'update-abc-123',
      runtimeVersion: 'fingerprint:sha256:deadbeef',
      dryRun: false,
    });

    const initArg = (mockSentry.init as jest.Mock).mock.calls[0][0];
    expect(initArg.release).toBe('update-abc-123');
    expect(initArg.dist).toBe('fingerprint:sha256:deadbeef');
  });

  it('passes undefined for release and dist when updateId and runtimeVersion are null', () => {
    initCrashReporter({ dsn: 'https://key@sentry.io/789', updateId: null, runtimeVersion: null, dryRun: false });

    const initArg = (mockSentry.init as jest.Mock).mock.calls[0][0];
    expect(initArg.release).toBeUndefined();
    expect(initArg.dist).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Missing DSN: forces dry-run and logs a warning
// ---------------------------------------------------------------------------
describe('initCrashReporter — missing DSN', () => {
  it('forces dry-run (enabled:false) and logs a console.warn when DSN is empty', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    initCrashReporter({ dsn: '', updateId: null, runtimeVersion: null, dryRun: false });

    const initArg = (mockSentry.init as jest.Mock).mock.calls[0][0];
    expect(initArg.enabled).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      '[CrashReporter] DSN not configured — falling back to dry-run mode'
    );

    warnSpy.mockRestore();
  });

  it('does not warn when already in dryRun mode with empty DSN', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    initCrashReporter({ dsn: '', updateId: null, runtimeVersion: null, dryRun: true });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Sentry.init throwing: must not propagate
// ---------------------------------------------------------------------------
describe('initCrashReporter — resilience', () => {
  it('does not throw if Sentry.init throws internally', () => {
    (mockSentry.init as jest.Mock).mockImplementationOnce(() => {
      throw new Error('Sentry boom');
    });

    expect(() =>
      initCrashReporter({ dsn: 'https://key@sentry.io/err', updateId: null, runtimeVersion: null, dryRun: false })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// beforeSend: scrubber is wired in
// ---------------------------------------------------------------------------
describe('initCrashReporter — scrubber wiring', () => {
  it('registers a beforeSend hook in the Sentry config', () => {
    initCrashReporter({ dsn: 'https://key@sentry.io/123', updateId: null, runtimeVersion: null, dryRun: false });

    const initArg = (mockSentry.init as jest.Mock).mock.calls[0][0];
    expect(typeof initArg.beforeSend).toBe('function');
  });

  it('beforeSend passes through clean events unchanged', () => {
    initCrashReporter({ dsn: 'https://key@sentry.io/123', updateId: null, runtimeVersion: null, dryRun: false });

    const initArg = (mockSentry.init as jest.Mock).mock.calls[0][0];
    const event = { message: 'test error', level: 'error' };
    const result = initArg.beforeSend(event);
    expect(result).toEqual(event);
  });

  it('beforeSend redacts a Stellar secret key embedded in an event', () => {
    initCrashReporter({ dsn: 'https://key@sentry.io/123', updateId: null, runtimeVersion: null, dryRun: false });

    const initArg = (mockSentry.init as jest.Mock).mock.calls[0][0];
    const secretKey = 'S' + 'A'.repeat(55);
    const event = { extra: { leak: secretKey } };
    const result = initArg.beforeSend(event) as typeof event;
    expect(result.extra.leak).toBe('[REDACTED:secret_key]');
  });
});

// ---------------------------------------------------------------------------
// recordBreadcrumb
// ---------------------------------------------------------------------------
describe('recordBreadcrumb', () => {
  it('calls Sentry.addBreadcrumb with category, message, and data', () => {
    recordBreadcrumb('donate', 'entered donate screen', { projectId: '42' });

    expect(mockSentry.addBreadcrumb).toHaveBeenCalledWith({
      category: 'donate',
      message: 'entered donate screen',
      data: { projectId: '42' },
    });
  });

  it('calls Sentry.addBreadcrumb without data when omitted', () => {
    recordBreadcrumb('navigation', 'navigated to home');

    expect(mockSentry.addBreadcrumb).toHaveBeenCalledWith({
      category: 'navigation',
      message: 'navigated to home',
      data: undefined,
    });
  });
});
