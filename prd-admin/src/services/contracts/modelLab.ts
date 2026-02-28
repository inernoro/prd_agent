import type { ApiResponse } from '@/types/api';

export type ModelLabSuite = 'speed' | 'intent' | 'custom';

export type ModelLabParams = {
  temperature: number;
  maxTokens?: number | null;
  timeoutMs: number;
  maxConcurrency: number;
  repeatN: number;
};

export type ModelLabSelectedModel = {
  /** 平台侧模型 ID（业务语义 modelId） */
  modelId: string;
  platformId: string;
  name: string;
  /** 兼容字段：历史版本/旧接口使用；语义等同于 modelId */
  modelName: string;
  group?: string | null;
};

export type ModelLabExperiment = {
  id: string;
  ownerAdminId: string;
  name: string;
  suite: ModelLabSuite;
  selectedModels: ModelLabSelectedModel[];
  promptTemplateId?: string | null;
  promptText?: string | null;
  params: ModelLabParams;
  createdAt: string;
  updatedAt: string;
};

export type ModelLabModelSet = {
  id: string;
  ownerAdminId: string;
  name: string;
  models: ModelLabSelectedModel[];
  createdAt: string;
  updatedAt: string;
};

export type ListModelLabExperimentsContract = (args?: {
  search?: string;
  page?: number;
  pageSize?: number;
}) => Promise<ApiResponse<{ items: ModelLabExperiment[]; page: number; pageSize: number }>>;

export type UpsertModelLabExperimentInput = {
  name?: string;
  suite?: ModelLabSuite;
  selectedModels?: ModelLabSelectedModel[];
  promptTemplateId?: string | null;
  promptText?: string | null;
  params?: Partial<ModelLabParams>;
};

export type CreateModelLabExperimentContract = (input: UpsertModelLabExperimentInput) => Promise<ApiResponse<ModelLabExperiment>>;
export type GetModelLabExperimentContract = (id: string) => Promise<ApiResponse<ModelLabExperiment>>;
export type UpdateModelLabExperimentContract = (id: string, input: UpsertModelLabExperimentInput) => Promise<ApiResponse<ModelLabExperiment>>;
export type DeleteModelLabExperimentContract = (id: string) => Promise<ApiResponse<true>>;

export type ListModelLabModelSetsContract = (args?: { search?: string; limit?: number }) => Promise<ApiResponse<{ items: ModelLabModelSet[] }>>;
export type UpsertModelLabModelSetContract = (input: { id?: string; name: string; models: ModelLabSelectedModel[] }) => Promise<ApiResponse<ModelLabModelSet>>;

export type RunModelLabStreamInput = {
  experimentId?: string;
  suite?: ModelLabSuite;
  promptText?: string;
  /** 专项测试期望输出格式：json / mcp / functionCall */
  expectedFormat?: 'json' | 'mcp' | 'functionCall' | 'imageGenPlan';
  /** 当 expectedFormat=imageGenPlan 时生效：限制 items 数量（1-20，默认 10） */
  imagePlanMaxItems?: number;
  /** 当 expectedFormat=imageGenPlan 时生效：仅本次请求覆盖 system prompt */
  systemPromptOverride?: string;
  /** 是否自动追加系统主模型作为标准答案（若未在已选模型里） */
  includeMainModelAsStandard?: boolean;
  params?: Partial<ModelLabParams>;
  enablePromptCache?: boolean;
  modelIds?: string[];
  models?: ModelLabSelectedModel[];
  /** 识图模式：图片 base64 列表（data URI 或纯 base64） */
  imageBase64List?: string[];
};

export type RunModelLabStreamEvent = { event?: string; data?: string };

export type RunModelLabStreamContract = (args: {
  input: RunModelLabStreamInput;
  onEvent: (evt: RunModelLabStreamEvent) => void;
  signal: AbortSignal;
}) => Promise<ApiResponse<true>>;


