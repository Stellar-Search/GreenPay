/**
 * lib/api.ts — Backend HTTP client
 */
import axios from "axios";
import type {
  ClimateProject,
  Donation,
  DonorProfile,
  FreelancerProfile,
  ProjectUpdate,
  LeaderboardEntry,
  EscrowJob,
  ProjectCampaign,
} from "@/utils/types";

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000",
  headers: { "Content-Type": "application/json" },
  timeout: 10000,
  withCredentials: true,
});

interface ApiSuccessEnvelope<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

interface ApiErrorEnvelope {
  success: false;
  error: ApiErrorPayload;
}

type ApiEnvelope<T> = ApiSuccessEnvelope<T> | ApiErrorEnvelope;

export interface ApiErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiClientError extends Error {
  code: string;
  status: number;
  details?: unknown;
  response?: unknown;

  constructor(error: ApiErrorPayload, status: number, response?: unknown) {
    super(error.message);
    this.name = "ApiClientError";
    this.code = error.code;
    this.status = status;
    this.details = error.details;
    this.response = response;
  }
}

export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiClientError) {
    return error.message;
  }

  return fallback;
}

function unwrapApiEnvelope<T>(payload: ApiEnvelope<T>): { data: T; meta?: Record<string, unknown> } | null {
  if (!payload || typeof payload !== "object" || !("success" in payload)) {
    return null;
  }

  if (payload.success) {
    return { data: payload.data, meta: payload.meta };
  }

  return null;
}

function responseMeta(response: unknown): Record<string, unknown> | undefined {
  return (response as { apiMeta?: Record<string, unknown> }).apiMeta;
}

// All API routes are served under the versioned `/api/v1` prefix (issue #204).
// Rewrite `/api/*` request paths to `/api/v1/*` from a single place so every
// helper below stays on the unversioned path string.
api.interceptors.request.use((config) => {
  if (config.url && config.url.startsWith("/api/") && !config.url.startsWith("/api/v1/")) {
    config.url = config.url.replace(/^\/api\//, "/api/v1/");
  }
  return config;
});

let csrfToken: string | null = null;

async function refreshCsrfToken() {
  const { data } = await api.get<{ csrfToken: string }>(
    "/api/csrf-token",
  );
  csrfToken = data.csrfToken;
  return csrfToken;
}

api.interceptors.request.use(async (config) => {
  const method = config.method?.toUpperCase();
  const isMutating = method && ["POST", "PUT", "PATCH", "DELETE"].includes(method);

  if (isMutating) {
    if (!csrfToken) {
      await refreshCsrfToken();
    }

    if (csrfToken) {
      config.headers.set("X-CSRF-Token", csrfToken);
    }
  }

  return config;
});

const ADMIN_TOKEN_STORAGE_KEY = "greenpay_admin_token";
const ADMIN_REFRESH_TOKEN_STORAGE_KEY = "greenpay_admin_refresh_token";

let adminToken: string | null =
  typeof window !== "undefined" ? window.sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) : null;
let adminRefreshToken: string | null =
  typeof window !== "undefined" ? window.sessionStorage.getItem(ADMIN_REFRESH_TOKEN_STORAGE_KEY) : null;

export function setAdminToken(token: string | null, refreshToken: string | null = null) {
  adminToken = token;
  adminRefreshToken = refreshToken;
  if (typeof window === "undefined") return;
  if (token) {
    window.sessionStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
    if (refreshToken) {
      window.sessionStorage.setItem(ADMIN_REFRESH_TOKEN_STORAGE_KEY, refreshToken);
    }
  } else {
    window.sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    window.sessionStorage.removeItem(ADMIN_REFRESH_TOKEN_STORAGE_KEY);
  }
}

export function logoutAdmin() {
  setAdminToken(null);
  // Clear any redirect/refresh state if needed. In-flight promise handles itself.
}

export function isAdminAuthenticated(): boolean {
  return !!adminToken;
}

api.interceptors.request.use((config) => {
  if (adminToken) {
    config.headers.set("Authorization", `Bearer ${adminToken}`);
  }
  return config;
});

let refreshPromise: Promise<string | null> | null = null;

async function refreshAdminSession(): Promise<string | null> {
  if (!adminRefreshToken) return null;
  try {
    const { data } = await api.post<{ token: string; expiresIn: number }>(
      "/api/admin/refresh",
      { refreshToken: adminRefreshToken },
    );

    setAdminToken(data.token, adminRefreshToken);
    return data.token;
  } catch (err) {
    logoutAdmin();
    return null;
  }
}

api.interceptors.response.use(
  (response) => {
    const envelope = unwrapApiEnvelope(response.data);
    if (envelope) {
      (response as { apiMeta?: Record<string, unknown> }).apiMeta = envelope.meta;
      response.data = envelope.data;
    }
    return response;
  },
  async (error) => {
    const originalRequest = error.config;
    
    if (error.response?.status === 403 && !originalRequest.__csrfRetry) {
      originalRequest.__csrfRetry = true;
      csrfToken = null;
      await refreshCsrfToken();
      if (csrfToken) {
        originalRequest.headers = {
          ...originalRequest.headers,
          "X-CSRF-Token": csrfToken,
        };
        return api.request(originalRequest);
      }
    }

    if (error.response?.status === 401 && adminRefreshToken && !originalRequest.__authRetry) {
      originalRequest.__authRetry = true;
      
      if (!refreshPromise) {
        refreshPromise = refreshAdminSession().finally(() => {
          refreshPromise = null;
        });
      }
      
      const newToken = await refreshPromise;
      if (newToken) {
        originalRequest.headers = {
          ...originalRequest.headers,
          Authorization: `Bearer ${newToken}`,
        };
        return api.request(originalRequest);
      }
    }

    const body = error.response?.data;
    if (body?.success === false && body.error?.code && body.error?.message) {
      return Promise.reject(new ApiClientError(body.error, error.response.status, error.response));
    }

    return Promise.reject(error);
  },
);

export async function csrfFetch(input: RequestInfo, init: RequestInit = {}) {
  const method = init.method?.toUpperCase() || "GET";
  const needsToken = ["POST", "PUT", "PATCH", "DELETE"].includes(method);

  if (needsToken) {
    if (!csrfToken) {
      await refreshCsrfToken();
    }

    init.headers = {
      ...(init.headers as Record<string, string>),
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken ?? "",
    };
    init.credentials = "include";
  }

  return fetch(input, init);
}

export async function parseApiFetchResponse<T>(response: Response): Promise<T> {
  const body = await response.json() as ApiEnvelope<T>;

  if (body.success === true) {
    return body.data;
  }

  throw new ApiClientError(body.error, response.status, response);
}

// ── Projects ──────────────────────────────────────────────────────────────────
export async function fetchProjects(params?: {
  category?: string;
  status?: string;
  verified?: boolean;
  search?: string;
  limit?: number;
}) {
  const { data } = await api.get<ClimateProject[]>(
    "/api/projects",
    { params },
  );
  return data;
}

export async function fetchProject(id: string) {
  const { data } = await api.get<ClimateProject>(
    `/api/projects/${id}`,
  );
  return data;
}

export interface AISummaryResponse {
  aiSummary: string;
  aiSummaryGeneratedAt: string;
  aiSummaryModel: string;
  aiSummarySourceHash: string;
}

/**
 * Trigger backend AI-summary generation for a project. Server-side this is
 * gated to the project owner (caller's `adminAddress` must equal the
 * project's wallet address), so this should only be called from the admin
 * "Refresh summary" path.
 */
export async function generateProjectSummary(
  projectId: string,
  adminAddress: string,
): Promise<AISummaryResponse> {
  const { data } = await api.post<AISummaryResponse>(
    `/api/projects/${projectId}/generate-summary`,
    { adminAddress },
  );
  return data;
}

export async function createProjectCampaign(
  projectId: string,
  payload: {
    title: string;
    goalXLM: string;
    deadline: string;
    description?: string;
  },
) {
  const { data } = await api.post<ProjectCampaign>(
    `/api/projects/${projectId}/campaigns`,
    payload,
  );
  return data;
}

// ── Matching ──────────────────────────────────────────────────────────────────
export async function fetchProjectMatches(projectId: string) {
  const { data } = await api.get<Array<{
      id: string;
      projectId: string;
      matcherAddress: string;
      capXLM: string;
      multiplier: number;
      matchedXLM: string;
      remainingXLM: string;
      expiresAt: string;
      createdAt: string;
    }>>(`/api/projects/${projectId}/matching`);
  return data;
}

// ── Donations ─────────────────────────────────────────────────────────────────
export async function recordDonation(payload: {
  projectId: string;
  donorAddress: string;
  amountXLM?: string;
  amount?: string;
  currency?: "XLM" | "USDC";
  message?: string;
  transactionHash: string;
}) {
  const { data } = await api.post<Donation>(
    "/api/donations",
    payload,
  );
  return data;
}

export async function fetchProjectDonations(
  projectId: string,
  limit = 20,
  cursor?: string,
) {
  const params: { limit: number; cursor?: string } = { limit };
  if (cursor) params.cursor = cursor;
  const response = await api.get<Donation[]>(`/api/donations/project/${projectId}`, { params });
  const { data } = response;
  return { donations: data, nextCursor: (responseMeta(response)?.nextCursor as string | null | undefined) ?? null };
}

export async function fetchProjectDonationMessages(projectId: string, limit = 10) {
  const { data } = await api.get<Donation[]>(
    `/api/donations/project/${projectId}/messages`,
    { params: { limit } },
  );
  return data;
}

export async function fetchDonorHistory(publicKey: string) {
  const { data } = await api.get<Donation[]>(
    `/api/donations/donor/${publicKey}`,
  );
  return data;
}

// ── Profiles ──────────────────────────────────────────────────────────────────
export async function fetchProfile(publicKey: string) {
  const { data } = await api.get<DonorProfile>(
    `/api/profiles/${publicKey}`,
  );
  return data;
}

export async function fetchFreelancerProfile(publicKey: string) {
  const { data } = await api.get<FreelancerProfile>(
    `/api/profiles/${publicKey}`,
  );
  return data;
}

export async function upsertProfile(
  payload: Partial<DonorProfile> & { publicKey: string },
) {
  const { data } = await api.post<DonorProfile>(
    "/api/profiles",
    payload,
  );
  return data;
}

// ── Leaderboard ───────────────────────────────────────────────────────────────
export async function fetchLeaderboard(limit = 20, period = "all", offset = 0) {
  const { data } = await api.get<LeaderboardEntry[]>("/api/leaderboard", { params: { limit, period, offset } });
  return data;
}

// ── Jobs (escrow) ───────────────────────────────────────────────────────────
export async function fetchJobs() {
  const { data } = await api.get<EscrowJob[]>(
    "/api/jobs",
  );
  return data;
}

export async function fetchJob(id: string) {
  const { data } = await api.get<EscrowJob>(
    `/api/jobs/${id}`,
  );
  return data;
}

/**
 * Mark job completed after on-chain release_escrow succeeds (stores release tx hash).
 */
export async function completeJobRelease(
  jobId: string,
  releaseTransactionHash: string,
) {
  const { data } = await api.patch<EscrowJob>(
    `/api/jobs/${jobId}/release`,
    { releaseTransactionHash },
  );
  return data;
}

// ── Project Updates ─────────────────────────────────────────────
export async function fetchProjectUpdates(projectId: string) {
  const { data } = await api.get<ProjectUpdate[]>(
    `/api/updates/${projectId}`,
  );
  return data;
}

export async function createProjectUpdate(payload: {
  projectId: string;
  title: string;
  body: string;
  adminKey?: string;
}) {
  const { data } = await api.post<ProjectUpdate>(
    "/api/updates",
    payload,
  );
  return data;
}

// ── Subscriptions ────────────────────────────────────────────────
export async function subscribeToProject(payload: {
  projectId: string;
  email: string;
  donorAddress?: string;
}) {
  const { data } = await api.post<{ message: string }>(
    "/api/subscriptions",
    payload,
  );
  return data;
}

export async function fetchSubscriberCount(projectId: string) {
  const { data } = await api.get<{ count: number }>(
    `/api/subscriptions/${projectId}/count`,
  );
  return data.count;
}

// ── Global Stats ─────────────────────────────────────────────────
export interface GlobalStats {
  totalDonations: number;
  totalXLMRaised: string;
  totalCO2OffsetKg: number;
}

export async function fetchGlobalStats(): Promise<GlobalStats> {
  const { data } = await api.get<GlobalStats>(
    "/api/stats/global",
  );
  return data;
}

// ── Admin Login ──────────────────────────────────────────────────
export async function adminLogin(username: string, password: string) {
  const { data } = await api.post<{
    token: string;
    refreshToken: string;
    expiresIn: number;
  }>("/api/admin/login", { username, password });
  setAdminToken(data.token, data.refreshToken);
  return data;
}

export async function updateProjectStatus(
  projectId: string,
  status: "active" | "rejected" | "paused",
  reason?: string,
) {
  const { data } = await api.patch<ClimateProject>(
    `/api/projects/${projectId}/status`,
    { status, reason },
  );
  return data;
}

export async function registerProjectOnChain(payload: {
  projectId: string;
  name: string;
  wallet: string;
  co2PerXLM: number;
  adminAddress: string;
}) {
  const { data } = await api.post<{ xdr: string }>(
    "/api/projects/admin/register",
    payload,
  );
  return data;
}

export async function confirmProjectRegistration(payload: {
  projectId: string;
  transactionHash: string;
}) {
  const { data } = await api.post<ClimateProject>(
    "/api/projects/admin/confirm",
    payload,
  );
  return data;
}

// ── Admin: AI Summary Failures ────────────────────────────────────
export interface AISummaryJobFailure {
  id: string;
  projectId: string;
  payload: Record<string, unknown>;
  errorMessage: string | null;
  errorStack: string | null;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
}

export async function fetchAISummaryFailures() {
  const { data } = await api.get<AISummaryJobFailure[]>(
    "/api/admin/ai-summary-failures",
  );
  return data;
}

export async function retryAISummaryFailure(failureId: string) {
  const { data } = await api.post<{ status: string }>(
    `/api/admin/ai-summary-failures/${failureId}/retry`,
    {},
  );
  return data;
}

// ── Update Likes ─────────────────────────────────────────────────
export async function toggleUpdateLike(updateId: string, donorAddress: string) {
  const { data } = await api.post<{ liked: boolean; likeCount: number }>(
    `/api/updates/${updateId}/like`,
    { donorAddress },
  );
  return data;
}

export async function fetchUpdateLikes(updateId: string, donorAddress?: string) {
  const params: Record<string, string> = {};
  if (donorAddress) params.donorAddress = donorAddress;
  const { data } = await api.get<{ liked: boolean; likeCount: number }>(
    `/api/updates/${updateId}/likes`,
    { params },
  );
  return data;
}

// ── Featured Project ─────────────────────────────────────────────
export async function fetchFeaturedProject(): Promise<ClimateProject | null> {
  try {
    const { data } = await api.get<ClimateProject>(
      "/api/projects/featured",
    );
    return data;
  } catch {
    return null;
  }
}

// ── Category Stats ───────────────────────────────────────────────
export interface CategoryStats {
  category: string;
  count: number;
}

export async function fetchCategoryStats(): Promise<CategoryStats[]> {
  const { data } = await api.get<CategoryStats[]>(
    "/api/stats/categories",
  );
  return data;
}

// ── Impact Aggregation ───────────────────────────────────────────────────────
export interface ImpactProjectStats {
  totalDonationsXLM: string;
  donorCount: number;
  co2OffsetKg: number;
  treesEquivalent: number;
  uniqueCountries: number;
}

export interface ImpactCategoryBreakdownItem {
  category: string;
  totalDonationsXLM: string;
  donorCount: number;
  co2OffsetKg: number;
}

export interface ImpactGlobalStats extends ImpactProjectStats {
  breakdownByCategory: ImpactCategoryBreakdownItem[];
}

export interface ImpactDonorStats {
  totalDonatedXLM: string;
  co2OffsetKg: number;
  projectsSupported: number;
  topCategory: string | null;
}

export async function fetchImpactProject(projectId: string): Promise<ImpactProjectStats> {
  const { data } = await api.get<ImpactProjectStats>(
    `/api/impact/project/${projectId}`,
  );
  return data;
}

export async function fetchImpactGlobal(): Promise<ImpactGlobalStats> {
  const { data } = await api.get<ImpactGlobalStats>(
    "/api/impact/global",
  );
  return data;
}

export async function fetchImpactDonor(publicKey: string): Promise<ImpactDonorStats> {
  const { data } = await api.get<ImpactDonorStats>(
    `/api/impact/donor/${publicKey}`,
  );
  return data;
}

export interface SubmitProjectPayload {
  name: string;
  category: string;
  description: string;
  location: string;
  goalXLM: string;
  walletAddress: string;
  organization: {
    name: string;
    website: string;
    country: string;
    contactEmail: string;
  };
  co2Methodology: {
    name: string;
    verificationBody: string;
    annualTonnesCO2: string;
    documentUrl: string;
  };
}

export interface SubmitProjectResponse {
  id: string;
  reviewTimeline: string;
}

export async function submitProject(payload: SubmitProjectPayload): Promise<SubmitProjectResponse> {
  const { data } = await api.post<SubmitProjectResponse>(
    "/api/projects",
    payload,
  );
  return data;
}

// ── Network Graph (on-chain transaction visualizer) ─────────────────────────
export interface NetworkNode {
  id: string;
  totalIn: number;
  totalOut: number;
  degree: number;
}

export interface NetworkEdge {
  source: string;
  target: string;
  amount: number;
  type: "donation" | "escrow";
  txHash: string;
}

export interface TransactionGraph {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
}

export async function fetchTransactionGraph(limit?: number): Promise<TransactionGraph> {
  const { data } = await api.get<TransactionGraph>(
    "/api/network/graph",
    { params: limit ? { limit } : undefined },
  );
  return data;
}
