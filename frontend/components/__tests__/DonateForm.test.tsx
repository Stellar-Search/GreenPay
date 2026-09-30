import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import DonateForm from "../DonateForm";
import * as stellarApi from "@/lib/stellar";
import * as walletApi from "@/lib/wallet";
import * as serverApi from "@/lib/api";
import { renderWithLocale } from "./renderWithLocale";
import type { ClimateProject } from "@/utils/types";

// Mock dependencies
jest.mock("@/lib/stellar", () => ({
  ...jest.requireActual("@/lib/stellar"),
  buildDonationTransaction: jest.fn(),
  submitAndConfirmDonation: jest.fn(),
  getXLMBalance: jest.fn(),
  getAssetBalance: jest.fn(),
}));

jest.mock("@/lib/wallet", () => ({
  signTransactionWithWallet: jest.fn(),
}));

jest.mock("@/lib/api", () => ({
  recordDonation: jest.fn(),
}));

describe("DonateForm", () => {
  const mockProject: ClimateProject = {
    id: "proj-123",
    name: "Test Project",
    walletAddress: "GBX...",
    description: "Test desc",
    co2_per_xlm: 100,
    category: "Reforestation",
    location: "Test Location",
    goalXLM: "1000",
    raisedXLM: "250",
    donorCount: 3,
    co2OffsetKg: 500,
    status: "active",
    verified: true,
    tags: ["test"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const publicKey = "GAX...";

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    (stellarApi.getXLMBalance as jest.Mock).mockResolvedValue("100");
    (stellarApi.getAssetBalance as jest.Mock).mockResolvedValue("50");
  });

  it("handles chain success with backend failure and allows retry", async () => {
    const mockTxHash = "hash-456";
    const mockSignedXDR = "signed-xdr";

    // Setup mocks for initial failure
    (stellarApi.buildDonationTransaction as jest.Mock).mockResolvedValue({ toXDR: () => "xdr" });
    (walletApi.signTransactionWithWallet as jest.Mock).mockResolvedValue({ signedXDR: mockSignedXDR });
    (stellarApi.submitAndConfirmDonation as jest.Mock).mockResolvedValue({ hash: mockTxHash });
    (serverApi.recordDonation as jest.Mock).mockRejectedValueOnce(new Error("500 Internal Server Error"));

    renderWithLocale(<DonateForm project={mockProject} publicKey={publicKey} />);

    // Select amount
    fireEvent.click(screen.getByText("10 XLM"));

    // Click donate
    const donateButton = screen.getByRole("button", { name: /Donate 10/i });
    fireEvent.click(donateButton);

    // Wait for the error state
    await waitFor(() => {
      expect(screen.getByText("We couldn't record this donation")).toBeInTheDocument();
    });

    // The transaction should not have been cleared from local state
    expect(localStorage.getItem("pendingDonationRecord")).toContain(mockTxHash);

    // Retry should only call recordDonation again with the same hash
    (serverApi.recordDonation as jest.Mock).mockResolvedValueOnce({});
    
    const retryButton = screen.getByRole("button", { name: /Retry Recording/i });
    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(screen.getByText("Thank you!")).toBeInTheDocument();
    });

    // Check that we didn't sign or submit again
    expect(stellarApi.buildDonationTransaction).toHaveBeenCalledTimes(1);
    expect(walletApi.signTransactionWithWallet).toHaveBeenCalledTimes(1);
    expect(stellarApi.submitAndConfirmDonation).toHaveBeenCalledTimes(1);

    // Check that recordDonation was called twice (first fail, then succeed)
    expect(serverApi.recordDonation).toHaveBeenCalledTimes(2);
    expect(serverApi.recordDonation).toHaveBeenNthCalledWith(2, expect.objectContaining({
      transactionHash: mockTxHash,
      projectId: mockProject.id,
    }));
    
    // LocalStorage should be cleared
    expect(localStorage.getItem("pendingDonationRecord")).toBeNull();
  });
});
