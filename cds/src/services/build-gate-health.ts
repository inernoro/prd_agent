/**
 * build-gate-health — 全局构建队列健康判定（纯函数 SSOT）。
 *
 * 背景（2026-07-16 线上事故）：build-gate 曾堵死在 active=3/queued=54、消化约
 * 12/小时，agent 部署排队 50 分钟以上。根因修完后（排队可取消 / 极速版跳闸 /
 * 崩溃早退 / 层内共享 abort / manual 合并 / run 账本周期收割），本模块把
 * 「该类问题是否复发」固化成可机器判定的健康函数，供三个消费方共用：
 *
 *   1. GET /api/cluster/build-gate/health（cluster.ts）——健康 200 / 退化 503，
 *      给注册在「任务调度」里的定时回归任务当探测目标（退化时任务 run 红灯）。
 *   2. startBuildGateWatchdog（index.ts）——进程内 60s 采样，退化时向
 *      ServerEventLogStore 记 warn/error 事件（dashboard 系统日志可见）。
 *   3. cds/tests/services/build-gate-health.test.ts —— CI 回归门禁。
 *
 * 纯函数、无 I/O：输入闸门快照 + run 账本 + 当前时刻，输出结论 + 原因清单。
 */

import type { DeploymentRun } from '../types.js';
import type { BuildGateHolder } from './build-gate.js';

export interface BuildGateSnapshot {
  active: number;
  queued: number;
  max: number;
  holders: Array<BuildGateHolder & { acquiredAt: string }>;
  waiters: Array<BuildGateHolder & { enqueuedAt: string }>;
}

export type BuildGateHealthReasonKind =
  | 'queue-backlog' // 排队积压：queued 达到阈值（历史事故 54）
  | 'stuck-holder' // 槽位持有超时：正常构建含就绪下限 ~20min，超 45min 视为卡死
  | 'stale-runs' // 幽灵 run：非终结 run 心跳停跳超阈值（周期收割器失效的兜底信号）
  | 'invariant'; // 闸门账目坏了：active 超上限 / 有排队却零活跃

export interface BuildGateHealthReason {
  kind: BuildGateHealthReasonKind;
  severity: 'warn' | 'error';
  message: string;
  detail?: Record<string, unknown>;
}

export interface BuildGateHealthResult {
  ok: boolean;
  /** 退化原因清单（ok=true 时为空）。 */
  reasons: BuildGateHealthReason[];
  /** 采样摘要，供事件/接口透出。 */
  summary: {
    active: number;
    queued: number;
    max: number;
    oldestHolderAgeMin: number | null;
    staleRunCount: number;
  };
}

export interface BuildGateHealthOptions {
  /** 排队积压阈值（默认 15；历史事故 54）。 */
  queueBacklogThreshold?: number;
  /** 槽位持有告警阈值分钟（默认 45；部署就绪下限 20min + 余量）。 */
  stuckHolderMinutes?: number;
  /** 非终结 run 心跳停跳阈值分钟（默认 30；周期收割 15min 过期 + 5min 一轮，30 仍在即失效）。 */
  staleRunMinutes?: number;
}

const DEFAULT_QUEUE_BACKLOG_THRESHOLD = 15;
const DEFAULT_STUCK_HOLDER_MINUTES = 45;
const DEFAULT_STALE_RUN_MINUTES = 30;

const RUN_TERMINAL_STATUSES = new Set(['running', 'failed', 'cancelled']);

function parseMs(value?: string | null): number {
  if (!value) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function evaluateBuildGateHealth(
  gate: BuildGateSnapshot,
  runs: ReadonlyArray<Pick<DeploymentRun, 'id' | 'status' | 'branchId' | 'heartbeatAt' | 'updatedAt' | 'startedAt'>>,
  now: Date,
  options: BuildGateHealthOptions = {},
): BuildGateHealthResult {
  const nowMs = now.getTime();
  const queueBacklogThreshold = options.queueBacklogThreshold ?? DEFAULT_QUEUE_BACKLOG_THRESHOLD;
  const stuckHolderMinutes = options.stuckHolderMinutes ?? DEFAULT_STUCK_HOLDER_MINUTES;
  const staleRunMinutes = options.staleRunMinutes ?? DEFAULT_STALE_RUN_MINUTES;
  const reasons: BuildGateHealthReason[] = [];

  // 1. 排队积压
  if (gate.queued >= queueBacklogThreshold) {
    reasons.push({
      kind: 'queue-backlog',
      severity: gate.queued >= queueBacklogThreshold * 2 ? 'error' : 'warn',
      message: `构建队列积压：${gate.queued} 个等待中（阈值 ${queueBacklogThreshold}，${gate.active}/${gate.max} 构建中）`,
      detail: { queued: gate.queued, threshold: queueBacklogThreshold, waiters: gate.waiters.slice(0, 10) },
    });
  }

  // 2. 槽位持有超时
  let oldestHolderAgeMin: number | null = null;
  const stuckHolders: Array<Record<string, unknown>> = [];
  for (const holder of gate.holders) {
    const acquiredMs = parseMs(holder.acquiredAt);
    if (!Number.isFinite(acquiredMs)) continue;
    const ageMin = Math.floor((nowMs - acquiredMs) / 60_000);
    oldestHolderAgeMin = oldestHolderAgeMin === null ? ageMin : Math.max(oldestHolderAgeMin, ageMin);
    if (ageMin >= stuckHolderMinutes) {
      stuckHolders.push({ ...holder, ageMin });
    }
  }
  if (stuckHolders.length > 0) {
    reasons.push({
      kind: 'stuck-holder',
      severity: 'error',
      message: `构建槽位持有超时：${stuckHolders.length} 个持有者超过 ${stuckHolderMinutes} 分钟未释放`,
      detail: { stuckHolders, thresholdMinutes: stuckHolderMinutes },
    });
  }

  // 3. 幽灵 run（周期收割器失效兜底）
  const staleRuns: Array<Record<string, unknown>> = [];
  for (const run of runs) {
    if (RUN_TERMINAL_STATUSES.has(run.status)) continue;
    const heartbeatMs = parseMs(run.heartbeatAt || run.updatedAt || run.startedAt);
    if (!Number.isFinite(heartbeatMs)) continue;
    const ageMin = Math.floor((nowMs - heartbeatMs) / 60_000);
    if (ageMin >= staleRunMinutes) {
      staleRuns.push({ id: run.id, branchId: run.branchId, status: run.status, heartbeatAgeMin: ageMin });
    }
  }
  if (staleRuns.length > 0) {
    reasons.push({
      kind: 'stale-runs',
      severity: 'warn',
      message: `幽灵部署 run：${staleRuns.length} 个非终结 run 心跳停跳超过 ${staleRunMinutes} 分钟（周期收割器可能失效）`,
      detail: { staleRuns: staleRuns.slice(0, 10), thresholdMinutes: staleRunMinutes },
    });
  }

  // 4. 闸门账目不变量
  if (gate.active > gate.max) {
    reasons.push({
      kind: 'invariant',
      severity: 'error',
      message: `构建闸账目异常：active(${gate.active}) 超过上限 max(${gate.max})——超额授予`,
      detail: { active: gate.active, max: gate.max },
    });
  }
  if (gate.active === 0 && gate.queued > 0) {
    reasons.push({
      kind: 'invariant',
      severity: 'error',
      message: `构建闸账目异常：0 个活跃构建但仍有 ${gate.queued} 个排队——槽位授予停摆`,
      detail: { active: gate.active, queued: gate.queued },
    });
  }

  return {
    ok: reasons.length === 0,
    reasons,
    summary: {
      active: gate.active,
      queued: gate.queued,
      max: gate.max,
      oldestHolderAgeMin,
      staleRunCount: staleRuns.length,
    },
  };
}
