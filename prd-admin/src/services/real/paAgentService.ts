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

// ── Session types ──────────────────────────────────────────────────────────

export interface PaSessionInfo {
  id: string;
  userId: string;
  title: string;
  lastMessagePreview?: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

// ── Sessions API ──────────────────────────────────────────────────────────

export async function getPaSessions(): Promise<ApiResponse<PaSessionInfo[]>> {
  return apiRequest<PaSessionInfo[]>('/api/pa-agent/sessions');
}

export async function createPaSession(): Promise<ApiResponse<PaSessionInfo>> {
  return apiRequest<PaSessionInfo>('/api/pa-agent/sessions', { method: 'POST' });
}

export async function renamePaSession(id: string, title: string): Promise<ApiResponse<PaSessionInfo>> {
  return apiRequest<PaSessionInfo>(`/api/pa-agent/sessions/${id}`, { method: 'PATCH', body: { title } });
}

export async function deletePaSession(id: string): Promise<ApiResponse<void>> {
  return apiRequest<void>(`/api/pa-agent/sessions/${id}`, { method: 'DELETE' });
}

// ── Legacy single-session ─────────────────────────────────────────────────

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

// ── Profile (跨会话画像) ──────────────────────────────────────────────────

export type PaMemorySource = 'auto' | 'suggest' | 'manual';
export type PaMemoryKind = 'role' | 'project' | 'fact' | 'preference';

export interface PaMemoryEntry {
  id: string;
  kind: PaMemoryKind;
  text: string;
  source: PaMemorySource;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt?: string;
}

export interface PaWorkRhythm {
  typicalStartHour?: number | null;
  typicalEndHour?: number | null;
  weekendActive: boolean;
  perfectionismLevel?: 'low' | 'mid' | 'high' | null;
}

export interface PaUserPreferences {
  preferredAddress?: string | null;
  forbiddenTopics: string[];
  savageLevel: 'gentle' | 'default' | 'sharp';
}

export interface PaUserProfile {
  id: string;
  userId: string;
  displayNameCache: string;
  rhythm: PaWorkRhythm;
  memories: PaMemoryEntry[];
  preferences: PaUserPreferences;
  lastActiveAt: string;
  createdAt: string;
  updatedAt: string;
}

export async function getPaProfile(): Promise<ApiResponse<PaUserProfile>> {
  return apiRequest<PaUserProfile>('/api/pa-agent/profile');
}

export async function updatePaProfile(
  req: { rhythm?: Partial<PaWorkRhythm>; preferences?: Partial<PaUserPreferences> },
): Promise<ApiResponse<PaUserProfile>> {
  return apiRequest<PaUserProfile>('/api/pa-agent/profile', { method: 'PUT', body: req });
}

export async function addPaMemory(
  req: { kind: PaMemoryKind; text: string },
): Promise<ApiResponse<PaMemoryEntry>> {
  return apiRequest<PaMemoryEntry>('/api/pa-agent/profile/memories', { method: 'POST', body: req });
}

export async function confirmPaMemory(id: string): Promise<ApiResponse<PaMemoryEntry>> {
  return apiRequest<PaMemoryEntry>(`/api/pa-agent/profile/memories/${id}/confirm`, { method: 'POST' });
}

export async function deletePaMemory(id: string): Promise<ApiResponse<void>> {
  return apiRequest<void>(`/api/pa-agent/profile/memories/${id}`, { method: 'DELETE' });
}

// ── SSE Chat Stream ────────────────────────────────────────────────────────

export interface PaChatChunk {
  type: 'delta' | 'done' | 'error';
  content?: string;
  message?: string;
}

export interface PaTaskEvent {
  autoSaved: boolean;
  confidence: 'auto' | 'suggest';
  taskId?: string;
  title: string;
  quadrant: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  reasoning?: string;
  subTasks?: string[];
}

/**
 * 画像更新事件 — chat 流末尾后端解析 LLM `update_profile` JSON 块后推送。
 * confidence=auto：已立即落盘并参与下次注入；confidence=suggest：等用户在画像面板确认。
 */
export interface PaProfileEvent {
  confidence: PaMemorySource;
  addedMemories: Array<{ id: string; kind: PaMemoryKind; text: string; source: PaMemorySource }>;
  changedFields: string[];
}

export interface StreamPaChatOptions {
  sessionId: string;
  message: string;
  attachedText?: string;
  attachedFileName?: string;
  onChunk: (chunk: PaChatChunk) => void;
  onDone: () => void;
  onError: (err: string) => void;
  onTask?: (event: PaTaskEvent) => void;
  onProfileUpdate?: (event: PaProfileEvent) => void;
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
              const friendly = raw_msg.includes('OpenRouter') || raw_msg.includes('API Key')
                ? 'AI 模型服务暂时不可用，请联系管理员'
                : raw_msg || '未知错误';
              opts.onError(friendly);
            } else if ((chunk as { type: string }).type === 'retry') {
              opts.onChunk({ type: 'delta', content: '\u200B' });
            } else if ((chunk as { type: string }).type === 'task') {
              try {
                const taskData = JSON.parse((chunk as { type: string; data: string }).data) as PaTaskEvent;
                opts.onTask?.(taskData);
              } catch { /* ignore */ }
            } else if ((chunk as { type: string }).type === 'profile') {
              try {
                const data = (chunk as { type: string; data: PaProfileEvent }).data;
                if (data) opts.onProfileUpdate?.(data);
              } catch { /* ignore */ }
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

// ── Review (复盘 SSE) ──────────────────────────────────────────────────────

export type PaReviewRange = 'weekly' | 'last7d' | 'last30d' | 'custom';

export interface PaReviewStageEvent {
  type: 'stage';
  stage: 'aggregating' | 'scoring' | 'suggesting';
  message: string;
}

export interface PaReviewDoneEvent {
  type: 'done';
  sessionId?: string;
  range: string;
}

export interface StreamPaReviewOptions {
  range: PaReviewRange;
  startDate?: string;
  endDate?: string;
  onStage: (event: PaReviewStageEvent) => void;
  onDelta: (content: string) => void;
  onDone: (event: PaReviewDoneEvent) => void;
  onError: (err: string) => void;
}

/**
 * 流式复盘 — SSE 事件：stage / delta / done / error
 * 一次性调用，所有累积文本通过 onDelta 增量推送。
 */
export async function streamPaReview(opts: StreamPaReviewOptions): Promise<() => void> {
  const token = useAuthStore.getState().token;
  const controller = new AbortController();

  void (async () => {
    try {
      const baseUrl = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').replace(/\/+$/, '');
      const url = `${baseUrl}/api/pa-agent/review/run`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          range: opts.range,
          startDate: opts.startDate,
          endDate: opts.endDate,
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
            const evt = JSON.parse(raw) as
              | PaReviewStageEvent
              | { type: 'delta'; content: string }
              | PaReviewDoneEvent
              | { type: 'error'; message: string };
            if (evt.type === 'stage') {
              opts.onStage(evt);
            } else if (evt.type === 'delta') {
              opts.onDelta(evt.content);
            } else if (evt.type === 'done') {
              opts.onDone(evt);
            } else if (evt.type === 'error') {
              opts.onError(evt.message || '未知错误');
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
