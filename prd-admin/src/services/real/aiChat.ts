import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { AiChatGetHistoryContract, AiChatUploadDocumentContract } from '@/services/contracts/aiChat';

export const uploadAiChatDocumentReal: AiChatUploadDocumentContract = async (input) => {
  return await apiRequest(api.v1.documents.list(), {
    method: 'POST',
    body: { content: input.content, title: input.title ?? null },
  });
};

export const getAiChatHistoryReal: AiChatGetHistoryContract = async ({ sessionId, limit }) => {
  const qs = new URLSearchParams();
  if (typeof limit === 'number' && Number.isFinite(limit)) qs.set('limit', String(limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return await apiRequest(`${api.v1.sessions.messages(encodeURIComponent(sessionId))}${suffix}`, {
    method: 'GET',
  });
};


