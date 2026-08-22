/**
 * components/LeaderboardTable.tsx
 *
 * Renders paginated leaderboard entries. The initial page size is controlled
 * by the `limit` prop (default 20; the leaderboard page passes 50). Users can
 * load additional pages via the "Load More" button until the backend cap (100)
 * is reached.
 *
 * Render strategy: the flat .map() is safe up to ~100 rows (the current backend
 * cap). Before raising the cap beyond 100, wrap the row list in a virtualized
 * window (e.g. react-window FixedSizeList) to keep DOM node count bounded.
 */
import { useState, useEffect, useCallback } from "react";
import { fetchLeaderboard } from "@/lib/api";
import { formatXLM, formatUSDEquivalent, shortenAddress, badgeEmoji, timeAgo } from "@/utils/format";
import { accountUrl } from "@/lib/stellar";
import { useXlmPriceInfo } from "@/lib/priceContext";
import { useI18n } from "@/lib/i18n";
import type { LeaderboardEntry } from "@/utils/types";

const AVATAR_COLORS = [
  "#227239",
  "#4caf70",
  "#2e7d32",
  "#1b5e20",
  "#1565c0",
  "#6a1b9a",
  "#c62828",
  "#ef6c00",
];

function hashToIndex(input: string, modulo: number) {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash % modulo;
}

function avatarInitials(displayName: string | undefined, publicKey: string) {
  const source = (displayName || publicKey).trim();
  const first = source[0] || "G";
  const second = source[1] || "P";
  return `${first}${second}`.toUpperCase();
}

function Avatar({ publicKey, displayName }: { publicKey: string; displayName?: string }) {
  const bg = AVATAR_COLORS[hashToIndex(publicKey, AVATAR_COLORS.length)];
  return (
    <div
      className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 font-display text-sm"
      style={{ backgroundColor: bg, color: "white" }}
      aria-hidden="true"
      title={displayName || publicKey}
    >
      {avatarInitials(displayName, publicKey)}
    </div>
  );
}

export default function LeaderboardTable({ limit = 20, period = "all" }: { limit?: number; period?: "all" | "month" | "year" }) {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const { xlmUsd, lastFetchedAt } = useXlmPriceInfo();
  const { t, localeTag } = useI18n();

  const loadPage = useCallback(async (offset: number, append: boolean) => {
    try {
      const newEntries = await fetchLeaderboard(limit, period, offset);
      setEntries(prev => append ? [...prev, ...newEntries] : newEntries);
      setHasMore(newEntries.length === limit);
    } catch {
      if (!append) setError("Could not load leaderboard.");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [limit, period]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setEntries([]);
    setHasMore(false);
    loadPage(0, false);
  }, [limit, period, loadPage]);

  const loadMore = async () => {
    setLoadingMore(true);
    await loadPage(entries.length, true);
  };

  if (loading) return (
    <div className="space-y-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="animate-pulse flex items-center gap-4 p-4 rounded-xl bg-forest-50 border border-forest-100">
          <div className="w-8 h-8 rounded-full bg-forest-200" />
          <div className="flex-1 space-y-2">
            <div className="h-3 bg-forest-200 rounded w-1/3" />
            <div className="h-2 bg-forest-100 rounded w-1/4" />
          </div>
          <div className="h-4 bg-forest-200 rounded w-20" />
        </div>
      ))}
    </div>
  );

  if (error) return <p className="text-red-500 text-sm text-center py-6 font-body">{error}</p>;

  if (entries.length === 0) return (
    <div className="text-center py-12">
      <p className="text-3xl mb-3">🌱</p>
      <p className="text-[#4b654b] font-body">No donors yet — be the first!</p>
    </div>
  );

  const medals = ["🥇", "🥈", "🥉"];

  return (
    <div className="space-y-2">
      {entries.map((entry) => (
        <div key={entry.publicKey}
          className="flex items-center gap-4 p-4 rounded-xl bg-white border border-[rgba(34,114,57,0.10)] hover:border-[rgba(34,114,57,0.25)] transition-all">

          {/* Rank */}
          <div className="w-8 text-center flex-shrink-0">
            {entry.rank <= 3
              ? <span className="text-lg">{medals[entry.rank - 1]}</span>
              : <span className="text-sm font-semibold text-[#547454] font-body">#{entry.rank}</span>
            }
          </div>

          {/* Badge */}
          {entry.topBadge && (
            <span className="text-xl flex-shrink-0" title={entry.topBadge}>
              {badgeEmoji(entry.topBadge)}
            </span>
          )}

          {/* Name / address */}
          <div className="flex-1 min-w-0 flex items-center gap-3">
            <Avatar publicKey={entry.publicKey} displayName={entry.displayName} />
            <div className="min-w-0">
              <a
                href={accountUrl(entry.publicKey)}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-forest-900 hover:text-forest-600 transition-colors text-sm font-body block truncate"
              >
                {entry.displayName || shortenAddress(entry.publicKey)}
              </a>
              <p className="text-xs text-[#547454] font-body mt-0.5">
                {t("project.projectsSupportedCount", { count: entry.projectsSupported })}
              </p>
            </div>
          </div>

          {/* Total donated */}
          <div className="text-end flex-shrink-0">
            <p className="font-mono font-semibold text-forest-600 text-sm">
              {formatXLM(entry.totalDonatedXLM, 2, localeTag)}
            </p>
            {formatUSDEquivalent(entry.totalDonatedXLM, xlmUsd, localeTag) && (
              <p 
                className="text-[11px] text-[#547454] font-body"
                title={lastFetchedAt ? `Rate updated ${timeAgo(lastFetchedAt.toISOString())}` : undefined}
              >
                {formatUSDEquivalent(entry.totalDonatedXLM, xlmUsd, localeTag)}
                {lastFetchedAt && " ⓘ"}
              </p>
            )}
            <p className="text-xs text-[#547454] font-body">donated</p>
          </div>
        </div>
      ))}

      {hasMore && !loading && (
        <div className="text-center mt-6">
          {loadingMore ? (
            <div className="animate-pulse h-10 bg-forest-100 rounded-lg" />
          ) : (
            <button onClick={loadMore} className="btn-secondary">
              Load More
            </button>
          )}
        </div>
      )}
    </div>
  );
}
