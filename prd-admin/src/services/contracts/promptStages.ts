import type { ApiResponse } from '@/types/api';

export type PromptStageEntry = {
  stageKey: string;
  order: number;
  role: 'PM' | 'DEV' | 'QA';
  title: string;
  promptTemplate: string;
};

export type PromptStageSettings = {
  id: string;
  stages: PromptStageEntry[];
  updatedAt: string;
};

export type AdminPromptStagesGetData = {
  isOverridden: boolean;
  settings: PromptStageSettings;
};

export type GetAdminPromptStagesContract = () => Promise<ApiResponse<AdminPromptStagesGetData>>;

export type PutAdminPromptStagesContract = (
  input: { stages: PromptStageEntry[] },
  idempotencyKey?: string
) => Promise<ApiResponse<{ settings: PromptStageSettings }>>;

export type ResetAdminPromptStagesContract = (idempotencyKey?: string) => Promise<ApiResponse<{ reset: true }>>;


