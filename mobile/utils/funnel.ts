/**
 * utils/funnel.ts — client-side funnel instrumentation for mobile.
 *
 * Rules this module holds itself to, matching the web:
 *  1. It can never break a donation. Every call swallows its own failures. A
 *     telemetry outage that stopped people donating would be a spectacular own
 *     goal for a feature justified by conversion.
 *  2. It collects no identifiers — no device id, no push token, no advertising
 *     id. The session id is a random value the server mints, and nothing about
 *     it is derived from the person or the handset.
 *  3. It instruments the *existing* flow too. Without a baseline emitted the
 *     same way, "conversion improved" is not a measurement.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { apiFetch } from './api';
import type { FunnelStage, OnboardingPathId } from './onboarding';

const SESSION_KEY = 'greenpay_onboarding_session';

/** Telemetry never blocks anything, so it gets a short, hard ceiling. */
const TELEMETRY_TIMEOUT_MS = 4000;

let inFlight: Promise<string | null> | null = null;

/**
 * Fire-and-forget POST. Returns the parsed payload or null; never throws, and
 * never outlives its timeout.
 */
async function postTelemetry<T>(path: string, body: unknown): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
  try {
    const response = await apiFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const parsed = await response.json();
    return (parsed?.data ?? parsed) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a telemetry request may be attempted at all.
 *
 * Unknown connectivity is treated as offline: NetInfo reports
 * `isInternetReachable: null` before its first probe resolves, and guessing
 * "online" there is exactly the case that fires a request during the offline
 * donate flow.
 */
async function canReachNetwork(): Promise<boolean> {
  try {
    const state = await NetInfo.fetch();
    if (state?.isConnected !== true) return false;
    return state.isInternetReachable !== false;
  } catch {
    return false;
  }
}

/**
 * Returns the current funnel session, starting one if needed.
 *
 * Concurrent callers share one request: a screen that mounts three
 * instrumented components would otherwise open three sessions and divide its
 * own conversion rate by three.
 */
export async function getSessionId(
  options: { path?: OnboardingPathId; projectId?: string } = {},
): Promise<string | null> {
  try {
    const existing = await AsyncStorage.getItem(SESSION_KEY);
    if (existing) return existing;
  } catch {
    // Storage unavailable — fall through and mint a fresh session.
  }

  if (!(await canReachNetwork())) return null;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const result = await postTelemetry<{ sessionId: string }>('/api/v1/onboarding/sessions', {
        path: options.path ?? null,
        projectId: options.projectId ?? null,
        referrer: 'direct',
      });
      if (result?.sessionId) {
        await AsyncStorage.setItem(SESSION_KEY, result.sessionId).catch(() => undefined);
      }
      return result?.sessionId ?? null;
    } catch {
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Records a funnel stage. Never throws, never awaited by a donation path. */
export async function track(
  stage: FunnelStage,
  options: {
    path?: OnboardingPathId;
    projectId?: string;
    detail?: Record<string, string | number | boolean>;
  } = {},
): Promise<void> {
  try {
    if (!(await canReachNetwork())) return;
    const sessionId = await getSessionId({ path: options.path, projectId: options.projectId });
    if (!sessionId) return;
    await postTelemetry('/api/v1/onboarding/events', {
      sessionId,
      stage,
      path: options.path ?? null,
      projectId: options.projectId ?? null,
      detail: options.detail ?? null,
    });
  } catch {
    // Deliberately silent — see rule 1 in the module header.
  }
}

/** Closes the funnel session with a terminal outcome. */
export async function completeFunnel(
  outcome: 'completed' | 'abandoned' | 'failed',
  path?: OnboardingPathId,
): Promise<void> {
  try {
    if (!(await canReachNetwork())) return;
    const sessionId = await AsyncStorage.getItem(SESSION_KEY);
    if (!sessionId) return;
    await postTelemetry('/api/v1/onboarding/sessions/complete', {
      sessionId,
      outcome,
      path: path ?? null,
    });
    if (outcome === 'completed') await clearSession();
  } catch {
    // Silent by design.
  }
}

export async function clearSession(): Promise<void> {
  try {
    await AsyncStorage.removeItem(SESSION_KEY);
  } catch {
    // Nothing useful to do.
  }
}
