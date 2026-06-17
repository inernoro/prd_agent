import { apiRequest } from './apiClient';
import { ok, fail, type ApiResponse } from '@/types/api';
import { useAuthStore } from '@/stores/authStore';

export interface FieldMapping {
  sourceColumn: string;
  templatePlaceholder: string;
}

export interface ParseSourceResult {
  fileKey: string;
  fileName: string;
  columns: string[];
  previewRows: Record<string, string>[];
  totalRows: number;
}

export interface ParseTemplateResult {
  fileKey: string;
  fileName: string;
  placeholders: string[];
}

export interface FileConvertTask {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  sourceFileName: string;
  templateFileName: string;
  totalRows: number;
  processedRows: number;
  hasResult: boolean;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FileConvertRule {
  id: string;
  name: string;
  description: string | null;
  fieldMappings: FieldMapping[];
  lastSourceFileName: string | null;
  /** 若有值，表示规则附带了永久保存的模板，加载规则后无需重新上传模板 */
  templateFileKey: string | null;
  templateFileName: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 从后端原始 JSON（任意格式）中提取可读错误字符串，永远返回 string */
function extractErrorMessage(data: unknown, fallback = '上传失败'): string {
  if (!data || typeof data !== 'object') return fallback;
  const d = data as Record<string, unknown>;
  // 优先: {"error": "string"}
  if (typeof d.error === 'string' && d.error) return d.error;
  // 次选: {"error": {"message": "string"}} — 全局异常处理器格式
  if (d.error && typeof d.error === 'object') {
    const e = d.error as Record<string, unknown>;
    if (typeof e.message === 'string' && e.message) return e.message;
  }
  // 兜底: {"message": "string"}
  if (typeof d.message === 'string' && d.message) return d.message;
  return fallback;
}

export async function parseSourceFile(file: File): Promise<ApiResponse<ParseSourceResult>> {
  const form = new FormData();
  form.append('file', file);
  const token = useAuthStore.getState().token ?? '';
  const res = await fetch('/api/file-convert/parse-source', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Client': 'admin',
    },
    body: form,
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) return fail('UNKNOWN', extractErrorMessage(data, '源文件解析失败'));
  return ok(data as ParseSourceResult);
}

export async function parseTemplateFile(file: File): Promise<ApiResponse<ParseTemplateResult>> {
  const form = new FormData();
  form.append('file', file);
  const token = useAuthStore.getState().token ?? '';
  const res = await fetch('/api/file-convert/parse-template', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Client': 'admin',
    },
    body: form,
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) return fail('UNKNOWN', extractErrorMessage(data, '模板文件解析失败'));
  return ok(data as ParseTemplateResult);
}

export async function createTask(payload: {
  sourceFileKey: string;
  sourceFileName: string;
  templateFileKey: string;
  templateFileName: string;
  fieldMappings: FieldMapping[];
  ruleId?: string | null;
}): Promise<ApiResponse<{ taskId: string }>> {
  return apiRequest('/api/file-convert/tasks', { method: 'POST', body: payload });
}

export async function listTasks(): Promise<ApiResponse<FileConvertTask[]>> {
  return apiRequest('/api/file-convert/tasks');
}

export async function downloadResult(taskId: string): Promise<void> {
  const token = useAuthStore.getState().token ?? '';
  const res = await fetch(`/api/file-convert/tasks/${taskId}/download`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Client': 'admin' },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error ?? '下载失败');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const cd = res.headers.get('content-disposition') ?? '';
  const match = cd.match(/filename="?([^"]+)"?/);
  a.download = match?.[1] ?? 'result.zip';
  a.click();
  URL.revokeObjectURL(url);
}

export async function listRules(): Promise<ApiResponse<FileConvertRule[]>> {
  return apiRequest('/api/file-convert/rules');
}

export async function saveRule(payload: {
  name: string;
  description?: string;
  fieldMappings: FieldMapping[];
  lastSourceFileName?: string;
  /** 若传入，后端将把临时模板提升为永久存储并绑定到规则 */
  tempTemplateFileKey?: string;
  templateFileName?: string;
}): Promise<ApiResponse<{ ruleId: string }>> {
  const token = useAuthStore.getState().token ?? '';
  const res = await fetch('/api/file-convert/rules', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Client': 'admin',
    },
    body: JSON.stringify(payload),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) return fail('UNKNOWN', extractErrorMessage(data, '保存规则失败'));
  return ok((data ?? {}) as { ruleId: string });
}

export async function updateRule(
  ruleId: string,
  payload: {
    name: string;
    description?: string;
    fieldMappings: FieldMapping[];
  }
): Promise<ApiResponse<{ ok: boolean }>> {
  return apiRequest(`/api/file-convert/rules/${ruleId}`, { method: 'PUT', body: payload });
}

export async function deleteRule(ruleId: string): Promise<ApiResponse<{ ok: boolean }>> {
  return apiRequest(`/api/file-convert/rules/${ruleId}`, { method: 'DELETE' });
}
