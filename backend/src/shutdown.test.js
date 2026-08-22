"use strict";

const http = require("http");
const { createShutdownHandler } = require("./shutdown");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, (err) => (err ? reject(err) : resolve(server.address().port)));
  });
}

function get(port, path = "/") {
  return new Promise((resolve, reject) => {
    http
      .get({ port, path }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      })
      .on("error", reject);
  });
}

function silentLogger() {
  return { log: jest.fn(), error: jest.fn() };
}

describe("createShutdownHandler", () => {
  let server;

  afterEach(async () => {
    if (server && server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("drains an in-flight request, stops new connections, and shuts dependencies down in order", async () => {
    let finishRequest;
    let requestStarted;
    const started = new Promise((resolve) => {
      requestStarted = resolve;
    });
    server = http.createServer((req, res) => {
      requestStarted();
      new Promise((resolve) => {
        finishRequest = resolve;
      }).then(() => res.end("done"));
    });
    const port = await listen(server);

    const pool = { end: jest.fn().mockResolvedValue(undefined) };
    const shutdownEventSourcing = jest.fn().mockResolvedValue(undefined);
    const stopIndexer = jest.fn();
    const exit = jest.fn();

    const shutdown = createShutdownHandler({
      server,
      pool,
      shutdownEventSourcing,
      stopIndexer,
      timeoutMs: 5000,
      exit,
      logger: silentLogger(),
    });

    const inFlight = get(port, "/slow");
    await started;

    const shutdownPromise = shutdown("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The server should have stopped accepting new connections already.
    await expect(get(port, "/")).rejects.toBeTruthy();

    // Dependencies must not be torn down until the in-flight request finishes.
    expect(stopIndexer).not.toHaveBeenCalled();
    expect(pool.end).not.toHaveBeenCalled();

    finishRequest();
    const response = await inFlight;
    expect(response.body).toBe("done");

    await shutdownPromise;

    expect(stopIndexer).toHaveBeenCalledTimes(1);
    expect(shutdownEventSourcing).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("runs the shutdown sequence only once when SIGINT and SIGTERM both arrive", async () => {
    server = http.createServer((req, res) => res.end("ok"));
    await listen(server);

    const pool = { end: jest.fn().mockResolvedValue(undefined) };
    const shutdownEventSourcing = jest.fn().mockResolvedValue(undefined);
    const stopIndexer = jest.fn();
    const exit = jest.fn();

    const shutdown = createShutdownHandler({
      server,
      pool,
      shutdownEventSourcing,
      stopIndexer,
      timeoutMs: 5000,
      exit,
      logger: silentLogger(),
    });

    await Promise.all([shutdown("SIGINT"), shutdown("SIGTERM")]);

    expect(shutdownEventSourcing).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("forces exit(1) if shutdown exceeds the configured timeout", async () => {
    server = http.createServer((req, res) => res.end("ok"));
    await listen(server);

    const pool = { end: jest.fn().mockResolvedValue(undefined) };
    // Simulates a dependency that never resolves (e.g. a hung scheduler).
    const shutdownEventSourcing = jest.fn(() => new Promise(() => {}));
    const stopIndexer = jest.fn();
    const exit = jest.fn();

    const shutdown = createShutdownHandler({
      server,
      pool,
      shutdownEventSourcing,
      stopIndexer,
      timeoutMs: 30,
      exit,
      logger: silentLogger(),
    });

    await shutdown("SIGTERM");

    expect(exit).toHaveBeenCalledWith(1);
  });
});
