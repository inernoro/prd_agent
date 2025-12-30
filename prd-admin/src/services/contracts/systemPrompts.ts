import type { ApiResponse } from '@/types/api';

export type SystemPromptEntry = {
  role: 'PM' | 'DEV' | 'QA';
  systemPrompt: string;
};

export type SystemPromptSettings = {
  id: string;
  entries: SystemPromptEntry[];
  updatedAt: string;
};

export type AdminSystemPromptsGetData = {
  isOverridden: boolean;
  settings: SystemPromptSettings;
};

export type GetAdminSystemPromptsContract = () => Promise<ApiResponse<AdminSystemPromptsGetData>>;

export type PutAdminSystemPromptsContract = (
  input: { entries: SystemPromptEntry[] },
  idempotencyKey?: string
) => Promise<ApiResponse<{ settings: SystemPromptSettings }>>;

export type ResetAdminSystemPromptsContract = (idempotencyKey?: string) => Promise<ApiResponse<{ reset: true }>>;


