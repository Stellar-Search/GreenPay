"use strict";
const jwt = require("jsonwebtoken");
const { createApiError } = require("./apiEnvelope");
const { env } = require("../config/env");

function getSecret() {
  return env.jwtSecret;
}

function signToken(payload, expiresIn) {
  return jwt.sign(payload, getSecret(), { expiresIn });
}

function verifyToken(token) {
  return jwt.verify(token, getSecret());
}

function adminRequired(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next(createApiError(401, "AUTH_HEADER_INVALID", "Missing or malformed Authorization header"));
  }
  const token = authHeader.slice(7);
  try {
    const decoded = verifyToken(token);
    req.admin = decoded;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return next(createApiError(401, "TOKEN_EXPIRED", "Token expired"));
    }
    return next(createApiError(401, "INVALID_TOKEN", "Invalid token"));
  }
}

module.exports = { signToken, verifyToken, adminRequired };
