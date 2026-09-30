import { renderHook, act } from "@testing-library/react";
import { useRouter } from "next/router";
import { useProjectSearch } from "../useProjectSearch";
import { fetchProjects } from "@/lib/api";

jest.mock("next/router", () => ({
  useRouter: jest.fn(),
}));

jest.mock("@/lib/api", () => ({
  fetchProjects: jest.fn(),
}));

const mockFetchProjects = fetchProjects as jest.MockedFunction<typeof fetchProjects>;
const mockUseRouter = useRouter as jest.MockedFunction<typeof useRouter>;

const emptyFacets = {
  category: {},
  status: {},
  verified: {},
  location: {},
  fundingProgress: {},
};

describe("useProjectSearch", () => {
  const push = jest.fn();

  beforeEach(() => {
    jest.useFakeTimers();
    push.mockClear();
    mockUseRouter.mockReturnValue({
      query: { status: "active", category: "Reforestation" },
      push,
    } as unknown as ReturnType<typeof useRouter>);

    mockFetchProjects.mockResolvedValue({
      projects: [],
      meta: { total: 0, search: null, latencyMs: 10, facets: emptyFacets },
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it("debounces fetchProjects when filters change", async () => {
    renderHook(() => useProjectSearch({ debounceMs: 300 }));

    expect(mockFetchProjects).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(300);
    });

    expect(mockFetchProjects).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "Reforestation",
        status: "active",
      }),
    );
  });

  it("setFilter pushes shallow route update", () => {
    const { result } = renderHook(() => useProjectSearch());

    act(() => {
      result.current.setFilter("verified", "true");
    });

    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: "/projects",
        query: expect.objectContaining({ verified: "true" }),
      }),
      undefined,
      { shallow: true },
    );
  });
});
