import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type {
  GetModelSizesContract,
  GetWatermarksContract,
  GetWatermarkByAppContract,
  CreateWatermarkContract,
  UpdateWatermarkContract,
  DeleteWatermarkContract,
  BindWatermarkAppContract,
  UnbindWatermarkAppContract,
  GetWatermarkFontsContract,
  UploadWatermarkFontContract,
  DeleteWatermarkFontContract,
  WatermarkFontInfo,
  UploadWatermarkIconContract,
} from '@/services/contracts/watermark';
import type { ApiResponse } from '@/types/api';

/**
 * 获取当前用户的所有水印配置
 */
export const getWatermarksReal: GetWatermarksContract = async () => {
  return await apiRequest(api.watermark.list(), { method: 'GET' });
};

/**
 * 获取绑定到指定应用的水印配置
 */
export const getWatermarkByAppReal: GetWatermarkByAppContract = async (input) => {
  return await apiRequest(api.watermark.byApp(encodeURIComponent(input.appKey)), { method: 'GET' });
};

/**
 * 创建新的水印配置
 */
export const createWatermarkReal: CreateWatermarkContract = async (input) => {
  return await apiRequest(api.watermark.list(), { method: 'POST', body: input });
};

/**
 * 更新水印配置
 */
export const updateWatermarkReal: UpdateWatermarkContract = async (input) => {
  const { id, ...body } = input;
  return await apiRequest(api.watermark.byId(encodeURIComponent(id)), { method: 'PUT', body });
};

/**
 * 删除水印配置
 */
export const deleteWatermarkReal: DeleteWatermarkContract = async (input) => {
  return await apiRequest(api.watermark.byId(encodeURIComponent(input.id)), { method: 'DELETE' });
};

/**
 * 绑定水印到指定应用（会先解绑该应用在其他水印上的绑定）
 */
export const bindWatermarkAppReal: BindWatermarkAppContract = async (input) => {
  return await apiRequest(api.watermark.bind(encodeURIComponent(input.id), encodeURIComponent(input.appKey)), {
    method: 'POST',
  });
};

/**
 * 解绑水印与指定应用的关联
 */
export const unbindWatermarkAppReal: UnbindWatermarkAppContract = async (input) => {
  return await apiRequest(api.watermark.unbind(encodeURIComponent(input.id), encodeURIComponent(input.appKey)), {
    method: 'DELETE',
  });
};

export const getWatermarkFontsReal: GetWatermarkFontsContract = async () => {
  return await apiRequest(api.watermark.fonts.list(), { method: 'GET' });
};

export const uploadWatermarkFontReal: UploadWatermarkFontContract = async (input) => {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const fd = new FormData();
  fd.append('file', input.file);
  if (input.displayName) fd.append('displayName', input.displayName);

  const rawBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
  const url = rawBase ? `${rawBase}${api.watermark.fonts.list()}` : api.watermark.fonts.list();
  const res = await fetch(url, { method: 'POST', headers, body: fd });
  const text = await res.text();
  try {
    return JSON.parse(text) as ApiResponse<WatermarkFontInfo>;
  } catch {
    return {
      success: false,
      data: null as never,
      error: { code: 'INVALID_FORMAT', message: `响应解析失败（HTTP ${res.status}）` },
    };
  }
};

export const deleteWatermarkFontReal: DeleteWatermarkFontContract = async (input) => {
  return await apiRequest(api.watermark.fonts.byKey(encodeURIComponent(input.fontKey)), { method: 'DELETE' });
};

export const uploadWatermarkIconReal: UploadWatermarkIconContract = async (input) => {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const fd = new FormData();
  fd.append('file', input.file);

  const rawBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
  const url = rawBase ? `${rawBase}${api.watermark.icons()}` : api.watermark.icons();
  const res = await fetch(url, { method: 'POST', headers, body: fd });
  const text = await res.text();
  try {
    return JSON.parse(text) as ApiResponse<{ url: string }>;
  } catch {
    return {
      success: false,
      data: null as never,
      error: { code: 'INVALID_FORMAT', message: `响应解析失败（HTTP ${res.status}）` },
    };
  }
};

export const getModelSizesReal: GetModelSizesContract = async (input) => {
  const key = encodeURIComponent(input.modelKey);
  return await apiRequest(api.modelSizes(key), { method: 'GET' });
};

/**
 * 测试水印：上传图片，返回带水印的图片 Blob
 * 单张图片返回图片，多张图片返回 ZIP 压缩包
 */
export const testWatermarkReal = async (input: { id: string; files: File[] }): Promise<{ success: boolean; blob?: Blob; isZip?: boolean; error?: string }> => {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const fd = new FormData();
  for (const file of input.files) {
    fd.append('files', file);
  }

  const rawBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
  const url = rawBase ? `${rawBase}/api/watermarks/${encodeURIComponent(input.id)}/test` : `/api/watermarks/${encodeURIComponent(input.id)}/test`;
  
  try {
    const res = await fetch(url, { method: 'POST', headers, body: fd });
    if (!res.ok) {
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        return { success: false, error: json.error?.message || `请求失败 (${res.status})` };
      } catch {
        return { success: false, error: `请求失败 (${res.status})` };
      }
    }
    const blob = await res.blob();
    const isZip = blob.type === 'application/zip' || res.headers.get('content-type')?.includes('zip');
    return { success: true, blob, isZip };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : '网络请求失败' };
  }
};
