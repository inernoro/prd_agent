import { apiRequest } from './apiClient';
import type { ApiResponse } from '@/types/api';
import { connectSse } from '@/lib/useSseStream';

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

export interface DimensionCheckItem {
  id: string;
  category: string;
  text: string;
  note?: string;
}

/** 用户在表格中的勾选状态：'yes' 勾选了"是" / 'no' 勾选了"否" / 'none' 未勾选或未填表 */
export type CheckboxState = 'yes' | 'no' | 'none';

export interface DimensionCheckItemResult {
  id: string;
  category: string;
  text: string;
  /** 用户在「是否涉及」列的实际勾选 */
  involvedChecked: CheckboxState;
  /** 用户在「方案是否包含」列的实际勾选 */
  coverageChecked: CheckboxState;
  /** 反作弊核查：仅当 involvedChecked='yes' 且 coverageChecked='yes' 时才有意义 */
  solutionFound?: boolean | null;
  /** 系统按 truth table 派生的最终通过状态 */
  passed: boolean;
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
  /** LLM 原始分（调整前）。仅当被系统兜底调整时填充，否则为 null/undefined */
  originalScore?: number | null;
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
  rerunCount?: number;
  /** 申诉状态：未申诉 / 审理中 / 已通过 / 已驳回 */
  appealStatus?: 'Pending' | 'Approved' | 'Rejected' | null;
  latestAppealId?: string;
  appealResolvedAt?: string;
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
  /** 系统三层兜底（evidence gate / 数据密度封顶 / summary 一致性闸）的调整日志，空数组表示未触发任何调整 */
  adjustmentLog?: string[];
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

/**
 * 未通过救机会：替换附件并触发重新评审。仅当 isPassed=false 且 RerunCount=0 时可调用。
 */
export async function reuploadOnFailure(
  id: string,
  attachmentId: string
): Promise<ApiResponse<{ message: string }>> {
  return apiRequest(`/api/review-agent/submissions/${encodeURIComponent(id)}/reupload-on-failure`, {
    method: 'POST',
    body: { attachmentId },
  });
}

/** 获取该 submission 的所有评审历史（按时间倒序） */
export async function getSubmissionResults(
  id: string
): Promise<ApiResponse<{ results: ReviewResult[] }>> {
  return apiRequest(`/api/review-agent/submissions/${encodeURIComponent(id)}/results`);
}

export interface LeaderboardItem {
  rank: number;
  key: string;
  name: string;
  submitterId: string;
  submitterName: string;
  totalCount: number;
  passedCount: number;
  /** 申诉成功并视为"待重审"的评审数（不计入通过/未通过） */
  appealApprovedCount?: number;
  passRate: number;
  firstTimePassedCount: number;
  firstTimePassRate: number | null;
}

export interface LeaderboardSummary {
  totalCount: number;
  totalPassedCount: number;
  /** 整个时段内申诉成功的评审总数（不计入通过率分子分母） */
  totalAppealApprovedCount?: number;
  totalPassRate: number;
  totalFirstTimePassedCount: number;
  totalFirstTimePassRate: number | null;
}

export interface LeaderboardResponse {
  items: LeaderboardItem[];
  summary: LeaderboardSummary;
  period: { startMonth: string; endMonth: string };
  groupBy: 'submitter' | 'document';
}

export async function getLeaderboard(params: {
  startMonth: string;
  endMonth: string;
  groupBy: 'submitter' | 'document';
}): Promise<ApiResponse<LeaderboardResponse>> {
  const qs = new URLSearchParams({
    startMonth: params.startMonth,
    endMonth: params.endMonth,
    groupBy: params.groupBy,
  });
  return apiRequest(`/api/review-agent/leaderboard?${qs}`);
}

// ── 申诉相关 ──

export type AppealStatus = 'Pending' | 'Approved' | 'Rejected';

export interface ReviewAppeal {
  id: string;
  submissionId: string;
  submitterId: string;
  submitterName: string;
  reasonHtml: string;
  imageAttachmentIds: string[];
  status: AppealStatus;
  resolverId?: string;
  resolverName?: string;
  resolverComment?: string;
  createdAt: string;
  resolvedAt?: string;
}

export async function createAppeal(
  submissionId: string,
  body: { reasonHtml: string; imageAttachmentIds: string[] }
): Promise<ApiResponse<{ appeal: ReviewAppeal }>> {
  return apiRequest(`/api/review-agent/submissions/${encodeURIComponent(submissionId)}/appeal`, {
    method: 'POST',
    body,
  });
}

export async function listAppeals(
  submissionId: string
): Promise<ApiResponse<{ items: ReviewAppeal[] }>> {
  return apiRequest(`/api/review-agent/submissions/${encodeURIComponent(submissionId)}/appeals`);
}

export async function approveAppeal(
  appealId: string,
  body: { comment: string }
): Promise<ApiResponse<{ appeal: ReviewAppeal }>> {
  return apiRequest(`/api/review-agent/appeals/${encodeURIComponent(appealId)}/approve`, {
    method: 'POST',
    body,
  });
}

export async function rejectAppeal(
  appealId: string,
  body: { comment: string }
): Promise<ApiResponse<{ appeal: ReviewAppeal }>> {
  return apiRequest(`/api/review-agent/appeals/${encodeURIComponent(appealId)}/reject`, {
    method: 'POST',
    body,
  });
}

export async function reuploadReviewSubmission(
  submissionId: string,
  attachmentId: string
): Promise<ApiResponse<{ message: string }>> {
  return apiRequest(`/api/review-agent/submissions/${encodeURIComponent(submissionId)}/reupload`, {
    method: 'POST',
    body: { attachmentId },
  });
}

/**
 * 上传申诉富文本里粘贴/拖拽的图片，返回可内嵌 <img src> 用的 URL。
 * 不走 apiRequest（避免 JSON.stringify FormData），直接 fetch + Authorization header。
 */
export async function uploadAppealImage(
  file: File
): Promise<ApiResponse<{ attachmentId: string; url: string }>> {
  const { useAuthStore } = await import('@/stores/authStore');
  const token = useAuthStore.getState().token;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch('/api/review-agent/appeals/upload-image', {
      method: 'POST',
      headers,
      body: fd,
      credentials: 'same-origin',
    });
    const text = await res.text();
    try {
      return JSON.parse(text) as ApiResponse<{ attachmentId: string; url: string }>;
    } catch {
      return {
        success: false,
        data: null,
        error: { code: 'UPLOAD_FAILED', message: text || `上传失败 (HTTP ${res.status})` },
      };
    }
  } catch (e) {
    return {
      success: false,
      data: null,
      error: { code: 'NETWORK_ERROR', message: (e as Error).message },
    };
  }
}

// SSE 流式接口 URL（供 useSseStream 使用）
export function getResultStreamUrl(submissionId: string): string {
  return `/api/review-agent/submissions/${submissionId}/result/stream`;
}

export async function runReviewSubmission(
  submissionId: string,
  signal: AbortSignal,
  onPhase?: (message: string) => void,
): Promise<{ success: boolean; errorMessage?: string }> {
  let streamError: string | undefined;
  const result = await connectSse({
    url: getResultStreamUrl(submissionId),
    signal,
    onEvent: (event) => {
      if (!event.data) return;
      try {
        const data = JSON.parse(event.data) as { message?: string; errorMessage?: string };
        if (event.event === 'phase' && data.message) onPhase?.(data.message);
        if (event.event === 'error') streamError = data.message ?? data.errorMessage ?? '评审失败';
      } catch {
        // Ignore non-JSON keepalive payloads.
      }
    },
  });
  if (!result.success) return { success: false, errorMessage: result.errorMessage };
  if (streamError) return { success: false, errorMessage: streamError };
  return { success: true };
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
