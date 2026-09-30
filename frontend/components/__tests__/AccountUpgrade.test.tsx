/**
 * components/__tests__/AccountUpgrade.test.tsx
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AccountUpgrade from "../AccountUpgrade";
import * as onboarding from "@/lib/onboarding";
import * as walletApi from "@/lib/wallet";
import { createStarterAccount, forgetStarterAccount, loadStarterAccount } from "@/lib/starterAccount";
import { Keypair, Networks, Transaction } from "@stellar/stellar-sdk";

jest.mock("@/lib/onboarding", () => ({
  requestUpgradeChallenge: jest.fn(),
  completeUpgrade: jest.fn(),
}));

jest.mock("@/lib/wallet", () => ({
  connectWallet: jest.fn(),
  signTransactionWithWallet: jest.fn(),
}));

const requestUpgradeChallenge = onboarding.requestUpgradeChallenge as jest.MockedFunction<
  typeof onboarding.requestUpgradeChallenge
>;
const completeUpgrade = onboarding.completeUpgrade as jest.MockedFunction<typeof onboarding.completeUpgrade>;
const connectWallet = walletApi.connectWallet as jest.MockedFunction<typeof walletApi.connectWallet>;
const signTransactionWithWallet = walletApi.signTransactionWithWallet as jest.MockedFunction<
  typeof walletApi.signTransactionWithWallet
>;

const WALLET = Keypair.random();
const NONCE = "a".repeat(48);

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  forgetStarterAccount();

  requestUpgradeChallenge.mockResolvedValue({
    upgradeId: "33333333-3333-4333-8333-333333333333",
    nonce: NONCE,
    message: `GreenPay account upgrade\nnonce:${NONCE}`,
    expiresInMs: 600_000,
  });
  connectWallet.mockResolvedValue({ publicKey: WALLET.publicKey(), error: null });
  signTransactionWithWallet.mockImplementation(async (xdr: string) => {
    const tx = new Transaction(xdr, Networks.TESTNET);
    tx.sign(WALLET);
    return { signedXDR: tx.toXDR(), error: null };
  });
  completeUpgrade.mockResolvedValue({
    upgradeId: "33333333-3333-4333-8333-333333333333",
    state: "completed",
    migrated: 3,
    canonicalAddress: WALLET.publicKey(),
  });
});

describe("AccountUpgrade", () => {
  it("renders nothing when there is no starter account to move", () => {
    const { container } = render(<AccountUpgrade />);
    expect(container).toBeEmptyDOMElement();
  });

  it("states what does not move before the donor signs", () => {
    // A donor arrives believing everything moves. Correcting that afterwards
    // is the failure this whole feature is trying to avoid.
    createStarterAccount(true);
    render(<AccountUpgrade />);
    const limitations = screen.getByTestId("upgrade-limitations");
    expect(limitations).toHaveTextContent(/stay recorded on Stellar/i);
    expect(limitations).toHaveTextContent(/leaderboard position/i);
    expect(limitations).toHaveTextContent(/still sitting in the starter account/i);
  });

  it("proves control of both addresses", async () => {
    createStarterAccount(true);
    render(<AccountUpgrade />);
    fireEvent.click(screen.getByTestId("account-upgrade-start"));

    await waitFor(() => expect(completeUpgrade).toHaveBeenCalled());
    const payload = completeUpgrade.mock.calls[0][0];
    // The starter key signs the challenge bytes; the wallet signs the
    // unsubmittable envelope, because it will not sign raw bytes.
    expect(payload.fromSignature).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(payload.toChallengeXdr.length).toBeGreaterThan(0);
  });

  it("has the wallet sign an envelope carrying this migration's nonce", async () => {
    createStarterAccount(true);
    render(<AccountUpgrade />);
    fireEvent.click(screen.getByTestId("account-upgrade-start"));

    await waitFor(() => expect(signTransactionWithWallet).toHaveBeenCalled());
    const tx = new Transaction(signTransactionWithWallet.mock.calls[0][0], Networks.TESTNET);
    const op = tx.operations[0] as { type: string; value: Buffer };
    expect(op.type).toBe("manageData");
    expect(Buffer.from(op.value).toString("utf8")).toBe(NONCE);
    // Unsubmittable, so signing it cannot move anything.
    expect(tx.sequence).toBe("0");
  });

  it("reports how many donations moved", async () => {
    createStarterAccount(true);
    render(<AccountUpgrade />);
    fireEvent.click(screen.getByTestId("account-upgrade-start"));

    await waitFor(() => expect(screen.getByTestId("account-upgrade-done")).toBeInTheDocument());
    expect(screen.getByText(/3 donations/)).toBeInTheDocument();
  });

  it("tells the donor not to delete the old key, which may still hold XLM", async () => {
    createStarterAccount(true);
    render(<AccountUpgrade />);
    fireEvent.click(screen.getByTestId("account-upgrade-start"));

    await waitFor(() => expect(screen.getByTestId("account-upgrade-done")).toBeInTheDocument());
    expect(screen.getByText(/Don't delete your old key yet/i)).toBeInTheDocument();
  });

  it("keeps the starter key after a successful migration", async () => {
    const starter = createStarterAccount(true);
    render(<AccountUpgrade />);
    fireEvent.click(screen.getByTestId("account-upgrade-start"));

    await waitFor(() => expect(screen.getByTestId("account-upgrade-done")).toBeInTheDocument());
    expect(loadStarterAccount()?.secret).toBe(starter.secret);
    expect(loadStarterAccount()?.upgradedTo).toBe(WALLET.publicKey());
  });

  it("refuses to migrate an account onto itself", async () => {
    const starter = createStarterAccount(true);
    connectWallet.mockResolvedValue({ publicKey: starter.publicKey, error: null });

    render(<AccountUpgrade />);
    fireEvent.click(screen.getByTestId("account-upgrade-start"));

    await waitFor(() => expect(screen.getByText(/same account/i)).toBeInTheDocument());
    expect(requestUpgradeChallenge).not.toHaveBeenCalled();
  });

  it("surfaces a wallet that declines to sign", async () => {
    createStarterAccount(true);
    signTransactionWithWallet.mockResolvedValue({ signedXDR: null, error: "Transaction rejected." });

    render(<AccountUpgrade />);
    fireEvent.click(screen.getByTestId("account-upgrade-start"));

    await waitFor(() => expect(screen.getByText("Transaction rejected.")).toBeInTheDocument());
    expect(completeUpgrade).not.toHaveBeenCalled();
  });

  it("surfaces a failure to connect a wallet", async () => {
    createStarterAccount(true);
    connectWallet.mockResolvedValue({ publicKey: null, error: "Freighter not installed." });

    render(<AccountUpgrade />);
    fireEvent.click(screen.getByTestId("account-upgrade-start"));

    await waitFor(() => expect(screen.getByText("Freighter not installed.")).toBeInTheDocument());
  });
});
