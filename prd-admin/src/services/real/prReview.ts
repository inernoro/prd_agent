/**
 * PR Review V2（pr-review）— per-user GitHub OAuth 审查工作台服务层
 *
 * 设计约定：
 * - 所有请求走 apiRequest，自动注入 JWT 与错误归一
 * - 返回 ApiResponse<T>，调用方用 res.success 判断
 * - 错误使用 res.error?.message，不是字符串
 * - 禁止 localStorage：所有状态由服务端决定
 */
import { apiRequest } from '@/services/real/apiClient';
import api from '@/services/api';
import type { ApiResponse } from '@/types/api';

// ===== 类型定义 =====

export type PrReviewState = 'open' | 'closed' | 'merged';

export interface PrReviewSnapshotDto {
  title: string;
  state: PrReviewState;
  authorLogin: string;
  authorAvatarUrl?: string | null;
  labels: string[];
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision?: string | null;
  createdAt: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  headSha: string;
}

export interface PrReviewItemDto {
  id: string;
  owner: string;
  repo: string;
  number: number;
  htmlUrl: string;
  note?: string | null;
  snapshot?: PrReviewSnapshotDto | null;
  lastRefreshedAt?: string | null;
  lastRefreshError?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PrReviewListResponse {
  page: number;
  pageSize: number;
  total: number;
  items: PrReviewItemDto[];
}

export interface PrReviewAuthStatus {
  connected: boolean;
  oauthConfigured: boolean;
  appKey: string;
  login?: string;
  avatarUrl?: string;
  scopes?: string;
  connectedAt?: string;
  lastUsedAt?: string;
}

export interface PrReviewAuthStart {
  authorizeUrl: string;
}

// ===== API 调用 =====

export async function getPrReviewAuthStatus(): Promise<ApiResponse<PrReviewAuthStatus>> {
  return apiRequest<PrReviewAuthStatus>(api.prReview.auth.status());
}

export async function startPrReviewOAuth(): Promise<ApiResponse<PrReviewAuthStart>> {
  return apiRequest<PrReviewAuthStart>(api.prReview.auth.start(), {
    method: 'POST',
  });
}

export async function disconnectPrReviewGitHub(): Promise<ApiResponse<{ deleted: boolean }>> {
  return apiRequest(api.prReview.auth.disconnect(), {
    method: 'DELETE',
  });
}

export async function listPrReviewItems(
  page = 1,
  pageSize = 20,
): Promise<ApiResponse<PrReviewListResponse>> {
  return apiRequest<PrReviewListResponse>(api.prReview.items.list(page, pageSize));
}

export async function createPrReviewItem(
  pullRequestUrl: string,
  note?: string,
): Promise<ApiResponse<PrReviewItemDto>> {
  return apiRequest<PrReviewItemDto>(api.prReview.items.create(), {
    method: 'POST',
    body: { pullRequestUrl, note: note?.trim() || undefined },
  });
}

export async function refreshPrReviewItem(id: string): Promise<ApiResponse<PrReviewItemDto>> {
  return apiRequest<PrReviewItemDto>(api.prReview.items.refresh(id), {
    method: 'POST',
  });
}

export async function updatePrReviewItemNote(
  id: string,
  note: string | null,
): Promise<ApiResponse<{ updated: boolean }>> {
  return apiRequest(api.prReview.items.updateNote(id), {
    method: 'PATCH',
    body: { note },
  });
}

export async function deletePrReviewItem(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return apiRequest(api.prReview.items.delete(id), {
    method: 'DELETE',
  });
}
