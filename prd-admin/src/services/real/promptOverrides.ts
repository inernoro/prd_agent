import type {
  DeleteAdminImageGenPlanPromptOverrideContract,
  GetAdminImageGenPlanPromptOverrideContract,
  ImageGenPlanPromptOverrideDto,
  PutAdminImageGenPlanPromptOverrideContract,
} from '@/services/contracts/promptOverrides';
import { apiRequest } from '@/services/real/apiClient';

export const getAdminImageGenPlanPromptOverrideReal: GetAdminImageGenPlanPromptOverrideContract = async () => {
  return await apiRequest<ImageGenPlanPromptOverrideDto>('/api/v1/admin/prompt-overrides/image-gen-plan', { method: 'GET' });
};

export const putAdminImageGenPlanPromptOverrideReal: PutAdminImageGenPlanPromptOverrideContract = async (input) => {
  const headers: Record<string, string> = {};
  if (input?.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey;
  return await apiRequest<ImageGenPlanPromptOverrideDto>('/api/v1/admin/prompt-overrides/image-gen-plan', {
    method: 'PUT',
    headers,
    body: { promptText: input.promptText },
  });
};

export const deleteAdminImageGenPlanPromptOverrideReal: DeleteAdminImageGenPlanPromptOverrideContract = async (input) => {
  const headers: Record<string, string> = {};
  if (input?.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey;
  return await apiRequest<ImageGenPlanPromptOverrideDto>('/api/v1/admin/prompt-overrides/image-gen-plan', {
    method: 'DELETE',
    headers,
  });
};


