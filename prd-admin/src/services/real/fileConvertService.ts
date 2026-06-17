import { apiRequest } from './apiClient';
import { ok, fail, type ApiResponse } from '@/types/api';

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
  lastTemplateFileName: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function parseSourceFile(file: File): Promise<ApiResponse<ParseSourceResult>> {
  const form = new FormData();
  form.append('file', file);
  const token = sessionStorage.getItem('authToken') || '';
  const res = await fetch('/api/file-convert/parse-source', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Client': 'admin',
    },
    body: form,
  });
  const data = await res.json() as { error?: string } & ParseSourceResult;
  if (!res.ok) return fail('UNKNOWN', data?.error ?? '上传失败');
  return ok(data as ParseSourceResult);
}

export async function parseTemplateFile(file: File): Promise<ApiResponse<ParseTemplateResult>> {
  const form = new FormData();
  form.append('file', file);
  const token = sessionStorage.getItem('authToken') || '';
  const res = await fetch('/api/file-convert/parse-template', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Client': 'admin',
    },
    body: form,
  });
  const data = await res.json() as { error?: string } & ParseTemplateResult;
  if (!res.ok) return fail('UNKNOWN', data?.error ?? '上传失败');
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
  const token = sessionStorage.getItem('authToken') || '';
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
  lastTemplateFileName?: string;
}): Promise<ApiResponse<{ ruleId: string }>> {
  return apiRequest('/api/file-convert/rules', { method: 'POST', body: payload });
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
