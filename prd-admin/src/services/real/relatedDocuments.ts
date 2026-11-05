import { apiRequest, resolveApiUrl } from './apiClient';
import { useAuthStore } from '@/stores/authStore';
import type { ApiResponse } from '@/types/api';

export interface RelatedDocument {
  id: string;
  title: string;
  description?: string;
  updatedAt?: string;
  isMain?: boolean;
  href?: string;
  isManual?: boolean;
  canEditTags?: boolean;
  tags?: string[];
  mentions?: Array<{ commentId: string; authorName: string; sourceSiteId: string; sourceTitle: string; label: string }>;
  preview?: { id: string; siteUrl: string; entryFile: string; wrappedAssetType?: string; contentShape?: 'self-contained-html' | 'multi-file'; requiresPreviewBridge?: boolean; useShareAccess: boolean };
}
export interface RelatedDocuments {
  version: number;
  mainSiteId: string | null;
  canManage: boolean;
  hasPermissionDifferences: boolean;
  items: RelatedDocument[];
}
export interface RelatedPermissionPreview {
  sourceId: string;
  sourceTitle: string;
  fingerprint: string;
  canSync: boolean;
  blockingReason?: string;
  canRevokeShares: boolean;
  shareNotice: string;
  items: Array<RelatedDocument & { matches: boolean; differences: string[]; activeShareCount: number }>;
}
export interface RelatedSyncResult {
  results: Array<{ id: string; title: string; success: boolean; message: string }>;
  sharesRevoked: number;
}
export type RelatedDocumentSource = { token?: string; password?: string };
const path = (id: string) => `/api/web-pages/${encodeURIComponent(id)}/related-documents`;

export async function getRelatedDocuments(id: string, source?: RelatedDocumentSource): Promise<ApiResponse<RelatedDocuments>> {
  if (!source?.token) return apiRequest(path(id));
  const query = new URLSearchParams({ siteId: id });
  if (source.password) query.set('password', source.password);
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = useAuthStore.getState().token;
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const response = await fetch(resolveApiUrl(`/api/web-pages/shares/view/${encodeURIComponent(source.token)}/related-documents?${query}`), {
      headers, cache: 'no-store',
    });
    return await response.json() as ApiResponse<RelatedDocuments>;
  } catch {
    return { success: false, data: null as never, error: { code: 'NETWORK_ERROR', message: '关联文档加载失败，请重试' } };
  }
}
export function saveRelatedDocuments(id: string, body: { siteIds: string[]; mainSiteId: string; version: number }) {
  return apiRequest<RelatedDocuments>(path(id), { method: 'PUT', body });
}
export function getRelatedCandidates(id: string) {
  return apiRequest<{ items: RelatedDocument[] }>(`${path(id)}/candidates`);
}
export function previewRelatedPermissions(id: string) {
  return apiRequest<RelatedPermissionPreview>(`${path(id)}/permissions`);
}
export function syncRelatedPermissions(id: string, fingerprint: string, revokeTargetShares: boolean) {
  return apiRequest<RelatedSyncResult>(`${path(id)}/permissions/sync`, { method: 'POST', body: { fingerprint, revokeTargetShares } });
}

export interface RelatedSummary {
  count: number;
  mainTitle?: string | null;
  isMain: boolean;
  titles: string[];
}
export function getRelatedSummaries(siteIds: string[]) {
  return apiRequest<{ items: Record<string, RelatedSummary> }>(`/api/web-pages/related-documents/summaries?${new URLSearchParams({ siteIds: siteIds.join(',') })}`);
}
