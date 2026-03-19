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
  return apiRequest<DesktopUpdateCacheItem[]>('GET', '/api/desktop-update-cache');
}

export async function triggerDesktopUpdateCache(target: string) {
  return apiRequest<string>('POST', '/api/desktop-update-cache/trigger', { target });
}

export async function deleteDesktopUpdateCache(id: string) {
  return apiRequest<{ deleted: boolean }>('DELETE', `/api/desktop-update-cache/${id}`);
}
