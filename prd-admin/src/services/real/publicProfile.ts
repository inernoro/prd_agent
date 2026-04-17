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

// ─── 公共类型 ───

export interface PublicProfileUser {
  username: string;
  displayName: string;
  avatarFileName?: string | null;
}

export interface PublicSection<T> {
  items: T[];
  total: number;
}

// ─── 各领域公开物的类型 ───

export interface PublicSite {
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

export interface PublicSkill {
  id: string;
  skillKey: string;
  title: string;
  description?: string;
  icon?: string | null;
  category: string;
  tags: string[];
  usageCount: number;
  publishedAt?: string | null;
  updatedAt: string;
}

export interface PublicProfileDocumentStore {
  id: string;
  name: string;
  description?: string | null;
  coverImageUrl?: string | null;
  tags: string[];
  documentCount: number;
  viewCount: number;
  updatedAt: string;
}

export interface PublicLiteraryPrompt {
  id: string;
  title: string;
  scenarioType?: string | null;
  forkCount: number;
  updatedAt: string;
}

export interface PublicWorkspace {
  id: string;
  title: string;
  coverAssetId?: string | null;
  publishedAt?: string | null;
  updatedAt: string;
}

export interface PublicEmergenceTree {
  id: string;
  title: string;
  description?: string | null;
  nodeCount: number;
  updatedAt: string;
}

export interface PublicWorkflow {
  id: string;
  name: string;
  description?: string | null;
  avatarUrl?: string | null;
  tags: string[];
  executionCount: number;
  updatedAt: string;
}

/**
 * 8 个领域公开物的聚合响应。
 * 前端根据每类的 total 决定是否显示对应 Tab。
 */
export interface PublicProfile {
  user: PublicProfileUser;
  sites: PublicSection<PublicSite>;
  skills: PublicSection<PublicSkill>;
  documents: PublicSection<PublicProfileDocumentStore>;
  prompts: PublicSection<PublicLiteraryPrompt>;
  workspaces: PublicSection<PublicWorkspace>;
  emergences: PublicSection<PublicEmergenceTree>;
  workflows: PublicSection<PublicWorkflow>;
}

export async function fetchPublicProfile(username: string): Promise<ApiResponse<PublicProfile>> {
  const url = joinUrl(getApiBaseUrl(), api.publicProfile.byUsername(username));
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
