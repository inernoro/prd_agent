import axios from 'axios';
import { useAuthStore } from '../stores/authStore';
import type { ApiResponse } from '../types';

const api = axios.create({
  baseURL: '/api/v1',
  timeout: 30000,
});

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response.data,
  (error) => {
    if (error.response?.status === 401) {
      useAuthStore.getState().logout();
    }
    return Promise.reject(error.response?.data || error);
  }
);

// Auth
export const login = (username: string, password: string) =>
  api.post('/auth/login', { username, password });

// Admin - Users
export const getUsers = (params?: Record<string, unknown>) =>
  api.get('/admin/users', { params });

export const updateUserStatus = (userId: string, status: string) =>
  api.put(`/admin/users/${userId}/status`, { status });

export const updateUserRole = (userId: string, role: string) =>
  api.put(`/admin/users/${userId}/role`, { role });

export const generateInviteCodes = (count: number, expiresInDays?: number) =>
  api.post('/admin/users/invite-codes', { count, expiresInDays });

// Admin - LLM Config
export const getLLMConfigs = () =>
  api.get('/admin/llm-configs');

export const createLLMConfig = (config: Record<string, unknown>) =>
  api.post('/admin/llm-configs', config);

export const updateLLMConfig = (configId: string, config: Record<string, unknown>) =>
  api.put(`/admin/llm-configs/${configId}`, config);

export const deleteLLMConfig = (configId: string) =>
  api.delete(`/admin/llm-configs/${configId}`);

export const activateLLMConfig = (configId: string) =>
  api.post(`/admin/llm-configs/${configId}/activate`);

// Admin - Stats
export const getOverviewStats = () =>
  api.get('/admin/stats/overview');

export const getMessageTrend = (days?: number) =>
  api.get('/admin/stats/message-trend', { params: { days } });

export const getTokenUsage = (days?: number) =>
  api.get('/admin/stats/token-usage', { params: { days } });

export const getActiveGroups = (limit?: number) =>
  api.get('/admin/stats/active-groups', { params: { limit } });

export const getGapStats = () =>
  api.get('/admin/stats/gap-stats');

// ========== Platform APIs ==========
export const getPlatforms = () =>
  api.get('/platforms');

export const getPlatform = (id: string) =>
  api.get(`/platforms/${id}`);

export const createPlatform = (data: Record<string, unknown>) =>
  api.post('/platforms', data);

export const updatePlatform = (id: string, data: Record<string, unknown>) =>
  api.put(`/platforms/${id}`, data);

export const deletePlatform = (id: string) =>
  api.delete(`/platforms/${id}`);

export const getPlatformModels = (id: string) =>
  api.get(`/platforms/${id}/models`);

export const getAvailableModels = (id: string) =>
  api.get(`/platforms/${id}/available-models`);

export const refreshAvailableModels = (id: string) =>
  api.post(`/platforms/${id}/refresh-models`);

// ========== PRD Agent ==========
export const uploadDocument = (content: string) =>
  api.post('/documents', { content });

type ChatStreamEvent = {
  type: 'start' | 'delta' | 'done' | 'error' | string;
  messageId?: string;
  content?: string;
  errorCode?: string;
  errorMessage?: string;
};

// 发送消息并通过 SSE 接收流式响应（不使用 axios，避免流式读取被缓冲）
export async function sendMessageWithSSE(
  sessionId: string,
  content: string,
  role: string,
  onStart: () => void,
  onDelta: (chunk: string) => void,
  onDone: () => void,
  onError: (error: unknown) => void
) {
  const token = useAuthStore.getState().token;
  const res = await fetch(`/api/v1/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      content,
      role, // 后端枚举：PM/DEV/QA/ADMIN
    }),
  });

  if (!res.ok) {
    let body: unknown = undefined;
    try {
      body = await res.json();
    } catch {
      // ignore
    }
    const err = body as Partial<ApiResponse<unknown>> | undefined;
    throw new Error(err?.error?.message || `请求失败 (${res.status})`);
  }

  if (!res.body) {
    throw new Error('SSE 响应体为空');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let started = false;

  const flushEventBlock = (block: string) => {
    // SSE block example:
    // event: message
    // data: {...}
    const lines = block.split('\n').map(l => l.trimEnd());
    const dataLine = lines.find(l => l.startsWith('data:'));
    if (!dataLine) return;
    const json = dataLine.replace(/^data:\s*/, '');
    if (!json) return;

    let evt: ChatStreamEvent | null = null;
    try {
      evt = JSON.parse(json) as ChatStreamEvent;
    } catch (e) {
      onError(e);
      return;
    }

    if (!evt) return;

    if (evt.type === 'start' && !started) {
      started = true;
      onStart();
      return;
    }

    if (evt.type === 'delta' && evt.content) {
      if (!started) {
        started = true;
        onStart();
      }
      onDelta(evt.content);
      return;
    }

    if (evt.type === 'done') {
      onDone();
      return;
    }

    if (evt.type === 'error') {
      onError({ code: evt.errorCode, message: evt.errorMessage });
      onDone();
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // 以空行分隔事件块
      let idx = buffer.indexOf('\n\n');
      while (idx !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (block.trim()) flushEventBlock(block);
        idx = buffer.indexOf('\n\n');
      }
    }
  } catch (e) {
    onError(e);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
}

// ========== Model APIs ==========
export const getModels = () =>
  api.get('/config/models');

export const getModel = (id: string) =>
  api.get(`/config/models/${id}`);

export const createModel = (data: Record<string, unknown>) =>
  api.post('/config/models', data);

export const updateModel = (id: string, data: Record<string, unknown>) =>
  api.put(`/config/models/${id}`, data);

export const deleteModel = (id: string) =>
  api.delete(`/config/models/${id}`);

export const deleteAllModels = () =>
  api.delete('/config/models/all');

export const testModel = (id: string) =>
  api.post(`/config/models/${id}/test`);

export const updateModelPriorities = (updates: Array<{ id: string; priority: number }>) =>
  api.put('/config/models/priorities', updates);

export const setMainModel = (modelId: string) =>
  api.put('/config/main-model', { modelId });

export const getMainModel = () =>
  api.get('/config/main-model');

export const batchAddModelsFromPlatform = (platformId: string, models: Array<{ modelName: string; displayName?: string; group?: string }>) =>
  api.post('/config/models/batch-from-platform', { platformId, models });

export const addModelsFromLibrary = (platformId: string, models: Array<{ modelName: string; name: string }>) =>
  api.post('/config/models/batch-from-platform', { platformId, models: models.map(m => ({ modelName: m.modelName, displayName: m.name })) });

export default api;



