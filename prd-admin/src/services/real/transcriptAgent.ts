import { apiRequest } from './apiClient';
import { useAuthStore } from '@/stores/authStore';
import { ok, fail, type ApiResponse } from '@/types/api';
import type {
  TranscriptWorkspace,
  TranscriptItem,
  TranscriptRun,
  TranscriptTemplate,
  TranscriptSegment,
} from '../contracts/transcriptAgent';

const BASE = '/api/transcript-agent';

// ── Workspaces ──
export const listWorkspaces = () =>
  apiRequest<TranscriptWorkspace[]>(`${BASE}/workspaces`, { method: 'GET' });

export const createWorkspace = (title: string) =>
  apiRequest<TranscriptWorkspace>(`${BASE}/workspaces`, { method: 'POST', body: { title } });

export const getWorkspace = (id: string) =>
  apiRequest<TranscriptWorkspace>(`${BASE}/workspaces/${id}`, { method: 'GET' });

export const deleteWorkspace = (id: string) =>
  apiRequest(`${BASE}/workspaces/${id}`, { method: 'DELETE' });

// ── Items ──
export const listItems = (workspaceId: string) =>
  apiRequest<TranscriptItem[]>(`${BASE}/workspaces/${workspaceId}/items`, { method: 'GET' });

export const uploadItem = async (workspaceId: string, file: File): Promise<ApiResponse<{ item: TranscriptItem; runId: string }>> => {
  // FormData 上传不走 apiRequest（会被 JSON 序列化），对照 avatarAssets.ts 写法
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const fd = new FormData();
  fd.append('file', file);

  const rawBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
  const url = rawBase
    ? `${rawBase}${BASE}/workspaces/${workspaceId}/items/upload`
    : `${BASE}/workspaces/${workspaceId}/items/upload`;

  try {
    const res = await fetch(url, { method: 'POST', headers, body: fd });
    const text = await res.text();
    if (!res.ok) {
      return fail('UPLOAD_ERROR', `上传失败（HTTP ${res.status}）`) as unknown as ApiResponse<{ item: TranscriptItem; runId: string }>;
    }
    try {
      const json = JSON.parse(text);
      // 如果服务器已返回 ApiResponse 格式
      if ('success' in json && 'data' in json) {
        return json as ApiResponse<{ item: TranscriptItem; runId: string }>;
      }
      // Controller 直接返回裸对象 {item, runId}
      return ok(json as { item: TranscriptItem; runId: string });
    } catch {
      return fail('PARSE_ERROR', '响应解析失败') as unknown as ApiResponse<{ item: TranscriptItem; runId: string }>;
    }
  } catch (e) {
    return fail('NETWORK_ERROR', e instanceof Error ? e.message : '网络错误') as unknown as ApiResponse<{ item: TranscriptItem; runId: string }>;
  }
};

export const deleteItem = (itemId: string) =>
  apiRequest(`${BASE}/items/${itemId}`, { method: 'DELETE' });

export const renameItem = (itemId: string, fileName: string) =>
  apiRequest(`${BASE}/items/${itemId}/rename`, { method: 'PATCH', body: { fileName } });

export const updateSegments = (itemId: string, segments: TranscriptSegment[]) =>
  apiRequest(`${BASE}/items/${itemId}/segments`, { method: 'PUT', body: segments });

// ── Copywrite ──
export const createCopywriteRun = (itemId: string, templateId: string) =>
  apiRequest<TranscriptRun>(`${BASE}/items/${itemId}/copywrite`, {
    method: 'POST',
    body: { templateId },
  });

// ── Templates ──
export const listTemplates = () =>
  apiRequest<TranscriptTemplate[]>(`${BASE}/templates`, { method: 'GET' });

// ── Runs ──
export const deleteRun = (runId: string) =>
  apiRequest<{ id: string }>(`${BASE}/runs/${runId}`, { method: 'DELETE' });

export const getRun = (runId: string) =>
  apiRequest<TranscriptRun>(`${BASE}/runs/${runId}`, { method: 'GET' });

export const listRuns = (workspaceId: string) =>
  apiRequest<TranscriptRun[]>(`${BASE}/workspaces/${workspaceId}/runs`, { method: 'GET' });

// ── Export ──
export const exportItem = (itemId: string, formats: string[]) =>
  apiRequest<Record<string, string>>(`${BASE}/items/${itemId}/export`, {
    method: 'POST',
    body: { formats },
  });
