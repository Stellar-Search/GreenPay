/**
 * pages/admin/ai-summary-failures.tsx — Operator view of AI summary
 * generation jobs that permanently failed (pg-boss retries exhausted), with
 * a manual retry action. Gated by the platform JWT admin login, not wallet
 * ownership, since this is an operations surface rather than a per-project
 * one.
 */
import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import {
  isAdminAuthenticated,
  fetchAISummaryFailures,
  retryAISummaryFailure,
  type AISummaryJobFailure,
} from "@/lib/api";

export default function AISummaryFailuresPage() {
  const router = useRouter();
  const [failures, setFailures] = useState<AISummaryJobFailure[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const loadFailures = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchAISummaryFailures()
      .then(setFailures)
      .catch((e: unknown) => setError((e as Error).message || "Failed to load failed jobs"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!isAdminAuthenticated()) {
      router.push("/admin/login");
    } else {
      loadFailures();
    }
  }, [router, loadFailures]);

  const handleRetry = async (failureId: string) => {
    setRetryingId(failureId);
    try {
      await retryAISummaryFailure(failureId);
      setFailures((prev) => prev.filter((f) => f.id !== failureId));
    } catch (e: unknown) {
      setError((e as Error).message || "Retry failed");
    } finally {
      setRetryingId(null);
    }
  };

  // Render loading while checking auth
  if (loading && failures.length === 0 && !error) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10">
        <div className="card animate-pulse h-32" />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10 animate-fade-in">
      <div className="mb-8">
        <p className="text-xs tracking-[0.22em] uppercase text-[#547454] font-body">Admin</p>
        <h1 className="font-display text-3xl font-bold text-forest-900 mb-1">
          AI Summary Job Failures
        </h1>
        <p className="text-sm text-[#4b654b] font-body">
          Summary-generation jobs that exhausted retries. Retrying re-queues generation for
          that project.
        </p>
      </div>

      {loading && (
        <div className="card animate-pulse space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-4 bg-forest-100 rounded" />
          ))}
        </div>
      )}

      {error && (
        <div className="card mb-4">
          <p className="text-red-600 font-body">{error}</p>
        </div>
      )}

      {!loading && failures.length === 0 && (
        <div className="card">
          <p className="text-[#4b654b] font-body">No failed summary generation jobs.</p>
        </div>
      )}

      {!loading && failures.length > 0 && (
        <div className="space-y-3">
          {failures.map((f) => (
            <div key={f.id} className="card flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h2 className="font-display font-semibold text-forest-900 truncate">
                    Project {f.projectId}
                  </h2>
                  <span className="badge text-xs flex-shrink-0 bg-red-50 text-red-700 border-red-200">
                    {f.status}
                  </span>
                </div>
                <p className="text-xs text-[#547454] font-body">{f.errorMessage}</p>
                <p className="text-xs text-[#547454] font-body">
                  Failed {new Date(f.createdAt).toLocaleString()}
                </p>
              </div>
              <button
                onClick={() => handleRetry(f.id)}
                disabled={retryingId === f.id}
                className="btn-primary text-sm py-2 px-4 flex-shrink-0 disabled:opacity-50"
              >
                {retryingId === f.id ? "Retrying…" : "Retry"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
