"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const request = require("supertest");
const yaml = require("js-yaml");
const { apiEnvelope, createApiError, errorHandler } = require("./apiEnvelope");

const IGNORED_DIRS = new Set([
  ".next",
  "coverage",
  "dist",
  "dist-firefox",
  "node_modules",
  "playwright-report",
  "test-results",
]);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return IGNORED_DIRS.has(entry.name) ? [] : walk(fullPath);
    }
    return [fullPath];
  });
}

describe("API response envelope", () => {
  it("wraps successful API JSON responses and metadata", async () => {
    const app = express();
    app.use(apiEnvelope);
    app.get("/api/v1/items", (req, res) => {
      res.apiMeta({ nextCursor: "cursor-2" });
      res.json([{ id: "item-1" }]);
    });

    const res = await request(app).get("/api/v1/items").expect(200);

    expect(res.body).toEqual({
      success: true,
      data: [{ id: "item-1" }],
      meta: { nextCursor: "cursor-2" },
    });
  });

  it("wraps errors with a stable code and display message", async () => {
    const app = express();
    app.use(apiEnvelope);
    app.get("/api/v1/items/:id", () => {
      throw createApiError(404, "ITEM_NOT_FOUND", "Item not found");
    });
    app.use(errorHandler);

    const res = await request(app).get("/api/v1/items/missing").expect(404);

    expect(res.body).toEqual({
      success: false,
      error: {
        code: "ITEM_NOT_FOUND",
        message: "Item not found",
      },
    });
  });

  it("keeps backend handlers from constructing envelopes by hand", () => {
    const backendSrc = path.resolve(__dirname, "..");
    const files = [
      ...walk(path.join(backendSrc, "routes")),
      ...walk(path.join(backendSrc, "middleware")),
    ].filter((file) => file.endsWith(".js") && !file.endsWith(".test.js") && !file.endsWith("apiEnvelope.js"));

    const offenders = files.flatMap((file) => {
      const source = fs.readFileSync(file, "utf8");
      return [
        /\bsuccess:\s*(true|false)\b/.test(source) ? `${file}: success envelope` : null,
        /\.json\(\s*\{\s*error\b/.test(source) ? `${file}: bare error JSON` : null,
      ].filter(Boolean);
    });

    expect(offenders).toEqual([]);
  });

  it("keeps clients from unwrapping endpoint-specific response shapes", () => {
    const root = path.resolve(__dirname, "../../..");
    const files = ["frontend", "mobile", "extension/src"].flatMap((dir) =>
      walk(path.join(root, dir))
        .filter((file) => /\.(ts|tsx)$/.test(file))
        .filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`))
        .filter((file) => !file.endsWith("frontend/lib/api.ts"))
        .filter((file) => !file.endsWith("mobile/utils/api.ts")),
    );

    const offenders = files.flatMap((file) => {
      const source = fs.readFileSync(file, "utf8");
      return [
        /response\??\.data\??\.(error|message)/.test(source) ? `${file}: response.data error parsing` : null,
        /\bdata\??\.data\b/.test(source) ? `${file}: nested data unwrapping` : null,
        /\bdata\.success\b/.test(source) ? `${file}: success flag branching` : null,
      ].filter(Boolean);
    });

    expect(offenders).toEqual([]);
  });

  it("documents the envelope schemas in OpenAPI", () => {
    const specPath = path.resolve(__dirname, "../../../docs/openapi.yml");
    const spec = yaml.load(fs.readFileSync(specPath, "utf8"));

    expect(spec.components.schemas.Success).toMatchObject({
      required: ["success", "data"],
      properties: {
        success: { enum: [true] },
        data: expect.any(Object),
        meta: expect.any(Object),
      },
    });
    expect(spec.components.schemas.Error).toMatchObject({
      required: ["success", "error"],
      properties: {
        success: { enum: [false] },
        error: {
          required: ["code", "message"],
          properties: {
            code: expect.any(Object),
            message: expect.any(Object),
          },
        },
      },
    });
  });
});
