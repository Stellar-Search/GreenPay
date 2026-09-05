import { useCallback, useEffect, useRef, useState } from "react";
import { getSocket } from "@/lib/socket";
import { fetchMissedEvents, type RealtimeStatus } from "@/lib/realtime";


export interface DonationSocketPayload {
  projectId: string;
  donorAddress: string;
  amountXLM: number;
  transactionHash: string;
  timestamp: string;
  /**
   * Opaque marker for this event's position in the global feed, added by the
   * backend. Stored as events arrive and replayed from on reconnect. Optional
   * so a payload from an older backend still type-checks.
   */
  cursor?: string;
}

export type SocketStatus = "connecting" | "connected" | "disconnected" | "error"

/** Why a caller may need to reconcile against REST rather than trust the feed. */
export type FeedGap =
  /** Events were missed and could not be replayed; refetch current state. */
  | { kind: "reset"; reason: string | null }
  /** The pod serving this client cannot reach other replicas, so the feed is partial. */
  | { kind: "degraded"; reason: string | null };

interface Options {
  /**
   * Called when the feed cannot be trusted to be complete and the caller should
   * refetch from REST. Without this a gap stays silent — which is exactly how
   * the cross-replica bug went unnoticed.
   */
  onGap?: (gap: FeedGap) => void;
  /** Disable reconnect replay (used by tests that assert socket-only behaviour). */
  replayOnReconnect?: boolean;
}

/**
 * Subscribes to the backend's "donation_event" Socket.io broadcast and invokes
 * `onDonation` for events matching `projectId`.
 *
 * Beyond forwarding live events it closes the reconnect gap: the cursor of the
 * last event seen is remembered, and on every reconnect the hook asks the
 * backend what was broadcast in the meantime and replays it through the same
 * callback, in order. When the backend cannot prove the replay is complete, or
 * reports that its pod is delivering to itself only, `onGap` fires so the caller
 * can reconcile against REST instead of silently carrying a hole in the feed.
 *
 * Exposes the connection `status` so consumers can observe socket connectivity.
 */
export function useDonationSocket(
    projectId: string | undefined | null,
    onDonation: (payload: DonationSocketPayload) => void,
    options: Options = {}
) {
  const socket = getSocket();
  const { onGap, replayOnReconnect = true } = options;

  // Track status state
  const [status, setStatus] = useState<SocketStatus>(
      socket.connected ? "connected" : "connecting"
  );
  const [delivery, setDelivery] = useState<RealtimeStatus["delivery"] | null>(null);

  // Store latest callbacks in refs to keep the subscription stable across renders
  const onDonationRef = useRef(onDonation);
  useEffect(() => {
    onDonationRef.current = onDonation;
  }, [onDonation]);

  const onGapRef = useRef(onGap);
  useEffect(() => {
    onGapRef.current = onGap;
  }, [onGap]);

  // The last cursor seen, in a ref rather than state: updating it must not
  // re-render, and the reconnect handler needs the current value, not the one
  // captured when the effect ran.
  const cursorRef = useRef<string | null>(null);

  // A reconnect can fire while a replay is still in flight; without this guard
  // the same events would be delivered twice.
  const replayingRef = useRef(false);

  const deliver = useCallback((payload: DonationSocketPayload) => {
    if (payload.cursor) cursorRef.current = payload.cursor;
    if (projectId === null || payload.projectId === projectId) {
      onDonationRef.current(payload);
    }
  }, [projectId]);

  useEffect(() => {
    if (projectId === undefined) return;

    let cancelled = false;

    const recoverMissedEvents = async () => {
      // Nothing seen yet means there is no timeline to reconcile — a first
      // connection is not a gap.
      if (!replayOnReconnect || replayingRef.current || !cursorRef.current) return;
      replayingRef.current = true;
      try {
        const result = await fetchMissedEvents<DonationSocketPayload>(cursorRef.current);
        if (cancelled) return;

        if (result.reset) {
          // The cursor could not be honoured. Say so rather than pretending an
          // empty replay meant nothing happened.
          onGapRef.current?.({ kind: "reset", reason: result.reason });
          return;
        }

        for (const event of result.events) {
          if (cancelled) break;
          if (event.name !== "donation_event") continue;
          deliver({ ...event.payload, cursor: event.cursor });
        }
        if (!cancelled && result.nextCursor) cursorRef.current = result.nextCursor;
      } catch {
        // The replay endpoint is unreachable, so the gap cannot be closed.
        // Reporting it lets the caller refetch; swallowing it would not.
        if (!cancelled) onGapRef.current?.({ kind: "reset", reason: "REPLAY_UNAVAILABLE" });
      } finally {
        replayingRef.current = false;
      }
    };

    const handleConnect = () => {
      setStatus("connected");
      void recoverMissedEvents();
    };
    const handleDisconnect = () => setStatus("disconnected");
    const handleConnectError = () => setStatus("error");

    const handleStatus = (payload: RealtimeStatus) => {
      setDelivery(payload?.delivery ?? null);
      if (payload?.degraded) {
        onGapRef.current?.({ kind: "degraded", reason: payload.reason ?? null });
      }
    };

    const handleEvent = (payload: DonationSocketPayload) => deliver(payload);

    // Attach listeners
    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);
    socket.on("donation_event", handleEvent);
    socket.on("realtime:status", handleStatus);

    // Initial state check in case it connected before listeners attached
    if (socket.connected) {
      setStatus("connected");
    }

    // Cleanup listeners on unmount or projectId change
    return () => {
      cancelled = true;
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleConnectError);
      socket.off("donation_event", handleEvent);
      socket.off("realtime:status", handleStatus);
    };
  }, [projectId, socket, deliver, replayOnReconnect]);

  return { status, delivery };
}
