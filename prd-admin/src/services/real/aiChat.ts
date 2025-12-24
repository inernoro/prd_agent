import { apiRequest } from '@/services/real/apiClient';
import type { AiChatGetHistoryContract, AiChatUploadDocumentContract } from '@/services/contracts/aiChat';

export const uploadAiChatDocumentReal: AiChatUploadDocumentContract = async (input) => {
  return await apiRequest('/api/v1/documents', {
    method: 'POST',
    body: { content: input.content },
  });
};

export const getAiChatHistoryReal: AiChatGetHistoryContract = async ({ sessionId, limit }) => {
  const qs = new URLSearchParams();
  if (typeof limit === 'number' && Number.isFinite(limit)) qs.set('limit', String(limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return await apiRequest(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages${suffix}`, {
    method: 'GET',
  });
};


