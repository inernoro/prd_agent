import type {
  AdminSystemPromptsGetData,
  GetAdminSystemPromptsContract,
  PutAdminSystemPromptsContract,
  ResetAdminSystemPromptsContract,
  SystemPromptEntry,
  SystemPromptSettings,
} from '@/services/contracts/systemPrompts';
import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';

export const getAdminSystemPromptsReal: GetAdminSystemPromptsContract = async () => {
  return await apiRequest<AdminSystemPromptsGetData>(api.prompts.system.get());
};

export const putAdminSystemPromptsReal: PutAdminSystemPromptsContract = async (input, idempotencyKey) => {
  const entries = Array.isArray(input?.entries) ? (input.entries as SystemPromptEntry[]) : [];
  const headers: Record<string, string> = {};
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return await apiRequest<{ settings: SystemPromptSettings }>(api.prompts.system.get(), {
    method: 'PUT',
    body: { entries },
    headers,
  });
};

export const resetAdminSystemPromptsReal: ResetAdminSystemPromptsContract = async (idempotencyKey) => {
  const headers: Record<string, string> = {};
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return await apiRequest<{ reset: true }>(api.prompts.system.reset(), {
    method: 'POST',
    body: {},
    headers,
  });
};


