/**
 * Search bar with autocomplete dropdown for project discovery.
 */
import { useRef, useEffect, useCallback } from "react";
import clsx from "clsx";
import { CATEGORY_ICONS } from "@/utils/format";
import type { ClimateProject } from "@/utils/types";

export interface ProjectSearchBarProps {
  search: string;
  onSearchChange: (value: string) => void;
  onSelectProject: (project: ClimateProject) => void;
  autocompleteResults: ClimateProject[];
  isAutocompleteOpen: boolean;
  setIsAutocompleteOpen: (open: boolean) => void;
  activeIndex: number;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  placeholder?: string;
}

export default function ProjectSearchBar({
  search,
  onSearchChange,
  onSelectProject,
  autocompleteResults,
  isAutocompleteOpen,
  setIsAutocompleteOpen,
  activeIndex,
  onKeyDown,
  placeholder = "Search projects by name, location, or keyword...",
}: ProjectSearchBarProps) {
  const searchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setIsAutocompleteOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [setIsAutocompleteOpen]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onSearchChange(e.target.value);
    },
    [onSearchChange],
  );

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      onKeyDown(e);
      if (e.key === "Enter" && activeIndex >= 0 && autocompleteResults[activeIndex]) {
        onSelectProject(autocompleteResults[activeIndex]);
      }
    },
    [onKeyDown, activeIndex, autocompleteResults, onSelectProject],
  );

  return (
    <div className="relative mb-6" ref={searchRef}>
      <span className="absolute start-4 top-1/2 -translate-y-1/2 text-[#547454] z-10">
        🔍
      </span>
      <input
        type="search"
        role="combobox"
        value={search}
        onChange={handleChange}
        onKeyDown={handleInputKeyDown}
        onFocus={() => search.length >= 2 && setIsAutocompleteOpen(true)}
        placeholder={placeholder}
        aria-label="Search climate projects"
        aria-expanded={isAutocompleteOpen}
        aria-controls="project-search-autocomplete"
        aria-activedescendant={
          activeIndex >= 0 ? `project-search-option-${activeIndex}` : undefined
        }
        className="input-field ps-10 relative z-10"
      />

      {isAutocompleteOpen && autocompleteResults.length > 0 && (
        <ul
          id="project-search-autocomplete"
          role="listbox"
          className="absolute top-full start-0 end-0 mt-2 bg-white border border-forest-200 rounded-xl shadow-xl z-50 overflow-hidden animate-fade-in list-none m-0 p-0"
        >
          {autocompleteResults.map((project, index) => (
            <li
              key={project.id}
              id={`project-search-option-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              onClick={() => onSelectProject(project)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  onSelectProject(project);
                }
              }}
              tabIndex={0}
              className={clsx(
                "flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors border-b border-forest-50 last:border-0",
                index === activeIndex ? "bg-forest-100" : "hover:bg-forest-50",
              )}
            >
              <div className="w-8 h-8 rounded-lg bg-forest-100 flex items-center justify-center text-lg flex-shrink-0">
                {CATEGORY_ICONS[project.category] || "🌿"}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-forest-900 truncate">
                  {project.name}
                </p>
                <p className="text-xs text-[#547454] font-body truncate">
                  {project.location} · {project.category}
                </p>
              </div>
              <div className="text-xs font-bold text-forest-500 uppercase tracking-widest opacity-40">
                View →
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
