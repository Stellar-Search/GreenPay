"use strict";

const pool = require("./pool");

describe("RotatablePool — Zero-Downtime Credential Rotation", () => {
  it("should initialize with primary pool", () => {
    expect(pool.primaryUrl).toBeDefined();
    expect(pool.activePoolName).toBe("primary");
  });

  it("should detect authentication error codes correctly", () => {
    const authErr1 = new Error("password authentication failed for user");
    authErr1.code = "28P01";
    
    const authErr2 = new Error("invalid authorization specification");
    authErr2.code = "28000";

    const nonAuthErr = new Error("relation does not exist");
    nonAuthErr.code = "42P01";

    expect(pool.isAuthError(authErr1)).toBe(true);
    expect(pool.isAuthError(authErr2)).toBe(true);
    expect(pool.isAuthError(nonAuthErr)).toBe(false);
  });

  it("should fallback to secondary pool when primary returns auth error", async () => {
    const mockPrimaryQuery = jest.fn().mockRejectedValue({
      code: "28P01",
      message: "password authentication failed for user",
    });
    const mockFallbackQuery = jest.fn().mockResolvedValue({ rows: [{ ok: 1 }] });

    pool.primaryPool.query = mockPrimaryQuery;
    pool.fallbackPool = {
      query: mockFallbackQuery,
      on: jest.fn(),
      end: jest.fn(),
    };

    const res = await pool.query("SELECT 1");
    expect(mockPrimaryQuery).toHaveBeenCalledWith("SELECT 1");
    expect(mockFallbackQuery).toHaveBeenCalledWith("SELECT 1");
    expect(res).toEqual({ rows: [{ ok: 1 }] });
    expect(pool.activePoolName).toBe("fallback");
  });

  it("should support runtime credential updates", () => {
    pool.updateCredentials("postgres://user:newpass@localhost:5432/db", "postgres://user:oldpass@localhost:5432/db");
    expect(pool.primaryUrl).toBe("postgres://user:newpass@localhost:5432/db");
    expect(pool.fallbackUrl).toBe("postgres://user:oldpass@localhost:5432/db");
    expect(pool.activePoolName).toBe("primary");
  });
});
