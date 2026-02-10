import { apiRequest } from './apiClient';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type {
  GetLiteraryAgentConfigContract,
  UpdateLiteraryAgentConfigContract,
  UploadReferenceImageContract,
  ClearReferenceImageContract,
  ListReferenceImageConfigsContract,
  CreateReferenceImageConfigContract,
  UpdateReferenceImageConfigContract,
  UpdateReferenceImageFileContract,
  DeleteReferenceImageConfigContract,
  ActivateReferenceImageConfigContract,
  DeactivateReferenceImageConfigContract,
  GetActiveReferenceImageConfigContract,
  LiteraryAgentConfig,
  ReferenceImageConfig,
} from '../contracts/literaryAgentConfig';

export const getLiteraryAgentConfigReal: GetLiteraryAgentConfigContract = async () => {
  return await apiRequest<LiteraryAgentConfig>(api.literaryAgent.config.get(), {
    method: 'GET',
  });
};

export const updateLiteraryAgentConfigReal: UpdateLiteraryAgentConfigContract = async (input) => {
  return await apiRequest<LiteraryAgentConfig>(api.literaryAgent.config.get(), {
    method: 'PUT',
    body: {
      referenceImageSha256: input.referenceImageSha256,
      referenceImageUrl: input.referenceImageUrl,
    },
  });
};

export const uploadReferenceImageReal: UploadReferenceImageContract = async (file) => {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const fd = new FormData();
  fd.append('file', file);

  const rawBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
  const url = rawBase
    ? `${rawBase}${api.literaryAgent.config.referenceImage()}`
    : api.literaryAgent.config.referenceImage();

  const res = await fetch(url, { method: 'POST', headers, body: fd });
  const json = await res.json();

  if (!res.ok || !json.success) {
    return {
      success: false,
      data: null,
      error: json.error ?? { code: 'UPLOAD_FAILED', message: '上传失败' },
    };
  }

  return {
    success: true,
    data: json.data as { sha256: string; url: string; config: LiteraryAgentConfig },
    error: null,
  };
};

export const clearReferenceImageReal: ClearReferenceImageContract = async () => {
  return await apiRequest<{ cleared: boolean; config: LiteraryAgentConfig }>(
    api.literaryAgent.config.referenceImage(),
    { method: 'DELETE' }
  );
};

// ========== 新的底图配置 API ==========

export const listReferenceImageConfigsReal: ListReferenceImageConfigsContract = async () => {
  return await apiRequest<{ items: ReferenceImageConfig[] }>(
    api.literaryAgent.config.referenceImages.list(),
    { method: 'GET' }
  );
};

export const createReferenceImageConfigReal: CreateReferenceImageConfigContract = async (input) => {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const fd = new FormData();
  fd.append('name', input.name);
  if (input.prompt) fd.append('prompt', input.prompt);
  fd.append('file', input.file);

  const rawBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
  const url = rawBase
    ? `${rawBase}${api.literaryAgent.config.referenceImages.list()}`
    : api.literaryAgent.config.referenceImages.list();

  const res = await fetch(url, { method: 'POST', headers, body: fd });
  const json = await res.json();

  if (!res.ok || !json.success) {
    return {
      success: false,
      data: null,
      error: json.error ?? { code: 'CREATE_FAILED', message: '创建失败' },
    };
  }

  return {
    success: true,
    data: json.data as { config: ReferenceImageConfig },
    error: null,
  };
};

export const updateReferenceImageConfigReal: UpdateReferenceImageConfigContract = async (input) => {
  return await apiRequest<{ config: ReferenceImageConfig }>(
    api.literaryAgent.config.referenceImages.byId(encodeURIComponent(input.id)),
    {
      method: 'PUT',
      body: {
        name: input.name,
        prompt: input.prompt,
      },
    }
  );
};

export const updateReferenceImageFileReal: UpdateReferenceImageFileContract = async (input) => {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const fd = new FormData();
  fd.append('file', input.file);

  const rawBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
  const url = rawBase
    ? `${rawBase}${api.literaryAgent.config.referenceImages.image(encodeURIComponent(input.id))}`
    : api.literaryAgent.config.referenceImages.image(encodeURIComponent(input.id));

  const res = await fetch(url, { method: 'PUT', headers, body: fd });
  const json = await res.json();

  if (!res.ok || !json.success) {
    return {
      success: false,
      data: null,
      error: json.error ?? { code: 'UPDATE_FAILED', message: '更新失败' },
    };
  }

  return {
    success: true,
    data: json.data as { config: ReferenceImageConfig },
    error: null,
  };
};

export const deleteReferenceImageConfigReal: DeleteReferenceImageConfigContract = async (input) => {
  return await apiRequest<{ deleted: boolean }>(
    api.literaryAgent.config.referenceImages.byId(encodeURIComponent(input.id)),
    { method: 'DELETE' }
  );
};

export const activateReferenceImageConfigReal: ActivateReferenceImageConfigContract = async (input) => {
  return await apiRequest<{ config: ReferenceImageConfig }>(
    api.literaryAgent.config.referenceImages.activate(encodeURIComponent(input.id)),
    { method: 'POST' }
  );
};

export const deactivateReferenceImageConfigReal: DeactivateReferenceImageConfigContract = async (input) => {
  return await apiRequest<{ config: ReferenceImageConfig }>(
    api.literaryAgent.config.referenceImages.deactivate(encodeURIComponent(input.id)),
    { method: 'POST' }
  );
};

export const getActiveReferenceImageConfigReal: GetActiveReferenceImageConfigContract = async () => {
  return await apiRequest<{ config: ReferenceImageConfig | null }>(
    api.literaryAgent.config.referenceImages.active(),
    { method: 'GET' }
  );
};

// ========== 模型查询 API（无参数）==========

import type {
  GetLiteraryAgentImageGenModelsContract,
  GetLiteraryAgentAllModelsContract,
  GetLiteraryAgentMainModelContract,
  LiteraryAgentModelPool,
  LiteraryAgentAllModelsResponse,
} from '../contracts/literaryAgentConfig';

/**
 * 获取文学创作配图生成可用的模型池列表（兼容旧接口）
 * 根据是否有激活的参考图自动选择 appCallerCode
 */
export const getLiteraryAgentImageGenModelsReal: GetLiteraryAgentImageGenModelsContract = async () => {
  return await apiRequest<LiteraryAgentModelPool[]>(
    api.literaryAgent.config.modelsImageGen(),
    { method: 'GET' }
  );
};

/**
 * 获取所有配图模型池（文生图 + 图生图），一次性返回
 * 前端可用于同时显示两个模型状态
 */
export const getLiteraryAgentAllModelsReal: GetLiteraryAgentAllModelsContract = async () => {
  return await apiRequest<LiteraryAgentAllModelsResponse>(
    api.literaryAgent.config.modelsAll(),
    { method: 'GET' }
  );
};

export const getLiteraryAgentMainModelReal: GetLiteraryAgentMainModelContract = async () => {
  return await apiRequest<{ model: import('../contracts/literaryAgentConfig').LiteraryAgentMainModel | null }>(
    api.literaryAgent.config.modelsMain(),
    { method: 'GET' }
  );
};

// ========== 图片生成 API（应用身份隔离）==========

import type {
  CreateLiteraryAgentImageGenRunContract,
  CancelLiteraryAgentImageGenRunContract,
  StreamLiteraryAgentImageGenRunContract,
  StreamLiteraryAgentImageGenRunWithRetryContract,
} from '../contracts/literaryAgentConfig';
import { fail, ok } from '@/types/api';
import { readSseStream } from '@/lib/sse';

function getApiBaseUrl() {
  const raw = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:5000';
  return raw.trim().replace(/\/+$/, '');
}

function joinUrl(base: string, path: string) {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  if (!b) return `/${p}`;
  return `${b}/${p}`;
}

/**
 * 创建文学创作图片生成任务
 * 使用 /api/literary-agent/image-gen/runs 接口
 */
export const createLiteraryAgentImageGenRunReal: CreateLiteraryAgentImageGenRunContract = async ({ input, idempotencyKey }) => {
  const headers: Record<string, string> = {};
  const idem = String(idempotencyKey ?? '').trim();
  if (idem) headers['Idempotency-Key'] = idem;
  return await apiRequest(api.literaryAgent.imageGen.runs.create(), { method: 'POST', body: input, headers });
};

/**
 * 取消文学创作图片生成任务
 */
export const cancelLiteraryAgentImageGenRunReal: CancelLiteraryAgentImageGenRunContract = async ({ runId }) => {
  const rid = encodeURIComponent(String(runId ?? '').trim());
  return await apiRequest(api.literaryAgent.imageGen.runs.cancel(rid), { method: 'POST' });
};

/**
 * SSE 流式获取文学创作图片生成任务事件
 */
export const streamLiteraryAgentImageGenRunReal: StreamLiteraryAgentImageGenRunContract = async ({ runId, afterSeq, onEvent, signal }) => {
  const token = useAuthStore.getState().token;
  if (!token) return fail('UNAUTHORIZED', '未登录') as unknown as ReturnType<StreamLiteraryAgentImageGenRunContract>;

  const rid = encodeURIComponent(String(runId ?? '').trim());
  const a = Number(afterSeq ?? 0);
  const qs = a > 0 ? `?afterSeq=${encodeURIComponent(String(a))}` : '';
  const url = joinUrl(getApiBaseUrl(), `${api.literaryAgent.imageGen.runs.stream(rid)}${qs}`);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      signal,
    });
  } catch (e) {
    return fail('NETWORK_ERROR', e instanceof Error ? e.message : '网络错误') as unknown as ReturnType<StreamLiteraryAgentImageGenRunContract>;
  }

  if (res.status === 401) {
    const authStore = useAuthStore.getState();
    if (authStore.isAuthenticated) {
      authStore.logout();
      window.location.href = '/login';
    }
    return fail('UNAUTHORIZED', '未登录') as unknown as ReturnType<StreamLiteraryAgentImageGenRunContract>;
  }

  if (!res.ok) {
    const t = await res.text();
    return fail('UNKNOWN', t || `HTTP ${res.status} ${res.statusText}`) as unknown as ReturnType<StreamLiteraryAgentImageGenRunContract>;
  }

  try {
    await readSseStream(res, onEvent as (evt: unknown) => void, signal);
  } catch (e) {
    if (signal.aborted) return ok(true);
    return fail('NETWORK_ERROR', e instanceof Error ? e.message : 'SSE 读取失败') as unknown as ReturnType<StreamLiteraryAgentImageGenRunContract>;
  }
  return ok(true);
};

/**
 * 带重试的 SSE 流式获取
 */
export const streamLiteraryAgentImageGenRunWithRetryReal: StreamLiteraryAgentImageGenRunWithRetryContract = async ({ runId, afterSeq, onEvent, signal, maxAttempts }) => {
  let lastSeq = Math.max(0, Number(afterSeq ?? 0) || 0);
  let attempt = 0;
  const max = Math.max(1, Math.min(50, Number(maxAttempts ?? 10) || 10));

  while (!signal.aborted) {
    attempt += 1;

    // 子 AbortController：用于每次连接独立取消
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal.addEventListener('abort', onAbort);

    const res = await streamLiteraryAgentImageGenRunReal({
      runId,
      afterSeq: lastSeq,
      signal: ac.signal,
      onEvent: (evt) => {
        onEvent(evt);
        const id = evt.id ? Number(evt.id) : NaN;
        if (Number.isFinite(id) && id > lastSeq) lastSeq = id;
      },
    });

    signal.removeEventListener('abort', onAbort);

    if (res.success) return ok(true);
    if (signal.aborted) return ok(true);
    if (attempt >= max) return res;

    // 指数退避 + jitter（上限 8s）
    const pow = Math.min(5, attempt); // 2^1..2^5
    const base = Math.min(8000, 400 * Math.pow(2, pow));
    const jitter = Math.floor(Math.random() * 240);
    await new Promise((r) => setTimeout(r, base + jitter));
  }

  return ok(true);
};

// ========== 风格图配置海鲜市场 API ==========

import type {
  ListReferenceImageConfigsMarketplaceContract,
  PublishReferenceImageConfigContract,
  UnpublishReferenceImageConfigContract,
  ForkReferenceImageConfigContract,
  MarketplaceReferenceImageConfig,
} from '../contracts/literaryAgentConfig';

export const listReferenceImageConfigsMarketplaceReal: ListReferenceImageConfigsMarketplaceContract = async (input) => {
  const qs = new URLSearchParams();
  if (input.keyword) qs.set('keyword', input.keyword);
  if (input.sort) qs.set('sort', input.sort);
  const q = qs.toString();
  return await apiRequest<{ items: MarketplaceReferenceImageConfig[] }>(
    `${api.literaryAgent.config.referenceImages.list()}/marketplace${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

export const publishReferenceImageConfigReal: PublishReferenceImageConfigContract = async (input) => {
  return await apiRequest<{ config: ReferenceImageConfig }>(
    `${api.literaryAgent.config.referenceImages.byId(encodeURIComponent(input.id))}/publish`,
    { method: 'POST' }
  );
};

export const unpublishReferenceImageConfigReal: UnpublishReferenceImageConfigContract = async (input) => {
  return await apiRequest<{ config: ReferenceImageConfig }>(
    `${api.literaryAgent.config.referenceImages.byId(encodeURIComponent(input.id))}/unpublish`,
    { method: 'POST' }
  );
};

export const forkReferenceImageConfigReal: ForkReferenceImageConfigContract = async (input) => {
  const body = input.name ? { Name: input.name } : {};
  return await apiRequest<{ config: ReferenceImageConfig }>(
    `${api.literaryAgent.config.referenceImages.byId(encodeURIComponent(input.id))}/fork`,
    { 
      method: 'POST',
      body,
    }
  );
};
