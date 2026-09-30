/**
 * components/__tests__/FirstDonationPaths.test.tsx
 */
import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import FirstDonationPaths from "../FirstDonationPaths";
import * as onboarding from "@/lib/onboarding";

jest.mock("@/lib/onboarding", () => ({
  fetchOnboardingPaths: jest.fn(),
  assessDonorSituation: jest.fn(),
}));

jest.mock("@/lib/funnel", () => ({
  track: jest.fn(),
  getSessionId: jest.fn().mockResolvedValue("44444444-4444-4444-8444-444444444444"),
}));

const fetchOnboardingPaths = onboarding.fetchOnboardingPaths as jest.MockedFunction<
  typeof onboarding.fetchOnboardingPaths
>;
const assessDonorSituation = onboarding.assessDonorSituation as jest.MockedFunction<
  typeof onboarding.assessDonorSituation
>;

const PATHS = {
  guarantee: "GreenPay never holds your key and never holds your money.",
  paths: [
    {
      id: "connected_wallet" as const,
      title: "I already have a Stellar wallet",
      available: true,
      unchanged: true,
      requires: ["A wallet extension"],
      tradeoffs: { keep: ["Full control."], giveUp: [] },
    },
    {
      id: "sponsored_account" as const,
      title: "I have XLM coming, but no Stellar account yet",
      available: true,
      requires: ["A few seconds"],
      limits: { maxDonationXlm: 250, maxLifetimeXlm: 1000 },
      tradeoffs: { keep: [], giveUp: ["Your key lives in this browser only."] },
    },
    {
      id: "onramp" as const,
      title: "I have no wallet and no XLM",
      available: false,
      unavailableReason: "No fiat on-ramp provider is configured for this deployment.",
      tradeoffs: { keep: [], giveUp: [] },
    },
  ],
};

function situation(recommendedPath: onboarding.OnboardingPathId, reason = "because") {
  return {
    walletDetected: false,
    address: null,
    readiness: "missing" as const,
    spendableXlm: "0.0000000",
    recommendedPath,
    reason,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  fetchOnboardingPaths.mockResolvedValue(PATHS);
  assessDonorSituation.mockResolvedValue(situation("sponsored_account"));
});

describe("FirstDonationPaths", () => {
  it("explains the donor's actual situation rather than asking them to diagnose it", async () => {
    assessDonorSituation.mockResolvedValue(
      situation("sponsored_account", "This address isn't a Stellar account yet."),
    );
    render(<FirstDonationPaths walletDetected={false} onAccountReady={jest.fn()} />);

    await waitFor(() =>
      expect(screen.getByTestId("donor-situation")).toHaveTextContent(
        /isn't a Stellar account yet/i,
      ),
    );
  });

  it("marks the recommended path without hiding the others", async () => {
    render(<FirstDonationPaths walletDetected={false} onAccountReady={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId("path-option-sponsored_account")).toBeInTheDocument());

    expect(screen.getByText("Suggested")).toBeInTheDocument();
    expect(screen.getByTestId("path-option-connected_wallet")).toBeInTheDocument();
  });

  it("puts each path's headline cost on the choice itself", async () => {
    // A donor should not have to open a path to find out what it costs them.
    render(<FirstDonationPaths walletDetected={false} onAccountReady={jest.fn()} />);
    await waitFor(() =>
      expect(screen.getByText(/Your key lives in this browser only/i)).toBeInTheDocument(),
    );
  });

  it("shows the donation cap on the sponsored option", async () => {
    render(<FirstDonationPaths walletDetected={false} onAccountReady={jest.fn()} />);
    await waitFor(() => expect(screen.getByText(/Up to 250 XLM per donation/i)).toBeInTheDocument());
  });

  it("disables an unavailable path and says why, rather than offering a dead end", async () => {
    render(<FirstDonationPaths walletDetected={false} onAccountReady={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId("path-option-onramp")).toBeDisabled());
    expect(screen.getByText(/No fiat on-ramp provider is configured/i)).toBeInTheDocument();
  });

  it("restates the non-custodial guarantee", async () => {
    render(<FirstDonationPaths walletDetected={false} onAccountReady={jest.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId("onboarding-guarantee")).toHaveTextContent(/never holds your key/i),
    );
  });

  it("hands a donor who picks the wallet path straight back", async () => {
    const onUseWallet = jest.fn();
    render(
      <FirstDonationPaths walletDetected onAccountReady={jest.fn()} onUseWallet={onUseWallet} />,
    );
    await waitFor(() => expect(screen.getByTestId("path-option-connected_wallet")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("path-option-connected_wallet"));
    expect(onUseWallet).toHaveBeenCalled();
  });

  it("opens the sponsored flow's disclosure when that path is chosen", async () => {
    render(<FirstDonationPaths walletDetected={false} onAccountReady={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId("path-option-sponsored_account")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("path-option-sponsored_account"));
    expect(screen.getByTestId("tradeoff-notice")).toBeInTheDocument();
  });

  it("keeps the wallet route reachable when the paths request fails", async () => {
    // An API outage must not blank the screen for a donor who could have
    // donated with the wallet they already have.
    fetchOnboardingPaths.mockRejectedValue(new Error("down"));
    render(<FirstDonationPaths walletDetected onAccountReady={jest.fn()} />);

    await waitFor(() =>
      expect(screen.getByText(/Connect a Stellar wallet to donate/i)).toBeInTheDocument(),
    );
  });
});
