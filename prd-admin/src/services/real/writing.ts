import { apiRequest } from './apiClient';
import type { WritingContext, WritingDocument, WritingReader, WritingState } from '@/services/contracts/writing';

const root = '/api/document-store';
export const writingContext = (storeId: string) => apiRequest<WritingContext>(`${root}/stores/${encodeURIComponent(storeId)}/writing-context`);
export const createWriting = (storeId: string, templateId = 'prd') => apiRequest<{ entryId: string; state: WritingState }>(`${root}/stores/${encodeURIComponent(storeId)}/writing`, { method: 'POST', body: { templateId } });
export const getWriting = (entryId: string) => apiRequest<WritingDocument>(`${root}/entries/${encodeURIComponent(entryId)}/writing`);
export const saveWriting = (entryId: string, input: Record<string, unknown>) => apiRequest<{ state: WritingState }>(`${root}/entries/${encodeURIComponent(entryId)}/writing`, { method: 'PUT', body: input });
export const generateWriting = (entryId: string, revision: number) => apiRequest<{ state: WritingState; runId: string }>(`${root}/entries/${encodeURIComponent(entryId)}/writing/generate`, { method: 'POST', body: { revision } });
export const commandWriting = (entryId: string, revision: number, action: string, input: Record<string, unknown> = {}) => apiRequest<{ state: WritingState }>(`${root}/entries/${encodeURIComponent(entryId)}/writing/commands`, { method: 'POST', body: { revision, action, ...input } });
export const readWriting = (entryId: string, options?: { overview?: boolean; version?: number }) => {
  const query = new URLSearchParams();
  if (options?.overview) query.set('overview', 'true');
  if (options?.version !== undefined) query.set('version', String(options.version));
  return apiRequest<WritingReader>(`${root}/entries/${encodeURIComponent(entryId)}/writing/published${query.size ? `?${query}` : ''}`);
};
