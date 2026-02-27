import { useAuthStore } from '@/stores/authStore';
import { api } from '@/services/api';
import { apiRequest } from '@/services/real/apiClient';
import type { ApiResponse } from '@/types/api';
import type { AdminUserAvatarUploadResponse } from '@/services/contracts/userAvatarUpload';

/**
 * 自服务：上传当前用户自己的头像（仅需 access 权限）
 */
export async function uploadMyAvatar(input: { file: File }): Promise<ApiResponse<AdminUserAvatarUploadResponse>> {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const fd = new FormData();
  fd.append('file', input.file);

  const rawBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
  const url = rawBase
    ? `${rawBase}${api.profile.avatarUpload()}`
    : api.profile.avatarUpload();

  const res = await fetch(url, { method: 'POST', headers, body: fd });
  const text = await res.text();
  try {
    return JSON.parse(text) as ApiResponse<AdminUserAvatarUploadResponse>;
  } catch {
    return {
      success: false,
      data: null,
      error: { code: 'INVALID_FORMAT', message: `响应解析失败（HTTP ${res.status}）` },
    } as ApiResponse<AdminUserAvatarUploadResponse>;
  }
}

/**
 * 自服务：更新当前用户自己的头像文件名（仅需 access 权限）
 */
export async function updateMyAvatar(
  avatarFileName: string | null
): Promise<ApiResponse<{ userId: string; avatarFileName?: string | null; avatarUrl?: string | null; updatedAt?: string }>> {
  return apiRequest<{ userId: string; avatarFileName?: string | null; avatarUrl?: string | null; updatedAt?: string }>(
    api.profile.avatar(),
    {
      method: 'PUT',
      body: { avatarFileName: avatarFileName || null },
    }
  );
}
