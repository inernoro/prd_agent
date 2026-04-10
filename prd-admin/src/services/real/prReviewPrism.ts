import { apiRequest } from '@/services/real/apiClient';
import api from '@/services/api';
import type { ApiResponse } from '@/types/api';

export type PrReviewPrismGateStatus = 'pending' | 'completed' | 'missing' | 'error';
export interface PrReviewPrismStatus {
  appKey: string;
  phase: string;
  message: string;
}

export interface PrReviewPrismTopDesignSetupStatus {
  repoRootDetected: boolean;
  repoRoot?: string | null;
  targetRepo?: string | null;
  designSourcesExists: boolean;
  activeSourceId?: string | null;
  activeVersion?: string | null;
  usesBootstrapPlaceholder: boolean;
  repoBindingsExists: boolean;
  repoBindingsHasRepositoryEntry: boolean;
  topDesignDocExists: boolean;
  anchorsExists: boolean;
  contextsExists: boolean;
  slicesExists: boolean;
  ready: boolean;
}

export interface PrReviewPrismSetupStatus {
  githubTokenConfigured: boolean;
  topDesign: PrReviewPrismTopDesignSetupStatus;
  readyForFullRefresh: boolean;
  guidance: string[];
}

export interface PrReviewPrismTokenConfigStatus {
  tokenConfigured: boolean;
  tokenMasked?: string | null;
  source: 'none' | 'environment' | 'appSettings';
  canWrite: boolean;
  guidance: string[];
}

export interface PrReviewPrismRepoSkillPackageRequest {
  repo: string;
  owner: string;
  context: string;
  anchorId: string;
}

export interface PrReviewPrismRepoSkillPackageResponse {
  fileName: string;
  contentBase64: string;
}

export interface PrReviewPrismSubmission {
  id: string;
  ownerUserId: string;
  ownerDisplayName: string;
  repoOwner: string;
  repoName: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  note?: string | null;
  pullRequestTitle: string;
  pullRequestAuthor: string;
  pullRequestState: string;
  headSha?: string | null;
  gateStatus: PrReviewPrismGateStatus;
  gateConclusion?: string | null;
  gateDetailsUrl?: string | null;
  decisionSuggestion?: string | null;
  riskScore?: number | null;
  confidencePercent?: number | null;
  blockersTriggered?: boolean | null;
  blockers: string[];
  advisories: string[];
  focusQuestions: string[];
  decisionCardCommentUrl?: string | null;
  decisionCardUpdatedAt?: string | null;
  lastRefreshedAt?: string | null;
  lastRefreshError?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PrReviewPrismBatchRefreshFailure {
  id: string;
  code: string;
  message: string;
}

export interface PrReviewPrismBatchRefreshResult {
  total: number;
  successCount: number;
  failureCount: number;
  submissions: PrReviewPrismSubmission[];
  failures: PrReviewPrismBatchRefreshFailure[];
}

export interface PrReviewPrismGateStatusCounts {
  completed: number;
  pending: number;
  missing: number;
  error: number;
}

export async function getPrReviewPrismStatus(): Promise<ApiResponse<PrReviewPrismStatus>> {
  return apiRequest(api.prReviewPrism.status());
}

export async function getPrReviewPrismSetupStatus(repo?: string): Promise<ApiResponse<PrReviewPrismSetupStatus>> {
  const params = new URLSearchParams();
  if (repo && repo.trim()) {
    params.set('repo', repo.trim());
  }
  const path = params.size > 0 ? `${api.prReviewPrism.setupStatus()}?${params.toString()}` : api.prReviewPrism.setupStatus();
  return apiRequest(path);
}

export async function getPrReviewPrismTokenConfigStatus(): Promise<ApiResponse<PrReviewPrismTokenConfigStatus>> {
  return apiRequest(api.prReviewPrism.tokenConfig.status());
}

export async function updatePrReviewPrismTokenConfig(
  token: string
): Promise<ApiResponse<PrReviewPrismTokenConfigStatus>> {
  return apiRequest(api.prReviewPrism.tokenConfig.update(), {
    method: 'PUT',
    body: { token },
  });
}

export async function downloadPrReviewPrismRepoBootstrapSkill(
  req: PrReviewPrismRepoSkillPackageRequest
): Promise<ApiResponse<PrReviewPrismRepoSkillPackageResponse>> {
  return apiRequest(api.prReviewPrism.bootstrapSkillPackage(), {
    method: 'POST',
    body: {
      repo: req.repo,
      owner: req.owner,
      context: req.context,
      anchorId: req.anchorId,
    },
  });
}

export async function listPrReviewPrismSubmissions(
  page = 1,
  pageSize = 20,
  q?: string,
  gateStatus?: PrReviewPrismGateStatus,
  repo?: string
): Promise<ApiResponse<{
  items: PrReviewPrismSubmission[];
  total: number;
  page: number;
  pageSize: number;
  gateStatusCounts: PrReviewPrismGateStatusCounts;
  repo?: string | null;
}>> {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
  });
  if (q && q.trim()) {
    params.set('q', q.trim());
  }
  if (gateStatus) {
    params.set('gateStatus', gateStatus);
  }
  if (repo && repo.trim()) {
    params.set('repo', repo.trim());
  }
  return apiRequest(`${api.prReviewPrism.submissions.list()}?${params.toString()}`);
}

export async function createPrReviewPrismSubmission(
  pullRequestUrl: string,
  note?: string
): Promise<ApiResponse<{ submission: PrReviewPrismSubmission; reused: boolean }>> {
  return apiRequest(api.prReviewPrism.submissions.create(), {
    method: 'POST',
    body: { pullRequestUrl, note },
  });
}

export async function getPrReviewPrismSubmission(
  id: string
): Promise<ApiResponse<{ submission: PrReviewPrismSubmission }>> {
  return apiRequest(api.prReviewPrism.submissions.byId(id));
}

export async function refreshPrReviewPrismSubmission(
  id: string
): Promise<ApiResponse<{ submission: PrReviewPrismSubmission }>> {
  return apiRequest(api.prReviewPrism.submissions.refresh(id), { method: 'POST' });
}

export async function batchRefreshPrReviewPrismSubmissions(
  ids: string[]
): Promise<ApiResponse<PrReviewPrismBatchRefreshResult>> {
  return apiRequest(api.prReviewPrism.submissions.batchRefresh(), {
    method: 'POST',
    body: { ids },
  });
}

export async function deletePrReviewPrismSubmission(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return apiRequest(api.prReviewPrism.submissions.delete(id), { method: 'DELETE' });
}
