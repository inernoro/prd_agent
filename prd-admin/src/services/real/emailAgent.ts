import { apiRequest } from './apiClient';
import type { ApiResponse } from '@/types/api';

// ──────────────────────────────────────────────
// 类型定义（与后端 EmailTemplate.cs 保持一致）
// ──────────────────────────────────────────────

export interface EmailRecipient {
  name: string;
  email?: string | null;
  note?: string | null;
}

export interface EmailTemplateVariable {
  key: string;
  label: string;
  placeholder?: string | null;
  defaultValue?: string | null;
  multiline?: boolean;
}

export interface EmailTemplate {
  id: string;
  title: string;
  category: string;
  scenario?: string | null;
  subject: string;
  approvalTarget?: string | null;
  body: string;
  toRecipients: EmailRecipient[];
  ccRecipients: EmailRecipient[];
  variables: EmailTemplateVariable[];
  isSystem: boolean;
  templateKey?: string | null;
  usageCount: number;
  createdBy: string;
  createdByName?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmailCategoryOption {
  key: string;
  label: string;
}

export interface EmailAgentMeta {
  categories: EmailCategoryOption[];
  systemTemplateCount: number;
  authorName?: string;
}

export interface UpsertEmailTemplateInput {
  title: string;
  category: string;
  scenario?: string;
  subject: string;
  approvalTarget?: string;
  body: string;
  toRecipients: EmailRecipient[];
  ccRecipients: EmailRecipient[];
  variables: EmailTemplateVariable[];
}

// ──────────────────────────────────────────────
// 元数据
// ──────────────────────────────────────────────

export async function getEmailAgentMeta(): Promise<ApiResponse<EmailAgentMeta>> {
  return apiRequest('/api/email-agent/meta');
}

// ──────────────────────────────────────────────
// 模板库 CRUD
// ──────────────────────────────────────────────

export async function listEmailTemplates(params: {
  category?: string;
  keyword?: string;
} = {}): Promise<ApiResponse<{ items: EmailTemplate[]; total: number }>> {
  const qs = new URLSearchParams();
  if (params.category) qs.set('category', params.category);
  if (params.keyword?.trim()) qs.set('keyword', params.keyword.trim());
  const q = qs.toString();
  return apiRequest(`/api/email-agent/templates${q ? `?${q}` : ''}`);
}

export async function getEmailTemplate(id: string): Promise<ApiResponse<{ template: EmailTemplate }>> {
  return apiRequest(`/api/email-agent/templates/${encodeURIComponent(id)}`);
}

export async function createEmailTemplate(
  input: UpsertEmailTemplateInput
): Promise<ApiResponse<{ template: EmailTemplate }>> {
  return apiRequest('/api/email-agent/templates', { method: 'POST', body: input });
}

export async function updateEmailTemplate(
  id: string,
  input: UpsertEmailTemplateInput
): Promise<ApiResponse<{ template: EmailTemplate }>> {
  return apiRequest(`/api/email-agent/templates/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: input,
  });
}

export async function deleteEmailTemplate(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return apiRequest(`/api/email-agent/templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function duplicateEmailTemplate(id: string): Promise<ApiResponse<{ template: EmailTemplate }>> {
  return apiRequest(`/api/email-agent/templates/${encodeURIComponent(id)}/duplicate`, { method: 'POST' });
}

export async function markEmailTemplateUsed(
  id: string
): Promise<ApiResponse<{ usageCount: number; system?: boolean }>> {
  return apiRequest(`/api/email-agent/templates/${encodeURIComponent(id)}/use`, { method: 'POST' });
}

// ──────────────────────────────────────────────
// AI SSE 端点（前端用 connectSse / useSseStream 消费，不能走 apiRequest）
// ──────────────────────────────────────────────

export const EMAIL_DRAFT_STREAM_URL = '/api/email-agent/draft/stream';
export const EMAIL_POLISH_STREAM_URL = '/api/email-agent/polish/stream';

export interface EmailDraftRequest {
  scenario: string;
  baseTemplateId?: string;
  tone?: string;
  sessionId?: string;
}

export interface EmailPolishRequest {
  content: string;
  instruction?: string;
  sessionId?: string;
}
