/**
 * notice-outbound-map — 把 CDS 站内信外发到 MAP 站内通知的适配器。
 *
 * 形状完全照 routes/bug-reports.ts 的三段式（resolve 配置 → build body → forward），
 * 理由也一样：**凭据只在服务端 env 里读，前端永远拿不到**；缺凭据必须如实降级，
 * 绝不假装发送成功。
 *
 * 凭据落点是 env-only，刻意不放 CDS 全局变量 `_global.customEnv`、也不放项目设置——
 * 那两处会被注入到**被部署项目的容器**里，等于把 MAP 管理员 token 泄给业务容器。
 *
 * 三个必须逐字对齐的坑（错了都不报错，只会静默走歪）：
 *  1. 字段名是 `dedupKey`，不是 dedupeKey。MAP 的 AdminNotificationEventRequest.DedupKey
 *     拼错会让 BuildEventKey 返回 null，同一件事每次都新建一条通知 → 刷屏；
 *  2. MAP 的 AllowedLevels 只有 info/success/warning/error，**没有 danger**，
 *     未知值被静默降成 info。CDS 的 danger 必须映射成 error；
 *  3. source 必须命中 MAP 的 AllowedEventSources（AdminNotificationSourceCatalog），
 *     而那张白名单里**没有任何 CDS 专属来源**。本轮不改 prd-api，故默认借
 *     'system-alert'（系统预警）。代价是 MAP 站内信里 CDS 告警与模型池/密钥告警
 *     混在一起、无法按来源筛，已登记进 doc/debt.cds.uptime-monitor.md。
 */

import type { CdsNoticeRecord } from './notice-ledger.js';

export interface NoticeOutboundConfig {
  baseUrl: string;
  token: string;
  /** MAP 通知来源（必须在 MAP 白名单内），默认 system-alert。 */
  source: string;
  /** 定向投递给某个 MAP 用户；不填则按 MAP 的默认受众规则。 */
  targetUserId?: string;
}

export type FetchLike = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface NoticeForwardResult {
  ok: boolean;
  reference?: string;
  reason?: string;
}

/** 与 bug-reports 同款：一次外发共用一份总预算，而不是每段各给 10s。 */
const FORWARD_BUDGET_MS = 10_000;

const DEFAULT_MAP_SOURCE = 'system-alert';

/**
 * 从环境变量解析外发配置。缺 baseUrl 或 token **任一项**都返回 null
 * （= 走「仅本地记录」路径）。导出供单测断言「未配置时必须降级」。
 */
export function resolveNoticeOutboundConfig(
  env: NodeJS.ProcessEnv = process.env,
): NoticeOutboundConfig | null {
  // 逃生阀：外发常态对 MAP 发外呼，被限流 / MAP 维护时必须能一刀关掉。
  const enabled = (env.CDS_NOTICE_OUTBOUND_ENABLED ?? '1').trim();
  if (enabled === '0' || enabled.toLowerCase() === 'false') return null;

  const baseUrl = (env.CDS_NOTICE_MAP_BASE_URL || '').trim().replace(/\/+$/, '');
  const token = (env.CDS_NOTICE_MAP_TOKEN || '').trim();
  if (!baseUrl || !token) return null;

  const source = (env.CDS_NOTICE_MAP_SOURCE || '').trim() || DEFAULT_MAP_SOURCE;
  const targetUserId = (env.CDS_NOTICE_MAP_TARGET_USER || '').trim();
  return { baseUrl, token, source, ...(targetUserId ? { targetUserId } : {}) };
}

/** CDS 级别 → MAP 级别。MAP 没有 danger，未映射会被静默降成 info（坑 2）。 */
export function mapNoticeLevel(level: CdsNoticeRecord['level']): 'info' | 'warning' | 'error' {
  if (level === 'danger') return 'error';
  if (level === 'warning') return 'warning';
  return 'info';
}

/** 组装 MAP `POST /api/dashboard/notifications/events` 的请求体。 */
export function buildMapNotificationBody(
  notice: CdsNoticeRecord,
  config: NoticeOutboundConfig,
): Record<string, unknown> {
  const occurrenceSuffix = notice.occurrences > 1 ? `（近期第 ${notice.occurrences} 次）` : '';
  return {
    source: config.source,
    title: notice.title,
    message: `${notice.body}${occurrenceSuffix}`,
    level: mapNoticeLevel(notice.level),
    ...(notice.actionLabel ? { actionLabel: notice.actionLabel } : {}),
    ...(notice.href ? { actionUrl: notice.href } : {}),
    // 逐字 dedupKey —— 不是 dedupeKey（坑 1）。
    dedupKey: notice.dedupeKey,
    expiresInDays: 7,
    ...(config.targetUserId ? { targetUserId: config.targetUserId } : {}),
  };
}

export function noticeOutboundUrl(config: NoticeOutboundConfig): string {
  return `${config.baseUrl}/api/dashboard/notifications/events`;
}

/**
 * 带凭据外发到 MAP。失败一律返回中文原因，绝不抛、绝不返回 ok:true。
 * 三类失败分开说：HTTP 状态、MAP 信封里的业务拒绝（如「不支持的通知来源」）、连接失败。
 */
export async function forwardNoticeToMap(
  notice: CdsNoticeRecord,
  config: NoticeOutboundConfig,
  fetchImpl?: FetchLike,
): Promise<NoticeForwardResult> {
  const doFetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!doFetch) return { ok: false, reason: '当前运行环境没有可用的 fetch 实现' };

  const budget = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(FORWARD_BUDGET_MS)
    : undefined;

  try {
    const res = await doFetch(noticeOutboundUrl(config), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(buildMapNotificationBody(notice, config)),
      ...(budget ? { signal: budget } : {}),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    const envelope = parsed as {
      success?: boolean;
      data?: { id?: string; notificationId?: string };
      error?: { message?: string };
    } | null;

    if (!res.ok) {
      // MAP 对未知 source 返 400「不支持的通知来源：xxx」——原文保留，
      // 否则运维只看到一个 400，猜不到是白名单没这条来源。
      const detail = envelope?.error?.message || (text ? text.slice(0, 200) : '');
      return { ok: false, reason: `通知系统返回 HTTP ${res.status}${detail ? `：${detail}` : ''}` };
    }
    if (envelope?.success === false) {
      return { ok: false, reason: envelope.error?.message || '通知系统拒绝了本次投递' };
    }
    const reference = envelope?.data?.id || envelope?.data?.notificationId;
    return { ok: true, ...(reference ? { reference } : {}) };
  } catch (err) {
    return {
      ok: false,
      reason: `无法连接通知系统：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
