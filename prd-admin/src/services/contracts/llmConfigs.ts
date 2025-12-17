import type { ApiResponse } from '@/types/api';
import type { LLMConfig } from '@/types/admin';

export type GetLLMConfigsContract = () => Promise<ApiResponse<LLMConfig[]>>;

export type CreateLLMConfigInput = {
  provider: string;
  model: string;
  apiEndpoint?: string;
  apiKey: string;
  maxTokens: number;
  temperature: number;
  topP: number;
  rateLimitPerMinute: number;
  isActive?: boolean;
  /** 是否启用Prompt Caching（Claude可节省90%输入token费用） */
  enablePromptCache?: boolean;
};

export type CreateLLMConfigContract = (input: CreateLLMConfigInput) => Promise<ApiResponse<LLMConfig>>;

export type UpdateLLMConfigInput = Partial<Omit<CreateLLMConfigInput, 'apiKey'>> & { apiKey?: string };

export type UpdateLLMConfigContract = (id: string, input: UpdateLLMConfigInput) => Promise<ApiResponse<LLMConfig>>;

export type DeleteLLMConfigContract = (id: string) => Promise<ApiResponse<true>>;

export type ActivateLLMConfigContract = (id: string) => Promise<ApiResponse<true>>;
