import { ApiError, apiRequest, apiUrl } from './api';
import type { CodeReviewResultPage } from '../../../src/shared/code-review-result';
export { REVIEW_CATEGORIES, REVIEW_SEVERITIES, REVIEW_SEVERITY_LABELS } from '../../../src/shared/code-review-result';
export type { CodeReviewFinding, CodeReviewResultPage } from '../../../src/shared/code-review-result';

export type CodeReviewStatus = 'queued' | 'preparing' | 'running' | 'archiving' | 'completed' | 'failed' | 'cancelled';

export interface CodeReviewTask {
  id: string;
  projectId: string;
  title: string;
  sourceType: 'zip' | 'github' | 'report';
  sourceName: string;
  githubUrl?: string;
  ref?: string;
  excludePatterns?: string[];
  commitSha?: string;
  sourceHash?: string;
  inputSkippedFiles?: number;
  engineCompleted?: boolean;
  status: CodeReviewStatus;
  phase: string;
  progress: { totalFiles: number; scannedFiles: number };
  createdAt: string;
  updatedAt: string;
  error?: string;
  reportId?: string;
  delivery: {
    status: 'not_requested' | 'pending' | 'sending' | 'sent' | 'failed';
    email?: string;
    error?: string;
  };
  findingsSummary?: Record<string, number>;
}

export interface CodeReviewSubmission {
  projectId: string;
  sourceType: 'zip' | 'github';
  file?: File;
  githubUrl?: string;
  ref?: string;
  excludePatterns?: string[];
  email?: string;
}

export const CODE_REVIEW_STATUS: Record<CodeReviewStatus, { label: string; active: boolean }> = {
  queued: { label: '排队中', active: true },
  preparing: { label: '准备源码', active: true },
  running: { label: '审查中', active: true },
  archiving: { label: '归档中', active: true },
  completed: { label: '已完成', active: false },
  failed: { label: '失败', active: false },
  cancelled: { label: '已取消', active: false },
};

export function codeReviewReportUrl(task: Pick<CodeReviewTask, 'id' | 'projectId' | 'reportId'>): string | null {
  if (!task.reportId) return null;
  return `/code-reviews?${new URLSearchParams({ project: task.projectId, task: task.id, report: '1' })}`;
}

export async function listCodeReviews(projectId: string, signal?: AbortSignal): Promise<CodeReviewTask[]> {
  const query = projectId ? `?${new URLSearchParams({ projectId })}` : '';
  const response = await apiRequest<{ tasks: CodeReviewTask[] }>(`/api/code-reviews${query}`, { signal });
  return response.tasks;
}

export interface CodeReviewRead {
  task: CodeReviewTask;
  result: CodeReviewResultPage | null;
  resultLoading?: boolean;
  reportUrl: string;
  downloadUrl?: string | null;
  resultUnavailableReason?: string;
}
export function readCodeReview(id: string, options: { offset?: number; limit?: number; severity?: string; query?: string } = {}, signal?: AbortSignal): Promise<CodeReviewRead> {
  const query = new URLSearchParams({ includeResult: '1' });
  if (options.offset !== undefined) query.set('offset', String(options.offset));
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  if (options.severity) query.set('severity', options.severity);
  if (options.query) query.set('q', options.query);
  return apiRequest<CodeReviewRead>(`/api/code-reviews/${encodeURIComponent(id)}?${query}`, { signal });
}

export async function uploadCodeReviewReport(projectId: string, title: string, file: File, signal?: AbortSignal): Promise<CodeReviewTask> {
  const form = new FormData();
  form.set('projectId', projectId); form.set('title', title); form.set('file', file);
  form.set('format', /\.(md|markdown)$/i.test(file.name) ? 'md' : 'html');
  const response = await fetch(apiUrl('/api/code-reviews/reports'), { method: 'POST', body: form, credentials: 'include', signal });
  const payload = await response.json() as { task?: CodeReviewTask; report?: { id: string }; message?: string };
  if (!response.ok) throw new Error(payload.message || '报告未能保存，请重试');
  if (payload.task) return payload.task;
  // Content deduplication can return an existing archive instead of a new task.
  const tasks = await listCodeReviews(projectId, signal);
  const existing = tasks.find(task => task.reportId === payload.report?.id);
  if (!existing) throw new Error('报告已保存，请返回列表刷新查看');
  return existing;
}

export async function submitCodeReview(input: CodeReviewSubmission, signal?: AbortSignal): Promise<CodeReviewTask> {
  if (input.sourceType === 'github') {
    const { task } = await apiRequest<{ task: CodeReviewTask }>('/api/code-reviews', {
      method: 'POST',
      body: {
        projectId: input.projectId,
        sourceType: input.sourceType,
        githubUrl: input.githubUrl,
        ref: input.ref || undefined,
        excludePatterns: input.excludePatterns,
        email: input.email || undefined,
      },
      signal,
    });
    return task;
  }
  if (!input.file) throw new Error('请选择 ZIP 压缩包');
  const form = new FormData();
  form.set('projectId', input.projectId);
  form.set('sourceType', 'zip');
  form.set('file', input.file);
  form.set('excludePatterns', JSON.stringify(input.excludePatterns || []));
  if (input.email) form.set('email', input.email);
  // FormData must go directly to fetch: apiRequest serializes bodies as JSON.
  const response = await fetch(apiUrl('/api/code-reviews'), { method: 'POST', body: form, credentials: 'include', signal });
  const text = await response.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!response.ok) {
    const detail = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    throw new ApiError(response.status, body,
      typeof detail.message === 'string' ? detail.message : `上传失败（HTTP ${response.status}），请重试`,
      response.headers.get('x-cds-request-id') || undefined);
  }
  if (!body || typeof body !== 'object' || !('task' in body)) throw new Error('服务器未返回审查任务，请刷新任务列表确认');
  return (body as { task: CodeReviewTask }).task;
}

export async function codeReviewAction(id: string, action: 'cancel' | 'retry' | 'delivery/retry'): Promise<CodeReviewTask> {
  const { task } = await apiRequest<{ task: CodeReviewTask }>(`/api/code-reviews/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
  return task;
}

/** Fetch before saving so downloads retain the same authentication as API reads. */
export async function downloadCodeReviewReport(id: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(apiUrl(`/api/code-reviews/${encodeURIComponent(id)}/report/download`), {
    credentials: 'include', signal,
  });
  if (!response.ok) {
    let message = `报告下载失败（HTTP ${response.status}），请重试`;
    try {
      const body: unknown = await response.json();
      if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') message = body.message;
    } catch { /* Non-JSON errors retain the HTTP failure message. */ }
    throw new Error(message);
  }
  return response.blob();
}
