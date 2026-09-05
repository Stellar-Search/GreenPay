"use strict";

const {
  encodeCursor,
  decodeCursor,
  formatPaginatedResponse,
} = require("./pagination");
const { ApiError } = require("../middleware/apiEnvelope");

describe("utils/pagination", () => {
  describe("encodeCursor & decodeCursor", () => {
    it("encodes and decodes valid payloads correctly", () => {
      const payload = { createdAt: "2026-08-26T12:00:00.000Z", id: "uuid-123" };
      const cursor = encodeCursor(payload);

      expect(cursor).toMatch(/^v1\./);
      const decoded = decodeCursor(cursor);
      expect(decoded).toEqual(payload);
    });

    it("handles legacy ISO date string (v0 compatibility)", () => {
      const iso = "2026-08-26T12:00:00.000Z";
      const decoded = decodeCursor(iso);
      expect(decoded).toEqual({ createdAt: iso, v0: true });
    });

    it("returns null for null, empty, or undefined cursor", () => {
      expect(decodeCursor(null)).toBeNull();
      expect(decodeCursor(undefined)).toBeNull();
      expect(decodeCursor("")).toBeNull();
      expect(decodeCursor("   ")).toBeNull();
    });

    it("throws 400 INVALID_CURSOR for malformed base64/json cursors", () => {
      expect.assertions(3);
      try {
        decodeCursor("v1.invalid_base64_json!!!");
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect(err.status).toBe(400);
        expect(err.code).toBe("INVALID_CURSOR");
      }
    });

    it("throws 400 UNSUPPORTED_CURSOR_VERSION for future cursor versions", () => {
      expect.assertions(3);
      try {
        decodeCursor("v99.eyJmb28iOiJiYXIifQ");
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect(err.status).toBe(400);
        expect(err.code).toBe("UNSUPPORTED_CURSOR_VERSION");
      }
    });

    it("throws 400 INVALID_CURSOR for arbitrary non-date strings", () => {
      expect.assertions(3);
      try {
        decodeCursor("not-a-cursor-not-a-date");
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect(err.status).toBe(400);
        expect(err.code).toBe("INVALID_CURSOR");
      }
    });
  });

  describe("formatPaginatedResponse", () => {
    const getCursorPayload = (row) => ({ id: row.id, createdAt: row.created_at });

    it("formats response when rows <= limit (no more pages)", () => {
      const rows = [
        { id: "1", created_at: "2026-08-26T12:00:00.000Z" },
        { id: "2", created_at: "2026-08-26T11:00:00.000Z" },
      ];
      const res = formatPaginatedResponse({
        rows,
        limit: 5,
        getCursorPayload,
      });

      expect(res.data).toEqual(rows);
      expect(res.meta.hasMore).toBe(false);
      expect(res.meta.nextCursor).toBeNull();
    });

    it("formats response when rows > limit (hasMore is true)", () => {
      const rows = [
        { id: "1", created_at: "2026-08-26T12:00:00.000Z" },
        { id: "2", created_at: "2026-08-26T11:00:00.000Z" },
        { id: "3", created_at: "2026-08-26T10:00:00.000Z" }, // extra row
      ];
      const res = formatPaginatedResponse({
        rows,
        limit: 2,
        getCursorPayload,
      });

      expect(res.data).toHaveLength(2);
      expect(res.data).toEqual(rows.slice(0, 2));
      expect(res.meta.hasMore).toBe(true);
      expect(res.meta.nextCursor).toBeDefined();

      const decoded = decodeCursor(res.meta.nextCursor);
      expect(decoded).toEqual({ id: "2", createdAt: "2026-08-26T11:00:00.000Z" });
    });
  });
});
