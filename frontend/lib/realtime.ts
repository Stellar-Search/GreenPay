/**
 * lib/realtime.ts
 *
 * Client half of the realtime delivery contract documented in docs/realtime.md.
 *
 * Socket delivery is best-effort. A client that is disconnected — a laptop lid,
 * a tunnel drop, a rolling deploy moving it between pods — simply does not
 * receive what was broadcast while it was away, and previously had no way to
 * find out. Every live event now carries the cursor identifying it, and this
 * module turns the last cursor seen into a concrete answer about the gap.
 */
import { csrfFetch } from "./api";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

/** Delivery scope reported by the pod holding this connection. */
export interface RealtimeStatus {
  instanceId: string;
  mode: "single-process" | "redis-adapter";
  degraded: boolean;
  reason: string | null;
  /**
   * "global": this pod's broadcasts reach clients on every replica.
   * "instance": they reach only clients connected to this pod, so the feed is
   * incomplete and the client should reconcile against REST rather than trust it.
   */
  delivery: "global" | "instance";
}

export interface ReplayedEvent<T = unknown> {
  cursor: string;
  name: string;
  payload: T;
  emittedAt: string;
}

export interface ReplayResult<T = unknown> {
  events: ReplayedEvent<T>[];
  nextCursor: string | null;
  /**
   * True when the server cannot prove the reply is complete — an unusable or
   * expired cursor. The contract is to refetch current state from REST instead
   * of stitching a partial replay into the timeline. Note this is NOT the same
   * as `events` being empty, which legitimately means "nothing happened".
   */
  reset: boolean;
  reason: string | null;
  degraded: boolean;
}

/**
 * Ask the backend what was broadcast after `cursor`.
 *
 * Any replica can answer, because the replay log is shared — which is what
 * makes this work when a reconnect lands the client on a different pod than
 * the one it was talking to before.
 */
export async function fetchMissedEvents<T = unknown>(
  cursor: string | null,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<ReplayResult<T>> {
  const query = new URLSearchParams();
  if (cursor) query.set("cursor", cursor);
  if (options.limit) query.set("limit", String(options.limit));

  const response = await csrfFetch(`${API_BASE}/api/v1/realtime/replay?${query.toString()}`, {
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`replay request failed with ${response.status}`);
  }

  const body = await response.json();
  const meta = body?.meta ?? {};

  return {
    events: (body?.data ?? []) as ReplayedEvent<T>[],
    nextCursor: meta.nextCursor ?? null,
    // Default to true: if the envelope is not what we expect, assuming the
    // replay was complete would silently hide a gap, which is the failure this
    // whole mechanism exists to prevent.
    reset: meta.reset !== false,
    reason: meta.reason ?? null,
    degraded: Boolean(meta.degraded),
  };
}
