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
