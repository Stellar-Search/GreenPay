"use strict";

const { logger } = require("../utils/logger");

const STATUS_ERROR_CODES = Object.freeze({
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  429: "RATE_LIMITED",
  500: "INTERNAL_SERVER_ERROR",
  503: "SERVICE_UNAVAILABLE",
});

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function createApiError(status, code, message, details) {
  return new ApiError(status, code, message, details);
}

function statusFromError(err) {
  const status = Number(err.status || err.statusCode || 500);
  return status >= 400 && status <= 599 ? status : 500;
}

function errorCodeForStatus(status) {
  return STATUS_ERROR_CODES[status] || "INTERNAL_SERVER_ERROR";
}

function errorResponseFrom(err) {
  const status = statusFromError(err);
  const message = err.expose === false && status >= 500
    ? "Internal server error"
    : err.message || "Internal server error";

  const error = {
    code: err.code || errorCodeForStatus(status),
    message,
  };

  if (err.details !== undefined) {
    error.details = err.details;
  }

  return { status, error };
}

function isApiJsonRequest(req) {
  return req.path === "/api" || req.path.startsWith("/api/");
}

function normalizeErrorBody(body, status) {
  if (body && typeof body === "object" && body.code && body.message) {
    return body;
  }

  if (body && typeof body === "object" && body.error && typeof body.error === "object") {
    return body.error;
  }

  return {
    code: body?.code || errorCodeForStatus(status),
    message: body?.message || body?.error || "Internal server error",
  };
}

function apiEnvelope(optionsOrReq, maybeRes, maybeNext) {
  if (optionsOrReq && typeof optionsOrReq === "object" && typeof maybeRes === "object") {
    return applyApiEnvelope(optionsOrReq, maybeRes, maybeNext, isApiJsonRequest);
  }

  const shouldEnvelope = optionsOrReq?.shouldEnvelope || isApiJsonRequest;
  return (req, res, next) => applyApiEnvelope(req, res, next, shouldEnvelope);
}

function applyApiEnvelope(req, res, next, shouldEnvelope) {
  const json = res.json.bind(res);
  const envelopeResponse = shouldEnvelope(req);

  res.json = (body) => {
    if (!envelopeResponse || res.locals.skipApiEnvelope) {
      return json(body);
    }

    if (res.statusCode >= 400) {
      return json({
        success: false,
        error: normalizeErrorBody(body, res.statusCode),
      });
    }

    const envelope = {
      success: true,
      data: body === undefined ? null : body,
    };

    if (res.locals.apiMeta !== undefined) {
      envelope.meta = res.locals.apiMeta;
    }

    return json(envelope);
  };

  res.apiMeta = (meta) => {
    res.locals.apiMeta = meta;
    return res;
  };

  next();
}

function notFoundHandler(req, res, next) {
  next(createApiError(404, "ROUTE_NOT_FOUND", `${req.method} ${req.path} not found`));
}

function errorHandler(err, req, res, next) {
  void next;
  const { status, error } = errorResponseFrom(err);

  logger.error({ msg: "unhandled error", error: err.message, status });

  res.status(status).json(error);
}

module.exports = {
  ApiError,
  apiEnvelope,
  createApiError,
  errorHandler,
  notFoundHandler,
};
