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
  GetLiteraryAgentModelsContract,
  GetLiteraryAgentChatModelsContract,
  GetLiteraryAgentImageGenModelsContract,
  GetLiteraryAgentAllModelsContract,
  GetLiteraryAgentMainModelContract,
  LiteraryAgentModelPool,
  LiteraryAgentAllModelsResponse,
} from '../contracts/literaryAgentConfig';

/**
 * 获取文学创作统一生图模型池列表（文生图 + 图生图，合并去重）
 */
export const getLiteraryAgentModelsReal: GetLiteraryAgentModelsContract = async () => {
  return await apiRequest<LiteraryAgentModelPool[]>(
    api.literaryAgent.config.models(),
    { method: 'GET' }
  );
};

/**
 * 获取文学创作对话/标记生成模型池列表
 */
export const getLiteraryAgentChatModelsReal: GetLiteraryAgentChatModelsContract = async () => {
  return await apiRequest<LiteraryAgentModelPool[]>(
    api.literaryAgent.config.modelsChatPools(),
    { method: 'GET' }
  );
};

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

/** 文学配图必须按文学目录查询能力，不能借用视觉创作的模型白名单。 */
export async function getLiteraryAgentAdapterInfoReal(modelId: string) {
  return await apiRequest<import('../contracts/models').ModelAdapterInfo>(
    api.literaryAgent.imageGen.adapterInfo(modelId),
  );
}

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
import { connectSse } from '@/lib/useSseStream';

/**
 * 预查询文学创作生图将使用的模型（不发送图片请求）
 * 用于前端在生成前展示调度到的模型名称
 */
export const getLiteraryAgentImageGenResolvedModelReal = async (hasInitImage = false): Promise<{
  resolved: boolean;
  model?: string;
  platform?: string;
  poolId?: string;
  poolName?: string;
  resolutionType?: string;
}> => {
  const res = await apiRequest<{
    resolved: boolean;
    model?: string;
    platform?: string;
    poolId?: string;
    poolName?: string;
    resolutionType?: string;
  }>(
    `${api.literaryAgent.imageGen.resolveModel()}?hasInitImage=${hasInitImage}`,
    { method: 'GET' }
  );
  if (res.success && res.data) return res.data;
  return { resolved: false };
};

export const getLiteraryAgentChatResolvedModelReal = async (): Promise<{
  resolved: boolean;
  model?: string;
  platform?: string;
  poolId?: string;
  poolName?: string;
  resolutionType?: string;
}> => {
  const res = await apiRequest<{
    resolved: boolean;
    model?: string;
    platform?: string;
    poolId?: string;
    poolName?: string;
    resolutionType?: string;
  }>(
    api.literaryAgent.imageGen.resolveChatModel(),
    { method: 'GET' }
  );
  if (res.success && res.data) return res.data;
  return { resolved: false };
};

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
  const rid = encodeURIComponent(String(runId ?? '').trim());
  const a = Number(afterSeq ?? 0);
  const qs = a > 0 ? `?afterSeq=${encodeURIComponent(String(a))}` : '';
  const url = `${api.literaryAgent.imageGen.runs.stream(rid)}${qs}`;

  const result = await connectSse({ url, onEvent: onEvent as (evt: { id?: string; event?: string; data?: string }) => void, signal });
  return (result.success ? ok(true) : fail(result.errorCode!, result.errorMessage!)) as unknown as ReturnType<StreamLiteraryAgentImageGenRunContract>;
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

// ========== 文学创作工作区（应用身份隔离，使用 /api/literary-agent/workspaces）==========

export async function listLiteraryAgentWorkspacesReal(input?: { limit?: number }) {
  const qs = input?.limit ? `?limit=${input.limit}` : '';
  return await apiRequest<{ items: any[] }>(`${api.literaryAgent.workspaces.list()}${qs}`, { method: 'GET' });
}

export async function createLiteraryAgentWorkspaceReal(input: { title?: string; scenarioType?: string; idempotencyKey?: string }) {
  const headers: Record<string, string> = {};
  const idem = String(input.idempotencyKey ?? '').trim();
  if (idem) headers['Idempotency-Key'] = idem;
  return await apiRequest<{ workspace: any }>(api.literaryAgent.workspaces.list(), {
    method: 'POST',
    headers,
    body: { title: input.title, scenarioType: input.scenarioType },
  });
}

export async function updateLiteraryAgentWorkspaceReal(input: {
  id: string;
  title?: string;
  articleContent?: string;
  scenarioType?: string;
  folderName?: string | null;
  memberUserIds?: string[];
  coverAssetId?: string;
  selectedPromptId?: string | null;
  idempotencyKey?: string;
}) {
  const headers: Record<string, string> = {};
  const idem = String(input.idempotencyKey ?? '').trim();
  if (idem) headers['Idempotency-Key'] = idem;
  return await apiRequest<{ workspace: any }>(
    api.literaryAgent.workspaces.byId(encodeURIComponent(input.id)),
    {
      method: 'PUT',
      headers,
      body: {
        title: input.title,
        articleContent: input.articleContent,
        scenarioType: input.scenarioType,
        folderName: input.folderName,
        memberUserIds: input.memberUserIds,
        coverAssetId: input.coverAssetId,
        selectedPromptId: input.selectedPromptId,
      },
    }
  );
}

export async function deleteLiteraryAgentWorkspaceReal(input: { id: string; idempotencyKey?: string }) {
  const headers: Record<string, string> = {};
  const idem = String(input.idempotencyKey ?? '').trim();
  if (idem) headers['Idempotency-Key'] = idem;
  return await apiRequest<{ deleted: boolean }>(
    api.literaryAgent.workspaces.byId(encodeURIComponent(input.id)),
    { method: 'DELETE', headers }
  );
}

export async function getLiteraryAgentWorkspaceDetailReal(input: { id: string; messageLimit?: number; assetLimit?: number }) {
  const qs = new URLSearchParams();
  if (input.messageLimit != null) qs.set('messageLimit', String(input.messageLimit));
  if (input.assetLimit != null) qs.set('assetLimit', String(input.assetLimit));
  const q = qs.toString();
  return await apiRequest<{
    workspace: any;
    messages: any[];
    assets: any[];
    canvas: any;
    viewport?: any;
    illustrationChoice?: LiteraryIllustrationChoice | null;
  }>(
    `${api.literaryAgent.workspaces.detail(encodeURIComponent(input.id))}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
}

/**
 * 一篇文章自己的配图风格与水印（智能体或网页为它指定过时才有）。source：remembered = 这篇记住的；account-default = 账号默认。
 * missing = 这篇记住过、但那套已被删除，本次按账号默认出图（页面要提示，不能再说成「本文自己的设定」）。
 */
export type LiteraryIllustrationChoice = {
  style: { styleId?: string | null; name: string; source: 'remembered' | 'account-default' | string; missing?: boolean };
  watermark: { watermarkId: string; name: string; source: 'remembered' | 'account-default' | string; missing?: boolean };
  notes: string[];
};

/** 设置 / 清除这篇文章的配图风格与水印。style / watermark 传配置 ID 或 none；clear = 回到跟随账号默认。 */
export async function setLiteraryIllustrationPrefsReal(input: { id: string; style?: string; watermark?: string; clear?: boolean }) {
  return await apiRequest<{ illustrationPrefs: unknown; effective: LiteraryIllustrationChoice }>(
    api.literaryAgent.workspaces.illustrationPrefs(encodeURIComponent(input.id)),
    { method: 'PUT', body: { style: input.style, watermark: input.watermark, clear: input.clear ?? false } }
  );
}

export type LiteraryIllustrationHistoryItem = {
  id: string;
  url: string;
  width: number;
  height: number;
  prompt?: string | null;
  markerIndex?: number | null;
  markerText?: string | null;
  workflowVersion?: number | null;
  isCurrent: boolean;
  createdAt: string;
  /** 什么时候不再挂在正文上；仍在用或算不出来时为空 */
  replacedAt?: string | null;
  /** 为什么被换下（后端给的人话） */
  replacedReason?: string | null;
  /** 是不是上一次换稿前在用的那组里的一张 */
  inLastSet?: boolean;
  /** 现在挂在哪些位置（同一张图可以被放回到多个位置）；markerIndex 是其中最靠前的一个 */
  mountedAt?: number[];
};

export type LiteraryIllustrationHistory = {
  workspaceId: string;
  currentVersion: number;
  total: number;
  currentCount: number;
  /** 每次换稿前真正挂在正文上的那组（新到旧，存档时记下的） */
  previousSets?: Array<{
    workflowVersion: number;
    archivedAt?: string | null;
    reason: string;
    images: Array<{ markerIndex: number; assetId: string; url: string; description?: string | null }>;
  }>;
  /** 当前正文里有哪些配图位置，旧图只能放回这些位置 */
  markerIndexes?: number[];
  groups: Array<{
    workflowVersion: number | null;
    isCurrentVersion: boolean;
    items: LiteraryIllustrationHistoryItem[];
  }>;
};

/** 这篇文章生成过的全部配图（含改稿 / 重新规划 / 重新生成之前的旧版本），按版本分组。 */
export async function getLiteraryIllustrationHistoryReal(input: { id: string }) {
  return await apiRequest<LiteraryIllustrationHistory>(
    api.literaryAgent.workspaces.illustrationHistory(encodeURIComponent(input.id)),
    { method: 'GET' }
  );
}

/** 把历史里的一张旧图放回正文的配图位置（默认它当初的位置）；图若记着当初的描述，标记描述一并换回。 */
export async function restoreLiteraryIllustrationReal(input: { id: string; assetId: string; markerIndex?: number; workflowVersion: number }) {
  return await apiRequest<{ markerIndex: number; url: string; description?: string | null; note?: string | null }>(
    api.literaryAgent.workspaces.restoreIllustration(encodeURIComponent(input.id), encodeURIComponent(input.assetId)),
    { method: 'POST', body: { markerIndex: input.markerIndex, workflowVersion: input.workflowVersion } }
  );
}

export async function uploadLiteraryAgentWorkspaceAssetReal(input: {
  id: string;
  data?: string;
  sourceUrl?: string;
  prompt?: string;
  width?: number;
  height?: number;
  articleInsertionIndex?: number;
  originalMarkerText?: string;
  idempotencyKey?: string;
}) {
  const headers: Record<string, string> = {};
  const idem = String(input.idempotencyKey ?? '').trim();
  if (idem) headers['Idempotency-Key'] = idem;
  return await apiRequest<{ asset: any }>(api.literaryAgent.workspaces.assets(encodeURIComponent(input.id)), {
    method: 'POST',
    headers,
    body: {
      data: input.data,
      sourceUrl: input.sourceUrl,
      prompt: input.prompt,
      width: input.width,
      height: input.height,
      articleInsertionIndex: input.articleInsertionIndex,
      originalMarkerText: input.originalMarkerText,
    },
  });
}
