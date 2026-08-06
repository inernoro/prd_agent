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
  /** 锚点分 0-10（存量旧任务为 1-5 制，展示口径看 run.anchorScale；证据缺失时为系统保守化后的值） */
  anchor: number;
  /** LLM 原始锚点分（仅被系统调整时填充） */
  originalAnchor?: number | null;
  weight: number;
  /** 加权得分 = anchor x weight / anchorScale */
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
  /** 合理性判定（评论驱动）：合理 / 不合理 / null=评论未给出判定 */
  reasonablenessVerdict?: string | null;
  /** 合理性判定依据（评论原文引用） */
  reasonablenessEvidence?: string | null;
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
  /** 产品经理评论列索引（前五因子的最高优先级证据源） */
  commentColumnIndexes?: number[];
  /** 锚点分制（10 = 0-10 分制；旧任务缺省 5 = 1-5 分制），仅影响展示口径 */
  anchorScale?: number;
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

/**
 * 上传需求表（.xls / .xlsx）并直接创建评估任务。
 * 列映射由后端自动综合（详细描述为核心证据源），创建后任务即 Queued。
 * FormData 上传不能走 apiRequest（会被 JSON 序列化），直接 fetch + Authorization。
 */
export async function createAssessment(
  file: File,
  title?: string
): Promise<ApiResponse<{ run: RequirementAssessmentRun }>> {
  const { useAuthStore } = await import('@/stores/authStore');
  const token = useAuthStore.getState().token;
  const fd = new FormData();
  fd.append('file', file);
  if (title) fd.append('title', title);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch('/api/review-agent/assessments', {
      method: 'POST',
      headers,
      body: fd,
      credentials: 'same-origin',
    });
    const text = await res.text();
    try {
      return JSON.parse(text) as ApiResponse<{ run: RequirementAssessmentRun }>;
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
