import type {
  CreateModelContract,
  CreateModelInput,
  DeleteModelContract,
  GetModelsContract,
  SetImageGenModelContract,
  SetIntentModelContract,
  ClearIntentModelContract,
  SetMainModelContract,
  SetVisionModelContract,
  TestModelContract,
  UpdateModelContract,
  UpdateModelInput,
} from '@/services/contracts/models';
import { apiRequest } from '@/services/real/apiClient';
import { fail, ok, type ApiResponse } from '@/types/api';
import type { Model } from '@/types/admin';

export const getModelsReal: GetModelsContract = async () => {
  return await apiRequest<Model[]>('/api/v1/config/models');
};

export const createModelReal: CreateModelContract = async (input: CreateModelInput) => {
  const created = await apiRequest<{ id: string }>('/api/v1/config/models', {
    method: 'POST',
    body: {
      name: input.name,
      modelName: input.modelName,
      platformId: input.platformId,
      group: input.group ?? null,
      enabled: input.enabled,
      enablePromptCache: typeof input.enablePromptCache === 'boolean' ? input.enablePromptCache : true,
    },
  });

  if (!created.success) return created as unknown as ApiResponse<Model>;

  const id = created.data.id;
  if (!id) return fail('UNKNOWN', '创建模型失败：后端未返回 id') as unknown as ApiResponse<Model>;

  return await apiRequest<Model>(`/api/v1/config/models/${id}`);
};

export const updateModelReal: UpdateModelContract = async (id: string, input: UpdateModelInput) => {
  // 后端 PUT 需要完整对象；这里先拉取现有配置再合并，避免字段丢失
  const current = await apiRequest<any>(`/api/v1/config/models/${id}`);
  if (!current.success) return current as unknown as ApiResponse<Model>;

  const m = current.data as any;

  const body: Record<string, unknown> = {
    name: input.name ?? m.name,
    modelName: input.modelName ?? m.modelName,
    apiUrl: 'apiUrl' in input ? (input as any).apiUrl : (m.apiUrl ?? null),
    platformId: input.platformId ?? m.platformId ?? null,
    group: 'group' in input ? input.group ?? null : (m.group ?? null),
    timeout: m.timeout ?? 360000,
    maxRetries: m.maxRetries ?? 3,
    maxConcurrency: m.maxConcurrency ?? 5,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : m.enabled,
    enablePromptCache:
      typeof (input as any).enablePromptCache === 'boolean'
        ? (input as any).enablePromptCache
        : (typeof m.enablePromptCache === 'boolean' ? m.enablePromptCache : true),
    remark: m.remark ?? null,
  };

  if (typeof (input as any).priority === 'number') body.priority = (input as any).priority;
  else if (typeof m.priority === 'number') body.priority = m.priority;

  if (typeof (input as any).apiKey === 'string' && (input as any).apiKey) body.apiKey = (input as any).apiKey;

  const updated = await apiRequest<{ id: string }>(`/api/v1/config/models/${id}`, { method: 'PUT', body });
  if (!updated.success) return updated as unknown as ApiResponse<Model>;

  return await apiRequest<Model>(`/api/v1/config/models/${id}`);
};

export const deleteModelReal: DeleteModelContract = async (id: string) => {
  const res = await apiRequest<true>(`/api/v1/config/models/${id}`, { method: 'DELETE', emptyResponseData: true });
  if (!res.success) return res;
  return ok(true);
};

export const testModelReal: TestModelContract = async (id: string) => {
  const res = await apiRequest<{ success: boolean; duration: number; error?: string }>(`/api/v1/config/models/${id}/test`, {
    method: 'POST',
    body: {},
  });
  return res;
};

export const setMainModelReal: SetMainModelContract = async (id: string) => {
  const res = await apiRequest<{ modelId: string; isMain: boolean }>('/api/v1/config/main-model', {
    method: 'PUT',
    body: { modelId: id },
  });

  if (!res.success) return res as unknown as ApiResponse<true>;
  return ok(true);
};

export const setIntentModelReal: SetIntentModelContract = async (id: string) => {
  const res = await apiRequest<{ modelId: string; isIntent: boolean }>('/api/v1/config/intent-model', {
    method: 'PUT',
    body: { modelId: id },
  });
  if (!res.success) return res as unknown as ApiResponse<true>;
  return ok(true);
};

export const clearIntentModelReal: ClearIntentModelContract = async () => {
  const res = await apiRequest<{ cleared: boolean }>('/api/v1/config/intent-model', {
    method: 'DELETE',
  });
  if (!res.success) return res as unknown as ApiResponse<true>;
  return ok(true);
};

export const setVisionModelReal: SetVisionModelContract = async (id: string) => {
  const res = await apiRequest<{ modelId: string; isVision: boolean }>('/api/v1/config/vision-model', {
    method: 'PUT',
    body: { modelId: id },
  });
  if (!res.success) return res as unknown as ApiResponse<true>;
  return ok(true);
};

export const setImageGenModelReal: SetImageGenModelContract = async (id: string) => {
  const res = await apiRequest<{ modelId: string; isImageGen: boolean }>('/api/v1/config/image-gen-model', {
    method: 'PUT',
    body: { modelId: id },
  });
  if (!res.success) return res as unknown as ApiResponse<true>;
  return ok(true);
};


