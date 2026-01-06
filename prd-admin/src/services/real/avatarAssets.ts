import { useAuthStore } from '@/stores/authStore';
import type { ApiResponse } from '@/types/api';
import type { AdminNoHeadAvatarUploadResponse } from '@/services/contracts/avatarAssets';

export async function uploadNoHeadAvatar(input: { file: File }): Promise<ApiResponse<AdminNoHeadAvatarUploadResponse>> {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const fd = new FormData();
  fd.append('file', input.file);

  const rawBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
  const url = rawBase ? `${rawBase}/api/v1/admin/assets/avatars/nohead` : '/api/v1/admin/assets/avatars/nohead';
  const res = await fetch(url, { method: 'POST', headers, body: fd });
  const text = await res.text();
  try {
    return JSON.parse(text) as ApiResponse<AdminNoHeadAvatarUploadResponse>;
  } catch {
    return {
      success: false,
      data: null,
      error: { code: 'INVALID_FORMAT', message: `响应解析失败（HTTP ${res.status}）` },
    } as ApiResponse<AdminNoHeadAvatarUploadResponse>;
  }
}


