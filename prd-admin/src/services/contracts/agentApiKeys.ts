/**
 * Agent 开放接口 API Key 管理合约。
 *
 * 用户通过"接入 AI"按钮打开 Dialog，在此处创建/续期/撤销 Key。
 * AI / Agent 获取明文 Key 后通过 `Authorization: Bearer sk-ak-xxxx` 调用开放接口。
 */

import type { ApiResponse } from '@/types/api';

export type AgentApiKeyStatus =
  | 'active'
  | 'expiring-soon'  // 30 天内过期
  | 'grace'          // 已过期但在宽限期内
  | 'expired'        // 已过期且超出宽限期（实际会被后端过滤掉）
  | 'disabled'
  | 'revoked';

export interface AgentApiKeyDto {
  id: string;
  name: string;
  description?: string | null;
  /** 前 12 字符明文，仅用于展示（如 `sk-ak-abc12345`） */
  keyPrefix: string;
  scopes: string[];
  isActive: boolean;
  createdAt: string;
  expiresAt?: string | null;
  lastRenewedAt?: string | null;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
  totalRequests: number;
  gracePeriodDays: number;
  /** 距离过期的剩余天数；null 表示永不过期 */
  daysLeft: number | null;
  status: AgentApiKeyStatus;
}

export type ListAgentApiKeysContract = () => Promise<
  ApiResponse<{ items: AgentApiKeyDto[]; allowedScopes: string[] }>
>;

export type CreateAgentApiKeyContract = (input: {
  name: string;
  description?: string;
  scopes: string[];
  ttlDays?: number;
}) => Promise<
  ApiResponse<{
    item: AgentApiKeyDto;
    /** 明文 Key —— 仅此一次返回，丢了只能重新生成 */
    apiKey: string;
    warning: string;
  }>
>;

export type UpdateAgentApiKeyContract = (input: {
  id: string;
  name?: string;
  description?: string;
  scopes?: string[];
  isActive?: boolean;
}) => Promise<ApiResponse<{ item: AgentApiKeyDto | null }>>;

export type RenewAgentApiKeyContract = (input: {
  id: string;
  ttlDays?: number;
}) => Promise<ApiResponse<{ item: AgentApiKeyDto | null }>>;

export type RevokeAgentApiKeyContract = (input: {
  id: string;
}) => Promise<ApiResponse<{ item: AgentApiKeyDto | null }>>;

export type DeleteAgentApiKeyContract = (input: {
  id: string;
}) => Promise<ApiResponse<{ deleted: boolean }>>;
