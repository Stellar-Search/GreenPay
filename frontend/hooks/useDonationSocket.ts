import { useEffect, useRef, useState } from "react";
import { getSocket } from "@/lib/socket";


export interface DonationSocketPayload {
  projectId: string;
  donorAddress: string;
  amountXLM: number;
  transactionHash: string;
  timestamp: string;
}

export type SocketStatus = "connecting" | "connected" | "disconnected" | "error"

/**
 * Subscribes to the backend's "donation_event" Socket.io broadcast and invokes
 * `onDonation` for events matching `projectId`.
 *
 * Exposes the connection `status` so consumers can observe socket connectivity.
 */

export function useDonationSocket(
    projectId: string | undefined | null,
    onDonation: (payload: DonationSocketPayload) => void
) {
  const socket = getSocket();

  // Track status state
  const [status, setStatus] = useState<SocketStatus>(
      socket.connected ? "connected" : "connecting"
  );

  // Store latest callback in a ref to keep subscription stable across re-renders
  const onDonationRef = useRef(onDonation);
  useEffect(() => {
    onDonationRef.current = onDonation;
  }, [onDonation]);

  useEffect(() => {
    if (projectId === undefined) return;

    // Track status events
    const handleConnect = () => setStatus("connected");
    const handleDisconnect = () => setStatus("disconnected");
    const handleConnectError = () => setStatus("error");

    const handleEvent = (payload: DonationSocketPayload) => {
      if (projectId === null || payload.projectId === projectId) {
        onDonationRef.current(payload);
      }
    };

    // Attach listeners
    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);
    socket.on("donation_event", handleEvent);

    // Initial state check in case it connected before listeners attached
    if (socket.connected) {
      setStatus("connected");
    }

    // Cleanup listeners on unmount or projectId change
    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleConnectError);
      socket.off("donation_event", handleEvent);
    };
  }, [projectId, socket]);

  return { status };
}