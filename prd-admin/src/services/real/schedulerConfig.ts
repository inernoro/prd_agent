import type { ApiResponse } from '@/types/api';
import type {
  ModelSchedulerConfig,
} from '../../types/schedulerConfig';
import type { ISchedulerConfigService } from '../contracts/schedulerConfig';
import { useAuthStore } from '@/stores/authStore';
import { api } from '@/services/api';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

function getAuthHeaders(): Record<string, string> {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export class SchedulerConfigService implements ISchedulerConfigService {
  async getConfig(): Promise<ApiResponse<ModelSchedulerConfig>> {
    const res = await fetch(`${API_BASE}${api.mds.schedulerConfig()}`, {
      headers: getAuthHeaders(),
    });

    if (!res.ok) {
      throw new Error(`获取系统配置失败: ${res.status}`);
    }

    return res.json();
  }

  async getSchedulerConfig(): Promise<ApiResponse<ModelSchedulerConfig>> {
    return this.getConfig();
  }

}
