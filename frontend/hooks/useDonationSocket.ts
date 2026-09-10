import { useCallback, useEffect, useRef, useState } from "react";
import { getSocket } from "@/lib/socket";
import {
  SOCKET_EVENTS,
  validateDonationPayload,
  type DonationSocketPayload,
} from "@/lib/socketEvents";

export type { DonationSocketPayload };

export type SocketStatus = "connecting" | "connected" | "disconnected" | "error"

/** Maximum entries tracked for deduplication before pruning. */
const MAX_DEDUPLICATION_ENTRIES = 2000;

export interface UseDonationSocketOptions {
  /** Called when the socket reconnects so consumers can reconcile state. */
  onReconnect?: () => void;
}

/**
 * Subscribes to the backend's Socket.IO "donation_event" broadcast and invokes
 * `onDonation` for validated, deduplicated events matching `projectId`.
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
    options?: UseDonationSocketOptions,
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

  const onReconnectRef = useRef(options?.onReconnect);
  useEffect(() => {
    onReconnectRef.current = options?.onReconnect;
  }, [options?.onReconnect]);

  // O(1) deduplication set keyed by transactionHash
  const seenTxHashesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (projectId === undefined) return;

    // Track status events
    const handleConnect = () => {
      const wasDisconnected = status === "disconnected" || status === "error";
      setStatus("connected");
      if (wasDisconnected) {
        onReconnectRef.current?.();
      }
    };
    const handleDisconnect = () => setStatus("disconnected");
    const handleConnectError = () => setStatus("error");

    const handleEvent = (raw: unknown) => {
      // 1. Runtime validation
      const result = validateDonationPayload(raw);
      if (!result.success) {
        console.warn(`[useDonationSocket] invalid payload dropped:`, result.error);
        return;
      }

      const payload = result.data;

      // 2. Filter by projectId
      if (projectId !== null && payload.projectId !== projectId) return;

      // 3. Deduplicate by transactionHash
      if (seenTxHashesRef.current.has(payload.transactionHash)) return;

      // Prune if set exceeds max size to prevent unbounded memory growth
      if (seenTxHashesRef.current.size >= MAX_DEDUPLICATION_ENTRIES) {
        const entries = Array.from(seenTxHashesRef.current);
        seenTxHashesRef.current = new Set(entries.slice(Math.floor(entries.length / 2)));
      }

      seenTxHashesRef.current.add(payload.transactionHash);

      // 4. Dispatch validated, deduplicated payload
      onDonationRef.current(payload);
    };

    const handleEvent = (payload: DonationSocketPayload) => deliver(payload);

    // Attach listeners
    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);
    socket.on(SOCKET_EVENTS.DONATION_EVENT, handleEvent);

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
      socket.off(SOCKET_EVENTS.DONATION_EVENT, handleEvent);
    };
  }, [projectId, socket, deliver, replayOnReconnect]);

  return { status };
}
