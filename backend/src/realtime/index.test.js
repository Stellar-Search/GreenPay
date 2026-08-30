"use strict";

/**
 * Behaviour of the realtime module in isolation, with a fake Socket.IO server
 * and fake Redis clients. The multi-process suite proves delivery for real;
 * these pin the decisions around it — chiefly that a Redis outage degrades
 * loudly and never takes the process with it.
 */

const realtime = require("./index");

function fakeIo() {
  const handlers = {};
  return {
    emitted: [],
    localEmitted: [],
    adapterFactory: null,
    on: (event, handler) => { handlers[event] = handler; },
    trigger: (event, arg) => handlers[event]?.(arg),
    emit(name, payload) { this.emitted.push({ name, payload }); },
    get local() {
      const self = this;
      return { emit: (name, payload) => self.localEmitted.push({ name, payload }) };
    },
    adapter(factory) { this.adapterFactory = factory; },
  };
}

function fakeRedis(status = "ready") {
  const listeners = {};
  return {
    status,
    stream: [],
    on(event, handler) { (listeners[event] ||= []).push(handler); return this; },
    off(event, handler) {
      listeners[event] = (listeners[event] || []).filter((h) => h !== handler);
      return this;
    },
    fire(event, arg) { (listeners[event] || []).forEach((h) => h(arg)); },
    xadd: jest.fn(function (...args) {
      const id = `${1700000000000 + this.stream.length}-0`;
      this.stream.push(id);
      return Promise.resolve(id);
    }),
    xrange: jest.fn().mockResolvedValue([]),
    quit: jest.fn().mockResolvedValue("OK"),
    disconnect: jest.fn(),
  };
}

function fakeClients() {
  return { pubClient: fakeRedis(), subClient: fakeRedis(), logClient: fakeRedis() };
}

afterEach(() => {
  realtime.resetRealtime();
  realtime.metrics.reset();
});

describe("single-process mode", () => {
  it("is the documented local-development path, and is not reported as degraded", async () => {
    const io = fakeIo();
    const result = await realtime.initializeRealtime(io, { redisUrl: null });

    expect(result.mode).toBe("single-process");
    expect(result.degraded).toBe(false);
    // No adapter is attached: one process delivering to its own clients is
    // complete delivery.
    expect(io.adapterFactory).toBeNull();

    const status = realtime.describeStatus();
    expect(status.degraded).toBe(false);
    expect(status.delivery).toBe("instance");
  });

  it("still broadcasts, so local behaviour is unchanged", async () => {
    const io = fakeIo();
    await realtime.initializeRealtime(io, { redisUrl: null });

    const published = await realtime.publish("donation_event", { projectId: "p1" });

    expect(io.emitted).toHaveLength(1);
    expect(io.emitted[0].name).toBe("donation_event");
    expect(io.emitted[0].payload.projectId).toBe("p1");
    // The cursor rides along even without Redis, so reconnect recovery works
    // locally too.
    expect(published.cursor).toMatch(/^l:/);
  });
});

describe("shared-adapter mode", () => {
  it("attaches the adapter and reports global delivery", async () => {
    const io = fakeIo();
    const createAdapterFn = jest.fn().mockReturnValue("adapter-instance");

    const result = await realtime.initializeRealtime(io, {
      redisUrl: "redis://fake:6379",
      clients: fakeClients(),
      createAdapterFn,
    });

    expect(result.mode).toBe("redis-adapter");
    expect(result.degraded).toBe(false);
    expect(io.adapterFactory).toBe("adapter-instance");
    expect(createAdapterFn).toHaveBeenCalledTimes(1);
    expect(realtime.describeStatus().delivery).toBe("global");
  });

  it("records the event before emitting it", async () => {
    const io = fakeIo();
    const clients = fakeClients();
    await realtime.initializeRealtime(io, {
      redisUrl: "redis://fake:6379", clients, createAdapterFn: () => ({}),
    });

    const published = await realtime.publish("donation_event", { projectId: "p1" });

    // Order matters: a client receiving cursor C then asking for "everything
    // after C" must not be told about an event the log has not yet stored.
    expect(clients.logClient.xadd).toHaveBeenCalledTimes(1);
    expect(published.cursor).toBe(`r:${clients.logClient.stream[0]}`);
    expect(io.emitted[0].payload.cursor).toBe(published.cursor);
  });
});

describe("degradation when the shared store fails", () => {
  it("flips to instance-only delivery and tells connected clients", async () => {
    const io = fakeIo();
    const clients = fakeClients();
    await realtime.initializeRealtime(io, {
      redisUrl: "redis://fake:6379", clients, createAdapterFn: () => ({}),
    });
    expect(realtime.describeStatus().delivery).toBe("global");

    clients.pubClient.fire("error", new Error("ECONNREFUSED"));

    const status = realtime.describeStatus();
    expect(status.degraded).toBe(true);
    expect(status.delivery).toBe("instance");
    expect(status.reason).toContain("ECONNREFUSED");

    // Announced to this pod's clients, not fanned out — the fan-out is exactly
    // what is broken.
    const announced = io.localEmitted.filter((e) => e.name === realtime.STATUS_EVENT);
    expect(announced).toHaveLength(1);
    expect(announced[0].payload.degraded).toBe(true);
  });

  it("keeps delivering locally rather than dropping the event", async () => {
    const io = fakeIo();
    const clients = fakeClients();
    clients.logClient.xadd = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await realtime.initializeRealtime(io, {
      redisUrl: "redis://fake:6379", clients, createAdapterFn: () => ({}),
    });

    const published = await realtime.publish("donation_event", { projectId: "p1" });

    expect(io.emitted).toHaveLength(1);
    expect(published.degraded).toBe(true);
    // Partial delivery beats none, but it is never reported as complete.
    expect(published.cursor).toMatch(/^l:/);
  });

  it("does not announce the same degradation repeatedly", async () => {
    const io = fakeIo();
    const clients = fakeClients();
    await realtime.initializeRealtime(io, {
      redisUrl: "redis://fake:6379", clients, createAdapterFn: () => ({}),
    });

    const error = new Error("ECONNREFUSED");
    clients.pubClient.fire("error", error);
    clients.pubClient.fire("error", error);
    clients.pubClient.fire("error", error);

    // A reconnect loop fires errors continuously; one announcement per state
    // change, not per error.
    expect(io.localEmitted.filter((e) => e.name === realtime.STATUS_EVENT)).toHaveLength(1);
  });

  it("recovers only once every connection is healthy again", async () => {
    const io = fakeIo();
    const clients = fakeClients();
    await realtime.initializeRealtime(io, {
      redisUrl: "redis://fake:6379", clients, createAdapterFn: () => ({}),
    });

    clients.pubClient.status = "connecting";
    clients.subClient.status = "connecting";
    clients.pubClient.fire("error", new Error("ECONNREFUSED"));
    expect(realtime.describeStatus().degraded).toBe(true);

    clients.pubClient.status = "ready";
    clients.pubClient.fire("ready");
    // One client back is not enough: the subscriber is what receives other
    // pods' broadcasts, so delivery is still not global.
    expect(realtime.describeStatus().degraded).toBe(true);

    clients.subClient.status = "ready";
    clients.subClient.fire("ready");
    expect(realtime.describeStatus().degraded).toBe(false);
    expect(realtime.describeStatus().delivery).toBe("global");
  });

  it("survives adapter construction failing outright", async () => {
    const io = fakeIo();
    const result = await realtime.initializeRealtime(io, {
      redisUrl: "redis://fake:6379",
      clients: fakeClients(),
      createAdapterFn: () => { throw new Error("adapter exploded"); },
    });

    // The API must still start; realtime is not the API.
    expect(result.degraded).toBe(true);
    expect(realtime.describeStatus().delivery).toBe("instance");
  });
});

describe("per-pod observability", () => {
  it("counts connections on this instance", async () => {
    const io = fakeIo();
    await realtime.initializeRealtime(io, { redisUrl: null });

    const sockets = [0, 1, 2].map(() => {
      const handlers = {};
      return { on: (e, h) => { handlers[e] = h; }, emit: jest.fn(), trigger: (e) => handlers[e]?.() };
    });
    sockets.forEach((socket) => io.trigger("connection", socket));
    expect(realtime.metrics.snapshot().currentConnections).toBe(3);

    sockets[0].trigger("disconnect");
    expect(realtime.metrics.snapshot().currentConnections).toBe(2);
    expect(realtime.metrics.snapshot().peakConnections).toBe(3);
  });

  it("tells a client its delivery scope the moment it connects", async () => {
    const io = fakeIo();
    await realtime.initializeRealtime(io, { redisUrl: null });

    const socket = { on: jest.fn(), emit: jest.fn() };
    io.trigger("connection", socket);

    expect(socket.emit).toHaveBeenCalledWith(realtime.STATUS_EVENT, expect.objectContaining({
      mode: "single-process",
      delivery: "instance",
    }));
  });
});

describe("shutdown", () => {
  it("closes every Redis connection so the process can exit", async () => {
    const io = fakeIo();
    const clients = fakeClients();
    await realtime.initializeRealtime(io, {
      redisUrl: "redis://fake:6379", clients, createAdapterFn: () => ({}),
    });

    await realtime.shutdownRealtime();

    // Leaving any of the three open keeps the event loop alive and turns every
    // rolling deploy into a forced, non-zero exit.
    expect(clients.pubClient.quit).toHaveBeenCalled();
    expect(clients.subClient.quit).toHaveBeenCalled();
    expect(clients.logClient.quit).toHaveBeenCalled();
  });

  it("falls back to a hard disconnect if quit fails", async () => {
    const io = fakeIo();
    const clients = fakeClients();
    clients.pubClient.quit = jest.fn().mockRejectedValue(new Error("already closed"));
    await realtime.initializeRealtime(io, {
      redisUrl: "redis://fake:6379", clients, createAdapterFn: () => ({}),
    });

    // Resolves rather than rejecting: a failed quit must not stall shutdown.
    await expect(realtime.shutdownRealtime()).resolves.toBeUndefined();
    expect(clients.pubClient.disconnect).toHaveBeenCalled();
  });
});

describe("publish before initialization", () => {
  it("is a no-op rather than a crash", async () => {
    // Route modules are imported by unit tests that never start a server.
    const result = await realtime.publish("donation_event", { projectId: "p" });
    expect(result).toEqual({ cursor: null, degraded: true });
  });
});
