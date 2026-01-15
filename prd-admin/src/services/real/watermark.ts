import { apiRequest } from '@/services/real/apiClient';
import { useAuthStore } from '@/stores/authStore';
import type {
  GetModelSizesContract,
  GetWatermarkContract,
  GetWatermarkFontsContract,
  UploadWatermarkFontContract,
  DeleteWatermarkFontContract,
  PutWatermarkContract,
  WatermarkFontInfo,
} from '@/services/contracts/watermark';
import type { ApiResponse } from '@/types/api';

export const getWatermarkReal: GetWatermarkContract = async () => {
  return await apiRequest('/api/user/watermark', { method: 'GET' });
};

export const putWatermarkReal: PutWatermarkContract = async (input) => {
  return await apiRequest('/api/user/watermark', { method: 'PUT', body: input });
};

export const getWatermarkFontsReal: GetWatermarkFontsContract = async () => {
  return await apiRequest('/api/watermark/fonts', { method: 'GET' });
};

export const uploadWatermarkFontReal: UploadWatermarkFontContract = async (input) => {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const fd = new FormData();
  fd.append('file', input.file);
  if (input.displayName) fd.append('displayName', input.displayName);

  const rawBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
  const url = rawBase ? `${rawBase}/api/watermark/fonts` : '/api/watermark/fonts';
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
  return await apiRequest(`/api/watermark/fonts/${encodeURIComponent(input.fontKey)}`, { method: 'DELETE' });
};

export const getModelSizesReal: GetModelSizesContract = async (input) => {
  const key = encodeURIComponent(input.modelKey);
  return await apiRequest(`/api/model/${key}/sizes`, { method: 'GET' });
};
