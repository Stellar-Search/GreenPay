/**
 * src/middleware/validate.test.js
 */
"use strict";

const request = require("supertest");
const express = require("express");
const { z } = require("zod");
const { validate, validateBody, ValidationError } = require("./validate");
const { apiEnvelope, errorHandler } = require("./apiEnvelope");
const { DonationCreateSchema } = require("../schemas/donations");
const { stellarPublicKey } = require("../schemas/common");

const { Keypair } = require("@stellar/stellar-sdk");
const _keys = Array.from({ length: 26 }, () => Keypair.random().publicKey());
function makeKey(char = "A") {
  const index = Math.abs(char.charCodeAt(0) - 65) % 26;
  return _keys[index];
}
function makeTx(char = "a") {
  return char.repeat(64);
}

describe("validateBody", () => {
  test("returns parsed data on success", () => {
    const data = validateBody(DonationCreateSchema, {
      projectId: "p1",
      donorAddress: makeKey("A"),
      transactionHash: makeTx("a"),
    });
    expect(data.donorAddress).toBe(makeKey("A"));
    expect(data.currency).toBe("XLM");
  });

  test("throws ValidationError (status 400) with the first issue message", () => {
    let caught;
    try {
      validateBody(DonationCreateSchema, {
        projectId: "p1",
        donorAddress: "not-a-key",
        transactionHash: makeTx("a"),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught.status).toBe(400);
    expect(caught.message).toBe("Invalid Stellar public key");
  });

  test("reports invalid transaction hash", () => {
    let caught;
    try {
      validateBody(DonationCreateSchema, {
        projectId: "p1",
        donorAddress: makeKey("B"),
        transactionHash: "bad",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught.message).toBe("Invalid transaction hash");
  });
});

describe("validate middleware", () => {
  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use(apiEnvelope);
    app.post(
      "/api/donations",
      validate(DonationCreateSchema),
      (req, res) => res.json({ ok: true, body: req.body }),
    );
    app.get(
      "/api/donor/:publicKey",
      validate(z.object({ publicKey: stellarPublicKey }), { source: "params" }),
      (req, res) => res.json({ ok: true, key: req.params.publicKey }),
    );
    app.use(errorHandler);
    return app;
  }

  test("passes validated body through and strips unknown fields", async () => {
    const res = await request(buildApp())
      .post("/api/donations")
      .send({
        projectId: "p1",
        donorAddress: makeKey("C"),
        transactionHash: makeTx("c"),
        evil: "should-be-removed",
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.ok).toBe(true);
    expect(res.body.data.body.evil).toBeUndefined();
  });

  test("rejects invalid body with the shared error envelope", async () => {
    const res = await request(buildApp())
      .post("/api/donations")
      .send({ donorAddress: makeKey("D"), transactionHash: makeTx("d") });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "projectId is required",
      },
    });
  });

  test("validates path params", async () => {
    const ok = await request(buildApp()).get(`/api/donor/${makeKey("E")}`);
    expect(ok.status).toBe(200);
    const bad = await request(buildApp()).get("/api/donor/not-a-key");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Invalid Stellar public key",
    });
  });

  test("calls next() for a valid body", () => {
    const mw = validate(z.object({}), {});
    const next = jest.fn();
    mw({ body: {} }, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

});
