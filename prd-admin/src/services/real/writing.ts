import { apiRequest, apiDownload } from './apiClient';
import type { WritingTeachingInfo, WritingTeaching, WritingContext, WritingTemplate, WritingDocument, WritingReader, WritingState } from '@/services/contracts/writing';

const root = '/api/document-store';
export const writingContext = (storeId: string) => apiRequest<WritingContext>(`${root}/stores/${encodeURIComponent(storeId)}/writing-context`);
export const createWriting = (storeId: string, templateId = 'prd') => apiRequest<{ entryId: string; state: WritingState }>(`${root}/stores/${encodeURIComponent(storeId)}/writing`, { method: 'POST', body: { templateId } });
export const getWriting = (entryId: string) => apiRequest<WritingDocument>(`${root}/entries/${encodeURIComponent(entryId)}/writing`);
export const saveWriting = (entryId: string, input: Record<string, unknown>) => apiRequest<{ state: WritingState }>(`${root}/entries/${encodeURIComponent(entryId)}/writing`, { method: 'PUT', body: input });
export const generateWriting = (entryId: string, revision: number, action?: 'reconcile') => apiRequest<{ state: WritingState; runId: string }>(`${root}/entries/${encodeURIComponent(entryId)}/writing/generate`, { method: 'POST', body: { revision, action } });
export const commandWriting = (entryId: string, revision: number, action: string, input: Record<string, unknown> = {}) => apiRequest<{ state: WritingState }>(`${root}/entries/${encodeURIComponent(entryId)}/writing/commands`, { method: 'POST', body: { revision, action, ...input } });
export const readWriting = (entryId: string, options?: { overview?: boolean; version?: number; course?: string }) => {
  const query = new URLSearchParams();
  if (options?.course) query.set('course', options.course);
  if (options?.overview) query.set('overview', 'true');
  if (options?.version !== undefined) query.set('version', String(options.version));
  return apiRequest<WritingReader>(`${root}/entries/${encodeURIComponent(entryId)}/writing/published${query.size ? `?${query}` : ''}`);
};

export const importWritingTemplate = (storeId: string, name: string, markdown: string) => apiRequest<{ template: WritingTemplate }>(`${root}/stores/${encodeURIComponent(storeId)}/writing-templates/import`, { method: 'POST', body: { name, markdown } });

export const exportWritingHtml = (entryId: string, version: number) => apiRequest<{ html: string; fileName: string; version: number; contentFingerprint: string }>(`${root}/entries/${encodeURIComponent(entryId)}/writing/export?version=${version}`);

export const getWritingTeaching = (entryId: string) => apiRequest<WritingTeachingInfo>(`${root}/entries/${encodeURIComponent(entryId)}/writing/teaching`);
export const generateWritingTeaching = (entryId: string, input: { requestId: string; sourceVersion: number; sourceFingerprint: string; instructions: string }) => apiRequest<{ teaching: WritingTeaching }>(`${root}/entries/${encodeURIComponent(entryId)}/writing/teaching`, { method: 'POST', body: input });
export const resumeWritingTeaching = (entryId: string, teachingId: string, revision: number) => apiRequest<{ teaching: WritingTeaching }>(`${root}/entries/${encodeURIComponent(entryId)}/writing/teaching/${encodeURIComponent(teachingId)}/resume`, { method: 'POST', body: { revision } });
export const approveWritingTeaching = (entryId: string, teaching: WritingTeaching) => apiRequest<{ teaching: WritingTeaching }>(`${root}/entries/${encodeURIComponent(entryId)}/writing/teaching/${encodeURIComponent(teaching.id)}/approve`, { method: 'POST', body: { revision: teaching.revision, artifactFingerprint: teaching.artifactFingerprint, sourceVersion: teaching.source.version, sourceFingerprint: teaching.sourceFingerprint } });
export const downloadWritingTeaching = (entryId: string, teachingId: string, portrait: boolean) => apiDownload(`${root}/entries/${encodeURIComponent(entryId)}/writing/teaching/${encodeURIComponent(teachingId)}/media?portrait=${portrait}`, 'teaching.mp4');
