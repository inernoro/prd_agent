import { api } from '@/services/api';
import { apiRequest } from '@/services/real/apiClient';
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
  bio?: string | null;
  profileBackground?: string | null;
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
  /** 主条目的标题 + 摘要预览（若存在） */
  primaryEntry?: {
    title: string;
    summary?: string | null;
  } | null;
}

export interface PublicLiteraryPrompt {
  id: string;
  title: string;
  scenarioType?: string | null;
  forkCount: number;
  updatedAt: string;
  /** 提示词正文的前 240 字（预览） */
  preview?: string | null;
}

export interface PublicWorkspace {
  id: string;
  title: string;
  coverAssetId?: string | null;
  /** 后端已从 image_assets 解析出的封面图 URL（可能为 null） */
  coverUrl?: string | null;
  publishedAt?: string | null;
  updatedAt: string;
}

export interface PublicEmergenceTree {
  id: string;
  title: string;
  description?: string | null;
  nodeCount: number;
  updatedAt: string;
  /** 种子内容前 240 字（预览） */
  seedPreview?: string | null;
}

export interface PublicWorkflow {
  id: string;
  name: string;
  description?: string | null;
  avatarUrl?: string | null;
  tags: string[];
  executionCount: number;
  updatedAt: string;
  /** 工作流节点总数 */
  nodeCount?: number;
  /** 前 5 个节点类型（顺序） */
  nodeTypes?: string[];
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

/**
 * 更新当前登录用户的个人公开页信息（自我介绍 + 背景主题）。
 * 传 null / 空字符串即清空。仅登录用户可调用。
 */
export async function updateMyPublicPage(
  bio: string | null | undefined,
  profileBackground: string | null | undefined,
): Promise<ApiResponse<{ userId: string; bio: string | null; profileBackground: string | null }>> {
  return apiRequest<{ userId: string; bio: string | null; profileBackground: string | null }>(
    api.profile.publicPage(),
    { method: 'PATCH', body: { bio: bio ?? null, profileBackground: profileBackground ?? null } },
  );
}

/** 公开页支持自助撤回的资源领域（对应 tab key） */
export type RetractDomain =
  | 'sites'
  | 'skills'
  | 'documents'
  | 'prompts'
  | 'workspaces'
  | 'emergences'
  | 'workflows';

/**
 * 将公开资源撤回为私有（仅资源所有者可操作）。
 * 不同领域走不同端点：
 *   - sites:      PATCH  /api/web-pages/{id}/visibility     { visibility: "private" }
 *   - skills:     POST   /api/skill-agent/skills/{skillKey}/unpublish
 *   - documents:  PUT    /api/document-store/stores/{id}    { isPublic: false }
 *   - prompts:    POST   /api/literary-agent/prompts/{id}/unpublish
 *   - workspaces: POST   /api/visual-agent/image-master/workspaces/{id}/unpublish
 *   - emergences: POST   /api/emergence/trees/{id}/unpublish
 *   - workflows:  POST   /api/workflow-agent/workflows/{id}/unpublish
 *
 * @param domain 领域 key
 * @param key 资源标识：多数领域传 id；skills 传 skillKey
 */
export async function retractPublicItem(
  domain: RetractDomain,
  key: string,
): Promise<ApiResponse<unknown>> {
  switch (domain) {
    case 'sites':
      return apiRequest(api.webPages.setVisibility(key), {
        method: 'PATCH',
        body: { visibility: 'private' },
      });
    case 'skills':
      return apiRequest(api.skillAgent.unpublish(key), { method: 'POST' });
    case 'documents':
      return apiRequest(api.documentStore.stores.detail(key), {
        method: 'PUT',
        body: { isPublic: false },
      });
    case 'prompts':
      return apiRequest(api.literaryAgent.prompts.unpublish(key), { method: 'POST' });
    case 'workspaces':
      return apiRequest(api.visualAgent.imageMaster.workspaces.unpublish(key), { method: 'POST' });
    case 'emergences':
      return apiRequest(api.emergence.trees.unpublish(key), { method: 'POST' });
    case 'workflows':
      return apiRequest(api.workflowAgent.workflows.unpublish(key), { method: 'POST' });
  }
}
