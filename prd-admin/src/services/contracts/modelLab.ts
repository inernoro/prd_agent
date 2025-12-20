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
  modelId: string;
  platformId: string;
  name: string;
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
  expectedFormat?: 'json' | 'mcp' | 'functionCall';
  params?: Partial<ModelLabParams>;
  enablePromptCache?: boolean;
  modelIds?: string[];
  models?: ModelLabSelectedModel[];
};

export type RunModelLabStreamEvent = { event?: string; data?: string };

export type RunModelLabStreamContract = (args: {
  input: RunModelLabStreamInput;
  onEvent: (evt: RunModelLabStreamEvent) => void;
  signal: AbortSignal;
}) => Promise<ApiResponse<true>>;


