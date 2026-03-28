import { apiRequest } from './apiClient';
import type { ApiResponse } from '@/types/api';

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

export interface ReviewDimensionConfig {
  id: string;
  key: string;
  name: string;
  maxScore: number;
  description: string;
  orderIndex: number;
  isActive: boolean;
  updatedAt: string;
  updatedBy?: string;
}

export interface ReviewDimensionScore {
  key: string;
  name: string;
  score: number;
  maxScore: number;
  comment: string;
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
  isPassed?: boolean
): Promise<ApiResponse<{ items: ReviewSubmission[]; total: number; page: number; pageSize: number }>> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (isPassed !== undefined) params.set('isPassed', String(isPassed));
  return apiRequest(`/api/review-agent/submissions?${params}`);
}

export async function getSubmitters(): Promise<ApiResponse<{ submitters: { id: string; name: string }[] }>> {
  return apiRequest('/api/review-agent/submitters');
}

export async function getAllSubmissions(
  page = 1,
  pageSize = 20,
  submitterId?: string,
  status?: string
): Promise<ApiResponse<{ items: ReviewSubmission[]; total: number; page: number; pageSize: number }>> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (submitterId) params.set('submitterId', submitterId);
  if (status) params.set('status', status);
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
