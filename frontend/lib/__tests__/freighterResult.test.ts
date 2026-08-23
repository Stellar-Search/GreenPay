import { extractBoolean, extractString, UnexpectedFreighterResponseError } from "../freighterResult";

describe("extractBoolean", () => {
  it("returns a bare boolean as-is", () => {
    expect(extractBoolean("isConnected", true, "isConnected")).toBe(true);
    expect(extractBoolean("isConnected", false, "isConnected")).toBe(false);
  });

  it("reads the named field off an object shape", () => {
    expect(extractBoolean("isAllowed", { isAllowed: true }, "isAllowed")).toBe(true);
    expect(extractBoolean("isAllowed", { isAllowed: false }, "isAllowed")).toBe(false);
  });

  it("throws a distinguishable error for an unexpected shape", () => {
    expect(() => extractBoolean("isConnected", { isConnected: "yes" }, "isConnected")).toThrow(
      UnexpectedFreighterResponseError
    );
    expect(() => extractBoolean("isConnected", null, "isConnected")).toThrow(UnexpectedFreighterResponseError);
    expect(() => extractBoolean("isConnected", undefined, "isConnected")).toThrow(UnexpectedFreighterResponseError);
    expect(() => extractBoolean("isConnected", {}, "isConnected")).toThrow(UnexpectedFreighterResponseError);
  });

  it("includes the call name in the error message", () => {
    expect(() => extractBoolean("isAllowed", 42, "isAllowed")).toThrow(/isAllowed/);
  });
});

describe("extractString", () => {
  it("returns a bare string as-is, including empty string", () => {
    expect(extractString("getPublicKey", "GABC", ["publicKey"])).toBe("GABC");
    expect(extractString("getPublicKey", "", ["publicKey"])).toBe("");
  });

  it("reads the first matching, non-empty named field off an object shape", () => {
    expect(extractString("getPublicKey", { publicKey: "GABC" }, ["publicKey", "address"])).toBe("GABC");
    expect(extractString("getPublicKey", { address: "GXYZ" }, ["publicKey", "address"])).toBe("GXYZ");
  });

  it("falls back to the next field when the first is empty", () => {
    expect(extractString("getPublicKey", { publicKey: "", address: "GXYZ" }, ["publicKey", "address"])).toBe(
      "GXYZ"
    );
  });

  it("throws a distinguishable error for an unexpected shape", () => {
    expect(() => extractString("getPublicKey", 42, ["publicKey"])).toThrow(UnexpectedFreighterResponseError);
    expect(() => extractString("getPublicKey", null, ["publicKey"])).toThrow(UnexpectedFreighterResponseError);
    expect(() => extractString("getPublicKey", { other: "value" }, ["publicKey", "address"])).toThrow(
      UnexpectedFreighterResponseError
    );
  });
});
