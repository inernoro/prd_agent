import type { ApiResponse } from '@/types/api';
import type {
  ModelGroup,
  CreateModelGroupRequest,
  UpdateModelGroupRequest,
  ModelGroupMonitoringData,
} from '../../types/modelGroup';
import type { IModelGroupsService } from '../contracts/modelGroups';
import { useAuthStore } from '@/stores/authStore';
import { api } from '@/services/api';

function getAuthHeaders(): Record<string, string> {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function readApiJson<T>(res: Response): Promise<ApiResponse<T>> {
  const text = await res.text();
  if (!text.trim()) {
    return { success: false, data: null as any, error: { code: 'INVALID_FORMAT', message: `Empty response (HTTP ${res.status})` } };
  }
  try {
    return JSON.parse(text) as ApiResponse<T>;
  } catch {
    return { success: false, data: null as any, error: { code: 'INVALID_FORMAT', message: text } };
  }
}

function mapGroupFromApi(g: any): ModelGroup {
  const modelType = String(g?.modelType ?? '').trim();
  const isDefaultForType = !!g?.isDefaultForType;
  return {
    ...g,
    modelType,
    isDefaultForType,
    code: g?.code || '',
    priority: g?.priority ?? 50,
    isSystemGroup: isDefaultForType,
  } as ModelGroup;
}

export class ModelGroupsService implements IModelGroupsService {
  async getModelGroups(modelType?: string): Promise<ApiResponse<ModelGroup[]>> {
    const base = api.mds.modelGroups.list();
    const url = modelType ? `${base}?modelType=${encodeURIComponent(modelType)}` : base;

    const res = await fetch(url, {
      headers: getAuthHeaders(),
    });

    const json = await readApiJson<ModelGroup[]>(res);
    if (!res.ok || !json.success) {
      throw new Error(json.error?.message || `获取模型分组失败: ${res.status}`);
    }
    return { ...json, data: (json.data ?? []).map((g: any) => mapGroupFromApi(g)) };
  }

  async getModelGroup(id: string): Promise<ApiResponse<ModelGroup>> {
    const res = await fetch(api.mds.modelGroups.byId(id), {
      headers: getAuthHeaders(),
    });

    const json = await readApiJson<ModelGroup>(res);
    if (!res.ok || !json.success) {
      throw new Error(json.error?.message || `获取模型分组失败: ${res.status}`);
    }
    return { ...json, data: mapGroupFromApi(json.data as any) };
  }

  async createModelGroup(
    request: CreateModelGroupRequest
  ): Promise<ApiResponse<ModelGroup>> {
    const payload = {
      name: String(request.name ?? '').trim(),
      code: String(request.code ?? '').trim(),
      priority: request.priority ?? 50,
      modelType: String(request.modelType ?? '').trim(),
      isDefaultForType: !!request.isDefaultForType,
      description: request.description ?? undefined,
      models: request.models ?? [],
    };
    const res = await fetch(api.mds.modelGroups.list(), {
      method: 'POST',
      headers: {
        ...getAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const json = await readApiJson<ModelGroup>(res);
    if (!res.ok || !json.success) {
      throw new Error(json.error?.message || `创建模型分组失败: ${res.status}`);
    }
    return { ...json, data: mapGroupFromApi(json.data as any) };
  }

  async updateModelGroup(
    id: string,
    request: UpdateModelGroupRequest
  ): Promise<ApiResponse<ModelGroup>> {
    const payload: Record<string, unknown> = {};
    if (request.name !== undefined) payload.name = String(request.name ?? '').trim();
    if (request.code !== undefined) payload.code = String(request.code ?? '').trim();
    if (request.priority !== undefined) payload.priority = request.priority;
    if (request.description !== undefined) payload.description = request.description;
    if (request.models !== undefined) payload.models = request.models;
    if (request.isDefaultForType !== undefined) payload.isDefaultForType = !!request.isDefaultForType;

    const res = await fetch(api.mds.modelGroups.byId(id), {
      method: 'PUT',
      headers: {
        ...getAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const json = await readApiJson<ModelGroup>(res);
    if (!res.ok || !json.success) {
      throw new Error(json.error?.message || `更新模型分组失败: ${res.status}`);
    }
    return { ...json, data: mapGroupFromApi(json.data as any) };
  }

  async deleteModelGroup(id: string): Promise<ApiResponse<{ id: string }>> {
    const res = await fetch(api.mds.modelGroups.byId(id), {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });

    const json = await readApiJson<{ id: string }>(res);
    if (!res.ok || !json.success) {
      throw new Error(json.error?.message || `删除模型分组失败: ${res.status}`);
    }
    return json;
  }

  async getGroupMonitoring(groupId: string): Promise<ApiResponse<ModelGroupMonitoringData>> {
    const res = await fetch(api.lab.modelTest.groupMonitoring(groupId), {
      headers: getAuthHeaders(),
    });

    const json = await readApiJson<ModelGroupMonitoringData>(res);
    if (!res.ok || !json.success) {
      throw new Error(json.error?.message || `获取分组监控数据失败: ${res.status}`);
    }
    return json;
  }

  async simulateDowngrade(
    groupId: string,
    modelId: string,
    platformId: string,
    failureCount: number
  ): Promise<ApiResponse<void>> {
    const res = await fetch(api.lab.modelTest.simulate.downgrade(), {
      method: 'POST',
      headers: {
        ...getAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ groupId, modelId, platformId, failureCount }),
    });

    const json = await readApiJson<void>(res);
    if (!res.ok || !json.success) {
      throw new Error(json.error?.message || `模拟降权失败: ${res.status}`);
    }
    return json;
  }

  async simulateRecover(
    groupId: string,
    modelId: string,
    platformId: string,
    successCount: number
  ): Promise<ApiResponse<void>> {
    const res = await fetch(api.lab.modelTest.simulate.recover(), {
      method: 'POST',
      headers: {
        ...getAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ groupId, modelId, platformId, successCount }),
    });

    const json = await readApiJson<void>(res);
    if (!res.ok || !json.success) {
      throw new Error(json.error?.message || `模拟恢复失败: ${res.status}`);
    }
    return json;
  }
}
