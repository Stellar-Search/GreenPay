import { useEffect, useRef, useState } from "react";

import { getSocket } from "@/lib/socket";

export interface DonationSocketPayload {
  projectId: string;
  donorAddress: string;
  amountXLM: number;
  transactionHash: string;
  timestamp: string; // ISO String timestamp
}

export type SocketStatus = "connecting" | "connected" | "disconnected" | "error";

export function useDonationSocket(
    projectId: string | undefined | null,
    onDonation: (payload: DonationSocketPayload) => void
) {
  const socket = getSocket();
  const [status, setStatus] = useState<SocketStatus>(
      socket.connected ? "connected" : "connecting"
  );

  // Keep track of the timestamp of the last received donation
  const lastEventTimestampRef = useRef<string | null>(null);
  const onDonationRef = useRef(onDonation);

  useEffect(() => {
    onDonationRef.current = onDonation;
  }, [onDonation]);

  useEffect(() => {
    if (projectId === undefined) return;

    // Helper to process donations and update the latest timestamp reference
    const processDonation = (payload: DonationSocketPayload) => {
      if (projectId === null || payload.projectId === projectId) {
        lastEventTimestampRef.current = payload.timestamp;
        onDonationRef.current(payload);
      }
    };

    // Helper to fetch missed donations during disconnection
    const backfillMissedDonations = async () => {
      if (!lastEventTimestampRef.current) return;

      try {
        const queryParams = new URLSearchParams();
        if (projectId) queryParams.append("projectId", projectId);
        queryParams.append("since", lastEventTimestampRef.current);

        const response = await fetch(`/api/donations?${queryParams.toString()}`);
        if (!response.ok) return;

        const missedDonations: DonationSocketPayload[] = await response.json();
        missedDonations.forEach(processDonation);
      } catch (err) {
        console.error("Failed to backfill missed donations:", err);
      }
    };

    const handleConnect = () => {
      setStatus("connected");
      // Backfill any data missed during downtime
      backfillMissedDonations();
    };

    const handleDisconnect = () => setStatus("disconnected");
    const handleConnectError = () => setStatus("error");

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);
    socket.on("donation_event", processDonation);

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleConnectError);
      socket.off("donation_event", processDonation);
    };
  }, [projectId, socket]);

  return { status };
}