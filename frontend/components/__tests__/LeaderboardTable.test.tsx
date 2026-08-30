/**
 * components/__tests__/LeaderboardTable.test.tsx
 *
 * Covers the pagination contract the table depends on: the "Load More"
 * affordance must follow the server's cursor and must disappear once the
 * server says there is nothing after the current page.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import LeaderboardTable from "../LeaderboardTable";
import { renderWithLocale } from "./renderWithLocale";
import { fetchLeaderboardWithMeta } from "@/lib/api";

jest.mock("@/lib/api", () => ({
  fetchLeaderboardWithMeta: jest.fn(),
}));

jest.mock("@/lib/priceContext", () => ({
  useXlmPriceInfo: () => ({ xlmUsd: null, lastFetchedAt: null }),
}));

const mockFetch = fetchLeaderboardWithMeta as jest.MockedFunction<
  typeof fetchLeaderboardWithMeta
>;

function entries(from: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    rank: from + i + 1,
    publicKey: `GDONOR${String(from + i).padStart(50, "0")}`,
    displayName: `Donor ${from + i}`,
    totalDonatedXLM: String(1000 - (from + i)),
    projectsSupported: 1,
    topBadge: null,
  })) as never[];
}

describe("LeaderboardTable pagination", () => {
  afterEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
  });

  it("hides Load More on a final page that exactly fills the limit", async () => {
    // The regression this guards: a last page of exactly `limit` rows used to
    // satisfy the old `newEntries.length === limit` heuristic, leaving the
    // button live with nextCursor null. Pressing it re-fetched page one and
    // appended it, duplicating every visible row.
    mockFetch.mockResolvedValueOnce({
      entries: entries(0, 2),
      nextCursor: null,
      hasMore: false,
    });

    renderWithLocale(<LeaderboardTable limit={2} />);

    await waitFor(() => expect(screen.getByText("Donor 0")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
  });

  it("follows the server cursor rather than a row offset when loading more", async () => {
    mockFetch
      .mockResolvedValueOnce({
        entries: entries(0, 2),
        nextCursor: "v1.cursor-from-page-one",
        hasMore: true,
      })
      .mockResolvedValueOnce({
        entries: entries(2, 2),
        nextCursor: null,
        hasMore: false,
      });

    renderWithLocale(<LeaderboardTable limit={2} />);

    await waitFor(() => expect(screen.getByText("Donor 0")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /load more/i }));

    await waitFor(() => expect(screen.getByText("Donor 2")).toBeInTheDocument());

    expect(mockFetch).toHaveBeenNthCalledWith(2, 2, "all", "v1.cursor-from-page-one");

    // Page one's rows are still present exactly once alongside page two's.
    expect(screen.getAllByText("Donor 0")).toHaveLength(1);
    expect(screen.getByText("Donor 3")).toBeInTheDocument();

    // Cursor exhausted, so the affordance is gone.
    expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
  });
});
