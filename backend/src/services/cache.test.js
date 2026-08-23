"use strict";

const { createCache } = require("./cache");

describe("createCache", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns a stored value before it expires", () => {
    const cache = createCache({ maxEntries: 10, sweepIntervalMs: 60_000 });
    cache.set("a", { value: 1 }, 1000);

    expect(cache.get("a")).toEqual({ value: 1 });
    cache.stopSweep();
  });

  it("returns null for a missing key", () => {
    const cache = createCache({ maxEntries: 10, sweepIntervalMs: 60_000 });
    expect(cache.get("missing")).toBeNull();
    cache.stopSweep();
  });

  it("expires an entry once its TTL has elapsed", () => {
    jest.useFakeTimers();
    const cache = createCache({ maxEntries: 10, sweepIntervalMs: 60_000 });
    cache.set("a", "value", 1000);

    jest.advanceTimersByTime(1001);

    expect(cache.get("a")).toBeNull();
    cache.stopSweep();
  });

  it("evicts the least-recently-used entry once maxEntries is exceeded", () => {
    const cache = createCache({ maxEntries: 2, sweepIntervalMs: 60_000 });
    cache.set("a", "1", 60_000);
    cache.set("b", "2", 60_000);
    cache.set("c", "3", 60_000); // evicts "a", the oldest

    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBe("2");
    expect(cache.get("c")).toBe("3");
    expect(cache.size()).toBe(2);
    cache.stopSweep();
  });

  it("treats a read as a recency refresh so a hot key survives eviction", () => {
    const cache = createCache({ maxEntries: 2, sweepIntervalMs: 60_000 });
    cache.set("a", "1", 60_000);
    cache.set("b", "2", 60_000);

    cache.get("a"); // "a" is now most-recently-used; "b" becomes the oldest
    cache.set("c", "3", 60_000); // evicts "b"

    expect(cache.get("a")).toBe("1");
    expect(cache.get("b")).toBeNull();
    expect(cache.get("c")).toBe("3");
    cache.stopSweep();
  });

  it("never grows past maxEntries even under a flood of distinct keys", () => {
    const cache = createCache({ maxEntries: 50, sweepIntervalMs: 60_000 });
    for (let i = 0; i < 500; i++) {
      cache.set(`key-${i}`, i, 60_000);
    }

    expect(cache.size()).toBe(50);
    cache.stopSweep();
  });

  it("sweeps expired entries on a timer even if they are never read again", () => {
    jest.useFakeTimers();
    const cache = createCache({ maxEntries: 10, sweepIntervalMs: 1000 });
    cache.set("a", "1", 500);

    expect(cache.size()).toBe(1);

    jest.advanceTimersByTime(1500); // TTL elapses, then the sweep timer fires

    expect(cache.size()).toBe(0);
    cache.stopSweep();
  });

  it("clear() empties the cache immediately", () => {
    const cache = createCache({ maxEntries: 10, sweepIntervalMs: 60_000 });
    cache.set("a", "1", 60_000);
    cache.clear();

    expect(cache.size()).toBe(0);
    expect(cache.get("a")).toBeNull();
    cache.stopSweep();
  });
});

describe("default cache singleton", () => {
  it("exposes get/set bound to a shared bounded store", () => {
    const cache = require("./cache");
    cache.set("shared-key", "shared-value", 60_000);

    expect(cache.get("shared-key")).toBe("shared-value");
  });
});
