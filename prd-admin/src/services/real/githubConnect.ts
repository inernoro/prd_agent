import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';

/**
 * 共用 GitHub 连接中心的前端服务层。
 *
 * 后端 /api/github/* 只要求登录态 —— 任何用户都能连自己的 GitHub 账号，
 * token 加密存在他自己名下，能看到哪些仓库由 GitHub 决定，本系统不代管。
 */

export interface GitHubAuthStatus {
  connected: boolean;
  /** 管理员是否配置了 OAuth App；false 时前端要直说"管理员没配"，不要让用户空点 */
  oauthConfigured: boolean;
  login?: string | null;
  avatarUrl?: string | null;
  scopes?: string | null;
  connectedAt?: string | null;
  lastUsedAt?: string | null;
}

export interface GitHubDeviceFlowStart {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string | null;
  intervalSeconds: number;
  expiresInSeconds: number;
  flowToken: string;
}

export type GitHubDeviceFlowPollStatus = 'pending' | 'slow_down' | 'expired' | 'denied' | 'done';

export interface GitHubRepository {
  id: number;
  fullName: string;
  owner: string;
  repo: string;
  description?: string | null;
  isPrivate: boolean;
  defaultBranch?: string | null;
  htmlUrl?: string | null;
  updatedAt?: string | null;
  ownerAvatarUrl?: string | null;
}

export interface GitHubBranch {
  name: string;
  protected: boolean;
}

export interface GitHubDirectoryNode {
  /** 仓库内路径；空串表示仓库根目录 */
  path: string;
  name: string;
  parentPath: string | null;
  depth: number;
  /** 直属该目录的 Markdown 文件数（同步是单层的，不含子目录） */
  markdownCount: number;
  fileCount: number;
  /** 是否默认预勾选（doc / docs 目录及其含 Markdown 的子目录） */
  recommended: boolean;
}

export interface GitHubDirectoryScan {
  owner: string;
  repo: string;
  branch: string;
  truncated: boolean;
  totalDirectories: number;
  directories: GitHubDirectoryNode[];
  recommendedPaths: string[];
}

export function getGitHubAuthStatus() {
  return apiRequest<GitHubAuthStatus>(api.github.auth.status(), { method: 'GET' });
}

export function startGitHubDeviceFlow() {
  return apiRequest<GitHubDeviceFlowStart>(api.github.auth.deviceStart(), { method: 'POST' });
}

export function pollGitHubDeviceFlow(flowToken: string) {
  return apiRequest<{ status: GitHubDeviceFlowPollStatus; login?: string; avatarUrl?: string }>(
    api.github.auth.devicePoll(),
    { method: 'POST', body: { flowToken } },
  );
}

export function disconnectGitHub() {
  return apiRequest<{ removed: boolean }>(api.github.auth.disconnect(), { method: 'DELETE' });
}

export function listGitHubRepositories(query?: string, page = 1, pageSize = 30) {
  return apiRequest<{ items: GitHubRepository[]; page: number; pageSize: number; hasMore: boolean }>(
    api.github.repositories(query, page, pageSize),
    { method: 'GET' },
  );
}

export function listGitHubBranches(owner: string, repo: string) {
  return apiRequest<{ owner: string; repo: string; items: GitHubBranch[] }>(
    api.github.branches(owner, repo),
    { method: 'GET' },
  );
}

/** 扫描整个仓库的目录，返回可勾选清单 + 默认预勾选路径（所有 doc / docs 目录，递归） */
export function scanGitHubDocDirectories(owner: string, repo: string, branch?: string) {
  return apiRequest<GitHubDirectoryScan>(
    api.github.docDirectories(owner, repo, branch),
    { method: 'GET' },
  );
}
