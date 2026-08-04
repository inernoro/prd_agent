import { useAuthStore } from '@/stores/authStore';
import { api } from '@/services/api';
import { apiRequest } from '@/services/real/apiClient';
import type { ApiResponse } from '@/types/api';
import type { AdminUserAvatarUploadResponse } from '@/services/contracts/userAvatarUpload';

type AvatarGenerationRun = {
  runId?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  stage: string;
  previewUrl?: string | null;
  assetSha256?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
};

const AVATAR_GENERATION_POLL_INTERVAL_MS = 800;
const AVATAR_GENERATION_MAX_POLLS = 750;

function waitForNextPoll(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, AVATAR_GENERATION_POLL_INTERVAL_MS));
}

function avatarGenerationFailure(code?: string | null): ApiResponse<{ previewUrl: string; assetSha256: string }> {
  const normalized = String(code ?? '').trim().toUpperCase();
  if (normalized === 'CONTENT_EMPTY' || normalized === 'INVALID_FORMAT' || normalized === 'AVATAR_SOURCE_UNAVAILABLE') {
    return {
      success: false,
      data: null,
      error: { code: normalized || 'AVATAR_SOURCE_UNAVAILABLE', message: '当前头像无法用于生成，请重新上传一张清晰图片后重试。' },
    };
  }
  if (normalized === 'UNAUTHORIZED' || normalized === 'PERMISSION_DENIED') {
    return {
      success: false,
      data: null,
      error: { code: normalized, message: '当前登录状态无法修改头像，请重新登录后重试。' },
    };
  }
  return {
    success: false,
    data: null,
    error: { code: normalized || 'AVATAR_GENERATION_FAILED', message: '头像生成服务暂时不可用，请稍后重试。' },
  };
}

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
  prompt: string;
  onProgress?: (stage: string) => void;
}): Promise<ApiResponse<{ previewUrl: string; assetSha256: string }>> {
  const prompt = input.prompt.trim();
  if (!prompt) {
    return { success: false, data: null, error: { code: 'CONTENT_EMPTY', message: '请描述想怎么修改头像' } };
  }

  const created = await apiRequest<AvatarGenerationRun>(api.profile.avatarGenerationRuns(), {
    method: 'POST',
    body: { prompt },
    timeoutMs: 20_000,
  });
  if (!created.success) return avatarGenerationFailure(created.error?.code);

  const runId = String(created.data.runId ?? '').trim();
  if (!runId) return avatarGenerationFailure('AVATAR_GENERATION_NOT_FOUND');
  input.onProgress?.(created.data.stage || '正在排队');

  for (let poll = 0; poll < AVATAR_GENERATION_MAX_POLLS; poll += 1) {
    await waitForNextPoll();
    const current = await apiRequest<AvatarGenerationRun>(
      api.profile.avatarGenerationRun(encodeURIComponent(runId)),
      { method: 'GET', timeoutMs: 15_000 },
    );
    if (!current.success) return avatarGenerationFailure(current.error?.code);

    input.onProgress?.(current.data.stage || '正在生成头像');
    if (current.data.status === 'completed') {
      const previewUrl = String(current.data.previewUrl ?? '').trim();
      const assetSha256 = String(current.data.assetSha256 ?? '').trim().toLowerCase();
      if (previewUrl && /^[a-f0-9]{64}$/.test(assetSha256)) {
        return { success: true, data: { previewUrl, assetSha256 }, error: null };
      }
      return avatarGenerationFailure('AVATAR_RESULT_UNAVAILABLE');
    }
    if (current.data.status === 'failed' || current.data.status === 'cancelled') {
      return avatarGenerationFailure(current.data.errorCode);
    }
  }

  return {
    success: false,
    data: null,
    error: {
      code: 'AVATAR_GENERATION_WAITING',
      message: '头像生成仍在继续，请稍后重新打开头像编辑器查看或重试。',
    },
  };
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
