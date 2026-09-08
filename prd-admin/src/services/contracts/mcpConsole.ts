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
  /** 写入档我自己签不签得出来：只有读权限位的人，卡片可用但写入不可勾 */
  writeAvailableToMe: boolean;
  /** 我名下有没有哪把活跃密钥拿到了这块能力 */
  granted: boolean;
  todayCalls: number;
  tools: McpToolDto[];
}

export interface McpClientDto {
  keyId: string;
  name: string;
  keyPrefix: string;
  /** 它此刻实际拿得到的能力。自动模式是服务端现算的，不是库里存的那份（存的是空） */
  scopes: string[];
  /** auto = 跟着主人的权限走，平台新增的能力自动进来；manual = 按当初存的清单钉死 */
  scopeMode: 'auto' | 'manual';
  /**
   * 你自己有、但没开给这台客户端的能力。只有手动模式才可能非空 ——
   * 这正是「用户知道、钥匙没权限」：告诉他还能给什么，但不替他给。
   */
  missingCapabilities: Array<{ key: string; title: string }>;
  isActive: boolean;
  /**
   * 不可用的原因。名单里不会出现已吊销的钥匙（服务端先按 RevokedAt 滤过），
   * 所以不可用只可能是这两种，而且两种都还救得回来 —— 不能一律说成「已作废」。
   */
  unusableReason?: 'disabled' | 'expired' | null;
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
  /** 幂等命中：这次没产生新副作用，占的额度已退回 */
  deduplicated: boolean;
  durationMs: number;
  argumentsPreview?: string | null;
  errorMessage?: string | null;
  artifact?: McpCallArtifactDto | null;
  createdAt: string;
}

export interface McpConsoleOverviewDto {
  endpointUrl: string;
  /**
   * 这个人**有没有过**任何一次调用 —— 不带时间下界，与下面所有「今天」的数字不同源。
   *
   * 「今天没调用」不等于「从来没接过」：一把昨天用过、今天之前被撤销的钥匙会让
   * clients 空、today 全零。别拿 recentCalls 代替它 —— 那份同样按今天切，
   * 今天没调用时必然为空（跨天的那份在「它干了什么」那个端点）。
   */
  hasHistory: boolean;
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
  /** 不可用（或宽限期）时的一句大白话原因；可用且不在宽限期时为 null。 */
  unusableReason?: string | null;
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


export type GetMcpVisibleToolsContract = (keyId: string) => Promise<ApiResponse<McpVisibleToolsDto>>;
