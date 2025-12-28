import type { ApiResponse } from '@/types/api';

export type ImageGenPlanPromptOverrideKey = 'imageGenPlan';

export type ImageGenPlanPromptOverrideDto = {
  key: ImageGenPlanPromptOverrideKey;
  isOverridden: boolean;
  promptText: string;
  defaultPromptText: string;
  updatedAt?: string | null;
  reset?: boolean;
};

export type GetAdminImageGenPlanPromptOverrideContract = () => Promise<ApiResponse<ImageGenPlanPromptOverrideDto>>;

export type PutAdminImageGenPlanPromptOverrideContract = (input: {
  promptText: string;
  idempotencyKey?: string;
}) => Promise<ApiResponse<ImageGenPlanPromptOverrideDto>>;

export type DeleteAdminImageGenPlanPromptOverrideContract = (input?: {
  idempotencyKey?: string;
}) => Promise<ApiResponse<ImageGenPlanPromptOverrideDto>>;


