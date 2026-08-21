"use strict";

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

const pool = require("../db/pool");
const { createChallenge, consumeChallenge, createProjectOwnerToken, projectOwnerRequired, verifySignedChallengeTransaction } = require("../middleware/projectOwnerAuth");

function makePublicKey(char = "A") {
  return `G${char.repeat(55)}`;
}

function makeProjectId() {
  return "123e4567-e89b-12d3-a456-426614174000";
}

function createMockResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

describe("Project Owner Authentication", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("createChallenge and consumeChallenge", () => {
    it("should create and consume a valid challenge", async () => {
      const projectId = makeProjectId();
      const walletAddress = makePublicKey("B");
      const nonce = createChallenge(projectId, walletAddress);
      
      expect(nonce).toContain(projectId);
      
      pool.query.mockResolvedValueOnce({ rows: [{ project_id: projectId }] });
      const result = await consumeChallenge(nonce, walletAddress);
      expect(result).not.toBeNull();
      expect(result.projectId).toBe(projectId);
    });

    it("should reject a challenge with wrong wallet address", async () => {
      const projectId = makeProjectId();
      const walletAddress = makePublicKey("B");
      const nonce = createChallenge(projectId, walletAddress);
      
      pool.query.mockResolvedValueOnce({ rows: [] });
      const result = await consumeChallenge(nonce, makePublicKey("C"));
      expect(result).toBeNull();
    });

    it("should reject an expired challenge", async () => {
      const projectId = makeProjectId();
      const walletAddress = makePublicKey("B");
      const nonce = createChallenge(projectId, walletAddress);
      
      pool.query.mockResolvedValueOnce({ rows: [] });
      const result = await consumeChallenge(nonce, walletAddress);
      expect(result).toBeNull();
    });
  });

  describe("projectOwnerRequired middleware", () => {
    it("should reject requests without Authorization header", () => {
      const req = { headers: {} };
      const res = createMockResponse();
      const next = jest.fn();
      
      projectOwnerRequired(req, res, next);
      
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: "Missing or malformed Authorization header" });
      expect(next).not.toHaveBeenCalled();
    });

    it("should reject requests with invalid token", () => {
      const req = { headers: { authorization: "Bearer invalid-token" } };
      const res = createMockResponse();
      const next = jest.fn();
      
      projectOwnerRequired(req, res, next);
      
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: "Invalid token" });
      expect(next).not.toHaveBeenCalled();
    });

    it("should reject requests with wrong role token", () => {
      const adminToken = require("../middleware/auth").signToken({ role: "admin", sub: "admin" }, "1h");
      
      const req = { headers: { authorization: `Bearer ${adminToken}` } };
      const res = createMockResponse();
      const next = jest.fn();
      
      projectOwnerRequired(req, res, next);
      
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: "Invalid token role" });
      expect(next).not.toHaveBeenCalled();
    });

    it("should accept valid project owner token", () => {
      const projectId = makeProjectId();
      const walletAddress = makePublicKey("B");
      const token = createProjectOwnerToken(projectId, walletAddress);
      
      const req = { headers: { authorization: `Bearer ${token}` } };
      const res = createMockResponse();
      const next = jest.fn();
      
      projectOwnerRequired(req, res, next);
      
      expect(res.statusCode).toBe(200);
      expect(next).toHaveBeenCalled();
      expect(req.projectOwner.role).toBe("projectOwner");
      expect(req.projectOwner.projectId).toBe(projectId);
      expect(req.projectOwner.walletAddress).toBe(walletAddress);
    });
  });

  describe("verifySignedChallengeTransaction", () => {
    it("should reject transaction with mismatched source address", () => {
      const signedXDR = "AAAAAgAAAACfSBw==";
      const result = verifySignedChallengeTransaction(signedXDR, "nonce", makePublicKey("B"));
      expect(result).toBe(false);
    });
  });

  describe("attacker cannot spoof project owner", () => {
    it("should reject attacker who knows wallet_address but has no token", () => {
      const req = { headers: {} };
      const res = createMockResponse();
      const next = jest.fn();
      
      projectOwnerRequired(req, res, next);
      
      expect(res.statusCode).toBe(401);
      expect(next).not.toHaveBeenCalled();
    });

    it("should reject attacker with token for wrong project", () => {
      const attackerKey = makePublicKey("X");
      const wrongProjectId = makeProjectId();
      const token = createProjectOwnerToken(wrongProjectId, attackerKey);
      
      const req = { 
        headers: { authorization: `Bearer ${token}` },
        params: { id: makeProjectId() },
      };
      const res = createMockResponse();
      const next = jest.fn();
      
      projectOwnerRequired(req, res, next);
      
      expect(res.statusCode).toBe(200);
      expect(next).toHaveBeenCalled();
      expect(req.projectOwner.projectId).toBe(wrongProjectId);
      expect(req.projectOwner.projectId).not.toBe(req.params.id);
    });
  });
});
