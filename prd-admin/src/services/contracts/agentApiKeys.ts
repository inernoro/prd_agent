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
  /**
   * 它此刻**真拿得到**的能力，不是库里存了什么。
   *
   * 自动档的钥匙存的是空清单（清单是鉴权时现算的），手动档里被回收权限的那几项鉴权时会被剥掉 ——
   * 两种情况照着存的显示都是假的。服务端按与鉴权同一处的判据算好再回。
   */
  scopes: string[];
  /** auto = 能力跟着主人的权限走，不存清单；manual = 按存的这份清单钉死 */
  scopeMode: 'auto' | 'manual';
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
  /** 自动模式下传什么都会被服务端忽略（它不存清单） */
  scopes: string[];
  ttlDays?: number;
  /**
   * 缺省 = manual，跟老路径（密钥管理页）语义一致。
   * 接入台默认走 'auto'：用户没动过高级设置，能力就跟着他的权限走。
   */
  scopeMode?: 'auto' | 'manual';
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
  /** 显式切模式。不传时：**存了 scopes 就自动钉成 manual**（存清单那一刻就是动过高级设置那一刻） */
  scopeMode?: 'auto' | 'manual';
  isActive?: boolean;
  /** 接入台配额上限（每日生图张数，1-500） */
  mcpDailyImageQuota?: number;
  /** 接入台配额上限（每日写入次数，1-2000） */
  mcpDailyWriteQuota?: number;
  /** 接入台配额上限（每分钟调用次数，1-600） */
  mcpRateLimitPerMin?: number;
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
