import axios from 'axios';
import { useAuthStore } from '../stores/authStore';

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

export default api;



