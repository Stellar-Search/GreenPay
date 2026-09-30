/**
 * Debounced project listing fetch with filter state derived from the router.
 */
import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import { fetchProjects } from "@/lib/api";
import type { ProjectSearchMeta } from "@/lib/api";
import type { ClimateProject } from "@/utils/types";

export interface ProjectSearchFilters {
  category: string;
  status: string;
  verified: boolean;
  search: string;
}

export interface UseProjectSearchOptions {
  debounceMs?: number;
  limit?: number;
}

export interface UseProjectSearchResult {
  projects: ClimateProject[];
  searchMeta: ProjectSearchMeta | null;
  loading: boolean;
  filters: ProjectSearchFilters;
  setFilter: (key: string, value: string) => void;
  setSearchInUrl: (value: string) => void;
}

export function useProjectSearch(
  options: UseProjectSearchOptions = {},
): UseProjectSearchResult {
  const { debounceMs = 300, limit = 50 } = options;
  const router = useRouter();

  const [projects, setProjects] = useState<ClimateProject[]>([]);
  const [searchMeta, setSearchMeta] = useState<ProjectSearchMeta | null>(null);
  const [loading, setLoading] = useState(true);

  const category = (router.query.category as string) || "";
  const status = (router.query.status as string) || "active";
  const verified = (router.query.verified as string) === "true";
  const search = (router.query.search as string) || "";

  const filters: ProjectSearchFilters = {
    category,
    status,
    verified,
    search,
  };

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

  const setSearchInUrl = useCallback(
    (value: string) => {
      router.push(
        {
          pathname: "/projects",
          query: { ...router.query, search: value || undefined },
        },
        undefined,
        { shallow: true },
      );
    },
    [router],
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      setLoading(true);
      fetchProjects({
        category: category || undefined,
        status: status || undefined,
        verified: verified || undefined,
        search: search || undefined,
        limit,
      })
        .then(({ projects: data, meta }) => {
          setProjects(data);
          setSearchMeta(meta ?? null);
        })
        .catch(console.error)
        .finally(() => setLoading(false));
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [category, status, verified, search, debounceMs, limit]);

  return {
    projects,
    searchMeta,
    loading,
    filters,
    setFilter,
    setSearchInUrl,
  };
}
