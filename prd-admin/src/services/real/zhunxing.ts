import { api } from '@/services/api';
import { apiRequest } from '@/services/real/apiClient';
import type { ApiResponse } from '@/types/api';

export interface ZhunxingCitation {
  documentId: string;
  documentTitle: string;
  clauseId: string;
  chapter: string;
  clauseTitle: string;
  snippet: string;
  fullText: string;
  riskLevel: string;
  matchScore: number;
}

export interface ZhunxingAskResponse {
  matched: boolean;
  answer: string;
  confidence: number;
  riskLevel: string;
  citations: ZhunxingCitation[];
  followUpSuggestion?: string;
}

export interface CreateZhunxingFeedbackRequest {
  question: string;
  matched: boolean;
  confidence?: number;
  feedbackType?: 'no_match' | 'answer_inaccurate' | 'missing_context';
  comment?: string;
  citationClauseIds?: string[];
}

export interface ZhunxingFeedbackResult {
  feedbackId: string;
  message: string;
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

export async function submitZhunxingFeedback(
  request: CreateZhunxingFeedbackRequest,
): Promise<ApiResponse<ZhunxingFeedbackResult>> {
  return await apiRequest(api.zhunxing.feedback(), {
    method: 'POST',
    body: request,
  });
}
