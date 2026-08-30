import { screen } from "@testing-library/react";
import ProjectCard, { ProjectCardSkeleton } from "../ProjectCard";
import { renderWithLocale } from "./renderWithLocale";
import type { ClimateProject } from "@/utils/types";

const mockProject: ClimateProject = {
  id: "proj-1",
  name: "Amazon Reforestation Initiative",
  description: "Restoring native tree cover across degraded rainforest land.",
  category: "Reforestation",
  location: "Brazil",
  walletAddress: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST",
  goalXLM: "10000",
  raisedXLM: "2500",
  donorCount: 42,
  co2OffsetKg: 1200,
  co2_per_xlm: 0.48,
  status: "active",
  verified: true,
  onChainVerified: false,
  tags: ["trees", "carbon"],
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-02T00:00:00.000Z",
};

describe("ProjectCard", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("matches snapshot for an active, partially-funded project", () => {
    const { container } = renderWithLocale(<ProjectCard project={mockProject} />);
    expect(container).toMatchSnapshot();
  });

  it("matches snapshot for a fully-funded project", () => {
    const funded: ClimateProject = { ...mockProject, raisedXLM: "10000" };
    const { container } = renderWithLocale(<ProjectCard project={funded} />);
    expect(container).toMatchSnapshot();
  });

  it("matches snapshot for the loading skeleton", () => {
    const { container } = renderWithLocale(<ProjectCardSkeleton />);
    expect(container).toMatchSnapshot();
  });

  it("pluralizes the donor count via ICU (English one/other)", () => {
    const oneDonor: ClimateProject = { ...mockProject, donorCount: 1 };
    renderWithLocale(<ProjectCard project={oneDonor} />);
    expect(screen.getByText("👥 1 donor")).toBeInTheDocument();
  });

  it("uses the plural form for counts other than one", () => {
    renderWithLocale(<ProjectCard project={mockProject} />);
    expect(screen.getByText("👥 42 donors")).toBeInTheDocument();
  });

  describe("RTL (Arabic locale)", () => {
    it("sets document dir to rtl and renders the Arabic 'few' plural category for a 3-donor project", () => {
      const threeDonors: ClimateProject = { ...mockProject, donorCount: 3 };
      renderWithLocale(<ProjectCard project={threeDonors} />, "ar");
      expect(document.documentElement.dir).toBe("rtl");
      // Arabic "few" category (3-10): "٣ متبرعين" — uses Arabic-Indic
      // digits via Intl.NumberFormat under ar-EG, not the English "3".
      expect(screen.getByText("👥 ٣ متبرعين")).toBeInTheDocument();
    });

    it("matches snapshot with RTL layout (logical start/end classes) and Arabic plural donor count", () => {
      const { container } = renderWithLocale(<ProjectCard project={mockProject} />, "ar");
      expect(container).toMatchSnapshot();
    });

    it("isolates Arabic project content as RTL even when the interface is English", () => {
      const arabicProject: ClimateProject = {
        ...mockProject,
        name: "مبادرة إعادة تشجير الأمازون",
        description: "زراعة الأشجار المحلية واستعادة الغابات المتدهورة.",
        category: "إعادة التشجير",
        location: "البرازيل",
        contentLanguage: "ar",
        contentDirection: "rtl",
        sourceLanguage: "en",
        requestedLanguage: "ar",
        machineTranslated: true,
      };
      const { container } = renderWithLocale(<ProjectCard project={arabicProject} />, "en");
      expect(container.querySelector('[lang="ar"][dir="rtl"]')).toBeInTheDocument();
      expect(screen.getByTestId("content-language-notice")).toHaveTextContent("Machine-translated");
    });
  });
});
