import { apiRequest } from './apiClient';
import { useAuthStore } from '@/stores/authStore';
import type { ApiResponse } from '@/types/api';

// ── Types ──────────────────────────────────────────────────────────────────

export interface PaSubTask {
  content: string;
  done: boolean;
}

export interface PaTask {
  id: string;
  userId: string;
  sessionId?: string;
  title: string;
  subTasks: PaSubTask[];
  quadrant: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  status: 'pending' | 'done' | 'archived';
  deadline?: string;
  reasoning?: string;
  contentHash?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaMessage {
  id: string;
  userId: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  taskJson?: string;
  createdAt: string;
}

export interface CreateTaskRequest {
  title: string;
  quadrant: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  sessionId?: string;
  reasoning?: string;
  subTasks?: string[];
  deadline?: string;
  contentHash?: string;
}

export interface UpdateTaskRequest {
  title?: string;
  quadrant?: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  status?: 'pending' | 'done' | 'archived';
  deadline?: string;
  subTasks?: PaSubTask[];
}

// ── Session ────────────────────────────────────────────────────────────────

export async function getPaSession(): Promise<ApiResponse<{ sessionId: string }>> {
  return apiRequest<{ sessionId: string }>('/api/pa-agent/session');
}

// ── Messages ───────────────────────────────────────────────────────────────

export async function getPaMessages(sessionId: string, limit = 50): Promise<ApiResponse<PaMessage[]>> {
  return apiRequest<PaMessage[]>(
    `/api/pa-agent/messages?sessionId=${encodeURIComponent(sessionId)}&limit=${limit}`,
  );
}

// ── Tasks ──────────────────────────────────────────────────────────────────

export async function getPaTasks(params?: { quadrant?: string; status?: string }): Promise<ApiResponse<PaTask[]>> {
  const qs = new URLSearchParams();
  if (params?.quadrant) qs.set('quadrant', params.quadrant);
  if (params?.status) qs.set('status', params.status);
  const query = qs.toString() ? `?${qs.toString()}` : '';
  return apiRequest<PaTask[]>(`/api/pa-agent/tasks${query}`);
}

export async function createPaTask(req: CreateTaskRequest): Promise<ApiResponse<PaTask>> {
  return apiRequest<PaTask>('/api/pa-agent/tasks', { method: 'POST', body: req });
}

export async function updatePaTask(id: string, req: UpdateTaskRequest): Promise<ApiResponse<PaTask>> {
  return apiRequest<PaTask>(`/api/pa-agent/tasks/${id}`, { method: 'PATCH', body: req });
}

export async function deletePaTask(id: string): Promise<ApiResponse<void>> {
  return apiRequest<void>(`/api/pa-agent/tasks/${id}`, { method: 'DELETE' });
}

export async function updatePaSubTask(taskId: string, index: number, done: boolean): Promise<ApiResponse<PaTask>> {
  return apiRequest<PaTask>(`/api/pa-agent/tasks/${taskId}/subtasks/${index}`, {
    method: 'PATCH',
    body: { done },
  });
}

// ── File Upload ────────────────────────────────────────────────────────────

export interface PaUploadResult {
  fileName: string;
  mimeType: string;
  fileSize: number;
  charCount: number;
  extractedText: string;
}

export async function uploadPaFile(file: File): Promise<ApiResponse<PaUploadResult>> {
  const token = useAuthStore.getState().token;
  const baseUrl = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').replace(/\/+$/, '');
  const form = new FormData();
  form.append('file', file);

  try {
    const resp = await fetch(`${baseUrl}/api/pa-agent/upload`, {
      method: 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: form,
    });
    const json = await resp.json() as ApiResponse<PaUploadResult>;
    return json;
  } catch (e) {
    return { success: false, data: null as unknown as PaUploadResult, error: { code: 'NETWORK_ERROR', message: (e as Error)?.message ?? '上传失败' } } as unknown as ApiResponse<PaUploadResult>;
  }
}

// ── SSE Chat Stream ────────────────────────────────────────────────────────

export interface PaChatChunk {
  type: 'delta' | 'done' | 'error';
  content?: string;
  message?: string;
}

export interface StreamPaChatOptions {
  sessionId: string;
  message: string;
  attachedText?: string;
  attachedFileName?: string;
  onChunk: (chunk: PaChatChunk) => void;
  onDone: () => void;
  onError: (err: string) => void;
}

export async function streamPaChat(opts: StreamPaChatOptions): Promise<() => void> {
  const token = useAuthStore.getState().token;

  const controller = new AbortController();

  void (async () => {
    try {
      const baseUrl = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').replace(/\/+$/, '');
      const url = `${baseUrl}/api/pa-agent/chat`;

      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          sessionId: opts.sessionId,
          message: opts.message,
          attachedText: opts.attachedText,
          attachedFileName: opts.attachedFileName,
        }),
        signal: controller.signal,
      });

      if (!resp.ok || !resp.body) {
        opts.onError(`HTTP ${resp.status}`);
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;
          try {
            const chunk = JSON.parse(raw) as PaChatChunk & { attempt?: number };
            if (chunk.type === 'done') {
              opts.onDone();
            } else if (chunk.type === 'error') {
              const raw_msg = chunk.message ?? '';
              const friendly = raw_msg.includes('User not found')
                ? 'AI 服务暂时不可用，请稍后重试'
                : raw_msg || '未知错误';
              opts.onError(friendly);
            } else if ((chunk as { type: string }).type === 'retry') {
              opts.onChunk({ type: 'delta', content: '\u200B' });
            } else {
              opts.onChunk(chunk);
            }
          } catch {
            // ignore parse errors
          }
        }
      }
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') {
        opts.onError((e as Error)?.message ?? '连接失败');
      }
    }
  })();

  return () => controller.abort();
}
