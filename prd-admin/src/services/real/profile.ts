import { useAuthStore } from '@/stores/authStore';
import { api } from '@/services/api';
import { apiMultipartRequest, apiRequest } from '@/services/real/apiClient';
import { toUserReadableErrorMessage } from '@/lib/userReadableError';
import { connectSse } from '@/lib/useSseStream';
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

const AVATAR_GENERATION_FALLBACK_POLL_INTERVAL_MS = 3_000;
const AVATAR_GENERATION_FALLBACK_MAX_POLLS = 200;
const AVATAR_GENERATION_STORAGE_PREFIX = 'prd-admin:avatar-generation-run:';
const AVATAR_GENERATION_CREATION_STORAGE_PREFIX = 'prd-admin:avatar-generation-create:';

type PendingAvatarGenerationCreation = {
  prompt: string;
  idempotencyKey: string;
};

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

function getPendingAvatarGenerationCreation(): PendingAvatarGenerationCreation | null {
  const storageKey = avatarGenerationCreationStorageKey();
  if (!storageKey) return null;
  try {
    const pending = JSON.parse(globalThis.sessionStorage?.getItem(storageKey) || 'null') as Partial<PendingAvatarGenerationCreation> | null;
    const prompt = String(pending?.prompt ?? '').trim();
    const idempotencyKey = String(pending?.idempotencyKey ?? '').trim();
    return prompt && idempotencyKey ? { prompt, idempotencyKey } : null;
  } catch {
    return null;
  }
}

function getOrCreateAvatarGenerationIdempotencyKey(prompt: string): string {
  const pending = getPendingAvatarGenerationCreation();
  if (pending?.prompt === prompt) return pending.idempotencyKey;

  const idempotencyKey = newAvatarGenerationIdempotencyKey();
  const storageKey = avatarGenerationCreationStorageKey();
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
    // 会话存储被浏览器策略禁用时，读写都会抛错；清理失败只降级本次恢复能力。
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

export function hasRecoverableMyAvatarGeneration(): boolean {
  return Boolean(getPendingMyAvatarGenerationRunId() || getPendingAvatarGenerationCreation());
}

function waitForNextPoll(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timeoutId = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, AVATAR_GENERATION_FALLBACK_POLL_INTERVAL_MS);
    const onAbort = () => {
      globalThis.clearTimeout(timeoutId);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function avatarGenerationFailure(code?: string | null): ApiResponse<{ previewUrl: string; assetSha256: string }> {
  const normalized = String(code ?? '').trim().toUpperCase();
  if (normalized === 'AVATAR_PROMPT_TOO_LONG') {
    return {
      success: false,
      data: null,
      error: { code: normalized, message: '头像修改描述不能超过 500 字，请缩短描述后重试。' },
    };
  }
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
  if (normalized === 'AVATAR_GENERATION_NOT_FOUND' || normalized === 'AVATAR_RESULT_UNAVAILABLE') {
    return {
      success: false,
      data: null,
      error: { code: normalized, message: '这次头像生成任务或结果已失效，请重新生成头像。' },
    };
  }
  // 后半段是路由解析失败的结构化原因（GatewayRouteFailure）：它们各自的文案在
  // userReadableError 映射表里，落到这里才不会被兜底成一句「头像生成服务暂时不可用」，
  // 把「配置不兼容」和「上游宕机」重新混成一团。
  if ([
    'IMAGE_GEN_REQUEST_REJECTED', 'LLM_QUOTA_EXCEEDED', 'QUOTA_EXCEEDED', 'RATE_LIMITED',
    'IMAGE_GEN_TIMEOUT', 'IMAGE_GEN_UNAVAILABLE',
    'ROUTE_CONFIG_INCOMPATIBLE', 'APPCALLER_POOL_UNBOUND', 'MODEL_POOL_EMPTY',
    'MODEL_POOL_ALL_UNAVAILABLE', 'LOGICAL_MODEL_CAPABILITY_MISMATCH', 'OFFERING_UNRESOLVABLE',
    'PLATFORM_DISABLED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_QUOTA_EXCEEDED',
    'GATEWAY_CONFIG_UNAVAILABLE', 'MODEL_NOT_IN_CATALOG',
  ].includes(normalized)) {
    return {
      success: false,
      data: null,
      error: {
        code: normalized,
        message: toUserReadableErrorMessage({ code: normalized }, {
          code: normalized,
          fallbackMessage: '头像生成服务暂时不可用',
          recoveryMessage: '请稍后重试。',
        }),
      },
    };
  }
  return {
    success: false,
    data: null,
    error: { code: normalized || 'AVATAR_GENERATION_FAILED', message: '头像生成服务暂时不可用，请稍后重试。' },
  };
}

function profileApiUrl(path: string): string {
  const rawBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
  if (!rawBase) return path;
  return `${rawBase}/${path.replace(/^\/+/, '')}`;
}

/**
 * 自服务：上传当前用户自己的头像（仅需 access 权限）
 */
export async function uploadMyAvatar(input: { file: File }): Promise<ApiResponse<AdminUserAvatarUploadResponse>> {
  const retainedRunId = getPendingMyAvatarGenerationRunId();
  const retainedCreationKey = getPendingAvatarGenerationCreation()?.idempotencyKey;
  const result = await apiMultipartRequest<AdminUserAvatarUploadResponse>(api.profile.avatarUpload(), {
    createFormData: () => {
      const formData = new FormData();
      formData.append('file', input.file);
      return formData;
    },
  });
  if (result.success) {
    if (retainedRunId) forgetAvatarGenerationRun(retainedRunId);
    if (retainedCreationKey) forgetAvatarGenerationCreation(retainedCreationKey);
    return result;
  }
  const code = result.error?.code || 'AVATAR_UPLOAD_FAILED';
  const recoveryMessage = code === 'DOCUMENT_TOO_LARGE'
    ? '请缩小图片后重新上传。'
    : code === 'NETWORK_ERROR' || code === 'DISCONNECTED'
      ? '请检查网络后重新上传。'
      : code === 'INVALID_FORMAT'
        ? '请稍后重新上传。'
        : '请检查图片后重新上传。';
  return {
    ...result,
    error: {
      code,
      message: toUserReadableErrorMessage(result.error, {
        code,
        fallbackMessage: '头像上传未完成',
        recoveryMessage,
      }),
    },
  } as ApiResponse<AdminUserAvatarUploadResponse>;
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
  if (prompt.length > 500) {
    return avatarGenerationFailure('AVATAR_PROMPT_TOO_LONG');
  }

  const idempotencyKey = getOrCreateAvatarGenerationIdempotencyKey(prompt);
  return createAndWaitForMyAvatarPreview(prompt, idempotencyKey, input);
}

async function createAndWaitForMyAvatarPreview(
  prompt: string,
  idempotencyKey: string,
  input: {
    onProgress?: (stage: string) => void;
    signal?: AbortSignal;
  },
): Promise<ApiResponse<{ previewUrl: string; assetSha256: string }>> {
  const created = await apiRequest<AvatarGenerationRun>(api.profile.avatarGenerationRuns(), {
    method: 'POST',
    body: { prompt },
    headers: { 'Idempotency-Key': idempotencyKey },
    timeoutMs: 20_000,
  });
  if (!created.success) {
    const code = String(created.error?.code ?? '').trim().toUpperCase();
    if (!['TIMEOUT', 'NETWORK_ERROR', 'DISCONNECTED', 'REQUEST_CANCELLED'].includes(code)) {
      forgetAvatarGenerationCreation(idempotencyKey);
    }
    return avatarGenerationFailure(created.error?.code);
  }

  const runId = String(created.data.runId ?? '').trim();
  if (!runId) return avatarGenerationFailure('AVATAR_GENERATION_NOT_FOUND');
  forgetAvatarGenerationCreation(idempotencyKey);
  rememberAvatarGenerationRun(runId);
  if (input.signal?.aborted) return avatarGenerationFailure('AVATAR_GENERATION_CANCELLED');
  input.onProgress?.(created.data.stage || '正在排队');

  return waitForMyAvatarPreview(runId, input);
}

export async function resumeMyAvatarPreview(input: {
  runId?: string | null;
  onProgress?: (stage: string) => void;
  signal?: AbortSignal;
}): Promise<ApiResponse<{ previewUrl: string; assetSha256: string }>> {
  const explicitRunId = String(input.runId || '').trim();
  input.onProgress?.('正在恢复头像生成任务');
  if (!explicitRunId) {
    const pendingCreation = getPendingAvatarGenerationCreation();
    if (pendingCreation) {
      return createAndWaitForMyAvatarPreview(
        pendingCreation.prompt,
        pendingCreation.idempotencyKey,
        input,
      );
    }
  }
  const runId = explicitRunId || getPendingMyAvatarGenerationRunId() || '';
  if (!runId) return avatarGenerationFailure('AVATAR_GENERATION_NOT_FOUND');
  rememberAvatarGenerationRun(runId);
  return waitForMyAvatarPreview(runId, input);
}

async function waitForMyAvatarPreview(
  runId: string,
  input: {
    onProgress?: (stage: string) => void;
    signal?: AbortSignal;
  },
): Promise<ApiResponse<{ previewUrl: string; assetSha256: string }>> {
  const streamed = await streamMyAvatarPreview(runId, input);
  if (streamed) return streamed;
  if (input.signal?.aborted) return avatarGenerationFailure('AVATAR_GENERATION_CANCELLED');

  // SSE 被代理或旧版本服务阻断时才降级轮询，避免正常生成期间重复读取 HTTP 与 MongoDB。
  for (let poll = 0; poll < AVATAR_GENERATION_FALLBACK_MAX_POLLS; poll += 1) {
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

    const terminal = resolveAvatarGenerationState(runId, current.data, input.onProgress);
    if (terminal) return terminal;
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

function resolveAvatarGenerationState(
  runId: string,
  current: AvatarGenerationRun,
  onProgress?: (stage: string) => void,
): ApiResponse<{ previewUrl: string; assetSha256: string }> | null {
  onProgress?.(current.stage || '正在生成头像');
  if (current.status === 'completed') {
    const previewUrl = String(current.previewUrl ?? '').trim();
    const assetSha256 = String(current.assetSha256 ?? '').trim().toLowerCase();
    if (previewUrl && /^[a-f0-9]{64}$/.test(assetSha256)) {
      return { success: true, data: { previewUrl, assetSha256 }, error: null };
    }
    forgetAvatarGenerationRun(runId);
    return avatarGenerationFailure('AVATAR_RESULT_UNAVAILABLE');
  }
  if (current.status === 'failed' || current.status === 'cancelled') {
    forgetAvatarGenerationRun(runId);
    return avatarGenerationFailure(current.errorCode);
  }
  return null;
}

async function streamMyAvatarPreview(
  runId: string,
  input: {
    onProgress?: (stage: string) => void;
    signal?: AbortSignal;
  },
): Promise<ApiResponse<{ previewUrl: string; assetSha256: string }> | null> {
  const streamController = new AbortController();
  const onAbort = () => streamController.abort();
  input.signal?.addEventListener('abort', onAbort, { once: true });
  let terminal: ApiResponse<{ previewUrl: string; assetSha256: string }> | null = null;

  try {
    const result = await connectSse({
      url: profileApiUrl(api.profile.avatarGenerationRunStream(encodeURIComponent(runId))),
      method: 'GET',
      signal: streamController.signal,
      onEvent: (event) => {
        if (event.event !== 'status' || !event.data || terminal) return;
        try {
          const current = JSON.parse(event.data) as AvatarGenerationRun;
          terminal = resolveAvatarGenerationState(runId, current, input.onProgress);
          if (terminal) streamController.abort();
        } catch {
          // 单帧损坏时等待下一帧；连接失败或结束后仍会走低频轮询兜底。
        }
      },
    });
    if (terminal) return terminal;
    if (input.signal?.aborted) return avatarGenerationFailure('AVATAR_GENERATION_CANCELLED');
    if (!result.success) return null;
    // 非终态流意外结束时降级轮询，避免代理截断导致任务永久卡住。
    return null;
  } finally {
    input.signal?.removeEventListener('abort', onAbort);
    streamController.abort();
  }
}

/** 将本人刚生成的视觉资产设为头像。服务端会再次校验资产归属。 */
export async function applyGeneratedMyAvatar(
  assetSha256: string,
): Promise<ApiResponse<AdminUserAvatarUploadResponse>> {
  const retainedRunId = getPendingMyAvatarGenerationRunId();
  const retainedCreationKey = getPendingAvatarGenerationCreation()?.idempotencyKey;
  const response = await apiRequest<AdminUserAvatarUploadResponse>(api.profile.avatarApplyGenerated(), {
    method: 'POST',
    body: { assetSha256 },
  });
  if (response.success && retainedRunId) forgetAvatarGenerationRun(retainedRunId);
  if (response.success && retainedCreationKey) forgetAvatarGenerationCreation(retainedCreationKey);
  return response;
}
