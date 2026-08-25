import { renderHook } from "@testing-library/react";
import { EventEmitter } from "events";
import { useDonationSocket, type DonationSocketPayload } from "../useDonationSocket";
import { getSocket } from "@/lib/socket";

jest.mock("@/lib/socket", () => ({
  getSocket: jest.fn(),
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

    // Mock fetch for backfill
    global.fetch = jest.fn();

    renderHook(() => useDonationSocket("project-1", onDonation));

    // Emit a donation to set lastEventTimestampRef
    const firstDonation = payload({ timestamp: "2026-01-01T10:00:00.000Z" });
    socket.emit("donation_event", firstDonation);
    expect(onDonation).toHaveBeenCalledWith(firstDonation);
    expect(onDonation).toHaveBeenCalledTimes(1);

    // Simulate reconnect event
    const missedDonations = [
      payload({ 
        donorAddress: "GDONOR2", 
        amountXLM: 5,
        transactionHash: "tx-2",
        timestamp: "2026-01-01T10:15:00.000Z" 
      }),
      payload({ 
        donorAddress: "GDONOR3", 
        amountXLM: 20,
        transactionHash: "tx-3",
        timestamp: "2026-01-01T10:30:00.000Z" 
      }),
    ];

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => missedDonations,
    });

    // Trigger reconnect
    socket.emit("connect", {});

    // Wait for async backfill to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify fetch was called with correct params
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/donations?")
    );
    const fetchUrl = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(fetchUrl).toContain("since=2026-01-01T10%3A00%3A00.000Z");
    expect(fetchUrl).toContain("projectId=project-1");

    // Verify missed donations were processed
    expect(onDonation).toHaveBeenCalledTimes(3);
    expect(onDonation).toHaveBeenNthCalledWith(2, missedDonations[0]);
    expect(onDonation).toHaveBeenNthCalledWith(3, missedDonations[1]);
  });

  it("handles backfill failure gracefully", async () => {
    const socket = makeFakeSocket();
    (getSocket as jest.Mock).mockReturnValue(socket);
    const onDonation = jest.fn();
    const consoleError = jest.spyOn(console, "error").mockImplementation();

    global.fetch = jest.fn();

    renderHook(() => useDonationSocket("project-1", onDonation));

    // Emit a donation to set lastEventTimestampRef
    const firstDonation = payload({ timestamp: "2026-01-01T10:00:00.000Z" });
    socket.emit("donation_event", firstDonation);

    // Simulate failed fetch
    (global.fetch as jest.Mock).mockRejectedValue(new Error("Network error"));

    socket.emit("connect", {});

    await new Promise(resolve => setTimeout(resolve, 100));

    expect(consoleError).toHaveBeenCalledWith(
      "Failed to backfill missed donations:",
      expect.any(Error)
    );

    consoleError.mockRestore();
  });

  it("skips backfill if no previous donations received", async () => {
    const socket = makeFakeSocket();
    (getSocket as jest.Mock).mockReturnValue(socket);
    const onDonation = jest.fn();

    global.fetch = jest.fn();

    renderHook(() => useDonationSocket("project-1", onDonation));

    // Trigger reconnect without any prior donations
    socket.emit("connect", {});

    await new Promise(resolve => setTimeout(resolve, 100));

    // Fetch should not be called
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
