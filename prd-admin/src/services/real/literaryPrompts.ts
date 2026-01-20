import { apiRequest } from './apiClient';
import type {
  ListLiteraryPromptsContract,
  CreateLiteraryPromptContract,
  UpdateLiteraryPromptContract,
  DeleteLiteraryPromptContract,
  LiteraryPrompt,
} from '../contracts/literaryPrompts';

export const listLiteraryPromptsReal: ListLiteraryPromptsContract = async (input) => {
  const qs = new URLSearchParams();
  if (input.scenarioType) qs.set('scenarioType', input.scenarioType);
  const q = qs.toString();
  return await apiRequest<{ items: LiteraryPrompt[] }>(
    `/api/literary-agent/prompts${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

export const createLiteraryPromptReal: CreateLiteraryPromptContract = async (input) => {
  return await apiRequest<{ prompt: LiteraryPrompt }>('/api/literary-agent/prompts', {
    method: 'POST',
    body: {
      title: input.title,
      content: input.content,
      scenarioType: input.scenarioType,
    },
  });
};

export const updateLiteraryPromptReal: UpdateLiteraryPromptContract = async (input) => {
  return await apiRequest<{ prompt: LiteraryPrompt }>(
    `/api/literary-agent/prompts/${encodeURIComponent(input.id)}`,
    {
      method: 'PUT',
      body: {
        title: input.title,
        content: input.content,
        scenarioType: input.scenarioType,
        order: input.order,
      },
    }
  );
};

export const deleteLiteraryPromptReal: DeleteLiteraryPromptContract = async (input) => {
  return await apiRequest<{ deleted: boolean }>(
    `/api/literary-agent/prompts/${encodeURIComponent(input.id)}`,
    { method: 'DELETE' }
  );
};
