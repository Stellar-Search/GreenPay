/**
 * utils/types.ts
 * Shared TypeScript types for Stellar GreenPay.
 */

/**
 * Supported project categories shown in the UI.
 */
export type ProjectCategory =
  | "Reforestation"
  | "Solar Energy"
  | "Ocean Conservation"
  | "Clean Water"
  | "Wildlife Protection"
  | "Carbon Capture"
  | "Wind Energy"
  | "Sustainable Agriculture"
  | "Other";

/**
 * Lifecycle status for a project in the marketplace.
 */
export type ProjectStatus = "active" | "completed" | "paused" | "rejected";

/**
 * A climate project listed on Stellar GreenPay.
 */
export interface ClimateProject {
  id: string;
  name: string;
  description: string;
  category: string;
  sourceCategory?: ProjectCategory;
  location: string;
  imageUrl?: string;
  walletAddress: string;       // Stellar address that receives donations
  goalXLM: string;             // fundraising goal
  raisedXLM: string;           // total raised so far
  donorCount: number;
  /** @deprecated Legacy operator input; use /api/impact project claims. */
  co2OffsetKg: number;
  /** @deprecated Retained for old contract/project payload compatibility only. */
  co2_per_xlm?: number;
  status: ProjectStatus;
  rejectionReason?: string | null;
  verified: boolean;
  onChainVerified?: boolean;
  contractRegisteredAt?: number | null;
  totalRaisedOnChain?: string;
  verificationExpiresAt?: string | null;
  verificationRevokedAt?: string | null;
  verificationRevocationReason?: string | null;
  verificationDecisionTxHash?: string | null;
  verificationDecisionContractId?: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  campaigns?: ProjectCampaign[];
  activeCampaign?: ProjectCampaign | null;
  averageRating?: number;
  ratingCount?: number;
  milestones?: ProjectMilestone[];
  // Cached AI-generated impact summary (populated by
  // POST /api/projects/:id/generate-summary). Null until the project owner
  // generates one. `aiSummarySourceHash` is a SHA-256 of the description at
  // generation time so the UI can surface a "needs refresh" hint when the
  // description has been edited since.
  aiSummary?: string | null;
  aiSummaryGeneratedAt?: string | null;
  aiSummaryModel?: string | null;
  aiSummarySourceHash?: string | null;
  serverNow?: number;
  sourceLanguage?: "en" | "es" | "ar";
  contentLanguage?: "en" | "es" | "ar";
  contentDirection?: "ltr" | "rtl";
  requestedLanguage?: "en" | "es" | "ar" | null;
  usedFallback?: boolean;
  machineTranslated?: boolean;
}

export type ProjectVerificationStatus =
  | "wallet_proof_pending"
  | "submitted"
  | "under_review"
  | "community_vote"
  | "approved"
  | "rejected"
  | "revoked"
  | "expired";

export interface ProjectVerificationApplication {
  id: string;
  projectId: string;
  submittedByWallet: string;
  status: ProjectVerificationStatus;
  attestationSummary?: string | null;
  walletChallengeExpiresAt?: string | null;
  walletVerifiedAt?: string | null;
  submittedAt?: string | null;
  communityVoteOpensAt?: string | null;
  communityVoteClosesAt?: string | null;
  approvedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
  revocationReason?: string | null;
  decisionTxHash?: string | null;
  decisionContractId?: string | null;
  latestRationale?: string | null;
  evidenceCount: number;
  proofCount: number;
  attestationCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectVerificationEvidence {
  id: string;
  applicationId: string;
  evidenceType: "wallet_control" | "legal_identity" | "project_documentation" | "impact_evidence" | "other";
  attestationType: "cryptographic_proof" | "human_attestation";
  documentHash: string;
  storageUri?: string | null;
  private: boolean;
  submittedBy: string;
  notes?: string | null;
  createdAt: string;
}

export interface ProjectVerificationEvent {
  id: string;
  applicationId: string;
  actor: string;
  actorType: "project_wallet" | "platform_admin" | "dao" | "system";
  fromStatus?: ProjectVerificationStatus | null;
  toStatus: ProjectVerificationStatus;
  rationale?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface ProjectVerificationStatusResponse {
  projectId: string;
  walletAddress: string;
  verified: boolean;
  onChainVerified: boolean;
  verificationExpiresAt?: string | null;
  verificationRevokedAt?: string | null;
  verificationRevocationReason?: string | null;
  verificationDecisionTxHash?: string | null;
  verificationDecisionContractId?: string | null;
  badgeExpired?: boolean;
  badgeRevoked?: boolean;
  currentStatus?: ProjectVerificationStatus | null;
  contractRegisteredAt?: number | null;
  totalRaisedOnChain?: string;
  latestApplication?: ProjectVerificationApplication | null;
  timeline: ProjectVerificationEvent[];
  publicEvidence?: ProjectVerificationEvidence[];
}

/**
 * A project milestone representing progress towards a goal.
 */
export interface ProjectMilestone {
  id: string;
  projectId: string;
  percentage: number;
  title: string;
  reachedAt?: string | null;
  transactionHash?: string | null;
  createdAt: string;
}

/**
 * A time-limited fundraising campaign for a project.
 */
export interface ProjectCampaign {
  id: string;
  projectId: string;
  title: string;
  description: string;
  goalXLM: string;
  raisedXLM: string;
  deadline: string;
  progressPercent: number;
  completed: boolean;
  active: boolean;
  createdAt: string;
}

/**
 * A donation record associated with a project and donor.
 */
export interface Donation {
  id: string;
  projectId: string;
  donorAddress: string;
  // Amount as stored and the currency used (e.g. "XLM" or "USDC").
  amountXLM?: string;
  amount?: string;
  currency?: "XLM" | "USDC";
  message?: string;
  transactionHash: string;
  createdAt: string;
  // On-chain contract data
  contractRecordId?: string;
  // Matching status
  isMatched?: boolean;
  matchedBy?: string;
}

/**
 * Donor profile information stored off-chain.
 */
export interface DonorProfile {
  publicKey: string;
  displayName?: string;
  bio?: string;
  totalDonatedXLM: string;
  projectsSupported: number;
  badges: DonorBadge[];
  createdAt: string;
}

/**
 * Badge tiers awarded to donors based on total donations.
 */
export type BadgeTier = "seedling" | "tree" | "forest" | "earth";

/**
 * Freelancer profile used in the escrow/jobs feature.
 */
export interface FreelancerProfile {
  publicKey: string;
  displayName?: string;
  bio?: string;
  skills: string[];
  completedJobs: number;
  totalEarnedXLM: string;
  createdAt: string;
}

/**
 * A donor badge earned at a point in time.
 */
export interface DonorBadge {
  tier: BadgeTier;
  earnedAt: string;
  projectId?: string;
}

/**
 * Project update post displayed in the updates feed.
 */
export interface ProjectUpdate {
  id: string;
  projectId: string;
  title: string;
  body: string;
  imageUrl?: string;
  createdAt: string;
  publishedAt?: string | null;
  editedAt?: string | null;
  revision?: number;
  moderationStatus?:
    | "pending"
    | "published_pending_review"
    | "published"
    | "rejected"
    | "removed"
    | "appealed";
  isEdited?: boolean;
  underReview?: boolean;
  sourceLanguage?: "en" | "es" | "ar";
  contentLanguage?: "en" | "es" | "ar";
  contentDirection?: "ltr" | "rtl";
  requestedLanguage?: "en" | "es" | "ar" | null;
  usedFallback?: boolean;
  machineTranslated?: boolean;
}

export interface ProjectUpdateRevision {
  revision: number;
  title: string;
  body: string;
  sourceLanguage: "en" | "es" | "ar";
  editReason: string;
  replacedAt: string;
}

export interface ProjectUpdateHistory {
  currentRevision: number;
  editedAt: string | null;
  revisions: ProjectUpdateRevision[];
}

export type ProjectUpdateReportReason =
  | "fraudulent_claim"
  | "abuse"
  | "spam"
  | "off_topic_solicitation"
  | "dangerous_content"
  | "privacy"
  | "other";

/**
 * Leaderboard entry representing a donor's rank and totals.
 */
export interface LeaderboardEntry {
  rank: number;
  publicKey: string;
  displayName?: string;
  totalDonatedXLM: string;
  projectsSupported: number;
  topBadge?: BadgeTier;
}

/**
 * Minimal project payload used by the donate page.
 */
export interface DonateProject {
  id: string;
  name: string;
  description: string;
  category: ProjectCategory;
  walletAddress: string;
  goalXLM: number;
  raisedXLM: number;
}

/**
 * Props provided to the donate page.
 */
export interface DonatePageProps {
  
  project: DonateProject | null;
  presetAmount: number | null;
}

/**
 * Status for an escrow job in the jobs marketplace.
 */
export type EscrowJobStatus = "draft" | "in_escrow" | "completed";

/**
 * Escrow job funded on-chain and tracked off-chain.
 */
export interface EscrowJob {
  id: string;
  title: string;
  description: string;
  clientPublicKey: string;
  freelancerPublicKey: string;
  amountEscrowXlm: string;
  status: EscrowJobStatus;
  releaseTransactionHash?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * History entry for monthly subscription payments.
 */
export interface MonthlyDonationHistoryItem {
  paidAt: string;
  amountXLM: string;
}

/**
 * Recurring monthly donation subscription state.
 *
 * `anchorDay` and `timeZone` define the donor-local billing schedule (see
 * frontend/lib/monthlyGiving.ts and docs/monthly-giving-scheduling.md).
 * They are optional in the type because subscriptions created before this
 * fields existed may still be sitting in a donor's localStorage; loader code
 * backfills sensible defaults for those records.
 */
export interface MonthlySubscription {
  id: string;
  projectId: string;
  projectName: string;
  amountXLM: string;
  startDate: string;
  durationMonths: number | null;
  nextDueDate: string;
  remainingMonths: number | null;
  status: "active" | "completed";
  createdAt: string;
  history: MonthlyDonationHistoryItem[];
  /** Immutable calendar day-of-month (1-31) the donor picked as their billing anchor. */
  anchorDay?: number;
  /** IANA timezone (e.g. "America/New_York") the donor's schedule is anchored to. */
  timeZone?: string;
}
