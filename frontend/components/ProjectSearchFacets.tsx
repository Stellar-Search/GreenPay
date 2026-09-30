/**
 * Sidebar facet filters for the project search listing page.
 */
import clsx from "clsx";
import { PROJECT_CATEGORIES, CATEGORY_ICONS } from "@/utils/format";
import type { ProjectSearchMeta } from "@/lib/api";
import type { ClimateProject } from "@/utils/types";

export interface ProjectSearchFacetsProps {
  status: string;
  category: string;
  verified: boolean;
  searchMeta: ProjectSearchMeta | null;
  projects: ClimateProject[];
  onFilterChange: (key: string, value: string) => void;
}

const STATUS_OPTIONS: ReadonlyArray<[string, string]> = [
  ["active", "Active"],
  ["completed", "Completed"],
  ["", "All"],
];

const FUNDING_LABELS: Record<string, string> = {
  under25: "Under 25%",
  "25to50": "25–50%",
  "50to75": "50–75%",
  over75: "Over 75%",
  funded: "Fully funded",
};

function facetCount(
  meta: ProjectSearchMeta | null,
  projects: ClimateProject[],
  facet: "verified",
  key: string,
): number | undefined {
  if (meta?.facets?.verified?.[key as "true" | "false"] != null) {
    return meta.facets.verified[key as "true" | "false"];
  }
  if (key === "true") {
    return projects.filter((p) => p.verified).length;
  }
  return undefined;
}

export default function ProjectSearchFacets({
  status,
  category,
  verified,
  searchMeta,
  projects,
  onFilterChange,
}: ProjectSearchFacetsProps) {
  const locationEntries = searchMeta?.facets?.location
    ? Object.entries(searchMeta.facets.location).slice(0, 8)
    : [];

  const fundingKeys = searchMeta?.facets?.fundingProgress
    ? Object.keys(searchMeta.facets.fundingProgress)
    : [];

  return (
    <aside className="hidden lg:block w-52 flex-shrink-0 space-y-6">
      <section aria-labelledby="facet-status">
        <p id="facet-status" className="label">
          Status
        </p>
        <div className="space-y-1">
          {STATUS_OPTIONS.map(([val, lab]) => (
            <button
              key={val || "all"}
              type="button"
              onClick={() => onFilterChange("status", val)}
              className={clsx(
                "w-full text-start px-3 py-2 rounded-lg text-sm transition-colors font-body flex items-center justify-between",
                status === val
                  ? "bg-forest-100 text-forest-700 font-semibold"
                  : "text-[#4b654b] hover:bg-forest-50 hover:text-forest-700",
              )}
            >
              {lab}
              {val && searchMeta?.facets?.status?.[val] != null && (
                <span className="text-xs text-[#547454]">
                  {searchMeta.facets.status[val]}
                </span>
              )}
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby="facet-verification">
        <p id="facet-verification" className="label">
          Verification
        </p>
        <button
          type="button"
          onClick={() => onFilterChange("verified", verified ? "" : "true")}
          className={clsx(
            "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors font-body",
            verified
              ? "bg-forest-100 text-forest-700"
              : "text-[#4b654b] hover:bg-forest-50 hover:text-forest-700",
          )}
        >
          <div
            className={clsx(
              "relative w-10 h-6 rounded-full transition-colors",
              verified ? "bg-emerald-600" : "bg-[#d0d0d0]",
            )}
            aria-hidden
          >
            <div
              className={clsx(
                "absolute top-1 w-4 h-4 rounded-full bg-white transition-all",
                verified ? "end-1" : "start-1",
              )}
            />
          </div>
          <span className="flex-1 text-start">
            ✓ Verified only{" "}
            <span className="text-xs text-[#547454]">
              ({facetCount(searchMeta, projects, "verified", "true") ?? "—"})
            </span>
          </span>
        </button>
      </section>

      <section aria-labelledby="facet-category">
        <p id="facet-category" className="label">
          Category
        </p>
        <div className="space-y-1 max-h-48 overflow-y-auto">
          <button
            type="button"
            onClick={() => onFilterChange("category", "")}
            className={clsx(
              "w-full text-start px-3 py-2 rounded-lg text-sm transition-colors font-body",
              !category
                ? "bg-forest-100 text-forest-700 font-semibold"
                : "text-[#4b654b] hover:bg-forest-50",
            )}
          >
            All categories
          </button>
          {PROJECT_CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => onFilterChange("category", cat)}
              className={clsx(
                "w-full text-start px-3 py-2 rounded-lg text-sm transition-colors font-body flex items-center justify-between gap-2",
                category === cat
                  ? "bg-forest-100 text-forest-700 font-semibold"
                  : "text-[#4b654b] hover:bg-forest-50 hover:text-forest-700",
              )}
            >
              <span className="truncate">
                {CATEGORY_ICONS[cat] || "🌿"} {cat}
              </span>
              {searchMeta?.facets?.category?.[cat] != null && (
                <span className="text-xs text-[#547454] shrink-0">
                  {searchMeta.facets.category[cat]}
                </span>
              )}
            </button>
          ))}
        </div>
      </section>

      {locationEntries.length > 0 && (
        <section aria-labelledby="facet-location">
          <p id="facet-location" className="label">
            Location
          </p>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {locationEntries.map(([loc, count]) => (
              <div
                key={loc}
                className="flex items-center justify-between px-3 py-1.5 text-sm text-[#4b654b] font-body"
              >
                <span className="truncate">{loc}</span>
                <span className="text-xs ms-2">{count}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {fundingKeys.length > 0 && (
        <section aria-labelledby="facet-funding">
          <p id="facet-funding" className="label">
            Funding progress
          </p>
          <div className="space-y-1">
            {Object.entries(FUNDING_LABELS).map(([key, label]) =>
              searchMeta?.facets?.fundingProgress?.[key] ? (
                <div
                  key={key}
                  className="flex items-center justify-between px-3 py-1.5 text-sm text-[#4b654b] font-body"
                >
                  <span>{label}</span>
                  <span className="text-xs">
                    {searchMeta.facets.fundingProgress[key]}
                  </span>
                </div>
              ) : null,
            )}
          </div>
        </section>
      )}

      {searchMeta?.latencyMs != null && (
        <section aria-labelledby="facet-latency" className="pt-2 border-t border-forest-100">
          <p id="facet-latency" className="text-xs text-[#547454] font-body">
            Search latency: {searchMeta.latencyMs}ms
            {searchMeta.latencyBudgetMs != null && (
              <span
                className={clsx(
                  "ms-1",
                  searchMeta.latencyMs > searchMeta.latencyBudgetMs
                    ? "text-amber-700"
                    : "text-emerald-700",
                )}
              >
                / {searchMeta.latencyBudgetMs}ms budget
              </span>
            )}
          </p>
        </section>
      )}
    </aside>
  );
}
