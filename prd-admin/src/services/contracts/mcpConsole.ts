/**
 * 智能体接入台（MCP）合约。
 *
 * 面板回答三个问题：我授权了什么、连着哪几台客户端、它们刚才做了什么。
 * 智能体侧走 /api/mcp（sk-ak 密钥），这里是给人看的那一面，走登录态。
 */

import type { ApiResponse } from '@/types/api';

export interface McpToolDto {
  name: string;
  description: string;
  requiredScope: string;
  /** 会在平台里留下东西的动作（建站、写文档…） */
  isWrite: boolean;
  granted: boolean;
}

export interface McpCapabilityDto {
  key: string;
  title: string;
  summary: string;
  readScope?: string | null;
  writeScope?: string | null;
  writeNeedsApproval: boolean;
  /** 我自己有没有这块能力的权限位；没有的话勾了也签不出密钥 */
  availableToMe: boolean;
  /** 我名下有没有哪把活跃密钥拿到了这块能力 */
  granted: boolean;
  todayCalls: number;
  tools: McpToolDto[];
}

export interface McpClientDto {
  keyId: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  isActive: boolean;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
  todayCalls: number;
  dailyImageQuota: number;
  dailyWriteQuota: number;
  rateLimitPerMin: number;
  todayImages: number;
  todayWrites: number;
}

export interface McpCallArtifactDto {
  kind?: string | null;
  id?: string | null;
  url?: string | null;
  title?: string | null;
}

export interface McpCallLogDto {
  id: string;
  keyId: string;
  keyName: string;
  toolName: string;
  capability?: string | null;
  /** success | error | denied */
  status: string;
  isWrite: boolean;
  imageCount: number;
  httpStatus: number;
  durationMs: number;
  argumentsPreview?: string | null;
  errorMessage?: string | null;
  artifact?: McpCallArtifactDto | null;
  createdAt: string;
}

export interface McpConsoleOverviewDto {
  endpointUrl: string;
  capabilities: McpCapabilityDto[];
  clients: McpClientDto[];
  today: {
    /** 「今天」按 UTC 自然日切，与额度口径一致 */
    sinceUtc: string;
    calls: number;
    images: number;
    writes: number;
    denied: number;
    failed: number;
  };
  recentCalls: McpCallLogDto[];
}

export interface McpVisibleToolsDto {
  endpointUrl: string;
  keyId: string;
  keyName: string;
  keyPrefix: string;
  isActive: boolean;
  expiresAt?: string | null;
  toolCount: number;
  tools: Array<{ name: string; description: string; capability?: string | null; isWrite: boolean }>;
}

export type GetMcpConsoleOverviewContract = () => Promise<ApiResponse<McpConsoleOverviewDto>>;

export type ListMcpCallsContract = (input: {
  keyId?: string;
  capability?: string;
  status?: string;
  skip?: number;
  limit?: number;
}) => Promise<ApiResponse<{ total: number; skip: number; limit: number; items: McpCallLogDto[] }>>;

export type GetMcpCallDetailContract = (id: string) => Promise<ApiResponse<McpCallLogDto>>;

export type GetMcpVisibleToolsContract = (keyId: string) => Promise<ApiResponse<McpVisibleToolsDto>>;
