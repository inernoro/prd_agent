import { apiRequest } from '@/services/real/apiClient';
import api from '@/services/api';
import type { ApiResponse } from '@/types/api';

export interface TechDocGitHubAuthStatus {
  connected: boolean;
  oauthConfigured: boolean;
  appKey: string;
  login?: string;
  avatarUrl?: string;
  scopes?: string;
  connectedAt?: string;
  lastUsedAt?: string;
}

export interface TechDocDeviceFlowStart {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  intervalSeconds: number;
  expiresInSeconds: number;
  flowToken: string;
}

export type TechDocDeviceFlowPollStatus = 'pending' | 'slow_down' | 'expired' | 'denied' | 'done';

export interface TechDocDeviceFlowPoll {
  status: TechDocDeviceFlowPollStatus;
}

export interface TechDocGitHubRepository {
  id: number;
  name: string;
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

export interface TechDocGitHubRepositoryList {
  items: TechDocGitHubRepository[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface TechDocGitHubTreeItem {
  name: string;
  path: string;
  type: 'dir' | 'file' | string;
  size?: number | null;
  htmlUrl?: string | null;
}

export interface TechDocGitHubTree {
  owner: string;
  repo: string;
  path: string;
  branch?: string | null;
  items: TechDocGitHubTreeItem[];
}

export interface TechDocGitHubContextFile {
  name: string;
  path: string;
  size?: number | null;
  content: string;
  truncated: boolean;
  htmlUrl?: string | null;
}

export interface TechDocGitHubContext {
  owner: string;
  repo: string;
  path: string;
  branch?: string | null;
  files: TechDocGitHubContextFile[];
}

export async function getTechDocGitHubAuthStatus(): Promise<ApiResponse<TechDocGitHubAuthStatus>> {
  return apiRequest<TechDocGitHubAuthStatus>(api.techDocFormatAgent.github.auth.status());
}

export async function startTechDocGitHubDeviceFlow(): Promise<ApiResponse<TechDocDeviceFlowStart>> {
  return apiRequest<TechDocDeviceFlowStart>(api.techDocFormatAgent.github.auth.deviceStart(), {
    method: 'POST',
  });
}

export async function pollTechDocGitHubDeviceFlow(
  flowToken: string,
): Promise<ApiResponse<TechDocDeviceFlowPoll>> {
  return apiRequest<TechDocDeviceFlowPoll>(api.techDocFormatAgent.github.auth.devicePoll(), {
    method: 'POST',
    body: { flowToken },
  });
}

export async function listTechDocGitHubRepositories(
  query?: string,
  page = 1,
  pageSize = 30,
): Promise<ApiResponse<TechDocGitHubRepositoryList>> {
  return apiRequest<TechDocGitHubRepositoryList>(
    api.techDocFormatAgent.github.repositories(query, page, pageSize),
  );
}

export async function getTechDocGitHubTree(
  owner: string,
  repo: string,
  path?: string,
  branch?: string,
): Promise<ApiResponse<TechDocGitHubTree>> {
  return apiRequest<TechDocGitHubTree>(
    api.techDocFormatAgent.github.tree(owner, repo, path, branch),
  );
}

export async function getTechDocGitHubContext(
  owner: string,
  repo: string,
  path?: string,
  branch?: string,
): Promise<ApiResponse<TechDocGitHubContext>> {
  return apiRequest<TechDocGitHubContext>(
    api.techDocFormatAgent.github.context(owner, repo, path, branch),
  );
}
