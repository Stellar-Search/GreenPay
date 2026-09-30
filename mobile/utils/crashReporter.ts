/**
 * utils/crashReporter.ts
 * Thin wrapper around @sentry/react-native that wires the scrubber into
 * Sentry's beforeSend hook so no raw report ever leaves the device.
 *
 * Design constraints (Requirements 5.1, 5.4, 5.6, 5.7, 6.7):
 *   - Idempotent: calling initCrashReporter more than once is a no-op.
 *   - dryRun mode: Sentry is initialised with enabled:false (dev / preview).
 *   - Missing DSN forces dryRun and logs a console warning.
 *   - The entire Sentry.init call is wrapped in try/catch — a bad config
 *     must never propagate as a boot crash.
 */
import * as Sentry from '@sentry/react-native';
import { scrubReport } from './scrubber';

export interface CrashReporterConfig {
  /** Sentry DSN. Required in production; leave empty to force dry-run. */
  dsn: string;
  /** EAS update ID — attached as `release` on every Sentry event. */
  updateId: string | null;
  /** Runtime version string — attached as `dist` on every Sentry event. */
  runtimeVersion: string | null;
  /**
   * When true the SDK is initialised with enabled:false and no events are
   * forwarded to Sentry's ingest. Used in development and preview builds.
   */
  dryRun: boolean;
}

/** Module-level guard — prevents double-init across hot reloads. */
let initialised = false;

/**
 * Resets the initialisation guard. Exported for use in tests only.
 * Do not call this in production code.
 */
export function _resetForTesting(): void {
  initialised = false;
}

/**
 * Initialises the crash reporter. Must be called once at app startup before
 * any navigation or wallet hooks execute (Requirement 5.6).
 *
 * Idempotent — subsequent calls are no-ops.
 */
export function initCrashReporter(config: CrashReporterConfig): void {
  if (initialised) return;
  initialised = true;

  let { dsn, dryRun } = config;

  // If DSN is missing and we're not already in dry-run mode, warn and force it.
  if (!dsn && !dryRun) {
    console.warn(
      '[CrashReporter] DSN not configured — falling back to dry-run mode'
    );
    dryRun = true;
  }

  try {
    Sentry.init({
      dsn: dsn || '',
      enabled: !dryRun,
      release: config.updateId ?? undefined,
      dist: config.runtimeVersion ?? undefined,
      beforeSend(event: Record<string, unknown>) {
        return scrubReport(event) as ReturnType<typeof Sentry.init>;
      },
    } as Parameters<typeof Sentry.init>[0]);
  } catch (err) {
    // A bad config must never crash the app (Requirement 5.6).
    console.error('[CrashReporter] Sentry.init failed:', err);
  }
}

/**
 * Records a breadcrumb for the current screen / flow step.
 * Safe to call whether or not the reporter has been initialised.
 *
 * NOTE: Do NOT pass transaction amounts, addresses, or wallet-derived data
 * in the `data` map — only screen names and flow-step labels (Requirement 5.5).
 */
export function recordBreadcrumb(
  category: string,
  message: string,
  data?: Record<string, string>
): void {
  Sentry.addBreadcrumb({ category, message, data });
}
