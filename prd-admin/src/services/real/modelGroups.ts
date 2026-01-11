import type { ApiResponse } from '@/types/api';
import type {
  ModelGroup,
  CreateModelGroupRequest,
  UpdateModelGroupRequest,
  ModelGroupMonitoringData,
} from '../../types/modelGroup';
import type { IModelGroupsService } from '../contracts/modelGroups';
import { useAuthStore } from '@/stores/authStore';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api/v1';

function getAuthHeaders(): Record<string, string> {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export class ModelGroupsService implements IModelGroupsService {
  async getModelGroups(modelType?: string): Promise<ApiResponse<ModelGroup[]>> {
    const url = modelType
      ? `${API_BASE}/admin/model-groups?modelType=${encodeURIComponent(modelType)}`
      : `${API_BASE}/admin/model-groups`;

    const res = await fetch(url, {
      headers: getAuthHeaders(),
    });

    if (!res.ok) {
      throw new Error(`获取模型分组失败: ${res.status}`);
    }

    return res.json();
  }

  async getModelGroup(id: string): Promise<ApiResponse<ModelGroup>> {
    const res = await fetch(`${API_BASE}/admin/model-groups/${id}`, {
      headers: getAuthHeaders(),
    });

    if (!res.ok) {
      throw new Error(`获取模型分组失败: ${res.status}`);
    }

    return res.json();
  }

  async createModelGroup(
    request: CreateModelGroupRequest
  ): Promise<ApiResponse<ModelGroup>> {
    const res = await fetch(`${API_BASE}/admin/model-groups`, {
      method: 'POST',
      headers: {
        ...getAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      throw new Error(`创建模型分组失败: ${res.status}`);
    }

    return res.json();
  }

  async updateModelGroup(
    id: string,
    request: UpdateModelGroupRequest
  ): Promise<ApiResponse<ModelGroup>> {
    const res = await fetch(`${API_BASE}/admin/model-groups/${id}`, {
      method: 'PUT',
      headers: {
        ...getAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      throw new Error(`更新模型分组失败: ${res.status}`);
    }

    return res.json();
  }

  async deleteModelGroup(id: string): Promise<ApiResponse<{ id: string }>> {
    const res = await fetch(`${API_BASE}/admin/model-groups/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });

    if (!res.ok) {
      throw new Error(`删除模型分组失败: ${res.status}`);
    }

    return res.json();
  }

  async getGroupMonitoring(groupId: string): Promise<ApiResponse<ModelGroupMonitoringData>> {
    const res = await fetch(`${API_BASE}/admin/model-groups/${groupId}/monitoring`, {
      headers: getAuthHeaders(),
    });

    if (!res.ok) {
      throw new Error(`获取分组监控数据失败: ${res.status}`);
    }

    return res.json();
  }

  async simulateDowngrade(
    groupId: string,
    modelId: string,
    platformId: string,
    failureCount: number
  ): Promise<ApiResponse<void>> {
    const res = await fetch(`${API_BASE}/admin/model-groups/${groupId}/simulate-downgrade`, {
      method: 'POST',
      headers: {
        ...getAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ modelId, platformId, failureCount }),
    });

    if (!res.ok) {
      throw new Error(`模拟降权失败: ${res.status}`);
    }

    return res.json();
  }

  async simulateRecover(
    groupId: string,
    modelId: string,
    platformId: string,
    successCount: number
  ): Promise<ApiResponse<void>> {
    const res = await fetch(`${API_BASE}/admin/model-groups/${groupId}/simulate-recover`, {
      method: 'POST',
      headers: {
        ...getAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ modelId, platformId, successCount }),
    });

    if (!res.ok) {
      throw new Error(`模拟恢复失败: ${res.status}`);
    }

    return res.json();
  }
}
