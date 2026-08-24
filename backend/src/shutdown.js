/**
 * src/shutdown.js — shared graceful shutdown sequence for SIGINT/SIGTERM.
 */
"use strict";

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    // Idle keep-alive sockets aren't mid-request, so drop them immediately;
    // active requests are left alone and the close() callback above waits
    // for them to finish on their own.
    if (typeof server.closeIdleConnections === "function") {
      server.closeIdleConnections();
    }
  });
}

/**
 * A keep-alive socket that finishes its in-flight response *during* drain
 * would otherwise sit idle waiting for a next request that will never
 * arrive — server.close()'s callback would then never fire. Ending the
 * socket right after that response completes (but only once shutdown has
 * actually begun) keeps drain bounded to real in-flight work.
 */
function closeSocketsOnceIdleDuringShutdown(server, isShuttingDown) {
  server.on("request", (req, res) => {
    res.on("finish", () => {
      if (isShuttingDown()) req.socket.end();
    });
  });
}

/**
 * Builds a shutdown(signal) function that stops accepting new HTTP
 * connections, drains in-flight requests, stops the indexer and the
 * event-sourcing scheduler, closes the database pool, and exits — bounded
 * by timeoutMs so a hung dependency can't block termination forever.
 */
function createShutdownHandler({
  server,
  pool,
  shutdownEventSourcing,
  stopIndexer,
  timeoutMs = 25000,
  exit = process.exit,
  logger = console,
}) {
  let shuttingDown = false;
  closeSocketsOnceIdleDuringShutdown(server, () => shuttingDown);

  return async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.log(`[Shutdown] Received ${signal}, draining connections (timeout ${timeoutMs}ms)...`);

    let timeoutHandle;
    const timedOut = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => resolve(true), timeoutMs);
      if (timeoutHandle.unref) timeoutHandle.unref();
    });

    const work = (async () => {
      await closeServer(server);
      logger.log("[Shutdown] HTTP server closed");

      if (stopIndexer) await stopIndexer();

      await shutdownEventSourcing();
      await pool.end();
      logger.log("[Shutdown] Database pool closed");
    })();

    const raced = await Promise.race([work.then(() => false), timedOut]);
    clearTimeout(timeoutHandle);

    if (raced) {
      logger.error(`[Shutdown] Exceeded ${timeoutMs}ms, forcing exit`);
      exit(1);
      return;
    }

    logger.log("[Shutdown] Graceful shutdown complete");
    exit(0);
  };
}

module.exports = { createShutdownHandler };
