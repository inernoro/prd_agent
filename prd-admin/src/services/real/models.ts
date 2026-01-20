import type {
  CreateModelContract,
  CreateModelInput,
  DeleteModelContract,
  GetModelsContract,
  SetImageGenModelContract,
  SetIntentModelContract,
  ClearIntentModelContract,
  ClearVisionModelContract,
  SetMainModelContract,
  SetVisionModelContract,
  ClearImageGenModelContract,
  TestModelContract,
  ModelPriorityUpdate,
  UpdateModelPrioritiesContract,
  UpdateModelContract,
  UpdateModelInput,
  GetModelAdapterInfoContract,
  GetModelsAdapterInfoBatchContract,
  ModelAdapterInfo,
  ModelAdapterInfoBrief,
} from '@/services/contracts/models';
import { apiRequest } from '@/services/real/apiClient';
import { fail, ok, type ApiResponse } from '@/types/api';
import type { Model } from '@/types/admin';

export const getModelsReal: GetModelsContract = async () => {
  return await apiRequest<Model[]>('/api/mds');
};

export const createModelReal: CreateModelContract = async (input: CreateModelInput) => {
  const created = await apiRequest<{ id: string }>('/api/mds', {
    method: 'POST',
    body: {
      name: input.name,
      modelName: input.modelName,
      platformId: input.platformId,
      group: input.group ?? null,
      enabled: input.enabled,
      enablePromptCache: typeof input.enablePromptCache === 'boolean' ? input.enablePromptCache : true,
      maxTokens: typeof input.maxTokens === 'number' ? input.maxTokens : null,
    },
  });

  if (!created.success) return created as unknown as ApiResponse<Model>;

  const id = created.data.id;
  if (!id) return fail('UNKNOWN', '创建模型失败：后端未返回 id') as unknown as ApiResponse<Model>;

  return await apiRequest<Model>(`/api/mds/${id}`);
};

export const updateModelReal: UpdateModelContract = async (id: string, input: UpdateModelInput) => {
  // 后端 PUT 需要完整对象；这里先拉取现有配置再合并，避免字段丢失
  const current = await apiRequest<any>(`/api/mds/${id}`);
  if (!current.success) return current as unknown as ApiResponse<Model>;

  const m = current.data as any;

  const hasMaxTokens = 'maxTokens' in (input as any);
  const body: Record<string, unknown> = {
    name: input.name ?? m.name,
    modelName: input.modelName ?? m.modelName,
    apiUrl: 'apiUrl' in input ? (input as any).apiUrl : (m.apiUrl ?? null),
    platformId: input.platformId ?? m.platformId ?? null,
    group: 'group' in input ? input.group ?? null : (m.group ?? null),
    timeout: m.timeout ?? 360000,
    maxRetries: m.maxRetries ?? 3,
    maxConcurrency: m.maxConcurrency ?? 5,
    maxTokens: hasMaxTokens ? ((input as any).maxTokens ?? null) : (m.maxTokens ?? null),
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

  const updated = await apiRequest<{ id: string }>(`/api/mds/${id}`, { method: 'PUT', body });
  if (!updated.success) return updated as unknown as ApiResponse<Model>;

  return await apiRequest<Model>(`/api/mds/${id}`);
};

export const deleteModelReal: DeleteModelContract = async (id: string) => {
  const res = await apiRequest<true>(`/api/mds/${id}`, { method: 'DELETE', emptyResponseData: true });
  if (!res.success) return res;
  return ok(true);
};

export const testModelReal: TestModelContract = async (id: string) => {
  const res = await apiRequest<{ success: boolean; duration: number; error?: string }>(`/api/mds/${id}/test`, {
    method: 'POST',
    body: {},
  });
  return res;
};

export const updateModelPrioritiesReal: UpdateModelPrioritiesContract = async (updates: ModelPriorityUpdate[]) => {
  return await apiRequest<{ updated: number }>('/api/mds/priorities', {
    method: 'PUT',
    body: (updates ?? []).map((x) => ({ id: x.id, priority: x.priority })),
  });
};

export const setMainModelReal: SetMainModelContract = async (input) => {
  const res = await apiRequest<{ modelId: string; isMain: boolean }>('/api/mds/main-model', {
    method: 'PUT',
    body: { platformId: input.platformId, modelId: input.modelId },
  });

  if (!res.success) return res as unknown as ApiResponse<true>;
  return ok(true);
};

export const setIntentModelReal: SetIntentModelContract = async (input) => {
  const res = await apiRequest<{ modelId: string; isIntent: boolean }>('/api/mds/intent-model', {
    method: 'PUT',
    body: { platformId: input.platformId, modelId: input.modelId },
  });
  if (!res.success) return res as unknown as ApiResponse<true>;
  return ok(true);
};

export const clearIntentModelReal: ClearIntentModelContract = async () => {
  const res = await apiRequest<{ cleared: boolean }>('/api/mds/intent-model', {
    method: 'DELETE',
  });
  if (!res.success) return res as unknown as ApiResponse<true>;
  return ok(true);
};

export const setVisionModelReal: SetVisionModelContract = async (input) => {
  const res = await apiRequest<{ modelId: string; isVision: boolean }>('/api/mds/vision-model', {
    method: 'PUT',
    body: { platformId: input.platformId, modelId: input.modelId },
  });
  if (!res.success) return res as unknown as ApiResponse<true>;
  return ok(true);
};

export const clearVisionModelReal: ClearVisionModelContract = async () => {
  const res = await apiRequest<{ cleared: boolean }>('/api/mds/vision-model', {
    method: 'DELETE',
  });
  if (!res.success) return res as unknown as ApiResponse<true>;
  return ok(true);
};

export const setImageGenModelReal: SetImageGenModelContract = async (input) => {
  const res = await apiRequest<{ modelId: string; isImageGen: boolean }>('/api/mds/image-gen-model', {
    method: 'PUT',
    body: { platformId: input.platformId, modelId: input.modelId },
  });
  if (!res.success) return res as unknown as ApiResponse<true>;
  return ok(true);
};

export const clearImageGenModelReal: ClearImageGenModelContract = async () => {
  const res = await apiRequest<{ cleared: boolean }>('/api/mds/image-gen-model', {
    method: 'DELETE',
  });
  if (!res.success) return res as unknown as ApiResponse<true>;
  return ok(true);
};

export const getModelAdapterInfoReal: GetModelAdapterInfoContract = async (modelId: string) => {
  return await apiRequest<ModelAdapterInfo>(`/api/mds/${modelId}/adapter-info`);
};

export const getModelsAdapterInfoBatchReal: GetModelsAdapterInfoBatchContract = async (modelIds: string[]) => {
  return await apiRequest<Record<string, ModelAdapterInfoBrief>>('/api/mds/adapter-info/batch', {
    method: 'POST',
    body: modelIds,
  });
};

