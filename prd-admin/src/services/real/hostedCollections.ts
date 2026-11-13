import { apiRequest, resolveApiUrl } from './apiClient';
import { useAuthStore } from '@/stores/authStore';
import type { ApiResponse } from '@/types/api';
import type { HostedCollection, HostedCollectionCandidates, HostedCollectionPermissions, HostedCollectionShare, HostedCollectionView, SaveHostedCollection } from '@/services/contracts/hostedCollections';
const root = '/api/web-pages/collections';
export const listHostedCollections = (dissolved = false) => apiRequest<{ items: HostedCollection[] }>(`${root}?dissolved=${dissolved}`);
export const getHostedCollection = (id: string) => apiRequest<HostedCollectionView>(`${root}/${encodeURIComponent(id)}`);
export const getHostedCollectionCandidates = () => apiRequest<HostedCollectionCandidates>(`${root}/candidates`);
export const findHostedCollectionMembers = (keyword: string) => apiRequest<{ items: { id: string; name: string }[] }>(`${root}/members?${new URLSearchParams({ keyword })}`);
export const saveHostedCollection = (id: string | undefined, body: SaveHostedCollection) => apiRequest<HostedCollectionView>(id ? `${root}/${encodeURIComponent(id)}` : root, { method: id ? 'PUT' : 'POST', body });
export const getHostedCollectionPermissions = (id: string) => apiRequest<HostedCollectionPermissions>(`${root}/${encodeURIComponent(id)}/permissions`);
export const syncHostedCollectionPermissions = (id: string, fingerprint: string, siteIds: string[], confirmedPrivateSourceFingerprint?: string) => apiRequest<{ results: { id: string; success: boolean; message: string }[]; fingerprint: string }>(`${root}/${encodeURIComponent(id)}/permissions/sync`, { method: 'POST', body: { fingerprint, siteIds, confirmedPrivateSourceFingerprint } });
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
    const result = await response.json() as ApiResponse<HostedCollectionView & { collection: HostedCollection & { collectionId?: string } }>;
    if (result.success) result.data.collection.id ??= result.data.collection.collectionId ?? '';
    return result;
  } catch { return { success: false, data: null as never, error: { code: 'NETWORK_ERROR', message: '分享暂时无法打开，请重试' } }; }
}
