import { screen, fireEvent } from "@testing-library/react";
import ProjectSearchFacets from "../ProjectSearchFacets";
import { renderWithLocale } from "./renderWithLocale";
import type { ProjectSearchMeta } from "@/lib/api";
import type { ClimateProject } from "@/utils/types";

const mockProjects: ClimateProject[] = [
  {
    id: "p1",
    name: "Amazon Reforestation",
    description: "Trees",
    category: "Reforestation",
    location: "Brazil",
    walletAddress: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST",
    goalXLM: "1000",
    raisedXLM: "250",
    donorCount: 3,
    co2OffsetKg: 100,
    co2_per_xlm: 0.5,
    status: "active",
    verified: true,
    onChainVerified: false,
    tags: [],
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  },
];

const mockMeta: ProjectSearchMeta = {
  total: 1,
  search: null,
  latencyMs: 45,
  latencyBudgetMs: 150,
  facets: {
    status: { active: 1 },
    category: { Reforestation: 1 },
    verified: { true: 1, false: 0 },
    location: { Brazil: 1 },
    fundingProgress: { under25: 1 },
  },
};

describe("ProjectSearchFacets", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("renders status filters with facet counts", () => {
    renderWithLocale(
      <ProjectSearchFacets
        status="active"
        category=""
        verified={false}
        searchMeta={mockMeta}
        projects={mockProjects}
        onFilterChange={jest.fn()}
      />,
    );
    const activeFilter = screen.getByRole("button", { name: "Active 1" });
    expect(activeFilter).toBeInTheDocument();
  });

  it("calls onFilterChange when category is selected", () => {
    const onFilterChange = jest.fn();
    renderWithLocale(
      <ProjectSearchFacets
        status="active"
        category=""
        verified={false}
        searchMeta={mockMeta}
        projects={mockProjects}
        onFilterChange={onFilterChange}
      />,
    );
    fireEvent.click(screen.getByText(/Reforestation/));
    expect(onFilterChange).toHaveBeenCalledWith("category", "Reforestation");
  });

  it("shows latency within budget in green tone", () => {
    renderWithLocale(
      <ProjectSearchFacets
        status="active"
        category=""
        verified={false}
        searchMeta={mockMeta}
        projects={mockProjects}
        onFilterChange={jest.fn()}
      />,
    );
    expect(screen.getByText(/Search latency: 45ms/)).toBeInTheDocument();
    expect(screen.getByText(/150ms budget/)).toBeInTheDocument();
  });
});
