/**
 * components/__tests__/OnRampHandoff.test.tsx
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import OnRampHandoff from "../OnRampHandoff";
import * as onboarding from "@/lib/onboarding";

jest.mock("@/lib/onboarding", () => ({ fetchOnrampProviders: jest.fn() }));
jest.mock("@/lib/funnel", () => ({ track: jest.fn() }));

const fetchOnrampProviders = onboarding.fetchOnrampProviders as jest.MockedFunction<
  typeof onboarding.fetchOnrampProviders
>;

const ADDRESS = "G" + "A".repeat(55);

const PROVIDER = {
  id: "sep24-anchor",
  name: "Example Anchor",
  anchorUrl: "https://anchor.example",
  disclosure: {
    providerId: "sep24-anchor",
    providerName: "Example Anchor",
    statements: [
      "You will be handed to Example Anchor to buy XLM. They take the payment, not GreenPay.",
      "They will ask you to verify your identity. GreenPay never sees what you give them.",
      "GreenPay cannot get it back for you if you lose the key.",
    ],
    obligations: { kyc_identity_verification: "provider", fiat_custody: "provider" },
    notes: [],
  },
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("OnRampHandoff", () => {
  it("says who takes the payment before the donor clicks through", async () => {
    fetchOnrampProviders.mockResolvedValue({ providers: [PROVIDER], configured: true });
    render(<OnRampHandoff destinationAddress={ADDRESS} />);

    await waitFor(() => expect(screen.getByTestId("onramp-handoff")).toBeInTheDocument());
    expect(screen.getByText(/They take the payment, not GreenPay/i)).toBeInTheDocument();
    expect(screen.getByText(/GreenPay never sees what you give them/i)).toBeInTheDocument();
  });

  it("links out to the provider", async () => {
    fetchOnrampProviders.mockResolvedValue({ providers: [PROVIDER], configured: true });
    render(<OnRampHandoff destinationAddress={ADDRESS} />);

    await waitFor(() =>
      expect(screen.getByTestId("onramp-continue-sep24-anchor")).toHaveAttribute(
        "href",
        "https://anchor.example",
      ),
    );
  });

  it("shows the address the provider will deliver to, and who holds its key", async () => {
    fetchOnrampProviders.mockResolvedValue({ providers: [PROVIDER], configured: true });
    render(<OnRampHandoff destinationAddress={ADDRESS} />);

    await waitFor(() => expect(screen.getByText(ADDRESS)).toBeInTheDocument());
    expect(screen.getByText(/Only you hold the key/i)).toBeInTheDocument();
  });

  it("gives an honest dead end, with an alternative, when nothing is configured", async () => {
    // A spinner or a button that goes nowhere would be worse than saying so.
    fetchOnrampProviders.mockResolvedValue({ providers: [], configured: false });
    render(<OnRampHandoff destinationAddress={ADDRESS} />);

    await waitFor(() => expect(screen.getByTestId("onramp-unavailable")).toBeInTheDocument());
    expect(screen.getByText(/never takes card payments itself/i)).toBeInTheDocument();
    expect(screen.getByText(ADDRESS)).toBeInTheDocument();
  });

  it("reports a failed lookup rather than pretending nothing is available", async () => {
    fetchOnrampProviders.mockRejectedValue(new Error("down"));
    render(<OnRampHandoff destinationAddress={ADDRESS} />);

    await waitFor(() => expect(screen.getByTestId("onramp-error")).toBeInTheDocument());
  });
});
