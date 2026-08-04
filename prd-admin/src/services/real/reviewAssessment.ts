import { apiRequest } from './apiClient';
import type { ApiResponse } from '@/types/api';

// ──────────────────────────────────────────────
// 产品评审员 — 需求评估（Excel 需求表批量评估 + 优先级排序）
// ──────────────────────────────────────────────

export interface RequirementFactorDefinition {
  key: string;
  name: string;
  weight: number;
  ruleRef: number;
  anchorGuide: string;
}

export interface RequirementFactorScore {
  key: string;
  name: string;
  /** 锚点分 1-5（证据缺失时为系统保守化后的值） */
  anchor: number;
  /** LLM 原始锚点分（仅被系统调整时填充） */
  originalAnchor?: number | null;
  weight: number;
  /** 加权得分 = anchor x weight / 5 */
  weightedScore: number;
  hasEvidence: boolean;
  evidence: string;
}

export type RequirementItemStatus = 'Pending' | 'Scored' | 'Error';

export interface RequirementAssessmentItem {
  id: string;
  runId: string;
  rowIndex: number;
  name: string;
  rawFields: Record<string, string>;
  factorScores: RequirementFactorScore[];
  totalScore: number;
  confidencePercent: number;
  missingInfo: string[];
  conclusion: string;
  /** 全局优先级序号（1 起，数字越小越优先） */
  priority?: number | null;
  tier?: string | null;
  isContractualOverride: boolean;
  adjustmentLog: string[];
  status: RequirementItemStatus;
  errorMessage?: string | null;
  scoredAt?: string | null;
}

export type RequirementAssessmentStatus = 'Draft' | 'Queued' | 'Running' | 'Done' | 'Error';

export interface RequirementAssessmentRun {
  id: string;
  ownerUserId: string;
  ownerName: string;
  title: string;
  fileName: string;
  sheetName: string;
  headers: string[];
  totalRowCount: number;
  truncated: boolean;
  nameColumnIndex?: number | null;
  descColumnIndex?: number | null;
  factorColumnMapping: Record<string, number[]>;
  weightsSnapshot: { key: string; name: string; weight: number }[];
  status: RequirementAssessmentStatus;
  scoredCount: number;
  itemCount: number;
  globalMissingHints: string[];
  errorMessage?: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface SuggestedColumnMapping {
  nameColumnIndex?: number | null;
  descColumnIndex?: number | null;
  factorColumns: Record<string, number[]>;
}

export interface ParseAssessmentResponse {
  run: RequirementAssessmentRun;
  headers: string[];
  previewRows: string[][];
  rowCount: number;
  truncated: boolean;
  totalRowCount: number;
  suggestedMapping: SuggestedColumnMapping;
  factors: RequirementFactorDefinition[];
}

/**
 * 上传需求表并解析（.xls / .xlsx）。
 * FormData 上传不能走 apiRequest（会被 JSON 序列化），直接 fetch + Authorization。
 */
export async function parseAssessmentExcel(
  file: File,
  title?: string
): Promise<ApiResponse<ParseAssessmentResponse>> {
  const { useAuthStore } = await import('@/stores/authStore');
  const token = useAuthStore.getState().token;
  const fd = new FormData();
  fd.append('file', file);
  if (title) fd.append('title', title);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch('/api/review-agent/assessments/parse', {
      method: 'POST',
      headers,
      body: fd,
      credentials: 'same-origin',
    });
    const text = await res.text();
    try {
      return JSON.parse(text) as ApiResponse<ParseAssessmentResponse>;
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

export async function startAssessment(
  id: string,
  body: {
    title?: string;
    nameColumnIndex: number;
    descColumnIndex?: number | null;
    factorColumns: Record<string, number[]>;
  }
): Promise<ApiResponse<{ run: RequirementAssessmentRun }>> {
  return apiRequest(`/api/review-agent/assessments/${encodeURIComponent(id)}/start`, {
    method: 'POST',
    body,
  });
}

export async function listAssessments(
  page = 1,
  pageSize = 20,
  all = false
): Promise<ApiResponse<{ items: RequirementAssessmentRun[]; total: number; page: number; pageSize: number }>> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (all) params.set('all', 'true');
  return apiRequest(`/api/review-agent/assessments?${params}`);
}

export async function getAssessment(
  id: string
): Promise<ApiResponse<{
  run: RequirementAssessmentRun;
  reportMarkdown?: string | null;
  items: RequirementAssessmentItem[];
  /** Draft 态附带的样例数据行（列映射确认界面用） */
  previewRows?: string[][] | null;
  factors: RequirementFactorDefinition[];
}>> {
  return apiRequest(`/api/review-agent/assessments/${encodeURIComponent(id)}`);
}

export async function rerunAssessment(id: string): Promise<ApiResponse<{ message: string }>> {
  return apiRequest(`/api/review-agent/assessments/${encodeURIComponent(id)}/rerun`, { method: 'POST' });
}

/** SSE 评估执行流 URL（供 useSseStream / connectSse 使用） */
export function getAssessmentStreamUrl(id: string): string {
  return `/api/review-agent/assessments/${encodeURIComponent(id)}/stream`;
}

/** 下载评估报告 Markdown（带鉴权 fetch → blob 触发浏览器下载） */
export async function downloadAssessmentReport(id: string, fileNameHint: string): Promise<boolean> {
  const { useAuthStore } = await import('@/stores/authStore');
  const token = useAuthStore.getState().token;
  try {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`/api/review-agent/assessments/${encodeURIComponent(id)}/export`, {
      headers,
      credentials: 'same-origin',
    });
    if (!res.ok) return false;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `需求评估报告-${fileNameHint}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}
