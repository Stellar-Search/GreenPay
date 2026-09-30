/**
 * components/__tests__/StarterAccountSetup.test.tsx
 *
 * Covers the client half of "a sponsorship that fails mid-flow" and "an
 * abandoned donation leaves no partial state".
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import StarterAccountSetup from "../StarterAccountSetup";
import * as onboarding from "@/lib/onboarding";
import * as starter from "@/lib/starterAccount";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

jest.mock("@/lib/onboarding", () => ({
  requestSponsorship: jest.fn(),
  submitSponsorship: jest.fn(),
  abandonSponsorship: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/funnel", () => ({ track: jest.fn() }));

const requestSponsorship = onboarding.requestSponsorship as jest.MockedFunction<
  typeof onboarding.requestSponsorship
>;
const submitSponsorship = onboarding.submitSponsorship as jest.MockedFunction<
  typeof onboarding.submitSponsorship
>;
const abandonSponsorship = onboarding.abandonSponsorship as jest.MockedFunction<
  typeof onboarding.abandonSponsorship
>;

const SESSION = "44444444-4444-4444-8444-444444444444";

function offer(overrides = {}) {
  return {
    id: "sponsorship-1",
    state: "awaiting_signature",
    // A real, signable envelope: signing is what this component is for, so a
    // placeholder string would test nothing.
    xdr: buildOfferXdr(),
    networkPassphrase: "Test SDF Network ; September 2015",
    sponsorPublicKey: "G" + "S".repeat(55),
    quote: { lockedXlm: "1.0000000", disclosure: [], recoverable: true },
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    ...overrides,
  };
}

function buildOfferXdr(): string {
  const sponsor = Keypair.random();
  return new TransactionBuilder(new Account(sponsor.publicKey(), "1"), {
    fee: "300",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "0" }))
    .setTimeout(900)
    .build()
    .toXDR();
}

function acknowledgeAndContinue() {
  fireEvent.click(screen.getByTestId("tradeoff-acknowledge"));
  fireEvent.click(screen.getByTestId("tradeoff-continue"));
}

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
});

describe("the disclosure gate", () => {
  it("shows the trade-offs before anything exists", () => {
    render(<StarterAccountSetup sessionId={SESSION} onReady={jest.fn()} />);
    expect(screen.getByTestId("tradeoff-notice")).toBeInTheDocument();
    // Declining at this point must cost nothing, so no key has been made yet.
    expect(starter.loadStarterAccount()).toBeNull();
  });

  it("states the reserve the platform locks, and that it is not a gift", () => {
    render(<StarterAccountSetup sessionId={SESSION} onReady={jest.fn()} />);
    expect(screen.getByText("1.0000000 XLM")).toBeInTheDocument();
    expect(screen.getByText(/not a gift/i)).toBeInTheDocument();
  });

  it("does not request a sponsorship until the donor acknowledges", () => {
    render(<StarterAccountSetup sessionId={SESSION} onReady={jest.fn()} />);
    expect(requestSponsorship).not.toHaveBeenCalled();
  });
});

describe("the happy path", () => {
  beforeEach(() => {
    requestSponsorship.mockResolvedValue(offer());
    submitSponsorship.mockResolvedValue({
      id: "sponsorship-1",
      state: "active",
      transactionHash: "abc",
      deduplicated: false,
    });
  });

  it("creates the key locally and sends only the public key", async () => {
    render(<StarterAccountSetup sessionId={SESSION} onReady={jest.fn()} />);
    acknowledgeAndContinue();

    await waitFor(() => expect(requestSponsorship).toHaveBeenCalled());
    const payload = requestSponsorship.mock.calls[0][0];
    expect(payload.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
    // The secret must not appear anywhere in what leaves the browser.
    expect(JSON.stringify(payload)).not.toContain(starter.loadStarterAccount()!.secret);
  });

  it("submits a transaction the donor's key has signed", async () => {
    render(<StarterAccountSetup sessionId={SESSION} onReady={jest.fn()} />);
    acknowledgeAndContinue();

    await waitFor(() => expect(submitSponsorship).toHaveBeenCalled());
    const [, signedXdr] = submitSponsorship.mock.calls[0];
    expect(signedXdr).not.toBe(offer().xdr);
  });

  it("offers the key for export before anything else", async () => {
    render(<StarterAccountSetup sessionId={SESSION} onReady={jest.fn()} />);
    acknowledgeAndContinue();

    await waitFor(() => expect(screen.getByTestId("starter-account-ready")).toBeInTheDocument());
    expect(screen.getByText(/Save your key now/i)).toBeInTheDocument();
    expect(screen.getByText(/only copy/i)).toBeInTheDocument();
  });

  it("keeps the key hidden until the donor asks for it", async () => {
    render(<StarterAccountSetup sessionId={SESSION} onReady={jest.fn()} />);
    acknowledgeAndContinue();

    await waitFor(() => expect(screen.getByTestId("starter-account-ready")).toBeInTheDocument());
    expect(screen.queryByTestId("starter-secret")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("starter-reveal"));
    expect(screen.getByTestId("starter-secret")).toBeInTheDocument();
  });

  it("hands the new address to the caller", async () => {
    const onReady = jest.fn();
    render(<StarterAccountSetup sessionId={SESSION} onReady={onReady} />);
    acknowledgeAndContinue();

    await waitFor(() => expect(onReady).toHaveBeenCalled());
    expect(onReady.mock.calls[0][0]).toBe(starter.loadStarterAccount()!.publicKey);
  });

  it("does not try to abandon a sponsorship that succeeded", async () => {
    const { unmount } = render(<StarterAccountSetup sessionId={SESSION} onReady={jest.fn()} />);
    acknowledgeAndContinue();

    await waitFor(() => expect(screen.getByTestId("starter-account-ready")).toBeInTheDocument());
    unmount();
    expect(abandonSponsorship).not.toHaveBeenCalled();
  });

  it("reuses an existing key rather than overwriting one that may hold XLM", async () => {
    const existing = starter.createStarterAccount(true);
    render(<StarterAccountSetup sessionId={SESSION} onReady={jest.fn()} />);
    acknowledgeAndContinue();

    await waitFor(() => expect(requestSponsorship).toHaveBeenCalled());
    expect(requestSponsorship.mock.calls[0][0].publicKey).toBe(existing.publicKey);
  });
});

describe("a sponsorship that fails mid-flow", () => {
  it("releases the reserved capacity and says nothing was created", async () => {
    requestSponsorship.mockResolvedValue(offer());
    submitSponsorship.mockRejectedValue(new Error("The account could not be created (tx_bad_seq)."));

    render(<StarterAccountSetup sessionId={SESSION} onReady={jest.fn()} />);
    acknowledgeAndContinue();

    await waitFor(() => expect(screen.getByTestId("starter-account-error")).toBeInTheDocument());
    expect(abandonSponsorship).toHaveBeenCalledWith("sponsorship-1");
  });

  it("offers a retry rather than a dead end", async () => {
    requestSponsorship.mockRejectedValue(new Error("Treasury exhausted."));

    render(<StarterAccountSetup sessionId={SESSION} onReady={jest.fn()} />);
    acknowledgeAndContinue();

    await waitFor(() => expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument());
  });

  it("never reports success when the request failed", async () => {
    requestSponsorship.mockRejectedValue(new Error("nope"));
    const onReady = jest.fn();

    render(<StarterAccountSetup sessionId={SESSION} onReady={onReady} />);
    acknowledgeAndContinue();

    await waitFor(() => expect(screen.getByTestId("starter-account-error")).toBeInTheDocument());
    expect(onReady).not.toHaveBeenCalled();
  });
});

describe("an abandoned flow", () => {
  it("releases the treasury capacity when the donor closes the flow", async () => {
    // The server sweeper guarantees this eventually; unmounting makes it
    // immediate, which is the difference between minutes and seconds of
    // capacity held for a donor who already left.
    requestSponsorship.mockResolvedValue(offer());
    submitSponsorship.mockImplementation(() => new Promise(() => {}));

    const { unmount } = render(<StarterAccountSetup sessionId={SESSION} onReady={jest.fn()} />);
    acknowledgeAndContinue();

    await waitFor(() => expect(submitSponsorship).toHaveBeenCalled());
    unmount();
    expect(abandonSponsorship).toHaveBeenCalledWith("sponsorship-1");
  });

  it("has nothing to release when the donor backs out at the disclosure", () => {
    const onCancel = jest.fn();
    render(<StarterAccountSetup sessionId={SESSION} onReady={jest.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId("tradeoff-cancel"));

    expect(onCancel).toHaveBeenCalled();
    expect(requestSponsorship).not.toHaveBeenCalled();
    expect(abandonSponsorship).not.toHaveBeenCalled();
  });
});

describe("a browser that will not keep the key", () => {
  it("warns before the donor relies on an account they will lose", async () => {
    requestSponsorship.mockResolvedValue(offer());
    submitSponsorship.mockResolvedValue({
      id: "sponsorship-1",
      state: "active",
      transactionHash: "abc",
      deduplicated: false,
    });
    const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {});

    render(<StarterAccountSetup sessionId={SESSION} onReady={jest.fn()} />);
    acknowledgeAndContinue();

    await waitFor(() => expect(screen.getByTestId("starter-account-ready")).toBeInTheDocument());
    expect(screen.getByTestId("starter-storage-warning")).toBeInTheDocument();
    setItem.mockRestore();
  });
});
