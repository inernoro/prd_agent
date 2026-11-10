import { apiRequest } from './apiClient';
import type { RelatedPermissionPreview, RelatedSyncResult } from './relatedDocuments';
import type { createShareLink } from './webPages';
type CreateShareLinkRequest = Parameters<typeof createShareLink>[0];

export interface HostedCollection {
  id: string; ownerUserId: string; title: string; siteIds: string[]; mainSiteId: string;
  version: number; shareGeneration: number; isDissolved: boolean; updatedAt: string;
}
export interface CollectionMember { id: string; title: string; available?: boolean }
export interface CollectionDetails {
  collection: HostedCollection | null;
  sites: CollectionMember[];
  legacyShare?: { id: string; title?: string; siteIds: string[] };
  shares: { id: string; token: string; visibility: string; expiresAt?: string; active: boolean; isRevoked: boolean; needsUpdate: boolean; memberCount: number; collectionVersion: number }[];
}
export interface CollectionDraft { title: string; siteIds: string[]; mainSiteId: string; version: number }
export interface CollectionSharingPreview {
  fingerprint: string; version: number; canShare: boolean; notice: string;
  items: { id: string; title: string; visibility: string; teamCount: number; isMain: boolean }[];
}
const root = '/api/web-pages/collections';
const path = (id: string) => `${root}/${encodeURIComponent(id)}`;
export const listCollections = (keyword = '', page = 1) => apiRequest<{ items: HostedCollection[]; total: number; page: number; pageSize: number }>(`${root}?${new URLSearchParams({ keyword, page: String(page) })}`);
export const getCollection = (id: string) => apiRequest<CollectionDetails>(path(id));
export const getCollectionByShare = (token: string) => apiRequest<CollectionDetails>(`${root}/by-share/${encodeURIComponent(token)}`);
export const createCollection = (body: CollectionDraft) => apiRequest<CollectionDetails>(root, { method: 'POST', body });
export const updateCollection = (id: string, body: CollectionDraft) => apiRequest<CollectionDetails>(path(id), { method: 'PUT', body });
export const adoptCollection = (token: string, title: string, mainSiteId: string) => apiRequest<CollectionDetails>(`${root}/from-share/${encodeURIComponent(token)}`, { method: 'POST', body: { title, mainSiteId } });
export const getCollectionCandidates = (keyword = '', page = 1) => apiRequest<{ items: CollectionMember[]; total: number }>(`${root}/candidates?${new URLSearchParams({ keyword, page: String(page) })}`);
export const stopCollectionSharing = (id: string, version: number) => apiRequest(path(id) + '/stop-sharing', { method: 'POST', body: { version } });
export const dissolveCollection = (id: string, version: number) => apiRequest(path(id) + '/dissolve', { method: 'POST', body: { version } });
export const previewCollectionPermissions = (id: string) => apiRequest<RelatedPermissionPreview>(path(id) + '/permissions');
export const syncCollectionPermissions = (id: string, fingerprint: string, revokeTargetShares: boolean) => apiRequest<RelatedSyncResult>(path(id) + '/permissions/sync', { method: 'POST', body: { fingerprint, revokeTargetShares } });
export const previewCollectionSharing = (id: string) => apiRequest<CollectionSharingPreview>(path(id) + '/sharing-preview');
export const createCollectionShare = (id: string, body: CreateShareLinkRequest & { collectionVersion: number; permissionFingerprint: string }) => apiRequest<{ id: string; token: string; shareUrl: string; password?: string }>(path(id) + '/shares', { method: 'POST', body });
