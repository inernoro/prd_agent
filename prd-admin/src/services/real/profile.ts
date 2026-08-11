import { useAuthStore } from '@/stores/authStore';
import { api } from '@/services/api';
import { apiRequest } from '@/services/real/apiClient';
import { toUserReadableErrorMessage } from '@/lib/userReadableError';
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
const AVATAR_GENERATION_STORAGE_PREFIX = 'prd-admin:avatar-generation-run:';
const AVATAR_GENERATION_CREATION_STORAGE_PREFIX = 'prd-admin:avatar-generation-create:';

function avatarGenerationStorageKey(): string | null {
  const userId = String(useAuthStore.getState().user?.userId ?? '').trim();
  return userId ? `${AVATAR_GENERATION_STORAGE_PREFIX}${userId}` : null;
}

function avatarGenerationCreationStorageKey(): string | null {
  const userId = String(useAuthStore.getState().user?.userId ?? '').trim();
  return userId ? `${AVATAR_GENERATION_CREATION_STORAGE_PREFIX}${userId}` : null;
}

function newAvatarGenerationIdempotencyKey(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return `profile-avatar-${randomUuid}`;
  return `profile-avatar-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
}

function getOrCreateAvatarGenerationIdempotencyKey(prompt: string): string {
  const storageKey = avatarGenerationCreationStorageKey();
  if (storageKey) {
    try {
      const pending = JSON.parse(globalThis.sessionStorage?.getItem(storageKey) || 'null') as {
        prompt?: string;
        idempotencyKey?: string;
      } | null;
      if (pending?.prompt === prompt && pending.idempotencyKey?.trim()) {
        return pending.idempotencyKey.trim();
      }
    } catch {
      // 损坏的会话记录会在下面被新记录覆盖。
    }
  }

  const idempotencyKey = newAvatarGenerationIdempotencyKey();
  if (storageKey) {
    try {
      globalThis.sessionStorage?.setItem(storageKey, JSON.stringify({ prompt, idempotencyKey }));
    } catch {
      // 会话存储不可用时仍由服务端唯一索引保护单次已携带的请求。
    }
  }
  return idempotencyKey;
}

function forgetAvatarGenerationCreation(idempotencyKey: string): void {
  const storageKey = avatarGenerationCreationStorageKey();
  if (!storageKey) return;
  try {
    const pending = JSON.parse(globalThis.sessionStorage?.getItem(storageKey) || 'null') as {
      idempotencyKey?: string;
    } | null;
    if (pending?.idempotencyKey === idempotencyKey) {
      globalThis.sessionStorage.removeItem(storageKey);
    }
  } catch {
    globalThis.sessionStorage?.removeItem(storageKey);
  }
}

function rememberAvatarGenerationRun(runId: string): void {
  const key = avatarGenerationStorageKey();
  if (!key) return;
  try {
    globalThis.sessionStorage?.setItem(key, runId);
  } catch {
    // 浏览器禁用会话存储时仍允许本次前台轮询继续。
  }
}

function forgetAvatarGenerationRun(runId: string): void {
  const key = avatarGenerationStorageKey();
  if (!key) return;
  try {
    if (globalThis.sessionStorage?.getItem(key) === runId) {
      globalThis.sessionStorage.removeItem(key);
    }
  } catch {
    // 会话存储不可用时无需影响头像结果。
  }
}

export function getPendingMyAvatarGenerationRunId(): string | null {
  const key = avatarGenerationStorageKey();
  if (!key) return null;
  try {
    return globalThis.sessionStorage?.getItem(key)?.trim() || null;
  } catch {
    return null;
  }
}

function waitForNextPoll(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timeoutId = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, AVATAR_GENERATION_POLL_INTERVAL_MS);
    const onAbort = () => {
      globalThis.clearTimeout(timeoutId);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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
  if (normalized === 'UNAUTHORIZED') {
    return {
      success: false,
      data: null,
      error: { code: normalized, message: '当前登录状态无法修改头像，请重新登录后重试。' },
    };
  }
  if (normalized === 'PERMISSION_DENIED') {
    return {
      success: false,
      data: null,
      error: { code: normalized, message: '当前账号没有视觉创作权限，请联系管理员开通后重试。' },
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

  try {
    const res = await fetch(url, { method: 'POST', headers, body: fd });
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as ApiResponse<AdminUserAvatarUploadResponse>;
      if (parsed.success) return parsed;
      const code = parsed.error?.code || 'AVATAR_UPLOAD_FAILED';
      return {
        ...parsed,
        error: {
          code,
          message: toUserReadableErrorMessage(parsed.error, {
            code,
            fallbackMessage: '头像上传未完成',
            recoveryMessage: '请检查图片后重新上传。',
          }),
        },
      };
    } catch {
      return {
        success: false,
        data: null,
        error: { code: 'INVALID_FORMAT', message: '头像上传未完成，请稍后重新上传。' },
      } as ApiResponse<AdminUserAvatarUploadResponse>;
    }
  } catch (error) {
    return {
      success: false,
      data: null,
      error: {
        code: 'NETWORK_ERROR',
        message: toUserReadableErrorMessage(error, {
          code: 'NETWORK_ERROR',
          fallbackMessage: '头像上传未完成',
          recoveryMessage: '请检查网络后重新上传。',
        }),
      },
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
  signal?: AbortSignal;
}): Promise<ApiResponse<{ previewUrl: string; assetSha256: string }>> {
  const prompt = input.prompt.trim();
  if (!prompt) {
    return { success: false, data: null, error: { code: 'CONTENT_EMPTY', message: '请描述想怎么修改头像' } };
  }

  const idempotencyKey = getOrCreateAvatarGenerationIdempotencyKey(prompt);
  const created = await apiRequest<AvatarGenerationRun>(api.profile.avatarGenerationRuns(), {
    method: 'POST',
    body: { prompt },
    headers: { 'Idempotency-Key': idempotencyKey },
    timeoutMs: 20_000,
    signal: input.signal,
  });
  if (input.signal?.aborted) return avatarGenerationFailure('AVATAR_GENERATION_CANCELLED');
  if (!created.success) return avatarGenerationFailure(created.error?.code);

  const runId = String(created.data.runId ?? '').trim();
  if (!runId) return avatarGenerationFailure('AVATAR_GENERATION_NOT_FOUND');
  forgetAvatarGenerationCreation(idempotencyKey);
  rememberAvatarGenerationRun(runId);
  input.onProgress?.(created.data.stage || '正在排队');

  return waitForMyAvatarPreview(runId, input);
}

export async function resumeMyAvatarPreview(input: {
  runId?: string | null;
  onProgress?: (stage: string) => void;
  signal?: AbortSignal;
}): Promise<ApiResponse<{ previewUrl: string; assetSha256: string }>> {
  const runId = String(input.runId || getPendingMyAvatarGenerationRunId() || '').trim();
  if (!runId) return avatarGenerationFailure('AVATAR_GENERATION_NOT_FOUND');
  rememberAvatarGenerationRun(runId);
  input.onProgress?.('正在恢复头像生成任务');
  return waitForMyAvatarPreview(runId, input);
}

async function waitForMyAvatarPreview(
  runId: string,
  input: {
    onProgress?: (stage: string) => void;
    signal?: AbortSignal;
  },
): Promise<ApiResponse<{ previewUrl: string; assetSha256: string }>> {

  for (let poll = 0; poll < AVATAR_GENERATION_MAX_POLLS; poll += 1) {
    if (!await waitForNextPoll(input.signal)) return avatarGenerationFailure('AVATAR_GENERATION_CANCELLED');
    const current = await apiRequest<AvatarGenerationRun>(
      api.profile.avatarGenerationRun(encodeURIComponent(runId)),
      { method: 'GET', timeoutMs: 15_000, signal: input.signal },
    );
    if (input.signal?.aborted) return avatarGenerationFailure('AVATAR_GENERATION_CANCELLED');
    if (!current.success) {
      if (String(current.error?.code ?? '').trim().toUpperCase() === 'AVATAR_GENERATION_NOT_FOUND') {
        forgetAvatarGenerationRun(runId);
      }
      return avatarGenerationFailure(current.error?.code);
    }

    input.onProgress?.(current.data.stage || '正在生成头像');
    if (current.data.status === 'completed') {
      const previewUrl = String(current.data.previewUrl ?? '').trim();
      const assetSha256 = String(current.data.assetSha256 ?? '').trim().toLowerCase();
      if (previewUrl && /^[a-f0-9]{64}$/.test(assetSha256)) {
        forgetAvatarGenerationRun(runId);
        return { success: true, data: { previewUrl, assetSha256 }, error: null };
      }
      forgetAvatarGenerationRun(runId);
      return avatarGenerationFailure('AVATAR_RESULT_UNAVAILABLE');
    }
    if (current.data.status === 'failed' || current.data.status === 'cancelled') {
      forgetAvatarGenerationRun(runId);
      return avatarGenerationFailure(current.data.errorCode);
    }
  }

  return {
    success: false,
    data: null,
    error: {
      code: 'AVATAR_GENERATION_WAITING',
      message: '头像生成仍在继续，稍后重新打开头像编辑器会自动恢复当前任务。',
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
