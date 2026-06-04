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
  answerRole: 'employee' | 'supervisor' | 'hr';
  confidence: number;
  riskLevel: string;
  decisionTree: ZhunxingDecisionStep[];
  conflictDetected: boolean;
  conflictMessage?: string;
  conflictClauses: ZhunxingConflictClause[];
  citations: ZhunxingCitation[];
  followUpSuggestion?: string;
}

export interface ZhunxingDecisionStep {
  stepNo: number;
  condition: string;
  action: string;
  clauseId?: string;
  chapter?: string;
  riskLevel?: string;
}

export interface ZhunxingConflictClause {
  clauseId: string;
  documentTitle: string;
  chapter: string;
  clauseTitle: string;
  ruleSummary: string;
  conflictReason: string;
  riskLevel: string;
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
  pendingCount: number;
  resolvedCount: number;
  closedCount: number;
  followUpNotifiedCount: number;
  replayVerifiedCount: number;
  replayMatchedCount: number;
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
  status: 'new' | 'triaged' | 'in_progress' | 'resolved' | 'closed';
  ownerDepartment?: string;
  assigneeUserId?: string;
  resolutionType?: string;
  resolutionNote?: string;
  resolvedBy?: string;
  resolvedAt?: string;
  replayQuestion?: string;
  replayMatched?: boolean;
  replayConfidence?: number;
  replayRiskLevel?: string;
  replayAnswerSnippet?: string;
  replayAt?: string;
  followUpNote?: string;
  followUpBy?: string;
  followUpNotifiedAt?: string;
  updatedAt: string;
  createdAt: string;
}

export interface ZhunxingFeedbackListResult {
  total: number;
  page: number;
  pageSize: number;
  items: ZhunxingFeedbackListItem[];
}

export interface UpdateZhunxingFeedbackWorkflowRequest {
  status?: 'new' | 'triaged' | 'in_progress' | 'resolved' | 'closed';
  ownerDepartment?: string;
  assigneeUserId?: string;
  resolutionType?: 'add_clause' | 'update_clause' | 'retrieval_tuning' | 'process_clarification' | 'other';
  resolutionNote?: string;
}

export interface ReplayZhunxingFeedbackRequest {
  question?: string;
  topK?: number;
}

export interface MarkZhunxingFeedbackFollowUpRequest {
  followUpNote?: string;
}

export interface ZhunxingFeedbackReplayResult {
  feedbackId: string;
  question: string;
  matched: boolean;
  confidence: number;
  riskLevel: string;
  answer: string;
  replayedAt: string;
  regressionDetected: boolean;
}

export interface ZhunxingFeedbackFollowUpResult {
  feedbackId: string;
  message: string;
  followUpNotifiedAt: string;
  status: string;
}

export interface ZhunxingTopicSubscriptionResult {
  userId: string;
  topics: string[];
  updatedAt: string;
}

export interface ZhunxingTopicUpdateItem {
  topic: string;
  topicLabel: string;
  documentId: string;
  documentTitle: string;
  clauseId: string;
  chapter: string;
  clauseTitle: string;
  summary: string;
  riskLevel: string;
  updatedAt: string;
}

export interface ZhunxingTopicUpdateFeed {
  days: number;
  totalUpdates: number;
  returnedUpdates: number;
  items: ZhunxingTopicUpdateItem[];
  generatedAt: string;
}

export interface ZhunxingHeatmapBucket {
  topic: string;
  topicLabel: string;
  questionCount: number;
  noMatchCount: number;
  pendingCount: number;
  avgConfidence: number;
  heatScore: number;
}

export interface ZhunxingKnowledgeHeatmap {
  days: number;
  totalFeedbackCount: number;
  generatedAt: string;
  buckets: ZhunxingHeatmapBucket[];
}

export async function askZhunxing(
  question: string,
  topK = 3,
  answerRole: 'employee' | 'supervisor' | 'hr' = 'employee',
): Promise<ApiResponse<ZhunxingAskResponse>> {
  return await apiRequest(api.zhunxing.ask(), {
    method: 'POST',
    body: {
      question,
      topK,
      answerRole,
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
    status?: string;
    matched?: boolean;
    keyword?: string;
    page?: number;
    pageSize?: number;
  } = {},
): Promise<ApiResponse<ZhunxingFeedbackListResult>> {
  const search = new URLSearchParams();
  if (params.feedbackType) search.set('feedbackType', params.feedbackType);
  if (params.status) search.set('status', params.status);
  if (params.matched !== undefined) search.set('matched', String(params.matched));
  if (params.keyword?.trim()) search.set('keyword', params.keyword.trim());
  if (params.page) search.set('page', String(params.page));
  if (params.pageSize) search.set('pageSize', String(params.pageSize));
  const query = search.toString();
  return await apiRequest(`${api.zhunxing.feedbacks()}${query ? `?${query}` : ''}`, {
    method: 'GET',
  });
}

export async function updateZhunxingFeedbackWorkflow(
  feedbackId: string,
  request: UpdateZhunxingFeedbackWorkflowRequest,
): Promise<ApiResponse<ZhunxingFeedbackListItem>> {
  return await apiRequest(api.zhunxing.feedbackWorkflow(feedbackId), {
    method: 'PATCH',
    body: request,
  });
}

export async function replayZhunxingFeedback(
  feedbackId: string,
  request: ReplayZhunxingFeedbackRequest = {},
): Promise<ApiResponse<ZhunxingFeedbackReplayResult>> {
  return await apiRequest(api.zhunxing.feedbackReplay(feedbackId), {
    method: 'POST',
    body: request,
  });
}

export async function markZhunxingFeedbackFollowUp(
  feedbackId: string,
  request: MarkZhunxingFeedbackFollowUpRequest = {},
): Promise<ApiResponse<ZhunxingFeedbackFollowUpResult>> {
  return await apiRequest(api.zhunxing.feedbackFollowUp(feedbackId), {
    method: 'POST',
    body: request,
  });
}

export async function getMyZhunxingTopicSubscription(): Promise<ApiResponse<ZhunxingTopicSubscriptionResult>> {
  return await apiRequest(api.zhunxing.subscriptionMe(), {
    method: 'GET',
  });
}

export async function updateMyZhunxingTopicSubscription(
  topics: string[],
): Promise<ApiResponse<ZhunxingTopicSubscriptionResult>> {
  return await apiRequest(api.zhunxing.subscriptionMe(), {
    method: 'PUT',
    body: {
      topics,
    },
  });
}

export async function getMyZhunxingTopicUpdates(
  days = 30,
  top = 20,
): Promise<ApiResponse<ZhunxingTopicUpdateFeed>> {
  const search = new URLSearchParams({
    days: String(days),
    top: String(top),
  });
  return await apiRequest(`${api.zhunxing.subscriptionUpdates()}?${search.toString()}`, {
    method: 'GET',
  });
}

export async function getZhunxingKnowledgeHeatmap(
  days = 30,
  top = 8,
): Promise<ApiResponse<ZhunxingKnowledgeHeatmap>> {
  const search = new URLSearchParams({
    days: String(days),
    top: String(top),
  });
  return await apiRequest(`${api.zhunxing.heatmap()}?${search.toString()}`, {
    method: 'GET',
  });
}
