import { apiRequest } from './apiClient';
import type { ApiResponse } from '@/types/api';

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

export interface DimensionCheckItem {
  id: string;
  category: string;
  text: string;
  note?: string;
}

export interface DimensionCheckItemResult {
  id: string;
  category: string;
  text: string;
  involved: boolean;
  covered: boolean;
  evidence?: string;
}

export interface ReviewDimensionConfig {
  id: string;
  key: string;
  name: string;
  maxScore: number;
  description: string;
  orderIndex: number;
  isActive: boolean;
  /** 子检查项（清单类维度使用，普通维度为 null/undefined） */
  items?: DimensionCheckItem[] | null;
  updatedAt: string;
  updatedBy?: string;
}

export interface ReviewDimensionScore {
  key: string;
  name: string;
  score: number;
  maxScore: number;
  comment: string;
  /** 子检查项判断结果（清单类维度使用） */
  items?: DimensionCheckItemResult[] | null;
}

export interface ReviewSubmission {
  id: string;
  submitterId: string;
  submitterName: string;
  title: string;
  attachmentId: string;
  fileName: string;
  status: 'Queued' | 'Running' | 'Done' | 'Error';
  resultId?: string;
  isPassed?: boolean;
  errorMessage?: string;
  submittedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ReviewResult {
  id: string;
  submissionId: string;
  dimensionScores: ReviewDimensionScore[];
  totalScore: number;
  isPassed: boolean;
  summary: string;
  fullMarkdown: string;
  parseError?: string;
  scoredAt: string;
}

// ──────────────────────────────────────────────
// 评审维度
// ──────────────────────────────────────────────

export async function getDimensions(): Promise<ApiResponse<{ dimensions: ReviewDimensionConfig[] }>> {
  return apiRequest('/api/review-agent/dimensions');
}

export async function updateDimensions(
  dimensions: Omit<ReviewDimensionConfig, 'updatedAt' | 'updatedBy'>[]
): Promise<ApiResponse<{ updated: number }>> {
  return apiRequest('/api/review-agent/dimensions', {
    method: 'PUT',
    body: dimensions,
  });
}

// ──────────────────────────────────────────────
// 提交管理
// ──────────────────────────────────────────────

export async function createSubmission(
  title: string,
  attachmentId: string
): Promise<ApiResponse<{ submission: ReviewSubmission }>> {
  return apiRequest('/api/review-agent/submissions', {
    method: 'POST',
    body: { title, attachmentId },
  });
}

export async function getMySubmissions(
  page = 1,
  pageSize = 50,
  filter?: string
): Promise<ApiResponse<{ items: ReviewSubmission[]; total: number; page: number; pageSize: number }>> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (filter) params.set('filter', filter);
  return apiRequest(`/api/review-agent/submissions?${params}`);
}

export async function getSubmitters(): Promise<ApiResponse<{ submitters: { id: string; name: string }[] }>> {
  return apiRequest('/api/review-agent/submitters');
}

export async function getAllSubmissions(
  page = 1,
  pageSize = 20,
  submitterId?: string,
  filter?: string
): Promise<ApiResponse<{ items: ReviewSubmission[]; total: number; page: number; pageSize: number }>> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (submitterId) params.set('submitterId', submitterId);
  if (filter) params.set('filter', filter);
  return apiRequest(`/api/review-agent/submissions/all?${params}`);
}

export async function getSubmission(
  id: string
): Promise<ApiResponse<{ submission: ReviewSubmission; result?: ReviewResult }>> {
  return apiRequest(`/api/review-agent/submissions/${id}`);
}

export async function rerunSubmission(id: string): Promise<ApiResponse<{ message: string }>> {
  return apiRequest(`/api/review-agent/submissions/${id}/rerun`, { method: 'POST' });
}

// SSE 流式接口 URL（供 useSseStream 使用）
export function getResultStreamUrl(submissionId: string): string {
  return `/api/review-agent/submissions/${submissionId}/result/stream`;
}

// ──────────────────────────────────────────────
// Webhook 配置
// ──────────────────────────────────────────────

export interface ReviewWebhookConfig {
  id: string;
  channel: string;
  webhookUrl: string;
  triggerEvents: string[];
  isEnabled: boolean;
  name?: string;
  mentionAll: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export const ReviewWebhookChannelLabels: Record<string, string> = {
  wecom: '企业微信',
  dingtalk: '钉钉',
  feishu: '飞书',
  custom: '自定义',
};

export const ReviewEventLabels: Record<string, string> = {
  review_completed: '评审完成',
};

export async function listReviewWebhooks(): Promise<ApiResponse<{ items: ReviewWebhookConfig[] }>> {
  return apiRequest('/api/review-agent/webhooks');
}

export async function createReviewWebhook(input: {
  channel: string;
  webhookUrl: string;
  triggerEvents?: string[];
  isEnabled?: boolean;
  name?: string;
  mentionAll?: boolean;
}): Promise<ApiResponse<{ webhook: ReviewWebhookConfig }>> {
  return apiRequest('/api/review-agent/webhooks', { method: 'POST', body: input });
}

export async function updateReviewWebhook(webhookId: string, input: {
  channel?: string;
  webhookUrl?: string;
  triggerEvents?: string[];
  isEnabled?: boolean;
  name?: string;
  mentionAll?: boolean;
}): Promise<ApiResponse<{ webhook: ReviewWebhookConfig }>> {
  return apiRequest(`/api/review-agent/webhooks/${encodeURIComponent(webhookId)}`, { method: 'PUT', body: input });
}

export async function deleteReviewWebhook(webhookId: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return apiRequest(`/api/review-agent/webhooks/${encodeURIComponent(webhookId)}`, { method: 'DELETE' });
}

export async function testReviewWebhook(input: {
  webhookUrl: string;
  channel?: string;
  mentionAll?: boolean;
}): Promise<ApiResponse<{ success: boolean; error?: string }>> {
  return apiRequest('/api/review-agent/webhooks/test', { method: 'POST', body: input });
}
