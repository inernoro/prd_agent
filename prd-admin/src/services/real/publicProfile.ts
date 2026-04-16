import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';

// 公开页无需登录，不走 apiRequest（避免 401 → refresh → redirect 链路）
function getApiBaseUrl() {
  return ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
}

function joinUrl(base: string, path: string) {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  if (!b) return `/${p}`;
  return `${b}/${p}`;
}

export interface PublicProfileUser {
  username: string;
  displayName: string;
  avatarFileName?: string | null;
}

export interface PublicProfileSite {
  id: string;
  title: string;
  description?: string;
  siteUrl: string;
  coverImageUrl?: string | null;
  tags: string[];
  viewCount: number;
  publishedAt?: string | null;
  updatedAt: string;
}

export interface PublicProfile {
  user: PublicProfileUser;
  sites: PublicProfileSite[];
  total: number;
}

export async function fetchPublicProfile(username: string, limit = 60): Promise<ApiResponse<PublicProfile>> {
  const url = joinUrl(getApiBaseUrl(), api.publicProfile.byUsername(username, limit));
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const json = await res.json();
    return json as ApiResponse<PublicProfile>;
  } catch {
    return {
      success: false,
      data: null as never,
      error: { code: 'NETWORK_ERROR', message: '网络请求失败' },
    };
  }
}
