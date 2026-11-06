import { ApiError, apiRequest, apiUrl } from './api';

export type CodeReviewStatus = 'queued' | 'preparing' | 'running' | 'archiving' | 'completed' | 'failed' | 'cancelled';

export interface CodeReviewTask {
  id: string;
  projectId: string;
  title: string;
  sourceType: 'zip' | 'github';
  sourceName: string;
  commitSha?: string;
  sourceHash?: string;
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
