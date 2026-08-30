/**
 * lib/funnel.ts — client-side funnel instrumentation.
 *
 * ── Rules this module holds itself to ───────────────────────────────────────
 * 1. It can never break a donation. Every call is fire-and-forget and every
 *    failure is swallowed. A telemetry outage that stopped people donating
 *    would be a spectacular own goal for a feature justified by conversion.
 * 2. It collects no identifiers. The session id is a random value generated
 *    here; there is no cookie, no fingerprint, and nothing that survives the
 *    donor clearing their storage.
 * 3. It instruments the *existing* wallet flow too. Without a baseline emitted
 *    the same way, "conversion improved" is not a measurement.
 */
import { csrfFetch } from "./api";
import type { FunnelStage, OnboardingPathId } from "./onboarding";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
const SESSION_KEY = "greenpay_onboarding_session";

/** Kept in sessionStorage: one funnel session per browser tab visit. */
function readStoredSession(): string | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

function storeSession(id: string): void {
  try {
    if (typeof window === "undefined") return;
    window.sessionStorage.setItem(SESSION_KEY, id);
  } catch {
    // Storage refused. The session id still works for this page's lifetime.
  }
}

let inFlight: Promise<string | null> | null = null;

/**
 * Returns the current funnel session, starting one if needed.
 *
 * Concurrent callers share one request: a page that mounts three instrumented
 * components would otherwise open three sessions and divide its own conversion
 * rate by three.
 */
export async function getSessionId(options: { path?: OnboardingPathId; projectId?: string } = {}): Promise<string | null> {
  const existing = readStoredSession();
  if (existing) return existing;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const response = await csrfFetch(`${API_BASE}/api/v1/onboarding/sessions`, {
        method: "POST",
        body: JSON.stringify({
          path: options.path ?? null,
          projectId: options.projectId ?? null,
          referrer: typeof document !== "undefined" ? document.referrer || "direct" : "direct",
        }),
      });
      const body = await response.json();
      const id = body?.data?.sessionId ?? body?.sessionId ?? null;
      if (id) storeSession(id);
      return id;
    } catch {
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Records a funnel stage. Never throws, never awaited by a donation path.
 */
export async function track(
  stage: FunnelStage,
  options: { path?: OnboardingPathId; projectId?: string; detail?: Record<string, string | number | boolean> } = {},
): Promise<void> {
  try {
    const sessionId = await getSessionId({ path: options.path, projectId: options.projectId });
    if (!sessionId) return;
    await csrfFetch(`${API_BASE}/api/v1/onboarding/events`, {
      method: "POST",
      body: JSON.stringify({
        sessionId,
        stage,
        path: options.path ?? null,
        projectId: options.projectId ?? null,
        detail: options.detail ?? null,
      }),
    });
  } catch {
    // Deliberately silent — see rule 1 in the module header.
  }
}

/** Closes the funnel session with a terminal outcome. */
export async function completeFunnel(
  outcome: "completed" | "abandoned" | "failed",
  path?: OnboardingPathId,
): Promise<void> {
  try {
    const sessionId = readStoredSession();
    if (!sessionId) return;
    await csrfFetch(`${API_BASE}/api/v1/onboarding/sessions/complete`, {
      method: "POST",
      body: JSON.stringify({ sessionId, outcome, path: path ?? null }),
    });
    if (outcome === "completed") clearSession();
  } catch {
    // Silent by design.
  }
}

export function clearSession(): void {
  try {
    if (typeof window === "undefined") return;
    window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Nothing to do.
  }
}
