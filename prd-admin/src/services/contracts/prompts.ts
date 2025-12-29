import type { ApiResponse } from '@/types/api';

export type PromptEntry = {
  promptKey: string;
  order: number;
  role: 'PM' | 'DEV' | 'QA';
  title: string;
  promptTemplate: string;
};

export type PromptSettings = {
  id: string;
  prompts: PromptEntry[];
  updatedAt: string;
};

export type AdminPromptsGetData = {
  isOverridden: boolean;
  settings: PromptSettings;
};

export type GetAdminPromptsContract = () => Promise<ApiResponse<AdminPromptsGetData>>;

export type PutAdminPromptsContract = (
  input: { prompts: PromptEntry[] },
  idempotencyKey?: string
) => Promise<ApiResponse<{ settings: PromptSettings }>>;

export type ResetAdminPromptsContract = (idempotencyKey?: string) => Promise<ApiResponse<{ reset: true }>>;


