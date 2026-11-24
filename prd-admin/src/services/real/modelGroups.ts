import type { ApiResponse } from '@/types/api';
import type { ModelGroup, ModelGroupHealthOverview } from '../../types/modelGroup';
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
    strategyType: g?.strategyType ?? 0,
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

  async getModelGroupHealthOverview(days?: number): Promise<ApiResponse<ModelGroupHealthOverview>> {
    const res = await fetch(api.mds.modelGroups.healthOverview(days), {
      headers: getAuthHeaders(),
    });

    const json = await readApiJson<ModelGroupHealthOverview>(res);
    if (!res.ok || !json.success) {
      throw new Error(json.error?.message || `获取模型池健康总览失败: ${res.status}`);
    }
    return json;
  }

}
