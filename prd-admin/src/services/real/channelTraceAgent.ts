import { apiRequest } from './apiClient';
import type { ApiResponse } from '@/types/api';

// ──────────────────────────────────────────────
// 类型
// ──────────────────────────────────────────────

export interface ChannelTraceKnowledge {
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdBy: string;
  createdByName: string;
  updatedBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ChannelTraceCaseSeverity = 'low' | 'medium' | 'high';

export interface ChannelTraceCase {
  id: string;
  title: string;
  symptom: string;
  rootCause?: string | null;
  resolution?: string | null;
  tags: string[];
  severity: ChannelTraceCaseSeverity;
  createdBy: string;
  createdByName: string;
  updatedBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ChannelTraceDiffStatus = 'Queued' | 'Running' | 'Done' | 'Error';

export interface ChannelTraceDiff {
  id: string;
  title: string;
  businessRule: string;
  codeContent: string;
  codeLocation?: string | null;
  diffReport?: string | null;
  status: ChannelTraceDiffStatus;
  errorMessage?: string | null;
  model?: string | null;
  modelPlatform?: string | null;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  completedAt?: string | null;
}

/** 智能排查时召回的相似案例（轻量字段） */
export interface ChannelTraceRelatedCase {
  id: string;
  title: string;
  severity: ChannelTraceCaseSeverity;
  tags: string[];
}

// ──────────────────────────────────────────────
// 业务知识库
// ──────────────────────────────────────────────

export async function listKnowledge(
  keyword?: string,
): Promise<ApiResponse<{ items: ChannelTraceKnowledge[] }>> {
  const qs = keyword ? `?keyword=${encodeURIComponent(keyword)}` : '';
  return apiRequest(`/api/channel-trace-agent/knowledge${qs}`);
}

export async function createKnowledge(payload: {
  title: string;
  content: string;
  tags?: string[];
}): Promise<ApiResponse<{ item: ChannelTraceKnowledge }>> {
  return apiRequest('/api/channel-trace-agent/knowledge', { method: 'POST', body: payload });
}

export async function updateKnowledge(
  id: string,
  payload: { title: string; content: string; tags?: string[] },
): Promise<ApiResponse<{ item: ChannelTraceKnowledge }>> {
  return apiRequest(`/api/channel-trace-agent/knowledge/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: payload,
  });
}

export async function deleteKnowledge(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return apiRequest(`/api/channel-trace-agent/knowledge/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/** 业务知识问答 SSE 流地址（POST，内联 SSE，断线重发） */
export const knowledgeAskUrl = '/api/channel-trace-agent/knowledge/ask';

// ──────────────────────────────────────────────
// 线上问题案例库
// ──────────────────────────────────────────────

export async function listCases(
  keyword?: string,
): Promise<ApiResponse<{ items: ChannelTraceCase[] }>> {
  const qs = keyword ? `?keyword=${encodeURIComponent(keyword)}` : '';
  return apiRequest(`/api/channel-trace-agent/cases${qs}`);
}

export interface UpsertCasePayload {
  title: string;
  symptom: string;
  rootCause?: string;
  resolution?: string;
  tags?: string[];
  severity?: ChannelTraceCaseSeverity;
}

export async function createCase(
  payload: UpsertCasePayload,
): Promise<ApiResponse<{ item: ChannelTraceCase }>> {
  return apiRequest('/api/channel-trace-agent/cases', { method: 'POST', body: payload });
}

export async function updateCase(
  id: string,
  payload: UpsertCasePayload,
): Promise<ApiResponse<{ item: ChannelTraceCase }>> {
  return apiRequest(`/api/channel-trace-agent/cases/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: payload,
  });
}

export async function deleteCase(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return apiRequest(`/api/channel-trace-agent/cases/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/** 线上问题智能排查 SSE 流地址（POST） */
export const caseDiagnoseUrl = '/api/channel-trace-agent/cases/diagnose';

// ──────────────────────────────────────────────
// 业务/代码差异对比
// ──────────────────────────────────────────────

export async function listDiffs(
  page = 1,
  pageSize = 50,
): Promise<
  ApiResponse<{ items: ChannelTraceDiff[]; total: number; page: number; pageSize: number }>
> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  return apiRequest(`/api/channel-trace-agent/diffs?${params}`);
}

export async function getDiff(id: string): Promise<ApiResponse<{ item: ChannelTraceDiff }>> {
  return apiRequest(`/api/channel-trace-agent/diffs/${encodeURIComponent(id)}`);
}

export async function deleteDiff(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return apiRequest(`/api/channel-trace-agent/diffs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/** 业务规则 vs 代码实现对比 SSE 流地址（POST） */
export const diffCompareUrl = '/api/channel-trace-agent/diffs/compare';
