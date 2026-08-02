import { useAuthStore } from '@/stores/authStore';
import { api } from '@/services/api';
import { apiRequest } from '@/services/real/apiClient';
import type { ApiResponse } from '@/types/api';
import type { AdminUserAvatarUploadResponse } from '@/services/contracts/userAvatarUpload';
import type { ImageGenGenerateResponse } from '@/services/contracts/imageGen';
import { avatarSourceToDataUrl, resolveGeneratedAvatarAsset } from '@/lib/avatarAi';

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

/**
 * 基于当前头像生成一张替换预览。生成结果仅返回给前端，用户确认后才会上传并替换头像。
 */
export async function generateMyAvatarPreview(input: {
  sourceImageUrl: string;
  prompt: string;
}): Promise<ApiResponse<{ previewUrl: string; assetSha256: string }>> {
  const prompt = input.prompt.trim();
  if (!prompt) {
    return { success: false, data: null, error: { code: 'CONTENT_EMPTY', message: '请描述想怎么修改头像' } };
  }

  try {
    const sourceImageUrl = input.sourceImageUrl.trim();
    if (!sourceImageUrl) throw new Error('当前头像不可用，请先上传一张头像');
    const isPublicImageUrl = sourceImageUrl.startsWith('https://');
    const sourceImage = isPublicImageUrl ? null : await avatarSourceToDataUrl(sourceImageUrl);
    const res = await apiRequest<ImageGenGenerateResponse>(api.visualAgent.imageGen.generate(), {
      method: 'POST',
      body: {
        prompt: `基于参考头像进行编辑，保持人物身份和主要五官特征，输出适合作为账号头像的正方形构图。用户要求：${prompt}`,
        images: sourceImage ? [sourceImage] : undefined,
        initImageUrl: isPublicImageUrl ? sourceImageUrl : undefined,
        n: 1,
        size: '1024x1024',
        responseFormat: 'b64_json',
      },
    });
    if (!res.success) return res as ApiResponse<{ previewUrl: string; assetSha256: string }>;

    const asset = resolveGeneratedAvatarAsset(res.data.images?.[0]);
    return { success: true, data: asset, error: null };
  } catch (error) {
    return {
      success: false,
      data: null,
      error: {
        code: 'AVATAR_GENERATION_FAILED',
        message: error instanceof Error ? error.message : '头像生成失败，请重试',
      },
    };
  }
}

/** 将本人刚生成的视觉资产设为头像。服务端会再次校验资产归属。 */
export async function applyGeneratedMyAvatar(
  assetSha256: string,
): Promise<ApiResponse<AdminUserAvatarUploadResponse>> {
  return apiRequest<AdminUserAvatarUploadResponse>(api.profile.avatarApplyGenerated(), {
    method: 'POST',
    body: { assetSha256 },
  });
}
