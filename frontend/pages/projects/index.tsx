/**
 * pages/projects/index.tsx — Browse all climate projects
 */
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter } from "next/router";
import ProjectCard, { ProjectCardSkeleton } from "@/components/ProjectCard";
import ProjectComparison from "@/components/ProjectComparison";
import ProjectSearchBar from "@/components/ProjectSearchBar";
import ProjectSearchFacets from "@/components/ProjectSearchFacets";
import { fetchProjects } from "@/lib/api";
import type { ProjectSearchMeta } from "@/lib/api";
import type { ClimateProject } from "@/utils/types";
import { useAutocomplete } from "@/hooks/useAutocomplete";
import { useI18n } from "@/lib/i18n";

export default function ProjectsPage() {
  const router = useRouter();
  const { t, locale } = useI18n();
  const [projects, setProjects] = useState<ClimateProject[]>([]);
  const [searchMeta, setSearchMeta] = useState<ProjectSearchMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [showComparison, setShowComparison] = useState(false);
  const searchUrlTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    query: search,
    setQuery: setSearch,
    results: autocompleteResults,
    isOpen: isAutocompleteOpen,
    setIsOpen: setIsAutocompleteOpen,
    activeIndex,
    handleKeyDown
  } = useAutocomplete<ClimateProject>(
    async (q) => {
      const { projects: results } = await fetchProjects({ search: q, limit: 5, lang: locale });
      return results;
    }
  );

  const category = (router.query.category as string) || "";
  const status = (router.query.status as string) || "active";
  const verified = (router.query.verified as string) === "true";
  const searchQuery = (router.query.search as string) || "";
  const compareQuery = (router.query.compare as string) || "";

  const selectedProjects = useMemo(
    () => projects.filter((project) => selectedProjectIds.includes(project.id)),
    [projects, selectedProjectIds],
  );

  useEffect(() => {
    if (searchQuery && !search) {
      setSearch(searchQuery);
    }
  }, [searchQuery, search, setSearch]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setLoading(true);
      fetchProjects({
        category: category || undefined,
        status: status || undefined,
        verified: verified || undefined,
        search: search || undefined,
        limit: 50,
        lang: locale,
      })
        .then(({ projects: data, meta }) => {
          setProjects(data);
          setSearchMeta(meta ?? null);
        })
        .catch(console.error)
        .finally(() => setLoading(false));
    }, 300);

    return () => clearTimeout(timer);
  }, [category, status, verified, search, locale]);

  useEffect(() => {
    if (!compareQuery || projects.length === 0) return;
    const ids = compareQuery
      .split(",")
      .map((id) => id.trim())
      .filter((id) => projects.some((project) => project.id === id))
      .slice(0, 3);
    if (ids.length >= 2) {
      setSelectedProjectIds(ids);
      setShowComparison(true);
    }
  }, [compareQuery, projects]);

  const setFilter = useCallback(
    (key: string, val: string) => {
      router.push(
        {
          pathname: "/projects",
          query: { ...router.query, [key]: val || undefined },
        },
        undefined,
        { shallow: true },
      );
    },
    [router],
  );

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearch(value);
      if (searchUrlTimer.current) {
        clearTimeout(searchUrlTimer.current);
      }
      searchUrlTimer.current = setTimeout(() => {
        router.push(
          {
            pathname: "/projects",
            query: { ...router.query, search: value || undefined },
          },
          undefined,
          { shallow: true },
        );
      }, 500);
    },
    [router, setSearch],
  );

  const handleSelectProject = (project: ClimateProject) => {
    setIsAutocompleteOpen(false);
    router.push(`/projects/${project.id}`);
  };

  const toggleSelection = (projectId: string) => {
    setSelectedProjectIds((current) => {
      if (current.includes(projectId)) {
        return current.filter((id) => id !== projectId);
      }
      if (current.length >= 3) {
        return current;
      }
      return [...current, projectId];
    });
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="font-display text-3xl font-bold text-forest-900 mb-1">
            Climate Projects
          </h1>
          <p className="text-[#4b654b] text-sm font-body">
            {loading
              ? "Loading..."
              : searchMeta?.total != null
                ? t("project.verifiedProjectsCount", { count: searchMeta.total })
                : t("project.verifiedProjectsCount", { count: projects.length })}
          </p>
        </div>
      </div>

      <ProjectSearchBar
        search={search}
        onSearchChange={handleSearchChange}
        onSelectProject={handleSelectProject}
        autocompleteResults={autocompleteResults}
        isAutocompleteOpen={isAutocompleteOpen}
        setIsAutocompleteOpen={setIsAutocompleteOpen}
        activeIndex={activeIndex}
        onKeyDown={handleKeyDown}
      />

      <div className="flex gap-6">
        <ProjectSearchFacets
          status={status}
          category={category}
          verified={verified}
          searchMeta={searchMeta}
          projects={projects}
          onFilterChange={setFilter}
        />

        <div className="flex-1">
          {selectedProjectIds.length >= 2 && (
            <div className="mb-4 flex items-center justify-between rounded-xl border border-forest-200 bg-forest-50 px-4 py-3">
              <p className="text-sm text-forest-800 font-body">
                {selectedProjectIds.length} selected for comparison
              </p>
              <button
                type="button"
                onClick={() => setShowComparison(true)}
                className="btn-primary text-sm py-2 px-4"
              >
                Compare selected
              </button>
            </div>
          )}

          {loading ? (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <ProjectCardSkeleton key={i} />
              ))}
            </div>
          ) : projects.length === 0 ? (
            <div className="card text-center py-16">
              <p className="text-4xl mb-3">🌿</p>
              <p className="font-display text-xl text-forest-900 mb-2">
                {search ? `No results for "${search}"` : "No projects found"}
              </p>
              <p className="text-[#4b654b] text-sm font-body">
                {search
                  ? "Try a different search"
                  : "Try adjusting your filters"}
              </p>
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {projects.map((p) => (
                <div key={p.id} className="relative">
                  <label
                    className={`absolute start-3 top-3 z-30 flex items-center gap-2 rounded-md border px-2 py-1 text-xs font-body shadow-sm ${
                      selectedProjectIds.includes(p.id)
                        ? "bg-forest-700 text-white border-forest-700"
                        : "bg-white text-forest-700 border-forest-200"
                    }`}
                    onClick={(e) => {
                      e.stopPropagation();
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedProjectIds.includes(p.id)}
                      onChange={() => toggleSelection(p.id)}
                      disabled={
                        selectedProjectIds.length >= 3 &&
                        !selectedProjectIds.includes(p.id)
                      }
                    />
                    Compare
                  </label>
                  <ProjectCard project={p} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {showComparison && selectedProjects.length >= 2 && (
        <ProjectComparison
          projects={selectedProjects}
          onClose={() => setShowComparison(false)}
        />
      )}
    </div>
  );
}
