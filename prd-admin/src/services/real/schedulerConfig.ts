import type { ApiResponse } from '@/types/api';
import type {
  ModelSchedulerConfig,
  UpdateSchedulerConfigRequest,
} from '../../types/schedulerConfig';
import type { ISchedulerConfigService } from '../contracts/schedulerConfig';
import { useAuthStore } from '@/stores/authStore';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api/v1';

function getAuthHeaders(): Record<string, string> {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export class SchedulerConfigService implements ISchedulerConfigService {
  async getConfig(): Promise<ApiResponse<ModelSchedulerConfig>> {
    const res = await fetch(`${API_BASE}/admin/scheduler-config`, {
      headers: getAuthHeaders(),
    });

    if (!res.ok) {
      throw new Error(`获取系统配置失败: ${res.status}`);
    }

    return res.json();
  }

  async updateConfig(
    request: UpdateSchedulerConfigRequest
  ): Promise<ApiResponse<ModelSchedulerConfig>> {
    const res = await fetch(`${API_BASE}/admin/scheduler-config`, {
      method: 'PUT',
      headers: {
        ...getAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      throw new Error(`更新系统配置失败: ${res.status}`);
    }

    return res.json();
  }

  async getSchedulerConfig(): Promise<ApiResponse<ModelSchedulerConfig>> {
    return this.getConfig();
  }

  async updateSchedulerConfig(
    request: UpdateSchedulerConfigRequest
  ): Promise<ApiResponse<ModelSchedulerConfig>> {
    return this.updateConfig(request);
  }
}
