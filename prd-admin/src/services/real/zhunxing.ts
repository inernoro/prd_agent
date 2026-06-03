import { api } from '@/services/api';
import { apiRequest } from '@/services/real/apiClient';
import type { ApiResponse } from '@/types/api';

export interface ZhunxingCitation {
  documentId: string;
  documentTitle: string;
  chapter: string;
  title: string;
  snippet: string;
  riskLevel: string;
}

export interface ZhunxingAskResponse {
  answer: string;
  citations: ZhunxingCitation[];
  followUpSuggestion?: string;
}

export async function askZhunxing(question: string, topK = 3): Promise<ApiResponse<ZhunxingAskResponse>> {
  return await apiRequest(api.zhunxing.ask(), {
    method: 'POST',
    body: {
      question,
      topK,
    },
  });
}
