import { apiRequest } from './apiClient';
import { api } from '@/services/api';
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
    `${api.literaryAgent.prompts.list()}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

export const createLiteraryPromptReal: CreateLiteraryPromptContract = async (input) => {
  return await apiRequest<{ prompt: LiteraryPrompt }>(api.literaryAgent.prompts.list(), {
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
    api.literaryAgent.prompts.byId(encodeURIComponent(input.id)),
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
    api.literaryAgent.prompts.byId(encodeURIComponent(input.id)),
    { method: 'DELETE' }
  );
};
