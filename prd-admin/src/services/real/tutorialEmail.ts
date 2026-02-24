import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';

// ========== Types ==========

export type TutorialEmailStep = {
  dayOffset: number;
  subject: string;
  templateId: string;
  skipCondition?: string | null;
};

export type TutorialEmailSequence = {
  id: string;
  sequenceKey: string;
  name: string;
  description?: string | null;
  triggerType: string;
  steps: TutorialEmailStep[];
  isActive: boolean;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TutorialEmailTemplate = {
  id: string;
  name: string;
  htmlContent: string;
  variables: string[];
  assetIds: string[];
  thumbnailUrl?: string | null;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TutorialEmailAsset = {
  id: string;
  fileName: string;
  fileUrl: string;
  tags: string[];
  fileSize: number;
  contentType?: string | null;
  uploadedBy?: string | null;
  uploadedAt: string;
};

export type TutorialEmailSentRecord = {
  stepIndex: number;
  sentAt: string;
  success: boolean;
  errorMessage?: string | null;
};

export type TutorialEmailEnrollment = {
  id: string;
  userId: string;
  email: string;
  sequenceKey: string;
  currentStepIndex: number;
  status: string;
  nextSendAt?: string | null;
  enrolledAt: string;
  sentHistory: TutorialEmailSentRecord[];
  updatedAt: string;
};

// ========== Sequences ==========

export async function listTutorialEmailSequences(): Promise<ApiResponse<{ items: TutorialEmailSequence[] }>> {
  return apiRequest(api.tutorialEmail.sequences.list(), { method: 'GET' });
}

export async function getTutorialEmailSequence(id: string): Promise<ApiResponse<TutorialEmailSequence>> {
  return apiRequest(api.tutorialEmail.sequences.byId(id), { method: 'GET' });
}

export async function createTutorialEmailSequence(data: {
  sequenceKey: string;
  name: string;
  description?: string;
  triggerType?: string;
  steps?: TutorialEmailStep[];
  isActive?: boolean;
}): Promise<ApiResponse<TutorialEmailSequence>> {
  return apiRequest(api.tutorialEmail.sequences.list(), { method: 'POST', body: data });
}

export async function updateTutorialEmailSequence(id: string, data: {
  name?: string;
  description?: string;
  triggerType?: string;
  steps?: TutorialEmailStep[];
  isActive?: boolean;
}): Promise<ApiResponse<TutorialEmailSequence>> {
  return apiRequest(api.tutorialEmail.sequences.byId(id), { method: 'PUT', body: data });
}

export async function deleteTutorialEmailSequence(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return apiRequest(api.tutorialEmail.sequences.byId(id), { method: 'DELETE' });
}

// ========== Templates ==========

export async function listTutorialEmailTemplates(): Promise<ApiResponse<{ items: TutorialEmailTemplate[] }>> {
  return apiRequest(api.tutorialEmail.templates.list(), { method: 'GET' });
}

export async function getTutorialEmailTemplate(id: string): Promise<ApiResponse<TutorialEmailTemplate>> {
  return apiRequest(api.tutorialEmail.templates.byId(id), { method: 'GET' });
}

export async function createTutorialEmailTemplate(data: {
  name: string;
  htmlContent: string;
  variables?: string[];
  assetIds?: string[];
  thumbnailUrl?: string;
}): Promise<ApiResponse<TutorialEmailTemplate>> {
  return apiRequest(api.tutorialEmail.templates.list(), { method: 'POST', body: data });
}

export async function updateTutorialEmailTemplate(id: string, data: {
  name?: string;
  htmlContent?: string;
  variables?: string[];
  assetIds?: string[];
  thumbnailUrl?: string;
}): Promise<ApiResponse<TutorialEmailTemplate>> {
  return apiRequest(api.tutorialEmail.templates.byId(id), { method: 'PUT', body: data });
}

export async function deleteTutorialEmailTemplate(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return apiRequest(api.tutorialEmail.templates.byId(id), { method: 'DELETE' });
}

// ========== Assets ==========

export async function listTutorialEmailAssets(tag?: string): Promise<ApiResponse<{ items: TutorialEmailAsset[] }>> {
  const qs = tag ? `?tag=${encodeURIComponent(tag)}` : '';
  return apiRequest(`${api.tutorialEmail.assets.list()}${qs}`, { method: 'GET' });
}

export async function createTutorialEmailAsset(data: {
  fileName: string;
  fileUrl: string;
  tags?: string[];
  fileSize?: number;
  contentType?: string;
}): Promise<ApiResponse<TutorialEmailAsset>> {
  return apiRequest(api.tutorialEmail.assets.list(), { method: 'POST', body: data });
}

export async function deleteTutorialEmailAsset(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return apiRequest(api.tutorialEmail.assets.byId(id), { method: 'DELETE' });
}

// ========== Enrollments ==========

export async function listTutorialEmailEnrollments(args?: {
  sequenceKey?: string;
  status?: string;
}): Promise<ApiResponse<{ items: TutorialEmailEnrollment[] }>> {
  const params = new URLSearchParams();
  if (args?.sequenceKey) params.set('sequenceKey', args.sequenceKey);
  if (args?.status) params.set('status', args.status);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiRequest(`${api.tutorialEmail.enrollments.list()}${qs}`, { method: 'GET' });
}

export async function enrollTutorialEmailUser(data: {
  userId: string;
  email: string;
  sequenceKey: string;
}): Promise<ApiResponse<TutorialEmailEnrollment>> {
  return apiRequest(api.tutorialEmail.enrollments.list(), { method: 'POST', body: data });
}

export async function unsubscribeTutorialEmailEnrollment(id: string): Promise<ApiResponse<{ unsubscribed: boolean }>> {
  return apiRequest(api.tutorialEmail.enrollments.unsubscribe(id), { method: 'POST', body: {} });
}

export async function batchEnrollTutorialEmail(data: {
  sequenceKey: string;
}): Promise<ApiResponse<{ enrolled: number; skipped: number; total: number }>> {
  return apiRequest(api.tutorialEmail.enrollments.batch(), { method: 'POST', body: data });
}

// ========== Test Send ==========

export async function testSendTutorialEmail(data: {
  email: string;
  name?: string;
  subject?: string;
  templateId: string;
}): Promise<ApiResponse<{ success: boolean }>> {
  return apiRequest(api.tutorialEmail.testSend(), { method: 'POST', body: data });
}

// ========== AI Generate ==========

export async function generateTutorialEmailTemplate(data: {
  topic?: string;
  style?: string;
  language?: string;
  extraRequirements?: string;
  messages?: Array<{ role: string; content: string }>;
}): Promise<ApiResponse<{ htmlContent: string; model?: string; tokens?: number }>> {
  return apiRequest(api.tutorialEmail.generate(), { method: 'POST', body: data });
}

// ========== Quick Send ==========

export async function quickSendTutorialEmail(data: {
  email: string;
  recipientName?: string;
  subject?: string;
  htmlContent: string;
  saveAsTemplate?: boolean;
  templateName?: string;
}): Promise<ApiResponse<{ sent: boolean; templateId?: string; templateName?: string }>> {
  return apiRequest(api.tutorialEmail.quickSend(), { method: 'POST', body: data });
}
