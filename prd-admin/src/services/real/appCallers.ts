import type { ApiResponse } from '@/types/api';
import type {
  LLMAppCaller,
  CreateAppCallerRequest,
  UpdateAppCallerRequest,
  AppCallerStats,
} from '../../types/appCaller';
import type { IAppCallersService } from '../contracts/appCallers';
import { useAuthStore } from '@/stores/authStore';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

function getAuthHeaders(): Record<string, string> {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export class AppCallersService implements IAppCallersService {
  async getAppCallers(
    page = 1,
    pageSize = 50
  ): Promise<
    ApiResponse<{
      items: LLMAppCaller[];
      total: number;
      page: number;
      pageSize: number;
    }>
  > {
    const res = await fetch(
      `${API_BASE}/open-platform/app-callers?page=${page}&pageSize=${pageSize}`,
      {
        headers: getAuthHeaders(),
      }
    );

    if (!res.ok) {
      throw new Error(`获取应用列表失败: ${res.status}`);
    }

    return res.json();
  }

  async getAppCaller(id: string): Promise<ApiResponse<LLMAppCaller>> {
    const res = await fetch(`${API_BASE}/open-platform/app-callers/${id}`, {
      headers: getAuthHeaders(),
    });

    if (!res.ok) {
      throw new Error(`获取应用失败: ${res.status}`);
    }

    return res.json();
  }

  async createAppCaller(
    request: CreateAppCallerRequest
  ): Promise<ApiResponse<LLMAppCaller>> {
    const res = await fetch(`${API_BASE}/open-platform/app-callers`, {
      method: 'POST',
      headers: {
        ...getAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      throw new Error(`创建应用失败: ${res.status}`);
    }

    return res.json();
  }

  async updateAppCaller(
    id: string,
    request: UpdateAppCallerRequest
  ): Promise<ApiResponse<LLMAppCaller>> {
    const res = await fetch(`${API_BASE}/open-platform/app-callers/${id}`, {
      method: 'PUT',
      headers: {
        ...getAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      throw new Error(`更新应用失败: ${res.status}`);
    }

    return res.json();
  }

  async deleteAppCaller(id: string): Promise<ApiResponse<{ id: string }>> {
    const res = await fetch(`${API_BASE}/open-platform/app-callers/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });

    if (!res.ok) {
      throw new Error(`删除应用失败: ${res.status}`);
    }

    return res.json();
  }

  async getAppCallerStats(id: string): Promise<ApiResponse<AppCallerStats>> {
    const res = await fetch(`${API_BASE}/open-platform/app-callers/${id}/stats`, {
      headers: getAuthHeaders(),
    });

    if (!res.ok) {
      throw new Error(`获取应用统计失败: ${res.status}`);
    }

    return res.json();
  }

  async scanApps(): Promise<
    ApiResponse<{ discovered: string[]; message: string }>
  > {
    const res = await fetch(`${API_BASE}/open-platform/app-callers/scan`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });

    if (!res.ok) {
      throw new Error(`扫描应用失败: ${res.status}`);
    }

    return res.json();
  }

  async scanAppCallers(): Promise<
    ApiResponse<{ discovered: string[]; message: string }>
  > {
    return this.scanApps();
  }
}
