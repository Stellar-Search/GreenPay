import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import dynamic from "next/dynamic";
import Link from "next/link";
import WalletConnect from "@/components/WalletConnect";
import { API_CLIENT_HEADERS, createProjectUpdate, createProjectVerificationApplication, csrfFetch, fetchImpactProject, fetchProject, fetchProjectDonations, fetchProjectMatches, fetchProjectVerification, isAdminAuthenticated, parseApiFetchResponse, recordProjectVerificationDecision, requestProjectVerificationChallenge, submitProjectVerificationWalletProof, updateProjectStatus, updateProjectVerificationApplicationStatus } from "@/lib/api";
import type { ImpactProjectStats } from "@/lib/api";
import { buildMilestoneTransaction, submitTransaction } from "@/lib/stellar";
import { useDonationSocket } from "@/hooks/useDonationSocket";
import { formatXLM, shortenAddress, timeAgo } from "@/utils/format";
import { useI18n } from "@/lib/i18n";
import type { ClimateProject, Donation, ProjectVerificationStatus, ProjectVerificationStatusResponse } from "@/utils/types";

const DonationGrowthChartNoSSR = dynamic(
  () => import("@/components/DonationGrowthChart"),
  { ssr: false },
);

interface AdminProps {
  publicKey: string | null;
  onConnect: (pk: string) => void;
}

function weekKey(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  // ISO week-like key (YYYY-WW) using UTC week start (Mon)
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function toDateTimeLocalInput(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

export default function ProjectAdmin({ publicKey, onConnect }: AdminProps) {
  const { localeTag } = useI18n();
  const router = useRouter();
  const { projectId } = router.query;

  const [project, setProject] = useState<ClimateProject | null>(null);
  const [projectImpact, setProjectImpact] = useState<ImpactProjectStats | null>(null);
  const [donations, setDonations] = useState<Donation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [updateTitle, setUpdateTitle] = useState("");
  const [updateBody, setUpdateBody] = useState("");
  const [postingState, setPostingState] = useState<"idle" | "posting" | "success" | "error">("idle");
  const [postingError, setPostingError] = useState<string | null>(null);

  const [milestones, setMilestones] = useState<any[]>([]);
  const [newMilestoneTitle, setNewMilestoneTitle] = useState("");
  const [newMilestonePercentage, setNewMilestonePercentage] = useState<number>(25);
  const [milestoneActionState, setMilestoneActionState] = useState<"idle" | "loading" | "success" | "error">("idle");

  const [approvalState, setApprovalState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [approvalMessage, setApprovalMessage] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");

  const [matches, setMatches] = useState<any[]>([]);
  const [verification, setVerification] = useState<ProjectVerificationStatusResponse | null>(null);
  const [verificationSummary, setVerificationSummary] = useState("");
  const [verificationState, setVerificationState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [verificationMessage, setVerificationMessage] = useState<string | null>(null);
  const [verificationChallenge, setVerificationChallenge] = useState<string | null>(null);
  const [verificationChallengeExpiry, setVerificationChallengeExpiry] = useState<string | null>(null);
  const [verificationSignature, setVerificationSignature] = useState("");
  const [verificationReviewRationale, setVerificationReviewRationale] = useState("");
  const [verificationVoteOpensAt, setVerificationVoteOpensAt] = useState("");
  const [verificationVoteClosesAt, setVerificationVoteClosesAt] = useState("");
  const [verificationDecisionTxHash, setVerificationDecisionTxHash] = useState("");
  const [verificationDecisionContractId, setVerificationDecisionContractId] = useState("");
  const [verificationDecisionExpiresAt, setVerificationDecisionExpiresAt] = useState("");
  const [verificationRevocationReason, setVerificationRevocationReason] = useState("");

  const [isAdminAuthed, setIsAdminAuthed] = useState(false);
  useEffect(() => {
    setIsAdminAuthed(isAdminAuthenticated());
  }, []);

  useEffect(() => {
    if (!projectId || typeof projectId !== "string") return;
    setLoading(true);
    setError(null);

    Promise.all([
      fetchProject(projectId),
      fetchProjectDonations(projectId, 200).then((r) => r.donations),
      fetch(`${process.env.NEXT_PUBLIC_API_URL || ""}/api/v1/projects/${projectId}/milestones`, {
        headers: API_CLIENT_HEADERS,
      }).then(r => r.json()),
      fetchProjectMatches(projectId).catch(() => []),
      fetchProjectVerification(projectId).catch(() => null),
      fetchImpactProject(projectId).catch(() => null),
    ])
      .then(([p, d, m, mt, verificationStatus, impact]) => {
        setProject(p);
        setProjectImpact(impact);
        setDonations(d);
        setMilestones(m.data || []);
        setMatches(mt);
        setVerification(verificationStatus);
        setVerificationSummary(verificationStatus?.latestApplication?.attestationSummary || "");
        setVerificationVoteOpensAt(toDateTimeLocalInput(verificationStatus?.latestApplication?.communityVoteOpensAt));
        setVerificationVoteClosesAt(toDateTimeLocalInput(verificationStatus?.latestApplication?.communityVoteClosesAt));
        setVerificationDecisionExpiresAt(toDateTimeLocalInput(verificationStatus?.latestApplication?.expiresAt));
      })
      .catch((e: unknown) => setError((e as Error).message || "Failed to load project"))
      .finally(() => setLoading(false));
  }, [projectId]);

  // Live-update the donor breakdown and growth chart as new donations arrive over Socket.io
  const handleLiveDonation = useCallback((payload: {
    donorAddress: string;
    amountXLM: number;
    transactionHash: string;
    timestamp: string;
  }) => {
    setDonations((prev) => {
      if (prev.some((d) => d.transactionHash === payload.transactionHash)) return prev;
      const newDonation: Donation = {
        id: payload.transactionHash,
        projectId: typeof projectId === "string" ? projectId : "",
        donorAddress: payload.donorAddress,
        amountXLM: String(payload.amountXLM),
        amount: String(payload.amountXLM),
        currency: "XLM",
        transactionHash: payload.transactionHash,
        createdAt: payload.timestamp,
      };
      return [newDonation, ...prev];
    });
  }, [projectId]);

  useDonationSocket(typeof projectId === "string" ? projectId : undefined, handleLiveDonation);

  const isOwner = !!publicKey && !!project && publicKey === project.walletAddress;
  const canAccessDashboard = isOwner || isAdminAuthed;

  const donorBreakdown = useMemo(() => {
    const byDonor = new Map<string, { donorAddress: string; total: number; count: number }>();
    for (const d of donations) {
      const donorAddress = d.donorAddress;
      const amount = parseFloat(d.amountXLM || d.amount || "0");
      const curr = byDonor.get(donorAddress) || { donorAddress, total: 0, count: 0 };
      curr.total += Number.isFinite(amount) ? amount : 0;
      curr.count += 1;
      byDonor.set(donorAddress, curr);
    }
    return Array.from(byDonor.values()).sort((a, b) => b.total - a.total);
  }, [donations]);

  const weeklyGrowth = useMemo(() => {
    const byWeek = new Map<string, number>();
    for (const d of donations) {
      const key = weekKey(d.createdAt);
      const amount = parseFloat(d.amountXLM || d.amount || "0");
      byWeek.set(key, (byWeek.get(key) || 0) + (Number.isFinite(amount) ? amount : 0));
    }
    return Array.from(byWeek.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, totalXLM]) => ({ week, totalXLM: Number(totalXLM.toFixed(2)) }));
  }, [donations]);

  const downloadCsv = () => {
    const header = ["donorAddress", "totalXLM", "donationCount"];
    const lines = donorBreakdown.map((d) => [d.donorAddress, d.total.toFixed(7), String(d.count)]);
    const csv = [header, ...lines]
      .map((row) => row.map((v) => `"${String(v).replace(/\"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `donor-report-${projectId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const postUpdate = async () => {
    if (!project) return;
    if (!updateTitle.trim() || !updateBody.trim()) {
      setPostingError("Title and body are required.");
      setPostingState("error");
      return;
    }
    setPostingState("posting");
    setPostingError(null);
    try {
      await createProjectUpdate({
        projectId: project.id,
        title: updateTitle.trim(),
        body: updateBody.trim(),
      });
      setUpdateTitle("");
      setUpdateBody("");
      setPostingState("success");
      setTimeout(() => setPostingState("idle"), 2000);
    } catch (e: unknown) {
      setPostingError((e as Error).message || "Failed to post update");
      setPostingState("error");
    }
  };

  const addMilestone = async () => {
    if (!project || !newMilestoneTitle.trim()) return;
    setMilestoneActionState("loading");
    try {
      const res = await csrfFetch(`${process.env.NEXT_PUBLIC_API_URL || ""}/api/v1/projects/${project.id}/milestones`, {
        method: "POST",
        body: JSON.stringify({ title: newMilestoneTitle.trim(), percentage: newMilestonePercentage }),
      });
      const data = await parseApiFetchResponse<any>(res);
      setMilestones([...milestones, data].sort((a, b) => a.percentage - b.percentage));
      setNewMilestoneTitle("");
      setMilestoneActionState("success");
      setTimeout(() => setMilestoneActionState("idle"), 2000);
    } catch (e: any) {
      alert(e.message);
      setMilestoneActionState("error");
    }
  };

  const recordMilestoneOnChain = async (milestone: any) => {
    if (!publicKey) return;
    setMilestoneActionState("loading");
    try {
      // 1. Build & Sign transaction
      const tx = await buildMilestoneTransaction({
        publicKey,
        milestoneTitle: milestone.title,
      });
      
      // Since we are in a browser, we'd normally use Freighter to sign.
      // For this demo, we'll assume the user signs via their wallet extension.
      const { signedXDR } = await (window as any).stellarWallets.signTransaction(tx.toXDR());
      
      // 2. Submit to Stellar
      const result = await submitTransaction(signedXDR);
      
      // 3. Update backend
      const res = await csrfFetch(`${process.env.NEXT_PUBLIC_API_URL || ""}/api/v1/projects/${project?.id}/milestones/${milestone.id}/reach`, {
        method: "POST",
        body: JSON.stringify({ transactionHash: result.hash }),
      });
      const data = await parseApiFetchResponse<any>(res);
      
      setMilestones(milestones.map(m => m.id === milestone.id ? data : m));
      setMilestoneActionState("success");
      setTimeout(() => setMilestoneActionState("idle"), 2000);
    } catch (e: any) {
      alert(e.message);
      setMilestoneActionState("error");
    }
  };

  const handleApprove = async () => {
    if (!project) return;
    setApprovalState("loading");
    setApprovalMessage(null);
    try {
      const updated = await updateProjectStatus(project.id, "active");
      setProject(updated);
      setApprovalMessage("Project approved successfully");
      setApprovalState("success");
      setTimeout(() => setApprovalState("idle"), 3000);
    } catch (e: any) {
      setApprovalMessage(e.message || "Failed to approve project");
      setApprovalState("error");
    }
  };

  const handleReject = async () => {
    if (!project || !rejectionReason.trim()) return;
    setApprovalState("loading");
    setApprovalMessage(null);
    try {
      const updated = await updateProjectStatus(project.id, "rejected", rejectionReason.trim());
      setProject(updated);
      setApprovalMessage("Project rejected");
      setApprovalState("success");
      setRejectionReason("");
      setTimeout(() => setApprovalState("idle"), 3000);
    } catch (e: any) {
      setApprovalMessage(e.message || "Failed to reject project");
      setApprovalState("error");
    }
  };

  const refreshProjectVerificationState = async (projectIdToRefresh: string) => {
    const [refreshedProject, refreshedVerification] = await Promise.all([
      fetchProject(projectIdToRefresh),
      fetchProjectVerification(projectIdToRefresh),
    ]);
    setProject(refreshedProject);
    setVerification(refreshedVerification);
    setVerificationVoteOpensAt(toDateTimeLocalInput(refreshedVerification.latestApplication?.communityVoteOpensAt));
    setVerificationVoteClosesAt(toDateTimeLocalInput(refreshedVerification.latestApplication?.communityVoteClosesAt));
    setVerificationDecisionExpiresAt(toDateTimeLocalInput(refreshedVerification.latestApplication?.expiresAt));
    return { refreshedProject, refreshedVerification };
  };

  const handleStartVerification = async () => {
    if (!project || !publicKey || !isOwner) return;
    setVerificationState("loading");
    setVerificationMessage(null);
    try {
      const application = await createProjectVerificationApplication(project.id, {
        submittedByWallet: publicKey,
        attestationSummary: verificationSummary.trim(),
      });
      const { refreshedVerification } = await refreshProjectVerificationState(project.id);
      setVerificationSummary(application.attestationSummary || verificationSummary);
      setVerificationMessage("Verification application created. Request a wallet challenge to prove control cryptographically.");
      setVerificationState("success");
    } catch (e: any) {
      setVerificationMessage(e.message || "Failed to create verification application");
      setVerificationState("error");
    }
  };

  const handleRequestVerificationChallenge = async () => {
    if (!project || !publicKey || !verification?.latestApplication || !isOwner) return;
    setVerificationState("loading");
    setVerificationMessage(null);
    try {
      const result = await requestProjectVerificationChallenge(project.id, {
        applicationId: verification.latestApplication.id,
        walletAddress: publicKey,
      });
      setVerificationChallenge(result.challenge);
      setVerificationChallengeExpiry(result.expiresAt);
      setVerificationMessage("Challenge issued. Sign this exact message with the project wallet and submit the signature to complete proof-of-control.");
      setVerificationState("success");
    } catch (e: any) {
      setVerificationMessage(e.message || "Failed to request verification challenge");
      setVerificationState("error");
    }
  };

  const handleSubmitWalletProof = async () => {
    if (!project || !verification?.latestApplication || !verificationSignature.trim() || !isOwner) return;
    setVerificationState("loading");
    setVerificationMessage(null);
    try {
      await submitProjectVerificationWalletProof(project.id, {
        applicationId: verification.latestApplication.id,
        signature: verificationSignature.trim(),
      });
      await refreshProjectVerificationState(project.id);
      setVerificationSignature("");
      setVerificationChallenge(null);
      setVerificationChallengeExpiry(null);
      setVerificationMessage("Wallet proof recorded. The application is now ready for review.");
      setVerificationState("success");
    } catch (e: any) {
      setVerificationMessage(e.message || "Failed to submit wallet proof");
      setVerificationState("error");
    }
  };

  const handleVerificationStatusUpdate = async (
    status: Exclude<ProjectVerificationStatus, "wallet_proof_pending" | "approved">,
    extra: {
      rationale?: string;
      communityVoteOpensAt?: string;
      communityVoteClosesAt?: string;
      revocationReason?: string;
    } = {},
    successMessage = "Verification application updated.",
  ) => {
    if (!project || !verification?.latestApplication) return;
    setVerificationState("loading");
    setVerificationMessage(null);
    try {
      await updateProjectVerificationApplicationStatus(project.id, {
        applicationId: verification.latestApplication.id,
        status,
        ...extra,
      });
      await refreshProjectVerificationState(project.id);
      setVerificationMessage(successMessage);
      setVerificationState("success");
    } catch (e: any) {
      setVerificationMessage(e.message || "Failed to update verification application");
      setVerificationState("error");
    }
  };

  const handleRecordVerificationDecision = async () => {
    if (!project || !verification?.latestApplication) return;
    setVerificationState("loading");
    setVerificationMessage(null);
    try {
      await recordProjectVerificationDecision(project.id, {
        applicationId: verification.latestApplication.id,
        decisionTxHash: verificationDecisionTxHash.trim(),
        decisionContractId: verificationDecisionContractId.trim(),
        expiresAt: new Date(verificationDecisionExpiresAt).toISOString(),
        rationale: verificationReviewRationale.trim() || undefined,
      });
      await refreshProjectVerificationState(project.id);
      setVerificationDecisionTxHash("");
      setVerificationDecisionContractId("");
      setVerificationDecisionExpiresAt("");
      setVerificationReviewRationale("");
      setVerificationMessage("DAO decision recorded and the badge is now anchored to the on-chain decision reference.");
      setVerificationState("success");
    } catch (e: any) {
      setVerificationMessage(e.message || "Failed to record DAO decision");
      setVerificationState("error");
    }
  };

  if (!publicKey) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16">
        <div className="text-center mb-10">
          <h1 className="font-display text-3xl font-bold text-forest-900 mb-3">Project Admin</h1>
          <p className="text-[#4b654b] font-body">Connect the project wallet to access analytics and post updates.</p>
        </div>
        <WalletConnect onConnect={onConnect} />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12">
        <div className="card">Loading…</div>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12">
        <div className="card">
          <p className="text-red-600 font-body">{error || "Project not found"}</p>
          <div className="mt-4">
            <Link className="text-forest-700 font-semibold hover:underline" href="/projects">
              ← Back to projects
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!canAccessDashboard) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12">
        <div className="card">
          <h1 className="font-display text-xl font-bold text-forest-900 mb-2">Access denied</h1>
          <p className="text-sm text-[#4b654b] font-body">
            This admin dashboard is only accessible to the project wallet or a verified platform admin session.
          </p>
          <div className="mt-4 text-xs text-[#547454] font-body">
            Connected: {shortenAddress(publicKey)} • Project wallet: {shortenAddress(project.walletAddress)}
          </div>
          <div className="mt-5">
            <Link className="text-forest-700 font-semibold hover:underline" href={`/projects/${project.id}`}>
              View project page →
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <p className="text-xs tracking-[0.22em] uppercase text-[#547454] font-body">Project Admin</p>
          <h1 className="font-display text-3xl font-bold text-forest-900 mb-1">{project.name}</h1>
          <p className="text-sm text-[#4b654b] font-body">Wallet: {shortenAddress(project.walletAddress, 10)}</p>
        </div>
        <Link href={`/projects/${project.id}`} className="btn-primary text-sm py-2.5 px-5 flex-shrink-0">
          View Project
        </Link>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {[
          { icon: "💚", label: "Total Raised", value: formatXLM(project.raisedXLM, 2, localeTag) },
          { icon: "👥", label: "Donors", value: String(project.donorCount) },
          { icon: "📋", label: "Outcome Claims", value: `${projectImpact?.claimSummary.total ?? 0} (${projectImpact?.claimSummary.verified ?? 0} verified)` },
          { icon: "🧾", label: "Recent Donations", value: String(donations.length) },
        ].map((stat) => (
          <div key={stat.label} className="card text-center shadow-sm border border-forest-100/50">
            <p className="text-2xl mb-2">{stat.icon}</p>
            <p className="font-display font-bold text-forest-900 text-lg leading-tight">{stat.value}</p>
            <p className="text-xs text-[#547454] mt-1 font-body uppercase tracking-wider font-bold opacity-60">{stat.label}</p>
          </div>
        ))}
      </div>

      <div className="card mb-8">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
          <h2 className="font-display text-xl font-bold text-forest-900">Donation Growth</h2>
          <button
            onClick={downloadCsv}
            className="px-5 py-2.5 rounded-xl text-sm font-semibold border border-forest-200 bg-forest-50 hover:bg-forest-100 transition-all"
          >
            Download donor report CSV
          </button>
        </div>
        <div className="h-64">
          <DonationGrowthChartNoSSR data={weeklyGrowth} />
        </div>
        <p className="text-xs text-[#547454] mt-3 font-body">
          Weekly totals based on recent donation history (up to 200 donations loaded).
        </p>
      </div>

      <div className="card mb-8">
        <h2 className="font-display text-xl font-bold text-forest-900 mb-4">Project Milestones</h2>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-4">
            {milestones.length === 0 ? (
              <p className="text-sm text-[#4b654b] font-body">No milestones defined yet.</p>
            ) : (
              milestones.map((m) => {
                const reached = parseFloat(project.raisedXLM) >= (parseFloat(project.goalXLM) * m.percentage / 100);
                return (
                  <div key={m.id} className={`p-4 rounded-xl border ${m.reachedAt ? 'bg-emerald-50 border-emerald-100' : 'bg-white border-forest-100'}`}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${m.reachedAt ? 'bg-emerald-500 text-white' : 'bg-forest-100 text-forest-700'}`}>
                          {m.percentage}%
                        </div>
                        <div>
                          <p className="font-semibold text-forest-900 font-body">{m.title}</p>
                          {m.reachedAt && <p className="text-[10px] text-emerald-600 font-bold uppercase tracking-widest">Reached {timeAgo(m.reachedAt)}</p>}
                        </div>
                      </div>
                      {reached && !m.reachedAt && (
                        <button
                          onClick={() => recordMilestoneOnChain(m)}
                          disabled={milestoneActionState === "loading"}
                          className="btn-primary text-xs py-1.5 px-3"
                        >
                          Record On-Chain
                        </button>
                      )}
                      {m.transactionHash && (
                        <a
                          href={`https://stellar.expert/explorer/testnet/tx/${m.transactionHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] text-emerald-600 hover:underline font-bold uppercase tracking-widest"
                        >
                          View Proof ↗
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
              })
            )}
          </div>
          <div className="bg-forest-50 p-5 rounded-2xl border border-forest-100">
            <h3 className="text-sm font-bold text-forest-900 mb-3 uppercase tracking-wider opacity-60">Add Milestone</h3>
            <div className="space-y-3">
              <input
                value={newMilestoneTitle}
                onChange={(e) => setNewMilestoneTitle(e.target.value)}
                placeholder="e.g. 25% Funded"
                className="input-field bg-white"
              />
              <div>
                <label className="block text-[10px] font-bold text-forest-800 uppercase tracking-widest mb-1 ms-1 opacity-75">Percentage of goal</label>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min="1"
                    max="100"
                    value={newMilestonePercentage}
                    onChange={(e) => setNewMilestonePercentage(parseInt(e.target.value))}
                    className="flex-1 accent-forest-600"
                  />
                  <span className="text-sm font-bold text-forest-900 w-8">{newMilestonePercentage}%</span>
                </div>
              </div>
              <button
                onClick={addMilestone}
                disabled={milestoneActionState === "loading" || !newMilestoneTitle.trim()}
                className="btn-primary w-full text-sm py-2 disabled:opacity-50"
              >
                {milestoneActionState === "loading" ? "Adding..." : "Add Milestone"}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <h2 className="font-display text-xl font-bold text-forest-900 mb-4">Recent Donations</h2>
          {donations.length === 0 ? (
            <p className="text-sm text-[#4b654b] font-body">No donations yet.</p>
          ) : (
            <div className="space-y-3">
              {donations.slice(0, 10).map((d) => (
                <div key={d.id} className="flex items-center justify-between gap-3 p-3 rounded-xl border border-forest-100">
                  <div>
                    <p className="text-sm font-semibold text-forest-900 font-body">
                      {shortenAddress(d.donorAddress)} • {formatXLM(d.amountXLM || d.amount || "0", 2, localeTag)}
                    </p>
                    <p className="text-xs text-[#547454] font-body">{timeAgo(d.createdAt)}</p>
                  </div>
                  {d.message && (
                    <p className="text-xs text-[#4b654b] font-body max-w-[220px] text-end">
                      “{d.message.slice(0, 60)}{d.message.length > 60 ? "…" : ""}”
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <h2 className="font-display text-xl font-bold text-forest-900 mb-2">Post Update</h2>
          <p className="text-sm text-[#4b654b] font-body mb-4">
            Publish a project update to notify subscribers.
          </p>
          <div className="space-y-3">
            <input
              value={updateTitle}
              onChange={(e) => setUpdateTitle(e.target.value)}
              className="input-field"
              placeholder="Update title"
              maxLength={120}
            />
            <textarea
              value={updateBody}
              onChange={(e) => setUpdateBody(e.target.value)}
              className="input-field min-h-[140px]"
              placeholder="Write your update..."
              maxLength={2000}
            />
            {postingState === "error" && postingError && (
              <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-sm font-body">
                {postingError}
              </div>
            )}
            {postingState === "success" && (
              <div className="p-3 rounded-xl bg-green-50 border border-green-200 text-green-700 text-sm font-body">
                Update posted.
              </div>
            )}
            <button
              onClick={postUpdate}
              disabled={postingState === "posting"}
              className="btn-primary w-full disabled:opacity-60"
            >
              {postingState === "posting" ? "Posting…" : "Post Update"}
            </button>
          </div>
        </div>
      </div>

      {/* Approval Workflow */}
      <div className="card mt-6">
        <h2 className="font-display text-xl font-bold text-forest-900 mb-2">Approval Workflow</h2>
        <p className="text-sm text-[#4b654b] font-body mb-4">
          Manage project status. Current status:{" "}
          <span className={`font-semibold ${project.status === "active" ? "text-emerald-600" : project.status === "rejected" ? "text-red-600" : "text-amber-600"}`}>
            {project.status}
          </span>
        </p>

        {project.rejectionReason && (
          <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm font-body mb-4">
            <strong>Rejection reason:</strong> {project.rejectionReason}
          </div>
        )}

        {approvalMessage && (
          <div className={`p-3 rounded-xl text-sm font-body mb-4 ${approvalState === "success" ? "bg-green-50 border border-green-200 text-green-700" : "bg-red-50 border border-red-200 text-red-600"}`}>
            {approvalMessage}
          </div>
        )}

        {isAdminAuthed ? (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-bold text-forest-800 uppercase tracking-widest mb-1 ms-1 opacity-75">
                Reason for rejection (required)
              </label>
              <textarea
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                className="input-field min-h-[80px]"
                placeholder="Provide a reason for this decision..."
                maxLength={500}
              />
            </div>
            <div className="flex gap-3">
              <button
                onClick={handleApprove}
                disabled={approvalState === "loading" || project.status === "active"}
                className="btn-primary flex-1 disabled:opacity-50"
              >
                {approvalState === "loading" ? "Processing…" : "Approve"}
              </button>
              <button
                onClick={handleReject}
                disabled={approvalState === "loading" || !rejectionReason.trim() || project.status === "rejected"}
                className="flex-1 bg-red-600 hover:bg-red-700 text-white font-semibold px-6 py-3 rounded-xl transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {approvalState === "loading" ? "Processing…" : "Reject"}
              </button>
            </div>
          </div>
        ) : (
          <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-sm font-body">
            <p className="text-amber-800 mb-2">
              Changing a project&apos;s status requires a verified platform-admin login.
            </p>
            <Link href="/admin/login" className="text-forest-700 font-semibold hover:underline">
              Log in as admin →
            </Link>
          </div>
        )}
      </div>

      {/* Verification Workflow */}
      <div className="card mt-6">
        <h2 className="font-display text-xl font-bold text-forest-900 mb-2">Verification Workflow</h2>
        <p className="text-sm text-[#4b654b] font-body mb-4">
          Direct admin badge-granting is retired. Start the recorded verification flow here, prove wallet control cryptographically, then move into community review and DAO decision-making.
        </p>

        {verificationMessage && (
          <div className={`p-3 rounded-xl text-sm font-body mb-4 ${verificationState === "error" ? "bg-red-50 border border-red-200 text-red-700" : "bg-emerald-50 border border-emerald-200 text-emerald-700"}`}>
            {verificationMessage}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-4">
            <div className="rounded-2xl border border-forest-100 bg-forest-50 p-4">
              <p className="text-[10px] uppercase tracking-widest font-bold text-forest-800 opacity-60 mb-2">Current verification state</p>
              <div className="flex flex-wrap gap-2 items-center mb-3">
                <span className="px-3 py-1 rounded-full bg-white border border-forest-200 text-sm font-semibold text-forest-900">
                  {verification?.currentStatus || verification?.latestApplication?.status || "not_started"}
                </span>
                {verification?.verified && (
                  <span className="px-3 py-1 rounded-full bg-emerald-100 border border-emerald-200 text-sm font-semibold text-emerald-700">
                    badge active
                  </span>
                )}
                {verification?.onChainVerified && (
                  <span className="px-3 py-1 rounded-full bg-emerald-100 border border-emerald-200 text-sm font-semibold text-emerald-700">
                    on-chain proof recorded
                  </span>
                )}
                {verification?.badgeExpired && (
                  <span className="px-3 py-1 rounded-full bg-amber-100 border border-amber-200 text-sm font-semibold text-amber-700">
                    badge expired
                  </span>
                )}
                {verification?.badgeRevoked && (
                  <span className="px-3 py-1 rounded-full bg-red-100 border border-red-200 text-sm font-semibold text-red-700">
                    badge revoked
                  </span>
                )}
              </div>
              <div className="grid grid-cols-3 gap-3 text-sm font-body">
                <div>
                  <p className="text-[10px] uppercase tracking-widest font-bold text-forest-800 opacity-50">Evidence</p>
                  <p className="font-semibold text-forest-900">{verification?.latestApplication?.evidenceCount ?? 0}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-widest font-bold text-forest-800 opacity-50">Proofs</p>
                  <p className="font-semibold text-forest-900">{verification?.latestApplication?.proofCount ?? 0}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-widest font-bold text-forest-800 opacity-50">Attestations</p>
                  <p className="font-semibold text-forest-900">{verification?.latestApplication?.attestationCount ?? 0}</p>
                </div>
              </div>
              {verification?.verificationExpiresAt && (
                <p className="mt-3 text-xs text-[#547454] font-body">
                  Current badge expiry: {new Date(verification.verificationExpiresAt).toLocaleString()}
                </p>
              )}
              {verification?.verificationDecisionTxHash && (
                <p className="mt-2 text-xs text-[#547454] font-body break-all">
                  Decision tx: {verification.verificationDecisionTxHash}
                </p>
              )}
              {verification?.verificationDecisionContractId && (
                <p className="mt-2 text-xs text-[#547454] font-body break-all">
                  Decision contract: {verification.verificationDecisionContractId}
                </p>
              )}
              {verification?.verificationRevocationReason && (
                <p className="mt-2 text-xs text-red-700 font-body">
                  Revocation reason: {verification.verificationRevocationReason}
                </p>
              )}
            </div>

            {isOwner && !verification?.latestApplication && (
              <div className="rounded-2xl border border-forest-100 p-4">
                <label className="block text-[10px] uppercase tracking-widest font-bold text-forest-800 opacity-60 mb-2">
                  Human attestation summary
                </label>
                <textarea
                  value={verificationSummary}
                  onChange={(e) => setVerificationSummary(e.target.value)}
                  className="input-field min-h-[140px]"
                  placeholder="Summarize legal identity checks, project documentation, and what reviewers should validate. Wallet control will be proven separately by signature."
                  maxLength={3000}
                />
                <button
                  onClick={handleStartVerification}
                  disabled={verificationState === "loading" || verificationSummary.trim().length < 20}
                  className="btn-primary w-full mt-3 disabled:opacity-50"
                >
                  {verificationState === "loading" ? "Starting…" : "Start Verification Application"}
                </button>
              </div>
            )}

            {!isOwner && !verification?.latestApplication && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <p className="text-sm text-amber-900 font-body">
                  Only the project wallet can start a verification application and produce the cryptographic proof-of-control signature.
                </p>
              </div>
            )}

            {isOwner && verification?.latestApplication && verification.latestApplication.status === "wallet_proof_pending" && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <p className="text-sm font-semibold text-amber-900 mb-2">Next step: prove wallet control</p>
                <p className="text-sm text-amber-900 font-body mb-3">
                  Request a one-time challenge, sign it with the project wallet, and submit that signature to complete cryptographic proof-of-control.
                </p>
                <button
                  onClick={handleRequestVerificationChallenge}
                  disabled={verificationState === "loading"}
                  className="btn-primary w-full disabled:opacity-50"
                >
                  {verificationState === "loading" ? "Preparing…" : "Request Wallet Challenge"}
                </button>
              </div>
            )}

            {verification?.latestApplication?.status === "submitted" && (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                <p className="text-sm font-semibold text-emerald-900 mb-2">Wallet proof completed</p>
                <p className="text-sm text-emerald-900 font-body">
                  The application has cryptographic wallet control proof and is ready to enter recorded review.
                </p>
              </div>
            )}
          </div>

          <div className="space-y-4">
            {verificationChallenge && (
              <div className="rounded-2xl border border-forest-100 p-4 bg-white">
                <p className="text-[10px] uppercase tracking-widest font-bold text-forest-800 opacity-60 mb-2">Wallet challenge</p>
                <pre className="text-xs whitespace-pre-wrap break-words bg-forest-50 border border-forest-100 rounded-xl p-3 text-forest-900 overflow-x-auto">{verificationChallenge}</pre>
                {verificationChallengeExpiry && (
                  <p className="mt-2 text-xs text-[#547454] font-body">
                    Expires at: {new Date(verificationChallengeExpiry).toLocaleString()}
                  </p>
                )}
              </div>
            )}

            {isOwner && verification?.latestApplication?.status === "wallet_proof_pending" && verificationChallenge && (
              <div className="rounded-2xl border border-forest-100 p-4 bg-white">
                <p className="text-[10px] uppercase tracking-widest font-bold text-forest-800 opacity-60 mb-2">Signed challenge proof</p>
                <textarea
                  value={verificationSignature}
                  onChange={(e) => setVerificationSignature(e.target.value)}
                  className="input-field min-h-[120px]"
                  placeholder="Paste the base64 or hex signature produced by the project wallet for the challenge above."
                />
                <button
                  onClick={handleSubmitWalletProof}
                  disabled={verificationState === "loading" || !verificationSignature.trim()}
                  className="btn-primary w-full mt-3 disabled:opacity-50"
                >
                  {verificationState === "loading" ? "Submitting…" : "Submit Wallet Proof"}
                </button>
              </div>
            )}

            <div className="rounded-2xl border border-forest-100 p-4">
              <p className="text-[10px] uppercase tracking-widest font-bold text-forest-800 opacity-60 mb-3">Recorded timeline</p>
              {verification?.timeline?.length ? (
                <div className="space-y-3">
                  {verification.timeline.map((event) => (
                    <div key={event.id} className="border-s-2 border-forest-200 ps-3">
                      <p className="text-sm font-semibold text-forest-900">
                        {event.toStatus.replace(/_/g, " ")}
                      </p>
                      <p className="text-xs text-[#547454] font-body">
                        {new Date(event.createdAt).toLocaleString()} • {event.actorType} • {shortenAddress(event.actor, 8)}
                      </p>
                      {event.rationale && (
                        <p className="text-sm text-[#4b654b] font-body mt-1">{event.rationale}</p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-[#4b654b] font-body">No verification events recorded yet.</p>
              )}
            </div>

            {!!verification?.publicEvidence?.length && (
              <div className="rounded-2xl border border-forest-100 p-4">
                <p className="text-[10px] uppercase tracking-widest font-bold text-forest-800 opacity-60 mb-3">Public evidence commits</p>
                <div className="space-y-3">
                  {verification.publicEvidence.map((item) => (
                    <div key={item.id} className="rounded-xl border border-forest-100 bg-forest-50 p-3">
                      <p className="text-sm font-semibold text-forest-900">{item.evidenceType.replace(/_/g, " ")}</p>
                      <p className="text-xs text-[#547454] font-body">
                        {item.attestationType === "cryptographic_proof" ? "Cryptographic proof" : "Human attestation"} • {new Date(item.createdAt).toLocaleString()}
                      </p>
                      <p className="mt-2 text-xs text-forest-900 break-all">{item.documentHash}</p>
                      {item.notes && (
                        <p className="mt-2 text-sm text-[#4b654b] font-body">{item.notes}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {isAdminAuthed && verification?.latestApplication && (
              <div className="rounded-2xl border border-forest-100 p-4 bg-forest-50">
                <p className="text-[10px] uppercase tracking-widest font-bold text-forest-800 opacity-60 mb-3">Admin review controls</p>
                <div className="space-y-3">
                  <textarea
                    value={verificationReviewRationale}
                    onChange={(e) => setVerificationReviewRationale(e.target.value)}
                    className="input-field min-h-[90px] bg-white"
                    placeholder="Record the rationale for the next review step or DAO decision."
                    maxLength={2000}
                  />

                  {verification.latestApplication.status === "submitted" && (
                    <button
                      onClick={() => handleVerificationStatusUpdate("under_review", { rationale: verificationReviewRationale.trim() || undefined }, "Application moved into recorded review.")}
                      disabled={verificationState === "loading"}
                      className="btn-primary w-full disabled:opacity-50"
                    >
                      {verificationState === "loading" ? "Updating…" : "Move to Under Review"}
                    </button>
                  )}

                  {verification.latestApplication.status === "under_review" && (
                    <div className="space-y-3 rounded-xl border border-forest-100 bg-white p-3">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[10px] uppercase tracking-widest font-bold text-forest-800 opacity-60 mb-1">
                            Vote opens
                          </label>
                          <input
                            type="datetime-local"
                            value={verificationVoteOpensAt}
                            onChange={(e) => setVerificationVoteOpensAt(e.target.value)}
                            className="input-field"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] uppercase tracking-widest font-bold text-forest-800 opacity-60 mb-1">
                            Vote closes
                          </label>
                          <input
                            type="datetime-local"
                            value={verificationVoteClosesAt}
                            onChange={(e) => setVerificationVoteClosesAt(e.target.value)}
                            className="input-field"
                          />
                        </div>
                      </div>
                      <button
                        onClick={() => handleVerificationStatusUpdate("community_vote", {
                          rationale: verificationReviewRationale.trim() || undefined,
                          communityVoteOpensAt: verificationVoteOpensAt ? new Date(verificationVoteOpensAt).toISOString() : undefined,
                          communityVoteClosesAt: verificationVoteClosesAt ? new Date(verificationVoteClosesAt).toISOString() : undefined,
                        }, "Community vote window recorded.")}
                        disabled={verificationState === "loading" || !verificationVoteOpensAt || !verificationVoteClosesAt}
                        className="btn-primary w-full disabled:opacity-50"
                      >
                        {verificationState === "loading" ? "Updating…" : "Open Community Vote"}
                      </button>
                    </div>
                  )}

                  {verification.latestApplication.status === "community_vote" && (
                    <div className="space-y-3 rounded-xl border border-forest-100 bg-white p-3">
                      <input
                        value={verificationDecisionTxHash}
                        onChange={(e) => setVerificationDecisionTxHash(e.target.value)}
                        className="input-field"
                        placeholder="DAO decision transaction hash"
                      />
                      <input
                        value={verificationDecisionContractId}
                        onChange={(e) => setVerificationDecisionContractId(e.target.value)}
                        className="input-field"
                        placeholder="DAO verification contract ID"
                      />
                      <div>
                        <label className="block text-[10px] uppercase tracking-widest font-bold text-forest-800 opacity-60 mb-1">
                          Badge expiry
                        </label>
                        <input
                          type="datetime-local"
                          value={verificationDecisionExpiresAt}
                          onChange={(e) => setVerificationDecisionExpiresAt(e.target.value)}
                          className="input-field"
                        />
                      </div>
                      <button
                        onClick={handleRecordVerificationDecision}
                        disabled={verificationState === "loading" || !verificationDecisionTxHash.trim() || !verificationDecisionContractId.trim() || !verificationDecisionExpiresAt}
                        className="btn-primary w-full disabled:opacity-50"
                      >
                        {verificationState === "loading" ? "Recording…" : "Record DAO Decision"}
                      </button>
                    </div>
                  )}

                  {["submitted", "under_review", "community_vote"].includes(verification.latestApplication.status) && (
                    <button
                      onClick={() => handleVerificationStatusUpdate("rejected", { rationale: verificationReviewRationale.trim() || undefined }, "Verification application rejected.")}
                      disabled={verificationState === "loading"}
                      className="w-full bg-red-600 hover:bg-red-700 text-white font-semibold px-6 py-3 rounded-xl transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {verificationState === "loading" ? "Updating…" : "Reject Verification Application"}
                    </button>
                  )}

                  {verification.latestApplication.status === "approved" && (
                    <div className="space-y-3 rounded-xl border border-red-100 bg-white p-3">
                      <textarea
                        value={verificationRevocationReason}
                        onChange={(e) => setVerificationRevocationReason(e.target.value)}
                        className="input-field min-h-[90px]"
                        placeholder="If new evidence invalidates the badge, record the revocation reason here."
                        maxLength={1000}
                      />
                      <button
                        onClick={() => handleVerificationStatusUpdate("revoked", {
                          rationale: verificationReviewRationale.trim() || undefined,
                          revocationReason: verificationRevocationReason.trim() || undefined,
                        }, "Verification badge revoked and donor-facing metadata updated.")}
                        disabled={verificationState === "loading" || !verificationRevocationReason.trim()}
                        className="w-full bg-red-600 hover:bg-red-700 text-white font-semibold px-6 py-3 rounded-xl transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {verificationState === "loading" ? "Revoking…" : "Revoke Badge"}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Donation Match Funds */}
      <div className="card mt-6">
        <h2 className="font-display text-xl font-bold text-forest-900 mb-2">Donation Match Funds</h2>
        <p className="text-sm text-[#4b654b] font-body mb-4">
          View and manage donation matching for this project.
        </p>

        {matches.length === 0 ? (
          <p className="text-sm text-[#4b654b] font-body">No active donation matches.</p>
        ) : (
          <div className="space-y-3">
            {matches.map((m: any) => (
              <div key={m.id} className="p-4 rounded-xl border border-forest-100 bg-forest-50">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <p className="text-sm font-semibold text-forest-900 font-body">
                      {m.multiplier}x matching
                    </p>
                    <p className="text-xs text-[#547454] font-body">
                      Matcher: {shortenAddress(m.matcherAddress)}
                    </p>
                  </div>
                  <span className="text-xs px-2 py-1 rounded-full bg-green-100 border border-green-200 text-green-700 font-body">
                    Active
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-3 mt-3">
                  <div>
                    <p className="text-[10px] uppercase tracking-widest font-bold text-forest-800 opacity-50">Cap (XLM)</p>
                    <p className="text-sm font-semibold text-forest-900 font-body">{formatXLM(m.capXLM, 2, localeTag)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-widest font-bold text-forest-800 opacity-50">Matched</p>
                    <p className="text-sm font-semibold text-forest-900 font-body">{formatXLM(m.matchedXLM, 2, localeTag)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-widest font-bold text-forest-800 opacity-50">Remaining</p>
                    <p className="text-sm font-semibold text-forest-900 font-body">{formatXLM(m.remainingXLM, 2, localeTag)}</p>
                  </div>
                </div>
                <p className="text-xs text-[#547454] font-body mt-2">
                  Expires: {new Date(m.expiresAt).toLocaleDateString()}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
