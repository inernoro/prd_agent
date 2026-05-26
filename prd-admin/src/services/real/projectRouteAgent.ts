import { apiRequest } from './apiClient';
import type { ApiResponse } from '@/types/api';

/** AI 抽取出的、本次分析实际克隆的仓库（V2 替代 V1 的 ProjectRouteRepoEntry） */
export interface ProjectRouteExtractedRepo {
  appName: string;
  repoUrl: string;
  branch: string;
  routemapPath: string;
  reasoning?: string | null;
}

export interface ProjectRouteSiteSpec {
  id: string;
  title: string;
  markdownContent: string;
  isActive: boolean;
  createdBy: string;
  updatedBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ProjectRouteResolutionStatus =
  | 'Hit'
  | 'NotFound'
  | 'Ambiguous'
  | 'CloneFailed'
  | 'NoRoutemap';

/** V2 重构后按仓库分组：每条 = 一个仓库 + 该仓库下命中的项目路径 + 关联到的 apps/modules */
export interface ProjectRouteResolution {
  repoUrl: string;
  repoAppName: string;
  projectPaths: string[];
  matchedAppsOrModules: string[];
  reasoning?: string | null;
  status: ProjectRouteResolutionStatus;
}

export type ProjectRoutePlanStatus = 'Queued' | 'Running' | 'Done' | 'Error';

export interface ProjectRoutePlan {
  id: string;
  submitterId: string;
  submitterName: string;
  title: string;
  attachmentId: string;
  fileName: string;
  extractedContent?: string | null;
  siteSpecId?: string | null;
  extractedApps: string[];
  extractedModules: string[];
  extractedRepos: ProjectRouteExtractedRepo[];
  resolutions: ProjectRouteResolution[];
  status: ProjectRoutePlanStatus;
  errorMessage?: string | null;
  model?: string | null;
  modelPlatform?: string | null;
  submittedAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
}

// ──────────────────────────────────────────────
// 公共站点说明（管理员）
// ──────────────────────────────────────────────

export async function getActiveSiteSpec(): Promise<
  ApiResponse<{ siteSpec: ProjectRouteSiteSpec | null }>
> {
  return apiRequest('/api/project-route-agent/site-spec');
}

export async function upsertSiteSpec(payload: {
  title: string;
  markdownContent: string;
}): Promise<ApiResponse<{ siteSpec: ProjectRouteSiteSpec; mode: 'created' | 'updated' }>> {
  return apiRequest('/api/project-route-agent/site-spec', {
    method: 'POST',
    body: payload,
  });
}

// ──────────────────────────────────────────────
// 方案 plans
// ──────────────────────────────────────────────

export async function createPlan(
  title: string,
  attachmentId: string
): Promise<ApiResponse<{ plan: ProjectRoutePlan }>> {
  return apiRequest('/api/project-route-agent/plans', {
    method: 'POST',
    body: { title, attachmentId },
  });
}

export async function listMyPlans(
  page = 1,
  pageSize = 50
): Promise<
  ApiResponse<{ items: ProjectRoutePlan[]; total: number; page: number; pageSize: number }>
> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  return apiRequest(`/api/project-route-agent/plans?${params}`);
}

export async function getPlan(
  id: string
): Promise<ApiResponse<{ plan: ProjectRoutePlan }>> {
  return apiRequest(`/api/project-route-agent/plans/${encodeURIComponent(id)}`);
}

export async function deletePlan(
  id: string
): Promise<ApiResponse<{ deleted: boolean }>> {
  return apiRequest(`/api/project-route-agent/plans/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/**
 * 分析阶段 SSE 流地址（不带 ?afterSeq；这是内联 SSE，断线就要重发）。
 * useSseStream 会自动附 Authorization 头。
 */
export function getAnalyzeStreamUrl(planId: string): string {
  return `/api/project-route-agent/plans/${encodeURIComponent(planId)}/analyze/stream`;
}

// ──────────────────────────────────────────────
// GitHub OAuth 状态（共享 pr-review 的授权）
// ──────────────────────────────────────────────

export interface ProjectRouteGitHubStatus {
  connected: boolean;
  githubLogin?: string | null;
  avatarUrl?: string | null;
  scopes?: string | null;
  connectedAt?: string | null;
}

export async function getProjectRouteGitHubStatus(): Promise<ApiResponse<ProjectRouteGitHubStatus>> {
  return apiRequest('/api/project-route-agent/github/status');
}
