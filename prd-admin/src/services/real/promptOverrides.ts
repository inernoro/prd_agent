import type {
  DeleteAdminImageGenPlanPromptOverrideContract,
  GetAdminImageGenPlanPromptOverrideContract,
  ImageGenPlanPromptOverrideDto,
  PutAdminImageGenPlanPromptOverrideContract,
} from '@/services/contracts/promptOverrides';
import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';

export const getAdminImageGenPlanPromptOverrideReal: GetAdminImageGenPlanPromptOverrideContract = async () => {
  return await apiRequest<ImageGenPlanPromptOverrideDto>(api.prompts.overrides.imageGenPlan(), { method: 'GET' });
};

export const putAdminImageGenPlanPromptOverrideReal: PutAdminImageGenPlanPromptOverrideContract = async (input) => {
  const headers: Record<string, string> = {};
  if (input?.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey;
  return await apiRequest<ImageGenPlanPromptOverrideDto>(api.prompts.overrides.imageGenPlan(), {
    method: 'PUT',
    headers,
    body: { promptText: input.promptText },
  });
};

export const deleteAdminImageGenPlanPromptOverrideReal: DeleteAdminImageGenPlanPromptOverrideContract = async (input) => {
  const headers: Record<string, string> = {};
  if (input?.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey;
  return await apiRequest<ImageGenPlanPromptOverrideDto>(api.prompts.overrides.imageGenPlan(), {
    method: 'DELETE',
    headers,
  });
};


