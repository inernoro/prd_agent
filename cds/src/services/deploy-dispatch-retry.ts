import type { BranchEntry } from '../types.js';
import type { DeployDispatchReconcileResult } from './deploy-dispatch-reconciler.js';

export interface DeployDispatchRetryDecision {
  retry: boolean;
  reason: string;
}

/**
 * 2026-06-23：重试风暴根因修复用的可选护栏。全部 opt-in —— 不传 options 时
 * 行为与历史一致（兼容旧 2 参调用与既有单测）。生产路径（index.ts reconciler）
 * 会把这些都填上，让任何项目都不会出现「7 小时前的构建还在跑」的幽灵：
 *
 *   - isProjectPaused：项目已暂停 → 一律不重试（与 webhook 闸门一致）。
 *   - skipWhenOperationActive：分支正处于 building/starting/restarting/stopping
 *     等在途操作 → 不再叠加一次新部署（避免把已经在跑的构建越堆越多）。
 *   - maxAgeMs：以**首次**派发时间（deployDispatchFirstAt，重试不刷新）为锚点，
 *     超过该时长直接放弃。这是治幽灵的关键——历史实现每次重试都刷新
 *     lastDeployDispatchAt，使「自派发以来的时长」永远归零、age 上限永不触发。
 *   - maxRetries：累计自动重试次数上限，达到即放弃（默认生产 3 次）。
 *   - baseBackoffMs：指数退避；距上次派发不足 base*2^retryCount 时本轮先跳过。
 */
export interface DeployDispatchRetryOptions {
  now?: Date;
  isProjectPaused?: boolean;
  skipWhenOperationActive?: boolean;
  maxAgeMs?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
}

/**
 * 2026-06-24：部署重试**默认关闭**的总闸（治重试风暴）。只有显式把
 * `CDS_DEPLOY_DISPATCH_RETRY_ENABLED` 设成 1/true/on/yes 才恢复自动补发；
 * 未设 / 空 / 0 / false 一律视为关闭。reconciler 仍会把 stale 标记为
 * interrupted（记账），但关闭时绝不自动触发部署。纯函数便于单测锁死「默认关」。
 */
export function isDeployDispatchRetryEnabled(raw: string | undefined | null): boolean {
  return /^(1|true|on|yes)$/i.test((raw || '').trim());
}

/** 仍在「在途」的分支状态：此时不应再叠加一次重试部署。 */
const ACTIVE_OPERATION_STATUSES = new Set(['building', 'starting', 'restarting', 'stopping']);

function parseTime(value?: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function shouldRetryInterruptedWebhookDispatch(
  branch: BranchEntry | undefined,
  result: DeployDispatchReconcileResult,
  options: DeployDispatchRetryOptions = {},
): DeployDispatchRetryDecision {
  if (!branch) return { retry: false, reason: 'branch-missing' };
  if (!result.commitSha) return { retry: false, reason: 'missing-commit-sha' };
  if (branch.lastDeployDispatchCommitSha !== result.commitSha) {
    return { retry: false, reason: 'dispatch-commit-changed' };
  }
  if (branch.lastDeployDispatchAt !== result.dispatchAt) {
    return { retry: false, reason: 'dispatch-timestamp-changed' };
  }

  const dispatchAtMs = parseTime(result.dispatchAt);
  const lastDeployAtMs = parseTime(branch.lastDeployAt);
  if (lastDeployAtMs >= dispatchAtMs) {
    return { retry: false, reason: 'already-deployed-after-dispatch' };
  }

  const lastStoppedAtMs = parseTime(branch.lastStoppedAt);
  const terminalStopAfterDispatch =
    lastStoppedAtMs >= dispatchAtMs
    && (branch.lastStopSource === 'user' || branch.lastStopSource === 'executor' || branch.lastStopSource === 'system');
  if (terminalStopAfterDispatch) {
    return { retry: false, reason: `terminal-stop-after-dispatch:${branch.lastStopSource}` };
  }

  if (branch.status === 'idle' && Object.values(branch.services || {}).every((svc) => svc.status === 'stopped')) {
    return { retry: false, reason: 'branch-idle-all-services-stopped' };
  }

  // ── 2026-06-23 重试风暴护栏（opt-in，旧 2 参调用不受影响）──
  if (options.isProjectPaused === true) {
    return { retry: false, reason: 'project-paused' };
  }

  if (options.skipWhenOperationActive && ACTIVE_OPERATION_STATUSES.has(branch.status)) {
    return { retry: false, reason: `operation-in-progress:${branch.status}` };
  }

  const nowMs = (options.now ?? new Date()).getTime();

  if (typeof options.maxAgeMs === 'number' && options.maxAgeMs > 0) {
    // 锚点优先用首次派发时间；缺省（老数据）退回本轮 dispatchAt。
    const firstAtMs = parseTime(branch.deployDispatchFirstAt) || dispatchAtMs;
    if (firstAtMs > 0 && nowMs - firstAtMs > options.maxAgeMs) {
      return { retry: false, reason: 'dispatch-too-old' };
    }
  }

  const retryCount = branch.deployDispatchRetryCount || 0;

  if (typeof options.maxRetries === 'number' && retryCount >= options.maxRetries) {
    return { retry: false, reason: 'retry-cap-reached' };
  }

  if (typeof options.baseBackoffMs === 'number' && options.baseBackoffMs > 0 && retryCount > 0) {
    const lastAttemptMs = parseTime(branch.lastDeployDispatchAt);
    const backoffMs = options.baseBackoffMs * 2 ** Math.min(retryCount, 10);
    if (lastAttemptMs > 0 && nowMs - lastAttemptMs < backoffMs) {
      return { retry: false, reason: 'backoff-pending' };
    }
  }

  return { retry: true, reason: 'stale-webhook-dispatch-safe-to-retry' };
}
