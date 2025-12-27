import type { ApiResponse } from '@/types/api';

export type RoleStagePrompt = {
  title: string;
  promptTemplate: string;
};

export type PromptStageItem = {
  stageKey: string;
  order: number;
  /** 兼容字段（旧版使用 step=order） */
  step?: number;
  pm: RoleStagePrompt;
  dev: RoleStagePrompt;
  qa: RoleStagePrompt;
};

export type PromptStageSettings = {
  id: string;
  stages: PromptStageItem[];
  updatedAt: string;
};

export type AdminPromptStagesGetData = {
  isOverridden: boolean;
  settings: PromptStageSettings;
};

export type GetAdminPromptStagesContract = () => Promise<ApiResponse<AdminPromptStagesGetData>>;

export type PutAdminPromptStagesContract = (
  input: { stages: PromptStageItem[] },
  idempotencyKey?: string
) => Promise<ApiResponse<{ settings: PromptStageSettings }>>;

export type ResetAdminPromptStagesContract = (idempotencyKey?: string) => Promise<ApiResponse<{ reset: true }>>;


