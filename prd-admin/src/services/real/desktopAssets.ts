import { apiRequest } from './apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';
import { useAuthStore } from '@/stores/authStore';
import type {
  AdminDesktopAssetUploadResponse,
  AdminDesktopAssetMatrixRow,
  DesktopAssetKey,
  DesktopAssetSkin,
} from '@/services/contracts/desktopAssets';

export async function listDesktopAssetSkins(): Promise<ApiResponse<DesktopAssetSkin[]>> {
  return await apiRequest<DesktopAssetSkin[]>(api.assets.desktop.skins.list());
}

export async function createDesktopAssetSkin(input: { name: string; enabled?: boolean }): Promise<ApiResponse<DesktopAssetSkin>> {
  return await apiRequest<DesktopAssetSkin>(api.assets.desktop.skins.list(), { method: 'POST', body: input });
}

export async function updateDesktopAssetSkin(input: { id: string; enabled?: boolean }): Promise<ApiResponse<DesktopAssetSkin>> {
  return await apiRequest<DesktopAssetSkin>(api.assets.desktop.skins.byId(encodeURIComponent(input.id)), {
    method: 'PUT',
    body: { enabled: input.enabled },
  });
}

export async function deleteDesktopAssetSkin(input: { id: string }): Promise<ApiResponse<{ deleted: boolean }>> {
  return await apiRequest<{ deleted: boolean }>(api.assets.desktop.skins.byId(encodeURIComponent(input.id)), {
    method: 'DELETE',
    emptyResponseData: { deleted: true },
  });
}

export async function listDesktopAssetKeys(): Promise<ApiResponse<DesktopAssetKey[]>> {
  return await apiRequest<DesktopAssetKey[]>(api.assets.desktop.keys.list());
}

export async function createDesktopAssetKey(input: {
  key: string;
  kind?: string;
  description?: string | null;
}): Promise<ApiResponse<DesktopAssetKey>> {
  return await apiRequest<DesktopAssetKey>(api.assets.desktop.keys.list(), { method: 'POST', body: input });
}

export async function deleteDesktopAssetKey(input: { id: string }): Promise<ApiResponse<{ deleted: boolean }>> {
  return await apiRequest<{ deleted: boolean }>(api.assets.desktop.keys.byId(input.id), {
    method: 'DELETE',
    emptyResponseData: { deleted: true },
  });
}

async function uploadDesktopAssetMultipart(args: {
  skin?: string | null;
  key: string;
  file: File;
}): Promise<ApiResponse<AdminDesktopAssetUploadResponse>> {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const fd = new FormData();
  if (args.skin) fd.append('skin', args.skin);
  fd.append('key', args.key);
  fd.append('file', args.file);

  const rawBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
  const url = rawBase ? `${rawBase}${api.assets.desktop.upload()}` : api.assets.desktop.upload();
  const res = await fetch(url, { method: 'POST', headers, body: fd });
  const text = await res.text();
  try {
    return JSON.parse(text) as ApiResponse<AdminDesktopAssetUploadResponse>;
  } catch {
    return {
      success: false,
      data: null,
      error: { code: 'INVALID_FORMAT', message: `响应解析失败（HTTP ${res.status}）` },
    } as ApiResponse<AdminDesktopAssetUploadResponse>;
  }
}

export async function uploadDesktopAsset(input: {
  skin?: string | null;
  key: string;
  file: File;
}): Promise<ApiResponse<AdminDesktopAssetUploadResponse>> {
  return await uploadDesktopAssetMultipart(input);
}

export async function getDesktopAssetsMatrix(): Promise<ApiResponse<AdminDesktopAssetMatrixRow[]>> {
  return await apiRequest<AdminDesktopAssetMatrixRow[]>(api.assets.desktop.matrix());
}


