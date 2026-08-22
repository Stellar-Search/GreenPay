import { useEffect } from "react";
import { getSocket } from "@/lib/socket";

export interface DonationSocketPayload {
  projectId: string;
  donorAddress: string;
  amountXLM: number;
  transactionHash: string;
  timestamp: string;
}

/**
 * Subscribes to the backend's "donation_event" Socket.io broadcast and invokes
 * `onDonation` for events matching `projectId`.
 *
 * Pass `null` for `projectId` to receive every broadcast donation, unfiltered
 * (used by the homepage's global live ticker). Pass `undefined` to skip
 * subscribing altogether, e.g. while a route param is still resolving.
 */
export function useDonationSocket(projectId: string | undefined | null, onDonation: (payload: DonationSocketPayload) => void) {
  useEffect(() => {
    if (projectId === undefined) return;

    const socket = getSocket();
    const handleEvent = (payload: DonationSocketPayload) => {
      if (projectId === null || payload.projectId === projectId) {
        onDonation(payload);
      }
    };

    socket.on("donation_event", handleEvent);
    return () => {
      socket.off("donation_event", handleEvent);
    };
  }, [projectId, onDonation]);
}
