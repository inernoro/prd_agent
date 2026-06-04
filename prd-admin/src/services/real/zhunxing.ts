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

export interface ZhunxingFeedbackCluster {
  clusterKey: string;
  sampleQuestion: string;
  count: number;
  lastOccurredAt: string;
}

export interface ZhunxingFeedbackSummary {
  totalCount: number;
  noMatchCount: number;
  answerInaccurateCount: number;
  missingContextCount: number;
  topNoMatchQuestions: ZhunxingFeedbackCluster[];
}

export interface ZhunxingFeedbackListItem {
  id: string;
  userId: string;
  question: string;
  matched: boolean;
  confidence: number;
  feedbackType: string;
  comment?: string;
  citationClauseIds: string[];
  createdAt: string;
}

export interface ZhunxingFeedbackListResult {
  total: number;
  page: number;
  pageSize: number;
  items: ZhunxingFeedbackListItem[];
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

export async function getZhunxingFeedbackSummary(top = 10): Promise<ApiResponse<ZhunxingFeedbackSummary>> {
  return await apiRequest(`${api.zhunxing.feedbackSummary()}?top=${top}`, {
    method: 'GET',
  });
}

export async function listZhunxingFeedbacks(
  params: {
    feedbackType?: string;
    matched?: boolean;
    keyword?: string;
    page?: number;
    pageSize?: number;
  } = {},
): Promise<ApiResponse<ZhunxingFeedbackListResult>> {
  const search = new URLSearchParams();
  if (params.feedbackType) search.set('feedbackType', params.feedbackType);
  if (params.matched !== undefined) search.set('matched', String(params.matched));
  if (params.keyword?.trim()) search.set('keyword', params.keyword.trim());
  if (params.page) search.set('page', String(params.page));
  if (params.pageSize) search.set('pageSize', String(params.pageSize));
  const query = search.toString();
  return await apiRequest(`${api.zhunxing.feedbacks()}${query ? `?${query}` : ''}`, {
    method: 'GET',
  });
}
