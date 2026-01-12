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
const CODE_SENTINEL = '[prd_group_code]';

function getAuthHeaders(): Record<string, string> {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function readApiJson<T>(res: Response): Promise<ApiResponse<T>> {
  const text = await res.text();
  if (!text.trim()) {
    // 兜底：后端应总是返回 ApiResponse，但这里防御空响应
    return { success: false, data: null as any, error: { code: 'INVALID_FORMAT', message: `Empty response (HTTP ${res.status})` } };
  }
  try {
    return JSON.parse(text) as ApiResponse<T>;
  } catch {
    return { success: false, data: null as any, error: { code: 'INVALID_FORMAT', message: text } };
  }
}

function splitCodeAndDescription(raw: string | null | undefined): { code: string; description: string } {
  const s = String(raw ?? '');
  const idx = s.indexOf(CODE_SENTINEL);
  if (idx !== 0) return { code: '', description: s };
  const rest = s.slice(CODE_SENTINEL.length);
  const nl = rest.indexOf('\n');
  if (nl < 0) return { code: rest.trim(), description: '' };
  return { code: rest.slice(0, nl).trim(), description: rest.slice(nl + 1) };
}

function joinCodeAndDescription(args: { code?: string; description?: string | null }): string | undefined {
  const code = String(args.code ?? '').trim();
  const desc = String(args.description ?? '').trim();
  if (!code) return desc || undefined;
  if (!desc) return `${CODE_SENTINEL}${code}`;
  return `${CODE_SENTINEL}${code}\n${desc}`;
}

function mapGroupFromApi(g: any): ModelGroup {
  const { code, description } = splitCodeAndDescription(g?.description);
  const modelType = String(g?.modelType ?? '').trim();
  const isDefaultForType = !!g?.isDefaultForType;
  return {
    ...g,
    modelType,
    isDefaultForType,
    // 兼容字段
    code: code || '',
    isSystemGroup: isDefaultForType,
    description,
  } as ModelGroup;
}

export class ModelGroupsService implements IModelGroupsService {
  async getModelGroups(modelType?: string): Promise<ApiResponse<ModelGroup[]>> {
    const url = modelType
      ? `${API_BASE}/admin/model-groups?modelType=${encodeURIComponent(modelType)}`
      : `${API_BASE}/admin/model-groups`;

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
    const res = await fetch(`${API_BASE}/admin/model-groups/${id}`, {
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
      modelType: String(request.modelType ?? '').trim(),
      isDefaultForType: !!request.isDefaultForType,
      description: joinCodeAndDescription({ code: request.code, description: request.description }),
    };
    const res = await fetch(`${API_BASE}/admin/model-groups`, {
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
    if (request.description !== undefined || request.code !== undefined) {
      payload.description = joinCodeAndDescription({ code: request.code, description: request.description });
    }
    if (request.models !== undefined) payload.models = request.models;
    if (request.isDefaultForType !== undefined) payload.isDefaultForType = !!request.isDefaultForType;

    const res = await fetch(`${API_BASE}/admin/model-groups/${id}`, {
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
    const res = await fetch(`${API_BASE}/admin/model-groups/${id}`, {
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
    const res = await fetch(`${API_BASE}/admin/model-groups/${groupId}/monitoring`, {
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
    const res = await fetch(`${API_BASE}/admin/model-groups/${groupId}/simulate-downgrade`, {
      method: 'POST',
      headers: {
        ...getAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ modelId, platformId, failureCount }),
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
    const res = await fetch(`${API_BASE}/admin/model-groups/${groupId}/simulate-recover`, {
      method: 'POST',
      headers: {
        ...getAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ modelId, platformId, successCount }),
    });

    const json = await readApiJson<void>(res);
    if (!res.ok || !json.success) {
      throw new Error(json.error?.message || `模拟恢复失败: ${res.status}`);
    }
    return json;
  }
}
