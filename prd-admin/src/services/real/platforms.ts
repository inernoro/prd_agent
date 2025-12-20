import type {
  CreatePlatformContract,
  CreatePlatformInput,
  DeletePlatformContract,
  GetPlatformsContract,
  UpdatePlatformContract,
  UpdatePlatformInput,
} from '@/services/contracts/platforms';
import { apiRequest } from '@/services/real/apiClient';
import { fail, ok, type ApiResponse } from '@/types/api';
import type { Platform } from '@/types/admin';

export const getPlatformsReal: GetPlatformsContract = async () => {
  return await apiRequest<Platform[]>('/api/v1/platforms');
};

export const createPlatformReal: CreatePlatformContract = async (input: CreatePlatformInput) => {
  const created = await apiRequest<{ id: string }>('/api/v1/platforms', {
    method: 'POST',
    body: {
      name: input.name,
      platformType: input.platformType,
      providerId: input.providerId ?? null,
      apiUrl: input.apiUrl,
      apiKey: input.apiKey,
      enabled: input.enabled,
      maxConcurrency: 5,
    },
  });

  if (!created.success) return created as unknown as ApiResponse<Platform>;

  const id = created.data.id;
  if (!id) return fail('UNKNOWN', '创建平台失败：后端未返回 id') as unknown as ApiResponse<Platform>;

  return await apiRequest<Platform>(`/api/v1/platforms/${id}`);
};

export const updatePlatformReal: UpdatePlatformContract = async (id: string, input: UpdatePlatformInput) => {
  // 后端 PUT 需要完整对象；这里先拉取现有配置再合并，避免字段丢失
  const current = await apiRequest<any>(`/api/v1/platforms/${id}`);
  if (!current.success) return current as unknown as ApiResponse<Platform>;

  const p = current.data as any;
  const body: Record<string, unknown> = {
    name: input.name ?? p.name,
    platformType: input.platformType ?? p.platformType,
    providerId: input.providerId ?? p.providerId ?? null,
    apiUrl: input.apiUrl ?? p.apiUrl,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : p.enabled,
    maxConcurrency: p.maxConcurrency ?? 5,
    remark: p.remark ?? null,
  };
  if (input.apiKey) body.apiKey = input.apiKey;

  const updated = await apiRequest<{ id: string }>(`/api/v1/platforms/${id}`, { method: 'PUT', body });
  if (!updated.success) return updated as unknown as ApiResponse<Platform>;

  return await apiRequest<Platform>(`/api/v1/platforms/${id}`);
};

export const deletePlatformReal: DeletePlatformContract = async (id: string) => {
  const res = await apiRequest<true>(`/api/v1/platforms/${id}`, { method: 'DELETE', emptyResponseData: true });
  if (!res.success) return res;
  return ok(true);
};


