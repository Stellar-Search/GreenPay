/**
 * Reconnect recovery: a client that was disconnected must be able to determine
 * and recover what it missed, rather than silently resuming with a hole in its
 * timeline.
 */
import { renderHook, waitFor, act } from "@testing-library/react";
import { EventEmitter } from "events";
import { useDonationSocket, type DonationSocketPayload } from "../useDonationSocket";
import { getSocket } from "@/lib/socket";

jest.mock("@/lib/socket", () => ({ getSocket: jest.fn() }));

function makeFakeSocket() {
  const emitter = new EventEmitter();
  return {
    connected: false,
    on: (event: string, handler: (...args: any[]) => void) => emitter.on(event, handler),
    off: (event: string, handler: (...args: any[]) => void) => emitter.off(event, handler),
    emit: (event: string, payload?: unknown) => emitter.emit(event, payload),
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

function envelope(body: { data: unknown[]; meta: Record<string, unknown> }) {
  return { ok: true, json: async () => body } as unknown as Response;
}

describe("useDonationSocket reconnect recovery", () => {
  let socket: ReturnType<typeof makeFakeSocket>;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    socket = makeFakeSocket();
    (getSocket as jest.Mock).mockReturnValue(socket);
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("replays events broadcast while the client was disconnected", async () => {
    const onDonation = jest.fn();
    renderHook(() => useDonationSocket("project-1", onDonation));

    // A live event establishes the client's position in the feed.
    act(() => { socket.emit("donation_event", payload({ transactionHash: "tx-1", cursor: "r:100-0" })); });
    expect(onDonation).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(envelope({
      data: [
        { cursor: "r:101-0", name: "donation_event", payload: payload({ transactionHash: "tx-2" }), emittedAt: "" },
        { cursor: "r:102-0", name: "donation_event", payload: payload({ transactionHash: "tx-3" }), emittedAt: "" },
      ],
      meta: { reset: false, reason: null, degraded: false, nextCursor: "r:102-0" },
    }));

    act(() => { socket.emit("disconnect"); });
    act(() => { socket.emit("connect"); });

    await waitFor(() => expect(onDonation).toHaveBeenCalledTimes(3));

    // The replay asked for events after the last cursor actually seen.
    expect(fetchMock.mock.calls[0][0]).toContain("cursor=r%3A100-0");
    expect(onDonation.mock.calls.map((call) => call[0].transactionHash)).toEqual(["tx-1", "tx-2", "tx-3"]);
  });

  it("reports a gap instead of silently accepting an unusable cursor", async () => {
    const onDonation = jest.fn();
    const onGap = jest.fn();
    renderHook(() => useDonationSocket("project-1", onDonation, { onGap }));

    act(() => { socket.emit("donation_event", payload({ cursor: "r:100-0" })); });

    fetchMock.mockResolvedValueOnce(envelope({
      data: [],
      meta: { reset: true, reason: "CURSOR_EXPIRED", degraded: false, nextCursor: null },
    }));

    act(() => { socket.emit("connect"); });

    await waitFor(() => expect(onGap).toHaveBeenCalledWith({ kind: "reset", reason: "CURSOR_EXPIRED" }));
    // Crucially it did NOT deliver an empty replay as if nothing had happened.
    expect(onDonation).toHaveBeenCalledTimes(1);
  });

  it("reports a gap when the replay endpoint itself is unreachable", async () => {
    const onGap = jest.fn();
    renderHook(() => useDonationSocket("project-1", jest.fn(), { onGap }));

    act(() => { socket.emit("donation_event", payload({ cursor: "r:100-0" })); });
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    act(() => { socket.emit("connect"); });

    await waitFor(() => expect(onGap).toHaveBeenCalledWith({ kind: "reset", reason: "REPLAY_UNAVAILABLE" }));
  });

  it("surfaces a pod that can only deliver to its own clients", async () => {
    const onGap = jest.fn();
    const { result } = renderHook(() => useDonationSocket("project-1", jest.fn(), { onGap }));

    act(() => {
      socket.emit("realtime:status", {
        instanceId: "pod-a", mode: "redis-adapter", degraded: true,
        reason: "redis publisher: ECONNREFUSED", delivery: "instance",
      });
    });

    expect(onGap).toHaveBeenCalledWith({ kind: "degraded", reason: "redis publisher: ECONNREFUSED" });
    // Exposed to the UI so it can tell the donor the feed is partial rather
    // than showing a confidently empty list.
    await waitFor(() => expect(result.current.delivery).toBe("instance"));
  });

  it("does not replay on a first connection, having missed nothing", async () => {
    renderHook(() => useDonationSocket("project-1", jest.fn()));
    act(() => { socket.emit("connect"); });
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });

  it("does not deliver the same events twice when reconnects overlap", async () => {
    const onDonation = jest.fn();
    renderHook(() => useDonationSocket("project-1", onDonation));

    act(() => { socket.emit("donation_event", payload({ transactionHash: "tx-1", cursor: "r:100-0" })); });

    let release: (value: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve; }));

    // Two reconnects in quick succession — a flapping connection.
    act(() => { socket.emit("connect"); });
    act(() => { socket.emit("connect"); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      release(envelope({
        data: [{ cursor: "r:101-0", name: "donation_event", payload: payload({ transactionHash: "tx-2" }), emittedAt: "" }],
        meta: { reset: false, reason: null, degraded: false, nextCursor: "r:101-0" },
      }));
    });

    await waitFor(() => expect(onDonation).toHaveBeenCalledTimes(2));
    expect(onDonation.mock.calls.map((call) => call[0].transactionHash)).toEqual(["tx-1", "tx-2"]);
  });
});
