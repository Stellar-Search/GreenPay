import { act, renderHook } from "@testing-library/react";
import { EventEmitter } from "events";
import { useDonationSocket, type DonationSocketPayload } from "../useDonationSocket";
import { getSocket } from "@/lib/socket";
import { fetchMissedEvents } from "@/lib/realtime";

jest.mock("@/lib/socket", () => ({
  getSocket: jest.fn(),
}));

jest.mock("@/lib/realtime", () => ({
  fetchMissedEvents: jest.fn(),
}));

function makeFakeSocket() {
  const emitter = new EventEmitter();
  return {
    on: (event: string, handler: (...args: any[]) => void) => emitter.on(event, handler),
    off: (event: string, handler: (...args: any[]) => void) => emitter.off(event, handler),
    emit: (event: string, payload: unknown) => emitter.emit(event, payload),
  };
}

function payload(overrides: Partial<DonationSocketPayload> = {}): DonationSocketPayload {
  return {
    projectId: "project-1",
    donorAddress: "GDONOR",
    amountXLM: 10,
    transactionHash: "tx-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("useDonationSocket", () => {
  beforeEach(() => {
    (getSocket as jest.Mock).mockReset();
    (fetchMissedEvents as jest.Mock).mockReset();
  });

  it("does not subscribe when projectId is undefined", () => {
    const socket = makeFakeSocket();
    (getSocket as jest.Mock).mockReturnValue(socket);
    const onDonation = jest.fn();

    renderHook(() => useDonationSocket(undefined, onDonation));
    socket.emit("donation_event", payload());

    expect(onDonation).not.toHaveBeenCalled();
  });

  it("filters events to the given projectId", () => {
    const socket = makeFakeSocket();
    (getSocket as jest.Mock).mockReturnValue(socket);
    const onDonation = jest.fn();

    renderHook(() => useDonationSocket("project-1", onDonation));
    socket.emit("donation_event", payload({ projectId: "project-2" }));
    expect(onDonation).not.toHaveBeenCalled();

    socket.emit("donation_event", payload({ projectId: "project-1" }));
    expect(onDonation).toHaveBeenCalledTimes(1);
  });

  it("receives every broadcast donation when projectId is null", () => {
    const socket = makeFakeSocket();
    (getSocket as jest.Mock).mockReturnValue(socket);
    const onDonation = jest.fn();

    renderHook(() => useDonationSocket(null, onDonation));
    socket.emit("donation_event", payload({ projectId: "project-1" }));
    socket.emit("donation_event", payload({ projectId: "project-2" }));

    expect(onDonation).toHaveBeenCalledTimes(2);
  });

  it("unsubscribes on unmount", () => {
    const socket = makeFakeSocket();
    (getSocket as jest.Mock).mockReturnValue(socket);
    const onDonation = jest.fn();

    const { unmount } = renderHook(() => useDonationSocket(null, onDonation));
    unmount();
    socket.emit("donation_event", payload());

    expect(onDonation).not.toHaveBeenCalled();
  });

  it("backfills missed donations on reconnect", async () => {
    const socket = makeFakeSocket();
    (getSocket as jest.Mock).mockReturnValue(socket);
    const onDonation = jest.fn();
    const mockFetchMissedEvents = fetchMissedEvents as jest.Mock;

    renderHook(() => useDonationSocket("project-1", onDonation));

    // Emit a donation with a cursor so cursorRef is populated
    const firstDonation = payload({ timestamp: "2026-01-01T10:00:00.000Z", cursor: "cursor-1" });
    act(() => {
      socket.emit("donation_event", firstDonation);
    });
    expect(onDonation).toHaveBeenCalledWith(firstDonation);
    expect(onDonation).toHaveBeenCalledTimes(1);

    // Simulate reconnect
    const missedDonations = [
      { name: "donation_event", payload: payload({ 
        donorAddress: "GDONOR2", 
        amountXLM: 5,
        transactionHash: "tx-2",
        timestamp: "2026-01-01T10:15:00.000Z" 
      }), cursor: "cursor-2", emittedAt: "2026-01-01T10:15:00.000Z" },
      { name: "donation_event", payload: payload({ 
        donorAddress: "GDONOR3", 
        amountXLM: 20,
        transactionHash: "tx-3",
        timestamp: "2026-01-01T10:30:00.000Z" 
      }), cursor: "cursor-3", emittedAt: "2026-01-01T10:30:00.000Z" },
    ];

    mockFetchMissedEvents.mockResolvedValue({
      events: missedDonations,
      nextCursor: "cursor-3",
      reset: false,
      reason: null,
      degraded: false,
    });

    // Trigger reconnect
    await act(async () => {
      socket.emit("connect", {});
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // Verify fetchMissedEvents was called with the cursor
    expect(mockFetchMissedEvents).toHaveBeenCalledWith("cursor-1");

    // Verify missed donations were processed
    // The hook spreads event.payload and adds cursor, so the delivered payloads include cursor
    expect(onDonation).toHaveBeenCalledTimes(3);
    expect(onDonation).toHaveBeenNthCalledWith(2, { ...missedDonations[0].payload, cursor: "cursor-2" });
    expect(onDonation).toHaveBeenNthCalledWith(3, { ...missedDonations[1].payload, cursor: "cursor-3" });
  });

  it("fires onGap with reset on backfill failure", async () => {
    const socket = makeFakeSocket();
    (getSocket as jest.Mock).mockReturnValue(socket);
    const onDonation = jest.fn();
    const onGap = jest.fn();
    const mockFetchMissedEvents = fetchMissedEvents as jest.Mock;

    renderHook(() => useDonationSocket("project-1", onDonation, { onGap }));

    // Emit a donation with a cursor so cursorRef is populated
    const firstDonation = payload({ timestamp: "2026-01-01T10:00:00.000Z", cursor: "cursor-1" });
    act(() => {
      socket.emit("donation_event", firstDonation);
    });

    // Simulate failed replay
    mockFetchMissedEvents.mockRejectedValue(new Error("Network error"));

    await act(async () => {
      socket.emit("connect", {});
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(onGap).toHaveBeenCalledWith({ kind: "reset", reason: "REPLAY_UNAVAILABLE" });
  });

  it("skips backfill if no previous donations received", async () => {
    const socket = makeFakeSocket();
    (getSocket as jest.Mock).mockReturnValue(socket);
    const onDonation = jest.fn();
    const mockFetchMissedEvents = fetchMissedEvents as jest.Mock;

    renderHook(() => useDonationSocket("project-1", onDonation));

    // Trigger reconnect without any prior donations (no cursor set)
    await act(async () => {
      socket.emit("connect", {});
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // fetchMissedEvents should not be called because no cursor was ever set
    expect(mockFetchMissedEvents).not.toHaveBeenCalled();
  });
});
