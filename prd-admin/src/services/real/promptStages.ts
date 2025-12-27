import type {
  AdminPromptStagesGetData,
  GetAdminPromptStagesContract,
  PutAdminPromptStagesContract,
  ResetAdminPromptStagesContract,
  PromptStageSettings,
  PromptStageEntry,
} from '@/services/contracts/promptStages';
import { apiRequest } from '@/services/real/apiClient';

export const getAdminPromptStagesReal: GetAdminPromptStagesContract = async () => {
  return await apiRequest<AdminPromptStagesGetData>('/api/v1/admin/prompt-stages');
};

export const putAdminPromptStagesReal: PutAdminPromptStagesContract = async (input, idempotencyKey) => {
  const stages = Array.isArray(input?.stages) ? (input.stages as PromptStageEntry[]) : [];
  const headers: Record<string, string> = {};
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return await apiRequest<{ settings: PromptStageSettings }>('/api/v1/admin/prompt-stages', {
    method: 'PUT',
    body: { stages },
    headers,
  });
};

export const resetAdminPromptStagesReal: ResetAdminPromptStagesContract = async (idempotencyKey) => {
  const headers: Record<string, string> = {};
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return await apiRequest<{ reset: true }>('/api/v1/admin/prompt-stages/reset', {
    method: 'POST',
    body: {},
    headers,
  });
};


