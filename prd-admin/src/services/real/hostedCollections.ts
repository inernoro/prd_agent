import { apiRequest, resolveApiUrl } from './apiClient';
import { useAuthStore } from '@/stores/authStore';
import type { ApiResponse } from '@/types/api';
import type { HostedCollection as HostedDocumentCollection, HostedCollectionCandidates, HostedCollectionPermissions, HostedCollectionShare, HostedCollectionView, SaveHostedCollection } from '@/services/contracts/hostedCollections';
const root = '/api/web-pages/collections';
export const listHostedCollections = (dissolved = false) => apiRequest<{ items: HostedDocumentCollection[] }>(`${root}?dissolved=${dissolved}`);
export const getHostedCollection = (id: string) => apiRequest<HostedCollectionView>(`${root}/${encodeURIComponent(id)}`);
export const getHostedCollectionCandidates = () => apiRequest<HostedCollectionCandidates>(`${root}/candidates`);
export const findHostedCollectionMembers = (keyword: string) => apiRequest<{ items: { id: string; name: string }[] }>(`${root}/members?${new URLSearchParams({ keyword })}`);
export const saveHostedCollection = (id: string | undefined, body: SaveHostedCollection) => apiRequest<HostedCollectionView>(id ? `${root}/${encodeURIComponent(id)}` : root, { method: id ? 'PUT' : 'POST', body });
export const getHostedCollectionPermissions = (id: string) => apiRequest<HostedCollectionPermissions>(`${root}/${encodeURIComponent(id)}/permissions`);
export const syncHostedCollectionPermissions = (id: string, fingerprint: string, siteIds: string[]) => apiRequest<{ results: { id: string; success: boolean; message: string }[]; fingerprint: string }>(`${root}/${encodeURIComponent(id)}/permissions/sync`, { method: 'POST', body: { fingerprint, siteIds } });
export const getHostedCollectionShares = (id: string) => apiRequest<{ items: HostedCollectionShare[] }>(`${root}/${encodeURIComponent(id)}/shares`);
export const createHostedCollectionShare = (id: string, body: { version: number; fingerprint: string; siteIds: string[]; title: string; visibility: string; password?: string; expiresInDays: number; confirmedPrivateSourceFingerprint?: string; accessUserIds?: string[] }) => apiRequest<{ id: string; token: string; shareUrl: string }>(`${root}/${encodeURIComponent(id)}/shares`, { method: 'POST', body });
export const stopHostedCollectionShares = (id: string) => apiRequest<{ stopped: number }>(`${root}/${encodeURIComponent(id)}/shares/stop`, { method: 'POST' });
export const dissolveHostedCollection = (id: string, version: number) => apiRequest<{ dissolved: boolean }>(`${root}/${encodeURIComponent(id)}/dissolve`, { method: 'POST', body: { version } });
export const restoreHostedCollection = (id: string, version: number) => apiRequest<HostedCollectionView>(`${root}/${encodeURIComponent(id)}/restore`, { method: 'POST', body: { version } });
export async function readHostedCollectionShare(token: string, password?: string): Promise<ApiResponse<HostedCollectionView>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const auth = useAuthStore.getState().token;
  if (auth) headers.Authorization = `Bearer ${auth}`;
  const query = new URLSearchParams(); if (password) query.set('password', password);
  try {
    const response = await fetch(resolveApiUrl(`/api/web-pages/shares/view/${encodeURIComponent(token)}/collection?${query}`), { headers, cache: 'no-store' });
    const result = await response.json() as ApiResponse<HostedCollectionView & { collection: HostedDocumentCollection & { collectionId?: string } }>;
    if (result.success) result.data.collection.id ??= result.data.collection.collectionId ?? '';
    return result;
  } catch { return { success: false, data: null as never, error: { code: 'NETWORK_ERROR', message: '分享暂时无法打开，请重试' } }; }
}

// 已有目录记录保持独立存储与原分享凭证；主分支接口继续使用原有契约。
import type { RelatedDocuments, RelatedPermissionPreview, RelatedSyncResult } from './relatedDocuments';
import type { createShareLink, HostedSite, ShareLinkItem } from './webPages';
type CreateShareLinkRequest = Parameters<typeof createShareLink>[0];

export interface HostedCollection {
  id: string; ownerUserId: string; title: string; siteIds: string[]; mainSiteId: string;
  version: number; shareGeneration: number; isDissolved: boolean; updatedAt: string;
}
export interface CollectionMember extends Partial<Pick<HostedSite,
  'coverImageUrl' | 'siteUrl' | 'entryFile' | 'wrappedAssetType' | 'contentShape' | 'requiresPreviewBridge' | 'totalSize'>> {
  id: string; title: string; available?: boolean;
}
export interface CollectionDetails {
  collection: HostedCollection | null;
  sites: CollectionMember[];
  legacyShare?: { id: string; title?: string; siteIds: string[] };
  shares: (Pick<ShareLinkItem, 'id' | 'token' | 'visibility' | 'expiresAt' | 'isRevoked'> &
    Partial<Pick<ShareLinkItem, 'siteIds' | 'createdAt' | 'viewCount' | 'accessLevel'>> &
    { active: boolean; needsUpdate: boolean; memberCount: number; collectionVersion: number })[];
}
export interface CollectionDraft { title: string; siteIds: string[]; mainSiteId: string; version: number }
export interface CollectionSharingPreview {
  fingerprint: string; version: number; canShare: boolean; notice: string;
  items: { id: string; title: string; visibility: string; teamCount: number; isMain: boolean }[];
}
const legacyRoot = '/api/web-pages/collections/compat';
const path = (id: string) => `${legacyRoot}/${encodeURIComponent(id)}`;
export interface CollectionHistoryItem {
  id: string; title: string; shareUrl: string; createdAt: string; expiresAt?: string; accessLevel: string;
  memberCount: number; isActive: boolean; statusLabel: string;
}
export const getCollectionHistory = (siteId: string, page = 1, keyword = '') => apiRequest<{ items: CollectionHistoryItem[]; total: number; page: number; pageSize: number }>(`${legacyRoot}/history?${new URLSearchParams({ siteId, page: String(page), keyword })}`);
export interface CollectionContext {
  id: string; title: string; memberCount: number; updatedAt: string;
  collectionId: string | null; legacyShareId: string | null; shareCount: number; primaryLink: CollectionHistoryItem | null;
}
export interface CollectionContextPage { items: CollectionContext[]; total: number; totalContexts: number; page: number; pageSize: number }
const contextPath = (siteId: string, contextId?: string) => `/api/web-pages/${encodeURIComponent(siteId)}/collection-contexts${contextId ? '/' + encodeURIComponent(contextId) : ''}`;
export const getCollectionContexts = (siteId: string, page = 1, keyword = '') => apiRequest<CollectionContextPage>(`${contextPath(siteId)}?${new URLSearchParams({ page: String(page), keyword })}`);
export const getCollectionContextDocuments = (siteId: string, contextId: string) => apiRequest<RelatedDocuments>(`${contextPath(siteId, contextId)}/documents`);
export const getCollectionContextLinks = (siteId: string, contextId: string, page = 1) => apiRequest<{ items: CollectionHistoryItem[]; total: number; page: number; pageSize: number }>(`${contextPath(siteId, contextId)}/links?${new URLSearchParams({ page: String(page) })}`);
export const listCollections = (keyword = '', page = 1, recentId?: string) => apiRequest<{
  items: HostedCollection[]; recent?: HostedCollection; members: Record<string, HostedSite>; total: number; page: number; pageSize: number;
}>(`${legacyRoot}?${new URLSearchParams({ keyword, page: String(page), includeMembers: 'true', ...(recentId ? { recentId } : {}) })}`);
export const suggestCollectionNames = (siteIds: string[], signal: AbortSignal) => apiRequest<{ names: string[] }>(`${legacyRoot}/name-suggestions`, { method: 'POST', body: { siteIds: siteIds.slice(0, 12) }, signal });
export const getCollection = (id: string) => apiRequest<CollectionDetails>(path(id));
export const getCollectionByShare = (token: string) => apiRequest<CollectionDetails>(`${legacyRoot}/by-share/${encodeURIComponent(token)}`);
export const createCollection = (body: CollectionDraft) => apiRequest<CollectionDetails>(legacyRoot, { method: 'POST', body });
export const updateCollection = (id: string, body: CollectionDraft) => apiRequest<CollectionDetails>(path(id), { method: 'PUT', body });
export const adoptCollection = (token: string, title: string, mainSiteId: string) => apiRequest<CollectionDetails>(`${legacyRoot}/from-share/${encodeURIComponent(token)}`, { method: 'POST', body: { title, mainSiteId } });
export const getCollectionCandidates = (keyword = '', page = 1) => apiRequest<{ items: CollectionMember[]; total: number }>(`${legacyRoot}/candidates?${new URLSearchParams({ keyword, page: String(page) })}`);
export const stopCollectionSharing = (id: string, version: number) => apiRequest(path(id) + '/stop-sharing', { method: 'POST', body: { version } });
export const dissolveCollection = (id: string, version: number) => apiRequest(path(id) + '/dissolve', { method: 'POST', body: { version } });
export const previewCollectionPermissions = (id: string) => apiRequest<RelatedPermissionPreview>(path(id) + '/permissions');
export const syncCollectionPermissions = (id: string, fingerprint: string, revokeTargetShares: boolean) => apiRequest<RelatedSyncResult>(path(id) + '/permissions/sync', { method: 'POST', body: { fingerprint, revokeTargetShares } });
export const previewCollectionSharing = (id: string) => apiRequest<CollectionSharingPreview>(path(id) + '/sharing-preview');
export const createCollectionShare = (id: string, body: CreateShareLinkRequest & { collectionVersion: number; permissionFingerprint: string }) => apiRequest<{ id: string; token: string; shareUrl: string; password?: string; expiresAt?: string; visibility: ShareLinkItem['visibility']; shortSeq?: number }>(path(id) + '/shares', { method: 'POST', body });
