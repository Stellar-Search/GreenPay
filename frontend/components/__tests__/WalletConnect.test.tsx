/**
 * components/__tests__/WalletConnect.test.tsx
 *
 * Most of this file is a regression guard rather than a test of new
 * behaviour. "The existing flow for donors who already have a funded wallet is
 * unchanged" is an acceptance criterion, and an untested criterion is a hope.
 */
import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import WalletConnect from "../WalletConnect";
import * as walletApi from "@/lib/wallet";

jest.mock("@/lib/wallet", () => ({
  isFreighterInstalled: jest.fn(),
  connectWallet: jest.fn(),
}));

jest.mock("@/lib/funnel", () => ({
  track: jest.fn(),
  getSessionId: jest.fn().mockResolvedValue(null),
  completeFunnel: jest.fn(),
}));

jest.mock("@/lib/onboarding", () => ({
  fetchOnboardingPaths: jest.fn().mockResolvedValue({
    paths: [
      {
        id: "connected_wallet",
        title: "I already have a Stellar wallet",
        available: true,
        unchanged: true,
        tradeoffs: { keep: [], giveUp: [] },
      },
    ],
    guarantee: "GreenPay never holds your key and never holds your money.",
  }),
  assessDonorSituation: jest.fn().mockResolvedValue({
    walletDetected: false,
    address: null,
    readiness: "missing",
    spendableXlm: "0.0000000",
    recommendedPath: "onramp",
    reason: "You have no wallet yet.",
  }),
}));

const isFreighterInstalled = walletApi.isFreighterInstalled as jest.MockedFunction<
  typeof walletApi.isFreighterInstalled
>;
const connectWallet = walletApi.connectWallet as jest.MockedFunction<typeof walletApi.connectWallet>;

const ADDRESS = "G" + "A".repeat(55);

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
});

describe("the existing flow, unchanged", () => {
  it("renders the same heading and button as before", () => {
    render(<WalletConnect onConnect={jest.fn()} />);
    expect(screen.getByRole("heading", { name: /connect your wallet/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /connect freighter wallet/i })).toBeInTheDocument();
  });

  it("shows the install link, not an onboarding affordance, by default", () => {
    render(<WalletConnect onConnect={jest.fn()} />);
    expect(screen.getByRole("link", { name: /install freighter/i })).toBeInTheDocument();
    expect(screen.queryByTestId("wallet-connect-no-wallet")).not.toBeInTheDocument();
  });

  it("connects and hands the address back", async () => {
    isFreighterInstalled.mockResolvedValue(true);
    connectWallet.mockResolvedValue({ publicKey: ADDRESS, error: null });
    const onConnect = jest.fn();

    render(<WalletConnect onConnect={onConnect} />);
    fireEvent.click(screen.getByRole("button", { name: /connect freighter wallet/i }));

    await waitFor(() => expect(onConnect).toHaveBeenCalledWith(ADDRESS));
  });

  it("surfaces a connection error", async () => {
    isFreighterInstalled.mockResolvedValue(true);
    connectWallet.mockResolvedValue({ publicKey: null, error: "Connection rejected." });

    render(<WalletConnect onConnect={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /connect freighter wallet/i }));

    await waitFor(() => expect(screen.getByText("Connection rejected.")).toBeInTheDocument());
  });

  it("still opens freighter.app when no wallet is installed and onboarding is off", async () => {
    // The pre-change behaviour, preserved exactly for every call site that has
    // not opted in.
    isFreighterInstalled.mockResolvedValue(false);
    const open = jest.spyOn(window, "open").mockImplementation(() => null);

    render(<WalletConnect onConnect={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /connect freighter wallet/i }));

    await waitFor(() => expect(open).toHaveBeenCalledWith("https://freighter.app", "_blank"));
    open.mockRestore();
  });
});

describe("with guided onboarding enabled", () => {
  it("offers a route for a donor with no wallet", () => {
    render(<WalletConnect onConnect={jest.fn()} allowGuidedOnboarding />);
    expect(screen.getByTestId("wallet-connect-no-wallet")).toBeInTheDocument();
  });

  it("shows the paths instead of sending the donor to freighter.app", async () => {
    // This is the funnel blocker being removed: the old branch here was a link
    // out of the product.
    isFreighterInstalled.mockResolvedValue(false);
    const open = jest.spyOn(window, "open").mockImplementation(() => null);

    render(<WalletConnect onConnect={jest.fn()} allowGuidedOnboarding />);
    fireEvent.click(screen.getByRole("button", { name: /connect freighter wallet/i }));

    await waitFor(() => expect(screen.getByTestId("first-donation-paths")).toBeInTheDocument());
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("still connects normally when a wallet is installed", async () => {
    // Enabling the new paths must not change anything for a donor who has one.
    isFreighterInstalled.mockResolvedValue(true);
    connectWallet.mockResolvedValue({ publicKey: ADDRESS, error: null });
    const onConnect = jest.fn();

    render(<WalletConnect onConnect={onConnect} allowGuidedOnboarding />);
    fireEvent.click(screen.getByRole("button", { name: /connect freighter wallet/i }));

    await waitFor(() => expect(onConnect).toHaveBeenCalledWith(ADDRESS));
    expect(screen.queryByTestId("first-donation-paths")).not.toBeInTheDocument();
  });

  it("lets the donor get back to the wallet card", async () => {
    render(<WalletConnect onConnect={jest.fn()} allowGuidedOnboarding />);
    fireEvent.click(screen.getByTestId("wallet-connect-no-wallet"));

    await waitFor(() => expect(screen.getByTestId("first-donation-paths")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("path-option-connected_wallet"));

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /connect your wallet/i })).toBeInTheDocument(),
    );
  });
});
