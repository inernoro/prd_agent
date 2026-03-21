import { apiRequest } from './apiClient';

export interface DesktopUpdateCacheItem {
  id: string;
  version: string;
  target: string;
  status: string;
  cosPackageUrl?: string;
  errorMessage?: string;
  packageSizeBytes?: number;
  githubPackageUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export async function getDesktopUpdateCaches() {
  return apiRequest<DesktopUpdateCacheItem[]>('/api/desktop-update-cache');
}

export async function triggerDesktopUpdateCache(target: string) {
  return apiRequest<string>('/api/desktop-update-cache/trigger', { method: 'POST', body: { target } });
}

export async function deleteDesktopUpdateCache(id: string) {
  return apiRequest<{ deleted: boolean }>(`/api/desktop-update-cache/${id}`, { method: 'DELETE' });
}
