import { apiRequest } from './apiClient';
import { api } from '@/services/api';
import type {
  ListLiteraryPromptsContract,
  CreateLiteraryPromptContract,
  UpdateLiteraryPromptContract,
  DeleteLiteraryPromptContract,
  ListLiteraryPromptsMarketplaceContract,
  PublishLiteraryPromptContract,
  UnpublishLiteraryPromptContract,
  ForkLiteraryPromptContract,
  LiteraryPrompt,
  MarketplaceLiteraryPrompt,
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

// 海鲜市场 API

export const listLiteraryPromptsMarketplaceReal: ListLiteraryPromptsMarketplaceContract = async (input) => {
  const qs = new URLSearchParams();
  if (input.scenarioType) qs.set('scenarioType', input.scenarioType);
  if (input.keyword) qs.set('keyword', input.keyword);
  if (input.sort) qs.set('sort', input.sort);
  const q = qs.toString();
  return await apiRequest<{ items: MarketplaceLiteraryPrompt[] }>(
    `${api.literaryAgent.prompts.list()}/marketplace${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

export const publishLiteraryPromptReal: PublishLiteraryPromptContract = async (input) => {
  return await apiRequest<{ prompt: LiteraryPrompt }>(
    `${api.literaryAgent.prompts.byId(encodeURIComponent(input.id))}/publish`,
    { method: 'POST' }
  );
};

export const unpublishLiteraryPromptReal: UnpublishLiteraryPromptContract = async (input) => {
  return await apiRequest<{ prompt: LiteraryPrompt }>(
    `${api.literaryAgent.prompts.byId(encodeURIComponent(input.id))}/unpublish`,
    { method: 'POST' }
  );
};

export const forkLiteraryPromptReal: ForkLiteraryPromptContract = async (input) => {
  return await apiRequest<{ prompt: LiteraryPrompt }>(
    `${api.literaryAgent.prompts.byId(encodeURIComponent(input.id))}/fork`,
    { method: 'POST' }
  );
};
