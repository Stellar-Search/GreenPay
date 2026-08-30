/**
 * pages/projects/[id].tsx — Single project detail + donate
 */
import { useState, useEffect } from "react";
import { useRouter } from "next/router";
import Link from "next/link";
import DonateForm from "@/components/DonateForm";
import { loadStarterAccount } from "@/lib/starterAccount";
import DonationFeed from "@/components/DonationFeed";
import ToastNotification, { type ToastItem } from "@/components/ToastNotification";
import WalletConnect from "@/components/WalletConnect";
import CircularProgress from "@/components/CircularProgress";
import MonthlyGivingSetup from "@/components/MonthlyGivingSetup";
import DescriptionAccordion from "@/components/DescriptionAccordion";
import ImpactClaimCard from "@/components/ImpactClaimCard";
import { createProjectCampaign, fetchImpactProject, fetchProject, fetchProjectMatches, fetchProjectUpdateHistory, fetchProjectUpdates, fetchSubscriberCount, generateProjectSummary, getApiErrorMessage, reportProjectUpdate, subscribeToProject, toggleUpdateLike } from "@/lib/api";
import type { ImpactProjectStats } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import ContentLanguageNotice from "@/components/ContentLanguageNotice";
import { formatXLM, progressPercent, timeAgo, statusClass, statusLabel, CATEGORY_ICONS, copyToClipboard, shortenAddress } from "@/utils/format";
import { buildReportHtml } from "@/utils/buildReportHtml";
import { accountUrl, fetchProjectDiscussion, type ProjectDiscussionMessage } from "@/lib/stellar";
import { markMonthlySubscriptionPaid } from "@/lib/monthlyGiving";
import type {
  ClimateProject,
  Donation,
  ProjectCampaign,
  ProjectUpdate,
  ProjectUpdateHistory,
  ProjectUpdateReportReason,
} from "@/utils/types";
import { useWishlist } from "@/hooks/useWishlist";
import { renderMarkdown } from "@/lib/safeMarkdown";

interface ProjectDetailProps {
  publicKey: string | null;
  onConnect: (pk: string) => void;
}

export default function ProjectDetail({
  publicKey,
  onConnect,
}: ProjectDetailProps) {
  const router = useRouter();
  const { id } = router.query;
  const { t, localeTag, locale } = useI18n();

  const [project, setProject] = useState<ClimateProject | null>(null);
  const [updates, setUpdates] = useState<ProjectUpdate[]>([]);
  const [updateLikes, setUpdateLikes] = useState<Record<string, { liked: boolean; likeCount: number }>>({});
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);
  const [updateHistories, setUpdateHistories] = useState<Record<string, ProjectUpdateHistory>>({});
  const [historyLoadingId, setHistoryLoadingId] = useState<string | null>(null);
  const [reportingUpdateId, setReportingUpdateId] = useState<string | null>(null);
  const [reportReason, setReportReason] = useState<ProjectUpdateReportReason>("fraudulent_claim");
  const [reportDetails, setReportDetails] = useState("");
  const [reportState, setReportState] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [reportError, setReportError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const [shareState, setShareState] = useState<'idle' | 'copied'>('idle');
  const [shareCount, setShareCount] = useState<number>(0);
  const [projectImpact, setProjectImpact] = useState<ImpactProjectStats | null>(null);

  /**
   * Which key signs this donation.
   *
   * Derived from whether the connected address *is* the browser-held starter
   * account rather than from a flag set during onboarding, so it stays correct
   * across a page reload, a second visit, or a donor who has since connected a
   * real wallet — in all of which a remembered flag would be stale and would
   * send the donation to the wrong signer.
   */
  const [donationSigner, setDonationSigner] = useState<"wallet" | "starter">("wallet");

  useEffect(() => {
    const starter = loadStarterAccount();
    setDonationSigner(starter && starter.publicKey === publicKey ? "starter" : "wallet");
  }, [publicKey]);
  const [subState, setSubState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [subError, setSubError] = useState<string | null>(null);
  const [subscriberCount, setSubscriberCount] = useState<number | null>(null);
  const [showMonthlySetup, setShowMonthlySetup] = useState(false);
  const [subEmail, setSubEmail] = useState("");
  const [serverOffset, setServerOffset] = useState(0);
  const [countdownNow, setCountdownNow] = useState(Date.now());
  const [campaignForm, setCampaignForm] = useState({
    title: "",
    goalXLM: "",
    deadline: "",
    description: "",
  });
  const [campaignState, setCampaignState] = useState<
    "idle" | "saving" | "success" | "error"
  >("idle");
  const [campaignError, setCampaignError] = useState<string | null>(null);
  const [discussion, setDiscussion] = useState<ProjectDiscussionMessage[]>([]);
  const [discussionLoading, setDiscussionLoading] = useState(false);
  const [matches, setMatches] = useState<any[]>([]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [aiSummaryState, setAiSummaryState] = useState<"idle" | "loading" | "error">("idle");
  const [aiSummaryError, setAiSummaryError] = useState<string | null>(null);

  const { toggleWishlist, isInWishlist } = useWishlist();
  const prefillAmount =
    typeof router.query.amount === "string" ? router.query.amount : undefined;
  const monthlySubId =
    typeof router.query.monthlySubId === "string"
      ? router.query.monthlySubId
      : null;
  const prefillReplyMemo =
    typeof router.query.replyMemo === "string" ? router.query.replyMemo : undefined;

  useEffect(() => {
    if (!id) return;
    Promise.all([
      fetchProject(id as string, locale),
      fetchProjectUpdates(id as string, locale),
      fetchProjectMatches(id as string),
      fetchImpactProject(id as string).catch(() => null),
    ])
      .then(([p, u, m, impact]) => {
        setProject(p);
        setUpdates(u);
        setMatches(m);
        setProjectImpact(impact);
        if (p.serverNow) {
          setServerOffset(p.serverNow - Date.now());
        }
      })
      .catch(() => router.push("/projects"))
      .finally(() => setLoading(false));
  }, [id, router, locale]);

  useEffect(() => {
    if (!project) return;
    setDiscussionLoading(true);
    fetchProjectDiscussion(project.walletAddress, 50)
      .then(setDiscussion)
      .catch(() => setDiscussion([]))
      .finally(() => setDiscussionLoading(false));
  }, [project]);

  useEffect(() => {
    if (!id) return;
    fetchSubscriberCount(id as string)
      .then(setSubscriberCount)
      .catch(() => null);
  }, [id]);

  useEffect(() => {
    const timer = window.setInterval(() => setCountdownNow(Date.now() + serverOffset), 1000);
    return () => window.clearInterval(timer);
  }, [serverOffset]);

  const handleCopyWallet = async () => {
    if (!project) return;
    const success = await copyToClipboard(project.walletAddress);
    if (success) {
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 2000);
    } else {
      setCopyState("error");
      setTimeout(() => setCopyState("idle"), 2000);
    }
  };

  const handleToggleLike = async (updateId: string) => {
    if (!publicKey) return;
    try {
      const result = await toggleUpdateLike(updateId, publicKey);
      setUpdateLikes((prev) => ({ ...prev, [updateId]: result }));
    } catch {
      // silently fail
    }
  };

  const handleToggleHistory = async (updateId: string) => {
    if (expandedHistoryId === updateId) {
      setExpandedHistoryId(null);
      return;
    }
    setExpandedHistoryId(updateId);
    if (updateHistories[updateId]) return;
    setHistoryLoadingId(updateId);
    try {
      const history = await fetchProjectUpdateHistory(updateId);
      setUpdateHistories((previous) => ({ ...previous, [updateId]: history }));
    } catch {
      setUpdateHistories((previous) => ({
        ...previous,
        [updateId]: { currentRevision: 1, editedAt: null, revisions: [] },
      }));
    } finally {
      setHistoryLoadingId(null);
    }
  };

  const openReportForm = (updateId: string) => {
    setReportingUpdateId(updateId);
    setReportReason("fraudulent_claim");
    setReportDetails("");
    setReportState("idle");
    setReportError(null);
  };

  const handleReportUpdate = async (event: React.FormEvent, updateId: string) => {
    event.preventDefault();
    if (!publicKey) return;
    setReportState("submitting");
    setReportError(null);
    try {
      await reportProjectUpdate({
        updateId,
        donorAddress: publicKey,
        reason: reportReason,
        details: reportDetails.trim() || undefined,
      });
      setReportState("success");
    } catch (error) {
      setReportState("error");
      setReportError(getApiErrorMessage(error, "Report could not be submitted."));
    }
  };

  const incrementShare = () => setShareCount(prev => prev + 1);

  const handleTwitterShare = () => {
    if (!project) return;
    incrementShare();
    const text = `I just donated to ${project.name} on Stellar GreenPay!`;
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(window.location.href)}`, '_blank');
  };

  const handleWhatsappShare = () => {
    if (!project) return;
    incrementShare();
    window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(window.location.href)}`, '_blank');
  };

  const handleCopyLink = async () => {
    if (!project) return;
    incrementShare();

    const shareData = {
      title: `${project.name} - Stellar GreenPay`,
      text: `Support ${project.name} on Stellar GreenPay - ${project.description.slice(0, 100)}...`,
      url: window.location.href,
    };

    // Try Web Share API first (mobile)
    if (
      navigator.share &&
      /mobile|android|iphone|ipad/i.test(navigator.userAgent)
    ) {
      try {
        await navigator.share(shareData);
        return;
      } catch (err) {
        // User cancelled or share failed, fall back to clipboard
        if ((err as Error).name === "AbortError") return;
      }
    }

    // Fallback to clipboard copy
    const success = await copyToClipboard(window.location.href);
    if (success) {
      setShareState("copied");
      setTimeout(() => setShareState("idle"), 2000);
    }
  };

  const handlePrintReport = () => {
    if (!project) return;

    // ── Build the report HTML via the pure buildReportHtml utility ────────────
    //
    // Security architecture (enforced inside buildReportHtml):
    //  1. Every user-controlled field is escaped with escapeHtml() before
    //     interpolation, neutralising stored XSS payloads.
    //  2. The HTML string is delivered via a sandboxed <iframe srcdoc="…">
    //     rather than window.open + document.write:
    //       • "allow-same-origin" absent → null origin → no sessionStorage
    //         access (admin JWT is unreachable even if a script ran).
    //       • "allow-scripts" absent → inline <script> blocks are blocked by
    //         the sandbox as a second layer of defence.
    //       • "allow-modals" present → contentWindow.print() works.
    //  3. Print/Close buttons are on the overlay outside the iframe — always
    //     reachable; no setTimeout race condition.
    const printContent = buildReportHtml({ project, updates });

    // ── Render in a sandboxed srcdoc iframe instead of window.open ───────────
    //
    // A sandboxed iframe with no "allow-same-origin" token runs in a unique
    // null origin — it cannot access the parent's sessionStorage (which holds
    // the admin JWT) even if a script somehow reached execution.  Omitting
    // "allow-scripts" provides a second layer: inline script blocks that
    // survive HTML escaping are still blocked by the sandbox policy.
    //
    // The overlay is added to the current document; the user clicks "Print"
    // (which calls iframe.contentWindow.print()) or "Close" to remove it.
    // This replaces the setTimeout race that could crash if the popup was
    // closed before 250 ms elapsed.
    const overlay = document.createElement("div");
    overlay.setAttribute("data-print-overlay", "true");
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:9999",
      "background:rgba(0,0,0,0.7)",
      "display:flex",
      "flex-direction:column",
      "align-items:center",
      "justify-content:center",
      "gap:12px",
    ].join(";");

    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-modals allow-same-origin");
    // allow-same-origin is needed only so contentWindow.print() works.
    // Scripts are still blocked because "allow-scripts" is absent.
    iframe.style.cssText =
      "width:860px;max-width:95vw;height:80vh;border:none;border-radius:8px;background:white;";
    iframe.srcdoc = printContent;

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:12px;";

    const printBtn = document.createElement("button");
    printBtn.textContent = "🖨 Print";
    printBtn.style.cssText =
      "padding:10px 24px;background:#227239;color:white;border:none;border-radius:6px;font-size:15px;cursor:pointer;font-weight:600;";
    printBtn.addEventListener("click", () => {
      iframe.contentWindow?.print();
    });

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕ Close";
    closeBtn.style.cssText =
      "padding:10px 24px;background:#fff;color:#1a2e1a;border:2px solid #c8dfc8;border-radius:6px;font-size:15px;cursor:pointer;font-weight:600;";
    closeBtn.addEventListener("click", () => {
      document.body.removeChild(overlay);
    });

    btnRow.appendChild(printBtn);
    btnRow.appendChild(closeBtn);
    overlay.appendChild(iframe);
    overlay.appendChild(btnRow);
    document.body.appendChild(overlay);
  };

  const handleSubscribe = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!project || !subEmail) return;
    setSubState("loading");
    setSubError(null);
    try {
      await subscribeToProject({
        projectId: project.id,
        email: subEmail,
        donorAddress: publicKey || undefined,
        preferredLanguage: locale,
      });
      setSubState("success");
      setSubEmail("");
      setSubscriberCount((c) => (c !== null ? c + 1 : null));
    } catch (err: unknown) {
      setSubError(getApiErrorMessage(err, "Could not subscribe. Try again."));
      setSubState("error");
    }
  };

  const handleCreateCampaign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!project) return;
    setCampaignState("saving");
    setCampaignError(null);
    try {
      await createProjectCampaign(project.id, campaignForm);
      const updatedProject = await fetchProject(project.id, locale);
      setProject(updatedProject);
      setCampaignForm({
        title: "",
        goalXLM: "",
        deadline: "",
        description: "",
      });
      setCampaignState("success");
      window.setTimeout(() => setCampaignState("idle"), 2000);
    } catch (err: unknown) {
      setCampaignError(getApiErrorMessage(err, "Could not create campaign."));
      setCampaignState("error");
    }
  };

  if (loading || !project)
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10 animate-pulse">
        <div className="h-8 bg-forest-200 rounded w-2/3 mb-4" />
        <div className="card space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-4 bg-forest-100 rounded" />
          ))}
        </div>
      </div>
    );

  const pct = progressPercent(project.raisedXLM, project.goalXLM);
  const isComplete = pct >= 100;
  const campaigns = project.campaigns || [];
  const activeCampaign =
    project.activeCampaign ||
    campaigns.find((campaign) => campaign.active) ||
    null;
  const completedCampaigns = campaigns.filter((campaign) => campaign.completed);

  const countdownText = activeCampaign
    ? formatCountdown(activeCampaign.deadline, countdownNow)
    : null;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10 pb-24 sm:pb-10 animate-fade-in">
      <ToastNotification
        toasts={toasts}
        onDismiss={(toastId) => setToasts((prev) => prev.filter((t) => t.id !== toastId))}
      />
      {isComplete && (
        <div className="celebration-overlay">
          {Array.from({ length: 50 }).map((_, i) => (
            <div
              key={i}
              className={
                i % 2 === 0 ? "celebration-leaf" : "celebration-confetti"
              }
              style={{
                left: `${Math.random() * 100}%`,
                animationDelay: `${Math.random() * 3}s`,
                animationDuration: `${3 + Math.random() * 2}s`,
              }}
            />
          ))}
        </div>
      )}

      <Link
        href="/projects"
        className="inline-flex items-center gap-1 text-sm text-[#4b654b] hover:text-forest-700 transition-colors mb-6 font-body"
      >
        ← Back to Projects
      </Link>

      {/* Celebration Banner */}
      {isComplete && (
        <div className="celebration-banner mb-6 bg-gradient-to-r from-emerald-500 via-green-500 to-teal-500 text-white rounded-2xl p-8 text-center shadow-2xl border-4 border-white relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-white/10 to-transparent pointer-events-none" />
          <div className="relative z-10">
            <div className="text-6xl mb-4 animate-bounce">🎉</div>
            <h2 className="font-display text-3xl sm:text-4xl font-bold mb-3">
              Fully Funded!
            </h2>
            <p className="text-lg sm:text-xl text-white/90 max-w-2xl mx-auto font-body">
              This project has reached its funding goal! Thank you to all{" "}
              {t("project.donorsCount", { count: project.donorCount })} who made this
              possible.
            </p>
            <div className="mt-6 inline-flex items-center gap-2 bg-white/20 backdrop-blur-sm px-6 py-3 rounded-full border border-white/30">
              <span className="text-2xl">✅</span>
              <span className="font-semibold text-lg">
                {formatXLM(project.raisedXLM, 2, localeTag)} raised of{" "}
                {formatXLM(project.goalXLM, 2, localeTag)} goal
              </span>
            </div>
          </div>
        </div>
      )}

      {activeCampaign && (
        <div className="card mb-6 border-amber-200 bg-gradient-to-r from-amber-50 to-orange-50">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-widest font-bold text-amber-700 font-body mb-1">
                Active Campaign
              </p>
              <h2 className="font-display text-xl font-semibold text-amber-900">
                {activeCampaign.title}
              </h2>
              {activeCampaign.description && (
                <p className="text-sm text-amber-800 font-body mt-1">
                  {activeCampaign.description}
                </p>
              )}
            </div>
            <p className="text-xs px-3 py-1 rounded-full bg-amber-100 border border-amber-200 text-amber-800 font-body">
              Ends in {countdownText}
            </p>
          </div>
          <div className="mt-4">
            <div className="flex justify-between text-xs mb-1 font-body text-amber-800">
              <span>{formatXLM(activeCampaign.raisedXLM, 2, localeTag)} raised</span>
              <span>
                {activeCampaign.progressPercent}% of{" "}
                {formatXLM(activeCampaign.goalXLM, 2, localeTag)}
              </span>
            </div>
            <div className="progress-bar h-2.5">
              <div
                className="progress-fill"
                style={{
                  width: `${Math.min(activeCampaign.progressPercent, 100)}%`,
                }}
              />
            </div>
          </div>
        </div>
      )}

      {matches.length > 0 && (
        <div className="card mb-6 border-green-200 bg-gradient-to-r from-green-50 to-emerald-50">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-widest font-bold text-green-700 font-body mb-1">
                Donation Matching Active
              </p>
              <h2 className="font-display text-xl font-semibold text-green-900">
                Your donation will be matched up to {matches[0].multiplier}x!
              </h2>
              <p className="text-sm text-green-800 font-body mt-2">
                Remaining capacity: {formatXLM(matches[0].remainingXLM, 2, localeTag)}
              </p>
            </div>
            <p className="text-xs px-3 py-1 rounded-full bg-green-100 border border-green-200 text-green-800 font-body">
              {new Date(matches[0].expiresAt).toLocaleDateString()}
            </p>
          </div>
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-6">
        {/* ── Main content ────────────────────────────────────────────── */}
        <div className="lg:col-span-2 space-y-6">
          {/* Header card */}
          <div className="card">
            <div className="flex items-start gap-4 mb-5">
              <div className="w-14 h-14 rounded-2xl bg-forest-100 flex items-center justify-center text-3xl border border-forest-200 flex-shrink-0">
                {CATEGORY_ICONS[(project.sourceCategory || project.category) as keyof typeof CATEGORY_ICONS] || "🌿"}
              </div>
              <div className="flex-1">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  {isComplete ? (
                    <span className="badge text-xs px-3 py-1.5 rounded-full bg-gradient-to-r from-green-500 to-emerald-600 text-white border-2 border-white shadow-lg font-body font-bold animate-pulse">
                      ✅ Fully Funded
                    </span>
                  ) : (
                    <span className={statusClass(project.status)}>
                      {statusLabel(project.status)}
                    </span>
                  )}
                  {project.onChainVerified ? (
                    <span className="badge-verified text-xs px-2.5 py-1 rounded-full bg-forest-100 text-forest-800 border border-forest-300 font-body font-bold shadow-sm">
                      On-chain verified ✓
                    </span>
                  ) : project.verified ? (
                    <span className="badge-verified text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200 font-body">
                      ✓ Verified
                    </span>
                  ) : null}
                  <span className="text-xs text-[#547454] bg-forest-50 px-2.5 py-1 rounded-full border border-forest-100 font-body">
                    {project.category}
                  </span>
                  <button
                    onClick={handleCopyLink}
                    className="btn-secondary text-xs py-1 px-3 ms-auto"
                    title="Share this project"
                  >
                    {shareState === "copied" ? "✓ Link copied!" : "Share 🌍"}
                  </button>
                  <button
                    onClick={() => toggleWishlist(project.id)}
                    className={`p-2 rounded-lg border transition-all duration-300 transform active:scale-90 
                      ${
                        isInWishlist(project.id)
                          ? "bg-red-50 text-red-500 border-red-200"
                          : "bg-forest-50 text-forest-300 border-forest-200 hover:text-red-400 hover:border-red-200"
                      }`}
                    title={
                      isInWishlist(project.id)
                        ? "Remove from wishlist"
                        : "Add to wishlist"
                    }
                  >
                    <svg
                      className={`w-5 h-5 ${isInWishlist(project.id) ? "fill-current" : "fill-none"}`}
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
                      />
                    </svg>
                  </button>
                </div>
                <div dir={project.contentDirection} lang={project.contentLanguage} className="text-start">
                  <h1 className="font-display text-2xl sm:text-3xl font-bold text-forest-900">
                    {project.name}
                  </h1>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1">
                  <p className="text-[#4b654b] text-sm font-body">
                    📍 {project.location}
                  </p>
                  {(project.averageRating || 0) > 0 && (
                    <div className="flex items-center gap-1">
                      <span className="text-amber-400 text-sm">★</span>
                      <span className="text-forest-900 text-sm font-bold">{project.averageRating?.toFixed(1)}</span>
                      <span className="text-[#547454] text-xs">({project.ratingCount} reviews)</span>
                    </div>
                  )}
                </div>
                </div>
                <div className="mt-2"><ContentLanguageNotice content={project} /></div>
              </div>
            </div>

            {/* Progress */}
            <div className="mb-5">
              {isComplete ? (
                <div className="bg-gradient-to-r from-green-500 to-emerald-600 text-white px-5 py-4 rounded-xl text-center font-semibold text-lg shadow-lg">
                  🎉 Goal Reached!
                </div>
              ) : (
                <div className="flex items-center gap-5">
                  <CircularProgress percentage={pct} size={64} strokeWidth={6} />
                  <div className="flex-1">
                    <p className="font-semibold text-forest-800 text-lg">{formatXLM(project.raisedXLM, 2, localeTag)} raised</p>
                    <p className="text-[#4b654b] text-sm font-body mt-0.5">towards {formatXLM(project.goalXLM, 2, localeTag)} goal</p>
                  </div>
                </div>
              )}
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                {
                  icon: "👥",
                  label: "Donors",
                  value: project.donorCount.toString(),
                },
                {
                  icon: "📋",
                  label: "Outcome Claims",
                  value: `${projectImpact?.claimSummary.total ?? 0} (${projectImpact?.claimSummary.verified ?? 0} verified)`,
                },
                {
                  icon: "🎯",
                  label: "Goal",
                  value: formatXLM(project.goalXLM, 2, localeTag),
                },
              ].map((s) => (
                <div key={s.label} className="stat-card text-center">
                  <p className="text-lg mb-1">{s.icon}</p>
                  <div className="flex items-center justify-center gap-1 mb-1">
                    <p className="font-semibold text-forest-900 text-sm font-body">
                      {s.value}
                    </p>
                  </div>
                  <p className="text-xs text-[#547454] font-body">{s.label}</p>
                </div>
              ))}
            </div>

            <section className="mt-5 border-t border-forest-100 pt-5">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <h2 className="font-display text-xl font-bold text-forest-900">Measured outcome claims</h2>
                  <p className="mt-1 text-xs text-forest-600">
                    Project-level evidence records; they are never calculated from your donation amount.
                  </p>
                </div>
                {projectImpact && (
                  <p className="text-xs font-semibold text-forest-700">
                    {projectImpact.claimSummary.operatorStated} operator-stated · {projectImpact.claimSummary.unverified} unverified · {projectImpact.claimSummary.revoked} withdrawn
                  </p>
                )}
              </div>
              {projectImpact === null ? (
                <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                  Outcome claim records are temporarily unavailable. No environmental quantity is inferred from the donation data.
                </p>
              ) : projectImpact.claims.length ? (
                <div className="mt-4 space-y-4">
                  {projectImpact.claims.map((claim) => (
                    <ImpactClaimCard key={claim.id} claim={claim} locale={localeTag} />
                  ))}
                </div>
              ) : (
                <p className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                  No measured outcome claim has been published for this project. The donation destination and amount remain verifiable on-chain.
                </p>
              )}
            </section>

            {/* Wallet link */}
            <div className="mt-4 pt-4 border-t border-forest-100 flex items-center gap-2 text-xs text-[#547454] font-body">
              <span>Project wallet:</span>
              <a
                href={accountUrl(project.walletAddress)}
                target="_blank"
                rel="noopener noreferrer"
                className="address-tag hover:border-forest-300 transition-colors"
              >
                {project.walletAddress.slice(0, 8)}...
                {project.walletAddress.slice(-6)} ↗
              </a>
              <button
                onClick={handleCopyWallet}
                className="ms-1 p-1.5 rounded hover:bg-forest-100 transition-colors focus:outline-none focus:ring-2 focus:ring-forest-300"
                title="Copy wallet address"
                aria-label="Copy wallet address to clipboard"
              >
                {copyState === "copied" ? (
                  <span className="flex items-center gap-1 text-green-600 font-semibold">
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                    Copied!
                  </span>
                ) : copyState === "error" ? (
                  <span className="flex items-center gap-1 text-red-600 text-xs">
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </span>
                ) : (
                  <svg
                    className="w-4 h-4 text-[#547454] hover:text-forest-700"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                    />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* AI-generated impact summary — sits above the full description so
              donors can decide in <30s whether to read more. The owner sees a
              Refresh button; everyone sees the disclaimer. */}
          {(project.aiSummary || (publicKey && publicKey === project.walletAddress)) && (
            <div className="card border-l-4 border-forest-500 bg-forest-50/40">
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-lg" aria-hidden="true">✨</span>
                  <h2 className="font-display text-base font-semibold text-forest-900">
                    Impact at a glance
                  </h2>
                  <span className="text-[10px] uppercase tracking-wider font-bold bg-forest-200 text-forest-800 px-2 py-0.5 rounded-full">
                    AI Generated
                  </span>
                </div>
                {publicKey && publicKey === project.walletAddress && (
                  <button
                    onClick={async () => {
                      if (aiSummaryState === "loading") return;
                      setAiSummaryState("loading");
                      setAiSummaryError(null);
                      try {
                        const result = await generateProjectSummary(project.id, publicKey);
                        setProject({ ...project, ...result });
                        setAiSummaryState("idle");
                      } catch (err: unknown) {
                        const msg = err instanceof Error ? err.message : "Failed to generate summary";
                        setAiSummaryError(msg);
                        setAiSummaryState("error");
                      }
                    }}
                    disabled={aiSummaryState === "loading"}
                    className="text-xs font-semibold text-forest-700 hover:text-forest-900 disabled:opacity-50 disabled:cursor-not-allowed font-body"
                  >
                    {aiSummaryState === "loading"
                      ? "Generating…"
                      : project.aiSummary
                        ? "Refresh summary"
                        : "Generate summary"}
                  </button>
                )}
              </div>

              {project.aiSummary ? (
                <p className="text-sm text-forest-900/90 leading-relaxed font-body">
                  {project.aiSummary}
                </p>
              ) : (
                <p className="text-sm text-[#4b654b] italic font-body">
                  No AI summary yet. Click &ldquo;Generate summary&rdquo; to create one for donors.
                </p>
              )}

              {aiSummaryError && (
                <p className="mt-2 text-xs text-red-600 font-body">{aiSummaryError}</p>
              )}

              <p className="mt-3 text-[11px] text-[#7a9a7a] font-body leading-snug">
                AI-generated from this project&rsquo;s description. May contain
                inaccuracies — read the full description below before donating.
                {project.aiSummaryGeneratedAt && (
                  <> Generated {timeAgo(project.aiSummaryGeneratedAt)}.</>
                )}
              </p>
            </div>
          )}

          {/* Description */}
          <div className="card">
            <h2 className="font-display text-lg font-semibold text-forest-900 mb-3">
              About this Project
            </h2>
            <div dir={project.contentDirection} lang={project.contentLanguage} className="text-start">
              <DescriptionAccordion description={project.description} />
            </div>
            {project.tags.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-4">
                {project.tags.map((tag) => (
                  <span
                    key={tag}
                    className="text-xs bg-forest-50 text-forest-700 border border-forest-200 px-2.5 py-1 rounded-full font-body"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Milestones */}
          {project.milestones && project.milestones.length > 0 && (
            <div className="card">
              <h2 className="font-display text-lg font-semibold text-forest-900 mb-4">
                Project Milestones
              </h2>
              <div className="space-y-4">
                {project.milestones.map((m) => {
                  const reached = parseFloat(project.raisedXLM) >= (parseFloat(project.goalXLM) * m.percentage / 100);
                  return (
                    <div key={m.id} className="relative">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${m.reachedAt ? 'bg-emerald-500 text-white' : reached ? 'bg-amber-400 text-white' : 'bg-forest-100 text-forest-700'}`}>
                            {m.percentage}%
                          </div>
                          <span className="text-sm font-semibold text-forest-900 font-body">{m.title}</span>
                        </div>
                        {m.transactionHash && (
                          <a
                            href={`https://stellar.expert/explorer/testnet/tx/${m.transactionHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] text-forest-500 hover:text-emerald-600 font-bold uppercase tracking-widest transition-colors"
                          >
                            Proof ↗
                          </a>
                        )}
                      </div>
                      <div className="w-full bg-forest-100 h-1.5 rounded-full overflow-hidden">
                        <div 
                          className={`h-full transition-all duration-1000 ${m.reachedAt ? 'bg-emerald-500' : reached ? 'bg-amber-400' : 'bg-forest-300'}`}
                          style={{ width: `${Math.min(100, (parseFloat(project.raisedXLM) / (parseFloat(project.goalXLM) * m.percentage / 100)) * 100)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {completedCampaigns.length > 0 && (
            <div className="card">
              <h2 className="font-display text-lg font-semibold text-forest-900 mb-4">
                Campaign History
              </h2>
              <div className="space-y-3">
                {completedCampaigns.map((campaign: ProjectCampaign) => (
                  <div
                    key={campaign.id}
                    className="rounded-xl border border-forest-200 bg-forest-50 p-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                      <p className="font-semibold text-forest-900 font-body">
                        {campaign.title}
                      </p>
                      <span className="text-xs px-2 py-1 rounded-full bg-forest-100 border border-forest-200 text-forest-700 font-body">
                        Completed
                      </span>
                    </div>
                    <p className="text-xs text-[#4b654b] font-body mb-2">
                      Ended {new Date(campaign.deadline).toLocaleDateString()}
                    </p>
                    <div className="flex justify-between text-xs mb-1 font-body">
                      <span>{formatXLM(campaign.raisedXLM, 2, localeTag)} raised</span>
                      <span>
                        {campaign.progressPercent}% of{" "}
                        {formatXLM(campaign.goalXLM, 2, localeTag)}
                      </span>
                    </div>
                    <div className="progress-bar h-2">
                      <div
                        className="progress-fill progress-fill-complete"
                        style={{
                          width: `${Math.min(campaign.progressPercent, 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="card bg-forest-50 border-forest-200">
            <h2 className="font-display text-lg font-semibold text-forest-900 mb-2">
              Campaign Creator
            </h2>
            <p className="text-xs text-[#4b654b] font-body mb-4">
              Project admins can launch a time-limited campaign with a custom
              goal and deadline.
            </p>
            <form onSubmit={handleCreateCampaign} className="space-y-3">
              <input
                type="text"
                required
                placeholder="Campaign title"
                value={campaignForm.title}
                onChange={(e) =>
                  setCampaignForm((prev) => ({
                    ...prev,
                    title: e.target.value,
                  }))
                }
                className="input-field"
              />
              <div className="grid sm:grid-cols-2 gap-3">
                <input
                  type="number"
                  required
                  min="1"
                  step="1"
                  placeholder="Goal (XLM)"
                  value={campaignForm.goalXLM}
                  onChange={(e) =>
                    setCampaignForm((prev) => ({
                      ...prev,
                      goalXLM: e.target.value,
                    }))
                  }
                  className="input-field"
                />
                <input
                  type="datetime-local"
                  required
                  aria-label="Campaign deadline"
                  value={campaignForm.deadline}
                  onChange={(e) =>
                    setCampaignForm((prev) => ({
                      ...prev,
                      deadline: e.target.value,
                    }))
                  }
                  className="input-field"
                />
              </div>
              <textarea
                placeholder="Description (optional)"
                value={campaignForm.description}
                onChange={(e) =>
                  setCampaignForm((prev) => ({
                    ...prev,
                    description: e.target.value,
                  }))
                }
                className="input-field min-h-24"
              />
              {campaignError && (
                <p className="text-xs text-red-600 font-body">
                  {campaignError}
                </p>
              )}
              <button
                type="submit"
                disabled={campaignState === "saving"}
                className="btn-primary text-sm py-2 px-4"
              >
                {campaignState === "saving"
                  ? "Saving..."
                  : campaignState === "success"
                    ? "Campaign Created"
                    : "Create Campaign"}
              </button>
            </form>
          </div>

          {/* Project updates */}
          <div className="card">
            <h2 className="font-display text-lg font-semibold text-forest-900 mb-4">
              {t("project.projectUpdates")}
            </h2>
            {updates.length === 0 ? (
              <p className="text-sm text-[#4b654b] font-body">{t("project.noUpdatesYet")}</p>
            ) : (
              <div className="space-y-4">
                {updates.map((u) => {
                  const like = updateLikes[u.id];
                  return (
                    <div
                      key={u.id}
                      className="pb-4 border-b border-forest-100 last:border-0 last:pb-0 text-start"
                      dir={u.contentDirection}
                      lang={u.contentLanguage}
                    >
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <h3 className="font-semibold text-forest-900 text-sm font-body">
                          {u.title}
                        </h3>
                        <div className="flex flex-wrap justify-end items-center gap-1.5 text-xs font-body">
                          {u.isEdited && (
                            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-800">
                              Edited · revision {u.revision}
                            </span>
                          )}
                          {u.underReview && (
                            <span className="rounded-full bg-sky-50 px-2 py-0.5 text-sky-800">
                              Published · review pending
                            </span>
                          )}
                          <span className="text-[#547454]">{timeAgo(u.createdAt)}</span>
                        </div>
                      </div>
                      <div
                        className="text-[#4b654b] text-sm leading-relaxed font-body prose prose-sm max-w-none"
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(u.body) }}
                      />
                      <div className="mt-2"><ContentLanguageNotice content={u} /></div>
                      <div className="flex flex-wrap items-center gap-3 mt-2">
                        <button
                          onClick={() => handleToggleLike(u.id)}
                          disabled={!publicKey}
                          className={`flex items-center gap-1.5 text-xs font-body transition-colors ${
                            like?.liked
                              ? "text-red-500 font-semibold"
                              : "text-[#547454] hover:text-red-400"
                          } disabled:opacity-50`}
                        >
                          <span>{like?.liked ? "❤️" : "🤍"}</span>
                          <span>{like?.likeCount ?? 0}</span>
                        </button>
                        {u.isEdited && (
                          <button
                            type="button"
                            onClick={() => handleToggleHistory(u.id)}
                            className="text-xs font-body text-forest-700 hover:underline"
                          >
                            {expandedHistoryId === u.id ? "Hide edit history" : "View edit history"}
                          </button>
                        )}
                        {publicKey && (
                          <button
                            type="button"
                            onClick={() => reportingUpdateId === u.id
                              ? setReportingUpdateId(null)
                              : openReportForm(u.id)}
                            className="text-xs font-body text-[#76553a] hover:underline"
                          >
                            {reportingUpdateId === u.id ? "Cancel report" : "Report update"}
                          </button>
                        )}
                      </div>
                      {expandedHistoryId === u.id && (
                        <div className="mt-3 rounded-lg border border-forest-100 bg-forest-50/40 p-3">
                          <p className="text-xs font-semibold text-forest-900 mb-2">Public edit history</p>
                          {historyLoadingId === u.id ? (
                            <p className="text-xs text-[#547454]">Loading history…</p>
                          ) : (updateHistories[u.id]?.revisions.length ?? 0) === 0 ? (
                            <p className="text-xs text-[#547454]">No earlier public revision is available.</p>
                          ) : (
                            <div className="space-y-3">
                              {updateHistories[u.id].revisions.map((revision) => (
                                <div key={revision.revision} className="border-t border-forest-100 pt-2 first:border-0 first:pt-0">
                                  <p className="text-xs font-semibold text-forest-800">
                                    Revision {revision.revision} · replaced {timeAgo(revision.replacedAt)}
                                  </p>
                                  <p className="text-xs text-[#547454] mt-0.5">Reason: {revision.editReason}</p>
                                  <p className="text-xs font-medium text-forest-900 mt-2">{revision.title}</p>
                                  <div
                                    className="text-xs text-[#4b654b] mt-1 prose prose-sm max-w-none"
                                    dangerouslySetInnerHTML={{ __html: renderMarkdown(revision.body) }}
                                  />
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {reportingUpdateId === u.id && (
                        <form
                          className="mt-3 rounded-lg border border-amber-200 bg-amber-50/50 p-3 space-y-2"
                          onSubmit={(event) => handleReportUpdate(event, u.id)}
                        >
                          <p className="text-xs font-semibold text-amber-950">
                            Reports are reviewed by moderators and do not automatically hide an update.
                          </p>
                          {reportState === "success" ? (
                            <p role="status" className="text-xs text-green-700">
                              Report submitted. A moderator will review it.
                            </p>
                          ) : (
                            <>
                              <label className="block text-xs text-amber-950">
                                Reason
                                <select
                                  value={reportReason}
                                  onChange={(event) => setReportReason(event.target.value as ProjectUpdateReportReason)}
                                  className="input-field mt-1 w-full text-sm"
                                >
                                  <option value="fraudulent_claim">Unsupported or misleading impact claim</option>
                                  <option value="abuse">Abuse or harassment</option>
                                  <option value="spam">Spam</option>
                                  <option value="off_topic_solicitation">Off-topic solicitation</option>
                                  <option value="dangerous_content">Dangerous content</option>
                                  <option value="privacy">Personal or private information</option>
                                  <option value="other">Other</option>
                                </select>
                              </label>
                              <label className="block text-xs text-amber-950">
                                Details (optional)
                                <textarea
                                  value={reportDetails}
                                  maxLength={2000}
                                  onChange={(event) => setReportDetails(event.target.value)}
                                  className="input-field mt-1 min-h-20 w-full text-sm"
                                  placeholder="Describe the specific statement or policy concern."
                                />
                              </label>
                              {reportError && <p role="alert" className="text-xs text-red-700">{reportError}</p>}
                              <button
                                type="submit"
                                disabled={reportState === "submitting"}
                                className="btn-primary px-3 py-1.5 text-xs disabled:opacity-60"
                              >
                                {reportState === "submitting" ? "Submitting…" : "Submit report"}
                              </button>
                            </>
                          )}
                        </form>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Donation feed */}
          <div className="card">
            <h2 className="font-display text-lg font-semibold text-forest-900 mb-4">
              Recent Donations
            </h2>
            <DonationFeed
              projectId={project.id}
              walletAddress={project.walletAddress}
              refreshKey={refreshKey}
              onNewDonation={(d) => {
                setToasts((prev) => [
                  ...prev,
                  {
                    id: `${d.id}`,
                    title: "New donation received",
                    description: `${shortenAddress(d.donorAddress)} just donated ${formatXLM(d.amountXLM || d.amount || "0", 2, localeTag)}`,
                    createdAt: Date.now(),
                  },
                ]);
              }}
            />
          </div>

          {/* Donor discussion (on-chain memos) */}
          <div className="card">
            <div className="flex items-center justify-between gap-3 mb-2">
              <h2 className="font-display text-lg font-semibold text-forest-900">
                Donor Discussion
              </h2>
              <span className="text-xs text-[#547454] font-body">On-chain memos</span>
            </div>
            <p className="text-xs text-[#4b654b] font-body mb-4">
              Discuss by donating — messages are Stellar transaction memos from real donations.
            </p>

            {discussionLoading ? (
              <p className="text-sm text-[#4b654b] font-body">Loading discussion…</p>
            ) : discussion.length === 0 ? (
              <p className="text-sm text-[#4b654b] font-body">
                No memo messages yet. Be the first to leave a message with your donation.
              </p>
            ) : (
              <div className="space-y-3">
                {discussion.slice(-50).map((m) => {
                  const suggested = `Reply to ${m.from.slice(0, 6)}…: `;
                  const replyMemo = suggested.length <= 100 ? suggested : suggested.slice(0, 100);
                  return (
                    <div key={m.id} className="p-3 rounded-xl border border-forest-100 bg-white">
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                        <div className="text-xs text-[#547454] font-body">
                          <a
                            href={accountUrl(m.from)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-semibold text-forest-700 hover:underline"
                          >
                            {m.from.slice(0, 6)}…{m.from.slice(-6)}
                          </a>
                          <span className="mx-2">•</span>
                          <span className="font-semibold text-forest-900">{formatXLM(m.amount, 2, localeTag)}</span>
                          <span className="mx-2">•</span>
                          <span>{timeAgo(m.createdAt)}</span>
                        </div>
                        <button
                          onClick={() => router.push({ pathname: router.pathname, query: { ...router.query, replyMemo } })}
                          className="text-xs font-semibold text-forest-700 hover:underline self-start sm:self-auto"
                          title="Reply by donating with a pre-filled memo"
                        >
                          Reply via donation
                        </button>
                      </div>
                      <p className="mt-2 text-sm text-forest-900 font-body leading-relaxed">
                        {m.memo}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ── Sidebar ─────────────────────────────────────────────────── */}
        <div className="space-y-4">

          {/* Sticky mobile donate button */}
          <div className="fixed bottom-0 start-0 end-0 z-40 p-3 bg-white/95 backdrop-blur-sm border-t border-forest-200 sm:hidden">
            {publicKey ? (
              <a
                href="#donate-form"
                className="btn-primary w-full text-center text-sm py-3 block"
              >
                Donate to {project.name}
              </a>
            ) : (
              <WalletConnect
                onConnect={onConnect}
                allowGuidedOnboarding
                projectId={project.id}
              />
            )}
          </div>

          {/* Outcome provenance */}
          <div className="card bg-forest-50 border-forest-200">
            <h3 className="font-display font-semibold text-forest-900 mb-2">How outcome reporting works</h3>
            <p className="text-xs text-[#4b654b] font-body leading-relaxed">
              A payment does not automatically become avoided emissions, sequestration, or an offset. Project operators submit measured ranges and evidence; independent verifiers attest a canonical hash on-chain. Withdrawn attestations stay visible.
            </p>
            <p className="mt-3 rounded-lg border border-forest-100 bg-white p-3 text-xs font-semibold text-forest-800">
              {projectImpact === null
                ? "Outcome records temporarily unavailable"
                : `${projectImpact.claimSummary.total} current and historical claim record${projectImpact.claimSummary.total === 1 ? "" : "s"}`}
            </p>
          </div>

          {publicKey ? (
            <div id="donate-form">
            <DonateForm
              project={project}
              publicKey={publicKey}
              signer={donationSigner}
              initialAmount={prefillAmount}
              initialMessage={prefillReplyMemo}
              onSuccess={() => {
                if (monthlySubId && prefillAmount) {
                  const parsedPrefillAmount = Number.parseFloat(prefillAmount);
                  if (
                    Number.isFinite(parsedPrefillAmount) &&
                    parsedPrefillAmount > 0
                  ) {
                    markMonthlySubscriptionPaid(
                      monthlySubId,
                      parsedPrefillAmount.toFixed(7),
                    );
                  }
                }
                setRefreshKey((k) => k + 1);
                setTimeout(
                  () => fetchProject(project.id, locale).then(setProject),
                  2000,
                );
              }}
            />
            </div>
          ) : (
            <div>
              <p className="text-center text-[#4b654b] text-sm mb-4 font-body">
                Connect your wallet to donate
              </p>
              <WalletConnect
                onConnect={onConnect}
                allowGuidedOnboarding
                projectId={project.id}
              />
            </div>
          )}

          {/* Share card */}
          <div className="card text-center bg-forest-50 border-forest-200">
            <p className="font-display font-semibold text-forest-900 mb-2">Spread the word 🌍</p>
            <p className="text-xs text-[#4b654b] mb-3 font-body">Share this project with friends and family to increase its impact.</p>
            
            <div className="grid grid-cols-3 gap-2 mb-3">
              <button
                onClick={handleTwitterShare}
                className="btn-secondary flex items-center justify-center py-2 px-0 text-[#1DA1F2] hover:bg-forest-100/50"
                title="Share on Twitter"
                aria-label="Share on Twitter"
              >
                <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24"><path d="M23.953 4.57a10 10 0 01-2.825.775 4.958 4.958 0 002.163-2.723c-.951.555-2.005.959-3.127 1.184a4.92 4.92 0 00-8.384 4.482C7.69 8.095 4.067 6.13 1.64 3.162a4.822 4.822 0 00-.666 2.475c0 1.71.87 3.213 2.188 4.096a4.904 4.904 0 01-2.228-.616v.06a4.923 4.923 0 003.946 4.827 4.996 4.996 0 01-2.212.085 4.936 4.936 0 004.604 3.417 9.867 9.867 0 01-6.102 2.105c-.39 0-.779-.023-1.17-.067a13.995 13.995 0 007.557 2.209c9.053 0 13.998-7.496 13.998-13.985 0-.21 0-.42-.015-.63A9.935 9.935 0 0024 4.59z"/></svg>
              </button>
              <button
                onClick={handleWhatsappShare}
                className="btn-secondary flex items-center justify-center py-2 px-0 text-[#25D366] hover:bg-forest-100/50"
                title="Share on WhatsApp"
                aria-label="Share on WhatsApp"
              >
                <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51a12.8 12.8 0 00-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/></svg>
              </button>
              <button
                onClick={handleCopyLink}
                className="btn-secondary flex items-center justify-center py-2 px-0 text-forest-700 hover:bg-forest-100/50"
                title="Copy Link"
                aria-label="Copy Link"
              >
                {shareState === 'copied' ? '✓' : (
                   <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
                )}
              </button>
            </div>
            {shareCount > 0 && <p className="text-xs text-forest-700 font-semibold mb-3">{shareCount} shares so far!</p>}

            <Link
              href={`/donate/${project.id}`}
              className="btn-secondary text-sm py-2 px-4 w-full mt-2 inline-flex items-center justify-center gap-2"
            >
              📱 Generate Donation QR
            </Link>
          </div>

          {/* Impact Report card */}
          <div className="card text-center bg-forest-50 border-forest-200">
            <p className="font-display font-semibold text-forest-900 mb-2">
              Impact Report 📊
            </p>
            <p className="text-xs text-[#4b654b] mb-3 font-body">
              Download a print-friendly summary of this project&apos;s progress and
              impact.
            </p>
            <button
              onClick={handlePrintReport}
              className="btn-primary text-sm py-2 px-4 w-full inline-flex items-center justify-center gap-2"
            >
              📄 Download Report
            </button>
          </div>

          {/* Subscribe card */}
          <div className="card bg-forest-50 border-forest-200">
            <p className="font-display font-semibold text-forest-900 mb-1">
              Get project updates 🔔
            </p>
            <p className="text-xs text-[#4b654b] mb-3 font-body">
              Receive an email when this project posts new updates.
            </p>
            {subscriberCount !== null && (
              <p className="text-xs text-[#547454] font-body mb-3">
                📬 {t("project.subscribersCount", { count: subscriberCount })}
              </p>
            )}
            {subState === "success" ? (
              <p className="text-sm text-green-700 font-body text-center py-2 font-semibold">
                ✓ Thank you for subscribing!
              </p>
            ) : (
              <form onSubmit={handleSubscribe} className="space-y-2">
                <input
                  type="email"
                  required
                  placeholder="your@email.com"
                  value={subEmail}
                  onChange={(e) => setSubEmail(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-forest-200 bg-white focus:outline-none focus:ring-2 focus:ring-forest-400 font-body"
                />
                {subError && (
                  <p className="text-xs text-red-600 font-body">{subError}</p>
                )}
                <button
                  type="submit"
                  disabled={subState === "loading"}
                  className="btn-primary text-sm py-2 px-4 w-full disabled:opacity-60"
                >
                  {subState === "loading" ? "Subscribing…" : "Subscribe"}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>

      {showMonthlySetup && (
        <MonthlyGivingSetup
          projectId={project.id}
          projectName={project.name}
          onClose={() => setShowMonthlySetup(false)}
        />
      )}
    </div>
  );
}

function formatCountdown(deadline: string, nowMs: number) {
  const deltaMs = new Date(deadline).getTime() - nowMs;
  if (deltaMs <= 0) return "0h 0m 0s";

  const totalSeconds = Math.floor(deltaMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  return `${hours}h ${minutes}m ${seconds}s`;
}
