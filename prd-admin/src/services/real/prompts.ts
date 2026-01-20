import type {
  AdminPromptsGetData,
  GetAdminPromptsContract,
  PutAdminPromptsContract,
  ResetAdminPromptsContract,
  PromptEntry,
  PromptSettings,
} from '@/services/contracts/prompts';
import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';

export const getAdminPromptsReal: GetAdminPromptsContract = async () => {
  return await apiRequest<AdminPromptsGetData>(api.prompts.list());
};

export const putAdminPromptsReal: PutAdminPromptsContract = async (input, idempotencyKey) => {
  const prompts = Array.isArray(input?.prompts) ? (input.prompts as PromptEntry[]) : [];
  const headers: Record<string, string> = {};
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return await apiRequest<{ settings: PromptSettings }>(api.prompts.list(), {
    method: 'PUT',
    body: { prompts },
    headers,
  });
};

export const resetAdminPromptsReal: ResetAdminPromptsContract = async (idempotencyKey) => {
  const headers: Record<string, string> = {};
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return await apiRequest<{ reset: true }>(api.prompts.reset(), {
    method: 'POST',
    body: {},
    headers,
  });
};


