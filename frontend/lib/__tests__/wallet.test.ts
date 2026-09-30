import {
  isConnected,
  getPublicKey,
  signTransaction,
  requestAccess,
  isAllowed,
} from "@stellar/freighter-api";
import {
  isFreighterInstalled,
  connectWallet,
  getConnectedPublicKey,
  signTransactionWithWallet,
} from "../wallet";

jest.mock("@stellar/freighter-api", () => ({
  isConnected: jest.fn(),
  getPublicKey: jest.fn(),
  signTransaction: jest.fn(),
  requestAccess: jest.fn(),
  isAllowed: jest.fn(),
}));

const mockIsConnected = isConnected as jest.Mock;
const mockGetPublicKey = getPublicKey as jest.Mock;
const mockSignTransaction = signTransaction as jest.Mock;
const mockRequestAccess = requestAccess as jest.Mock;
const mockIsAllowed = isAllowed as jest.Mock;

afterEach(() => jest.resetAllMocks());

describe("isFreighterInstalled", () => {
  it("supports the bare-boolean shape", async () => {
    mockIsConnected.mockResolvedValue(true);
    expect(await isFreighterInstalled()).toBe(true);
  });

  it("supports the object shape", async () => {
    mockIsConnected.mockResolvedValue({ isConnected: false });
    expect(await isFreighterInstalled()).toBe(false);
  });

  it("returns false rather than throwing on an unexpected shape", async () => {
    mockIsConnected.mockResolvedValue({ nonsense: true });
    expect(await isFreighterInstalled()).toBe(false);
  });

  it("returns false if the underlying call rejects", async () => {
    mockIsConnected.mockRejectedValue(new Error("boom"));
    expect(await isFreighterInstalled()).toBe(false);
  });
});

describe("connectWallet", () => {
  it("supports the bare-string shape", async () => {
    mockIsConnected.mockResolvedValue(true);
    mockRequestAccess.mockResolvedValue(undefined);
    mockGetPublicKey.mockResolvedValue("GABCDEF");
    expect(await connectWallet()).toEqual({ publicKey: "GABCDEF", error: null });
  });

  it("supports the { publicKey } object shape", async () => {
    mockIsConnected.mockResolvedValue(true);
    mockRequestAccess.mockResolvedValue(undefined);
    mockGetPublicKey.mockResolvedValue({ publicKey: "GABCDEF" });
    expect(await connectWallet()).toEqual({ publicKey: "GABCDEF", error: null });
  });

  it("supports the { address } object shape", async () => {
    mockIsConnected.mockResolvedValue(true);
    mockRequestAccess.mockResolvedValue(undefined);
    mockGetPublicKey.mockResolvedValue({ address: "GZYXWV" });
    expect(await connectWallet()).toEqual({ publicKey: "GZYXWV", error: null });
  });

  it("reports Freighter not installed without calling getPublicKey", async () => {
    mockIsConnected.mockResolvedValue(false);
    const result = await connectWallet();
    expect(result.publicKey).toBeNull();
    expect(result.error).toMatch(/not installed/i);
    expect(mockGetPublicKey).not.toHaveBeenCalled();
  });

  it("surfaces a clear error instead of a silent null on an unexpected shape", async () => {
    mockIsConnected.mockResolvedValue(true);
    mockRequestAccess.mockResolvedValue(undefined);
    mockGetPublicKey.mockResolvedValue({ nonsense: "value" });
    const result = await connectWallet();
    expect(result.publicKey).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it("reports a friendly message when the user declines", async () => {
    mockIsConnected.mockResolvedValue(true);
    mockRequestAccess.mockRejectedValue(new Error("User declined access"));
    const result = await connectWallet();
    expect(result).toEqual({ publicKey: null, error: "Connection rejected." });
  });
});

describe("getConnectedPublicKey", () => {
  it("supports the bare-boolean/bare-string shapes", async () => {
    mockIsAllowed.mockResolvedValue(true);
    mockGetPublicKey.mockResolvedValue("GABCDEF");
    expect(await getConnectedPublicKey()).toBe("GABCDEF");
  });

  it("supports the object shapes", async () => {
    mockIsAllowed.mockResolvedValue({ isAllowed: true });
    mockGetPublicKey.mockResolvedValue({ address: "GZYXWV" });
    expect(await getConnectedPublicKey()).toBe("GZYXWV");
  });

  it("returns null without calling getPublicKey when not allowed", async () => {
    mockIsAllowed.mockResolvedValue(false);
    expect(await getConnectedPublicKey()).toBeNull();
    expect(mockGetPublicKey).not.toHaveBeenCalled();
  });

  it("returns null rather than throwing on an unexpected shape", async () => {
    mockIsAllowed.mockResolvedValue({ nonsense: true });
    expect(await getConnectedPublicKey()).toBeNull();
  });
});

describe("signTransactionWithWallet", () => {
  it("supports the bare-string shape", async () => {
    mockSignTransaction.mockResolvedValue("signed-xdr");
    const result = await signTransactionWithWallet("xdr");
    expect(result).toEqual({ signedXDR: "signed-xdr", error: null });
  });

  it("supports the { signedTransaction } object shape", async () => {
    mockSignTransaction.mockResolvedValue({ signedTransaction: "signed-xdr" });
    const result = await signTransactionWithWallet("xdr");
    expect(result).toEqual({ signedXDR: "signed-xdr", error: null });
  });

  it("surfaces a clear error instead of a silent null on an unexpected shape", async () => {
    mockSignTransaction.mockResolvedValue({ nonsense: "value" });
    const result = await signTransactionWithWallet("xdr");
    expect(result.signedXDR).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it("marks a user decline as rejected rather than a hard error", async () => {
    mockSignTransaction.mockRejectedValue(new Error("User declined access"));
    const result = await signTransactionWithWallet("xdr");
    expect(result).toEqual({ signedXDR: null, error: "Transaction rejected.", rejected: true });
  });
});
