import { apiRequest } from './apiClient';
import type {
  TranscriptWorkspace,
  TranscriptItem,
  TranscriptRun,
  TranscriptTemplate,
  TranscriptSegment,
} from '../contracts/transcriptAgent';

const BASE = '/api/transcript-agent';

// ── Workspaces ──
export const listWorkspaces = () =>
  apiRequest<TranscriptWorkspace[]>(`${BASE}/workspaces`, { method: 'GET' });

export const createWorkspace = (title: string) =>
  apiRequest<TranscriptWorkspace>(`${BASE}/workspaces`, { method: 'POST', body: JSON.stringify({ title }) });

export const getWorkspace = (id: string) =>
  apiRequest<TranscriptWorkspace>(`${BASE}/workspaces/${id}`, { method: 'GET' });

export const deleteWorkspace = (id: string) =>
  apiRequest(`${BASE}/workspaces/${id}`, { method: 'DELETE' });

// ── Items ──
export const listItems = (workspaceId: string) =>
  apiRequest<TranscriptItem[]>(`${BASE}/workspaces/${workspaceId}/items`, { method: 'GET' });

export const uploadItem = async (workspaceId: string, file: File) => {
  const fd = new FormData();
  fd.append('file', file);
  return apiRequest<{ item: TranscriptItem; runId: string }>(
    `${BASE}/workspaces/${workspaceId}/items/upload`,
    { method: 'POST', body: fd, rawBody: true }
  );
};

export const deleteItem = (itemId: string) =>
  apiRequest(`${BASE}/items/${itemId}`, { method: 'DELETE' });

export const updateSegments = (itemId: string, segments: TranscriptSegment[]) =>
  apiRequest(`${BASE}/items/${itemId}/segments`, { method: 'PUT', body: JSON.stringify(segments) });

// ── Copywrite ──
export const createCopywriteRun = (itemId: string, templateId: string) =>
  apiRequest<TranscriptRun>(`${BASE}/items/${itemId}/copywrite`, {
    method: 'POST',
    body: JSON.stringify({ templateId }),
  });

// ── Templates ──
export const listTemplates = () =>
  apiRequest<TranscriptTemplate[]>(`${BASE}/templates`, { method: 'GET' });

// ── Runs ──
export const getRun = (runId: string) =>
  apiRequest<TranscriptRun>(`${BASE}/runs/${runId}`, { method: 'GET' });

export const listRuns = (workspaceId: string) =>
  apiRequest<TranscriptRun[]>(`${BASE}/workspaces/${workspaceId}/runs`, { method: 'GET' });

// ── Export ──
export const exportItem = (itemId: string, formats: string[]) =>
  apiRequest<Record<string, string>>(`${BASE}/items/${itemId}/export`, {
    method: 'POST',
    body: JSON.stringify({ formats }),
  });
