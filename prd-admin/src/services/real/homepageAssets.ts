import { apiRequest } from './apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';
import { useAuthStore } from '@/stores/authStore';
import type { HomepageAssetDto, HomepageAssetsMap } from '@/services/contracts/homepageAssets';

export async function listHomepageAssets(): Promise<ApiResponse<HomepageAssetDto[]>> {
  return await apiRequest<HomepageAssetDto[]>(api.assets.homepage.list());
}

export async function deleteHomepageAsset(input: { slot: string }): Promise<ApiResponse<{ deleted: boolean }>> {
  return await apiRequest<{ deleted: boolean }>(api.assets.homepage.bySlot(input.slot), {
    method: 'DELETE',
    emptyResponseData: { deleted: true },
  });
}

export async function uploadHomepageAsset(input: { slot: string; file: File }): Promise<ApiResponse<HomepageAssetDto>> {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const fd = new FormData();
  fd.append('slot', input.slot);
  fd.append('file', input.file);

  const rawBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
  const url = rawBase ? `${rawBase}${api.assets.homepage.upload()}` : api.assets.homepage.upload();
  const res = await fetch(url, { method: 'POST', headers, body: fd });
  const text = await res.text();
  try {
    return JSON.parse(text) as ApiResponse<HomepageAssetDto>;
  } catch {
    return {
      success: false,
      data: null,
      error: { code: 'INVALID_FORMAT', message: `响应解析失败（HTTP ${res.status}）` },
    } as ApiResponse<HomepageAssetDto>;
  }
}

export async function getHomepageAssetsPublic(): Promise<ApiResponse<HomepageAssetsMap>> {
  return await apiRequest<HomepageAssetsMap>(api.homepageAssets());
}
