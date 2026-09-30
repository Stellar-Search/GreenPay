/**
 * lib/socket.ts
 * Singleton Socket.io client shared across components that need live backend events.
 */
import { io, type Socket } from "socket.io-client";

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000", {
      // Allow fallback: start with polling, upgrade to websocket
      transports: ["polling", "websocket"],
      autoConnect: true,
    });
  }
  return socket;
}

// Add the explicit disconnect/teardown function
export const disconnectSocket = (): void => {
  if (socket) {
    socket.disconnect();
    socket = null; // Reset singleton instance for tests or clean re-initialization
  }
};