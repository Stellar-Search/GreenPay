/**
 * components/__tests__/TradeoffNotice.test.tsx
 *
 * The acceptance criterion this component owns is "what the donor is trading
 * off is stated plainly before they commit, not afterwards", so the tests are
 * about ordering and about the gate, not about styling.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import TradeoffNotice from "../TradeoffNotice";

const KEEP = ["You keep your donation history."];
const GIVE_UP = ["GreenPay cannot recover your key.", "Clearing browser data loses it."];

function renderNotice(props: Partial<React.ComponentProps<typeof TradeoffNotice>> = {}) {
  const onAcknowledge = jest.fn();
  render(
    <TradeoffNotice
      title="What you get, and what you are giving up"
      keep={KEEP}
      giveUp={GIVE_UP}
      onAcknowledge={onAcknowledge}
      {...props}
    />,
  );
  return { onAcknowledge };
}

describe("TradeoffNotice", () => {
  it("shows what the donor gives up above what they keep", () => {
    // Benefits first with caveats in grey below is exactly how a donor ends up
    // surprised later, which is the outcome this component exists to prevent.
    renderNotice();
    const giveUp = screen.getByTestId("tradeoff-giveup");
    const keep = screen.getByTestId("tradeoff-keep");
    expect(giveUp.compareDocumentPosition(keep) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders every give-up line", () => {
    renderNotice();
    for (const line of GIVE_UP) {
      expect(screen.getByText(line)).toBeInTheDocument();
    }
  });

  it("keeps the continue button disabled until the donor acknowledges", () => {
    renderNotice();
    expect(screen.getByTestId("tradeoff-continue")).toBeDisabled();
  });

  it("enables it only after the checkbox is ticked", () => {
    const { onAcknowledge } = renderNotice();
    fireEvent.click(screen.getByTestId("tradeoff-acknowledge"));
    const button = screen.getByTestId("tradeoff-continue");
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
  });

  it("does not proceed on the checkbox alone", () => {
    const { onAcknowledge } = renderNotice();
    fireEvent.click(screen.getByTestId("tradeoff-acknowledge"));
    expect(onAcknowledge).not.toHaveBeenCalled();
  });

  it("uses a real checkbox rather than 'by continuing you agree'", () => {
    renderNotice();
    expect(screen.getByTestId("tradeoff-acknowledge")).toHaveAttribute("type", "checkbox");
  });

  it("names the unrecoverable key in the acknowledgement itself", () => {
    renderNotice();
    expect(screen.getByText(/cannot recover my key/i)).toBeInTheDocument();
  });

  it("shows the cost with its explanation when one is given", () => {
    renderNotice({
      cost: { label: "GreenPay locks", value: "1.0000000 XLM", note: "It is a reserve, not a gift." },
    });
    expect(screen.getByText("1.0000000 XLM")).toBeInTheDocument();
    expect(screen.getByText(/reserve, not a gift/i)).toBeInTheDocument();
  });

  it("shows mitigations when there is something the donor can do", () => {
    renderNotice({ mitigation: ["Export your key now."] });
    expect(screen.getByText("Export your key now.")).toBeInTheDocument();
  });

  it("offers a way back when a cancel handler is given", () => {
    const onCancel = jest.fn();
    renderNotice({ onCancel });
    fireEvent.click(screen.getByTestId("tradeoff-cancel"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("omits the back button when there is nowhere to go back to", () => {
    renderNotice();
    expect(screen.queryByTestId("tradeoff-cancel")).not.toBeInTheDocument();
  });
});
