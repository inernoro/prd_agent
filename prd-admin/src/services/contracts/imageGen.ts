import type { ApiResponse } from '@/types/api';

export type ImageGenPlanItem = {
  prompt: string;
  count: number;
  /** 可选：单条覆盖的生图尺寸（如 "1024x1024"）。为空时回退到批量请求的 size。 */
  size?: string;
};

export type ImageGenPlanResponse = {
  total: number;
  items: ImageGenPlanItem[];
  usedPurpose: 'intent' | 'fallbackMain' | (string & {});
};

export type ImageGenImage = {
  index: number;
  base64?: string | null;
  url?: string | null;
  revisedPrompt?: string | null;
};

export type ImageGenGenerateMeta = {
  requestedSize?: string | null;
  effectiveSize?: string | null;
  sizeAdjusted?: boolean;
  ratioAdjusted?: boolean;
};

export type ImageGenGenerateResponse = {
  images: ImageGenImage[];
  meta?: ImageGenGenerateMeta | null;
};

export type PlanImageGenContract = (input: { text: string; maxItems?: number; systemPromptOverride?: string }) => Promise<ApiResponse<ImageGenPlanResponse>>;

export type GenerateImageGenContract = (input: {
  modelId: string;
  platformId?: string;
  modelName?: string;
  prompt: string;
  n?: number;
  size?: string;
  responseFormat?: 'b64_json' | 'url';
  /** 图生图首帧（DataURL 或纯 base64） */
  initImageBase64?: string;
}) => Promise<ApiResponse<ImageGenGenerateResponse>>;

export type ImageGenBatchStreamInput = {
  modelId: string;
  platformId?: string;
  modelName?: string;
  items: ImageGenPlanItem[];
  size?: string;
  responseFormat?: 'b64_json' | 'url';
  maxConcurrency?: number; // 最大并发数
};

export type ImageGenBatchStreamEvent = { event?: string; data?: string };

export type RunImageGenBatchStreamContract = (args: {
  input: ImageGenBatchStreamInput;
  onEvent: (evt: ImageGenBatchStreamEvent) => void;
  signal: AbortSignal;
}) => Promise<ApiResponse<true>>;

export type ImageGenSizeCapsItem = {
  modelId?: string | null;
  platformId?: string | null;
  modelName?: string | null;
  allowedCount: number;
  updatedAt: string;
};

export type GetImageGenSizeCapsResponse = {
  items: ImageGenSizeCapsItem[];
};

export type GetImageGenSizeCapsContract = (input?: { includeFallback?: boolean }) => Promise<ApiResponse<GetImageGenSizeCapsResponse>>;

// -------- 任务化 run（可断线恢复） --------

export type ImageGenRunPlanItemInput = {
  prompt: string;
  count: number;
  size?: string;
};

export type CreateImageGenRunInput = {
  /** 可选：内部配置模型 ID（LLMModel.Id）。若提供，则会自动解析 platformId + modelId */
  configModelId?: string;
  platformId?: string;
  /** 平台侧模型 ID（业务语义 modelId） */
  modelId?: string;
  /** 兼容字段：语义等同于 modelId */
  modelName?: string;
  items: ImageGenRunPlanItemInput[];
  size?: string;
  responseFormat?: 'b64_json' | 'url';
  maxConcurrency?: number;
};

export type CreateImageGenRunResponse = {
  runId: string;
};

export type CreateImageGenRunContract = (args: { input: CreateImageGenRunInput; idempotencyKey?: string }) => Promise<ApiResponse<CreateImageGenRunResponse>>;

export type ImageGenRunStatus = 'Queued' | 'Running' | 'Completed' | 'Failed' | 'Cancelled' | (string & {});

export type ImageGenRunDto = {
  id: string;
  status: ImageGenRunStatus;
  configModelId?: string | null;
  platformId?: string | null;
  modelId?: string | null;
  size: string;
  responseFormat: string;
  maxConcurrency: number;
  total: number;
  done: number;
  failed: number;
  cancelRequested: boolean;
  lastSeq: number;
  createdAt: string;
  startedAt?: string | null;
  endedAt?: string | null;
};

export type ImageGenRunItemDto = {
  runId: string;
  itemIndex: number;
  imageIndex: number;
  prompt: string;
  requestedSize: string;
  effectiveSize?: string | null;
  sizeAdjusted?: boolean;
  ratioAdjusted?: boolean;
  status: string;
  base64?: string | null;
  url?: string | null;
  revisedPrompt?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  startedAt?: string | null;
  endedAt?: string | null;
};

export type GetImageGenRunResponse = {
  run: ImageGenRunDto;
  items?: ImageGenRunItemDto[] | null;
};

export type GetImageGenRunContract = (args: { runId: string; includeItems?: boolean; includeImages?: boolean }) => Promise<ApiResponse<GetImageGenRunResponse>>;

export type ImageGenRunStreamEvent = { id?: string; event?: string; data?: string };

export type RunImageGenRunStreamContract = (args: {
  runId: string;
  afterSeq?: number;
  onEvent: (evt: ImageGenRunStreamEvent) => void;
  signal: AbortSignal;
}) => Promise<ApiResponse<true>>;

export type CancelImageGenRunContract = (args: { runId: string }) => Promise<ApiResponse<true>>;

export type StreamImageGenRunWithRetryContract = (args: {
  runId: string;
  afterSeq?: number;
  onEvent: (evt: ImageGenRunStreamEvent) => void;
  signal: AbortSignal;
  /** 最大重连次数；默认 10（含首次连接） */
  maxAttempts?: number;
}) => Promise<ApiResponse<true>>;

