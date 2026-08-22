"use strict";

jest.mock("../db/pool", () => ({ query: jest.fn() }));
jest.mock("../eventSourcing/commandBus", () => ({
  execute: jest.fn(),
  DonationReplayConflictError: class DonationReplayConflictError extends Error {
    constructor(transactionHash, mismatches) {
      super(`Transaction ${transactionHash} is already recorded with different details (${mismatches.join("; ")})`);
      this.name = "DonationReplayConflictError";
      this.code = "DONATION_TX_CONFLICT";
      this.status = 409;
      this.transactionHash = transactionHash;
      this.mismatches = mismatches;
    }
  },
}));
jest.mock("../middleware/rateLimiter", () => ({
  createRateLimiter: () => (req, res, next) => next(),
}));

const http = require("http");
const express = require("express");
const { Server: SocketServer } = require("socket.io");
const { io: ioc } = require("socket.io-client");
const supertest = require("supertest");
const pool = require("../db/pool");
const { execute } = require("../eventSourcing/commandBus");
const { DonationRecordedEvent } = require("../eventSourcing/events");

function makePublicKey(char = "A") {
  return `G${char.repeat(55)}`;
}

function makeTxHash(char = "a") {
  return char.repeat(64);
}

function queryResult(rows = []) {
  return { rows };
}

function mockSuccessfulDonation({ projectId, donorAddress, amountXlm, transactionHash }) {
  pool.query.mockResolvedValueOnce(queryResult([{ id: projectId }])); // project lookup
  const donationEvent = new DonationRecordedEvent({
    aggregateId: `Donation:${transactionHash}`,
    version: 1,
    actor: donorAddress,
    projectId,
    donorAddress,
    amountXlm,
    currency: "XLM",
    message: null,
    transactionHash,
  });
  execute.mockResolvedValueOnce({
    events: [donationEvent],
    data: { donationId: donationEvent.eventId, amountXlm: Number.parseFloat(amountXlm) },
    deduplicated: false,
  });
}

describe("POST /api/donations → donation_event WebSocket broadcast", () => {
  let httpServer;
  let ioServer;
  let request;
  let baseUrl;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    httpServer = http.createServer(app);
    ioServer = new SocketServer(httpServer, {
      cors: { origin: "*" },
      transports: ["websocket"],
    });
    app.set("io", ioServer);
    app.use("/api/donations", require("./donations"));

    httpServer.listen(0, () => {
      const { port } = httpServer.address();
      baseUrl = `http://localhost:${port}`;
      request = supertest(httpServer);
      done();
    });
  });

  afterAll((done) => {
    ioServer.close(done);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test(
    "emits donation_event to connected clients within 500 ms",
    (done) => {
      const donorAddress = makePublicKey("W");
      const transactionHash = makeTxHash("7");

      mockSuccessfulDonation({
        projectId: "project-ws",
        donorAddress,
        amountXlm: "25",
        transactionHash,
      });

      const socket = ioc(baseUrl, {
        transports: ["websocket"],
        forceNew: true,
      });

      const deadline = setTimeout(() => {
        socket.disconnect();
        done(new Error("donation_event was not received within 500 ms"));
      }, 500);

      socket.on("connect", () => {
        socket.on("donation_event", (data) => {
          clearTimeout(deadline);
          socket.disconnect();
          try {
            expect(data.projectId).toBe("project-ws");
            expect(data.donorAddress).toBe(donorAddress);
            expect(data.transactionHash).toBe(transactionHash);
            expect(typeof data.timestamp).toBe("string");
            done();
          } catch (assertionError) {
            done(assertionError);
          }
        });

        request
          .post("/api/donations")
          .send({
            projectId: "project-ws",
            donorAddress,
            amountXLM: "25",
            transactionHash,
          })
          .end((err) => {
            if (err) {
              clearTimeout(deadline);
              socket.disconnect();
              done(err);
            }
          });
      });

      socket.on("connect_error", (err) => {
        clearTimeout(deadline);
        done(err);
      });
    },
    2000,
  );

  test(
    "does not emit donation_event when the project is not found",
    (done) => {
      const donorAddress = makePublicKey("X");
      const transactionHash = makeTxHash("8");

      pool.query.mockResolvedValueOnce(queryResult([])); // project lookup → not found

      const socket = ioc(baseUrl, {
        transports: ["websocket"],
        forceNew: true,
      });

      let eventReceived = false;

      socket.on("connect", () => {
        socket.on("donation_event", () => {
          eventReceived = true;
        });

        request
          .post("/api/donations")
          .send({
            projectId: "nonexistent-project",
            donorAddress,
            amountXLM: "10",
            transactionHash,
          })
          .end((err, res) => {
            socket.disconnect();
            if (err) return done(err);
            try {
              expect(res.status).toBe(404);
              expect(eventReceived).toBe(false);
              expect(execute).not.toHaveBeenCalled();
              done();
            } catch (assertionError) {
              done(assertionError);
            }
          });
      });

      socket.on("connect_error", (err) => done(err));
    },
    2000,
  );

  test(
    "includes correct amountXLM in the donation_event payload",
    (done) => {
      const donorAddress = makePublicKey("Y");
      const transactionHash = makeTxHash("9");

      mockSuccessfulDonation({
        projectId: "project-ws-2",
        donorAddress,
        amountXlm: "100",
        transactionHash,
      });

      const socket = ioc(baseUrl, {
        transports: ["websocket"],
        forceNew: true,
      });

      const deadline = setTimeout(() => {
        socket.disconnect();
        done(new Error("donation_event was not received within 500 ms"));
      }, 500);

      socket.on("connect", () => {
        socket.on("donation_event", (data) => {
          clearTimeout(deadline);
          socket.disconnect();
          try {
            expect(data.amountXLM).toBe(100);
            done();
          } catch (assertionError) {
            done(assertionError);
          }
        });

        request
          .post("/api/donations")
          .send({
            projectId: "project-ws-2",
            donorAddress,
            amountXLM: "100",
            transactionHash,
          })
          .end((err) => {
            if (err) {
              clearTimeout(deadline);
              socket.disconnect();
              done(err);
            }
          });
      });

      socket.on("connect_error", (err) => {
        clearTimeout(deadline);
        done(err);
      });
    },
    2000,
  );
});
