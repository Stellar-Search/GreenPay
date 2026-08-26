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
});
