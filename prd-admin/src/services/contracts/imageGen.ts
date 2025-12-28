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

