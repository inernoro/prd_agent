import type { ApiResponse } from '@/types/api';
import type { Model } from '@/types/admin';

export type GetModelsContract = () => Promise<ApiResponse<Model[]>>;

export type CreateModelInput = {
  name: string;
  modelName: string;
  platformId: string;
  enabled: boolean;
  group?: string;
  enablePromptCache?: boolean;
  /** 透传到大模型请求的 max_tokens；不传/传 null 表示使用后端默认 */
  maxTokens?: number | null;
};

export type UpdateModelInput = Partial<CreateModelInput> & {
  isMain?: boolean;
};

export type CreateModelContract = (input: CreateModelInput) => Promise<ApiResponse<Model>>;
export type UpdateModelContract = (id: string, input: UpdateModelInput) => Promise<ApiResponse<Model>>;
export type DeleteModelContract = (id: string) => Promise<ApiResponse<true>>;

export type TestModelContract = (id: string) => Promise<ApiResponse<{ success: boolean; duration: number; error?: string }>>;

/** 业务侧模型唯一键：platformId + modelId（平台侧模型 ID，等价于后端 llmmodels.modelName） */
export type PlatformModelKey = { platformId: string; modelId: string };

export type SetMainModelContract = (input: PlatformModelKey) => Promise<ApiResponse<true>>;
export type SetIntentModelContract = (input: PlatformModelKey) => Promise<ApiResponse<true>>;
export type ClearIntentModelContract = () => Promise<ApiResponse<true>>;
export type SetVisionModelContract = (input: PlatformModelKey) => Promise<ApiResponse<true>>;
export type ClearVisionModelContract = () => Promise<ApiResponse<true>>;
export type SetImageGenModelContract = (input: PlatformModelKey) => Promise<ApiResponse<true>>;
export type ClearImageGenModelContract = () => Promise<ApiResponse<true>>;

export type ModelPriorityUpdate = { id: string; priority: number };
export type UpdateModelPrioritiesContract = (updates: ModelPriorityUpdate[]) => Promise<ApiResponse<{ updated: number }>>;

// 模型适配器信息
export type ModelAdapterSizeConstraint = {
  type: 'whitelist' | 'range' | 'aspect_ratio';
  description: string;
};

export type ModelAdapterLimitations = {
  mustBeDivisibleBy?: number | null;
  maxWidth?: number | null;
  maxHeight?: number | null;
  minWidth?: number | null;
  minHeight?: number | null;
  maxPixels?: number | null;
  notes: string[];
};

export type ModelAdapterInfo = {
  matched: boolean;
  modelId: string;
  modelName: string;
  adapterName?: string;
  displayName?: string;
  provider?: string;
  sizeConstraint?: ModelAdapterSizeConstraint;
  allowedSizes?: string[];
  allowedRatios?: string[];
  sizeOptions?: Array<{ size: string; aspectRatio?: string | null; resolution?: string | null }>;
  sizeParamFormat?: string;
  limitations?: ModelAdapterLimitations;
  supportsImageToImage?: boolean;
  supportsInpainting?: boolean;
};

export type ModelAdapterInfoBrief = {
  matched: boolean;
  adapterName?: string;
  displayName?: string;
  provider?: string;
  sizeConstraintType?: string;
  allowedSizesCount?: number;
  allowedRatios?: string[];
  notes?: string[];
};

export type GetModelAdapterInfoContract = (modelId: string) => Promise<ApiResponse<ModelAdapterInfo>>;
export type GetModelsAdapterInfoBatchContract = (modelIds: string[]) => Promise<ApiResponse<Record<string, ModelAdapterInfoBrief>>>;

/** 根据平台侧模型名直接获取适配信息（无需查询数据库） */
export type GetAdapterInfoByModelNameContract = (modelName: string) => Promise<ApiResponse<ModelAdapterInfo>>;
