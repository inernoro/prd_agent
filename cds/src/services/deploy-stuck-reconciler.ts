/**
 * deploy-stuck-reconciler — 部署/生命周期状态机的「通用看门狗」纯函数 SSOT。
 *
 * 病根（2026-06-27 fleet audit 39 个分支暴露）：CDS 的部署生命周期状态机
 * **没有**通用的卡死收敛器。只有 `ciImageStatus='waiting'` 有看门狗
 * （index.ts startCiWaitWatchdog），其余非终结态可以静默卡死永不收敛：
 *
 *  - TYPE 2「状态从未终结」：cd-s-mobile-homepage 的 branch.status='starting'
 *    卡 9.6 小时，而 lastReadyAt(23:01) 已晚于 lastDeployStartedAt(22:18)，
 *    随后又被自动降温（lastStoppedAt 落戳 + lastStopReason="自动降温"）——
 *    status 字段停在一个与生命周期时间戳**自相矛盾**的非终结值，UI 据此
 *    渲染出无限「99.99% / 部署耗时 772m」。又如 cursor-file-convert 空闲
 *    （已降温）但 per-service status 卡在 'stopping' 永不终结成 'stopped'。
 *
 *  - TYPE 1「极速版镜像落后 HEAD」：kind-newton / product-agent-migration
 *    的 ciImageStatus='ready' 但 ciTargetSha !== githubCommitSha —— CI 为
 *    真 HEAD 编了镜像却没被认领/部署，于是静默跑着旧镜像，无任何告警。
 *
 * 本模块对两类卡死给出**纯函数**收敛器，镜像 deploy-dispatch-reconciler
 * 的形状（输入 branches + now + options，输出 result 数组），所有 I/O
 * （git diff / 写日志 / 发事件）经回调注入，核心可脱离仓库单测。
 *
 * 设计取舍：
 *  - TYPE 2 优先走**时间戳证据**路径（ready 已晚于 start ⇒ 状态过期），
 *    只有完全拿不到证据时才用**保守硬超时**兜底（默认 ~45min = 3× 就绪
 *    超时），永不误杀一个「确实很久但健康」的构建。
 *  - TYPE 1 **只告警不自动部署**（自动重部署在这里不安全，可能踩到正在
 *    进行的部署 / 认领竞态）——把静默失败变成响亮失败，让人/CI 介入。
 */

import type { BranchEntry, BuildProfile, OperationLog } from '../types.js';
import type { ServerEventLogSink } from './server-event-log-store.js';
import { createHash } from 'node:crypto';
import { branchUsesPrebuiltMode } from './deploy-runtime.js';

/** 非终结的分支/服务状态。卡在这些值且与时间戳矛盾 ⇒ 需收敛。 */
const NON_TERMINAL_STATES = new Set(['starting', 'building', 'stopping', 'restarting']);

/**
 * 保守硬超时（毫秒）。非终结态持续超过此阈值且**无任何时间戳证据**可推断
 * 真实终态时，作为最后手段收敛为 error/stopped。故意取得很大（默认 45min =
 * 3× 就绪超时 300s），绝不误杀健康但耗时长的构建。可经 options 覆盖。
 */
export const STUCK_NON_TERMINAL_HARD_TIMEOUT_MS = 45 * 60_000;

export type StuckReconcileKind =
  | 'branch-status-finalized' // TYPE 2：分支级非终结态收敛
  | 'service-status-finalized' // TYPE 2：服务级非终结态收敛
  | 'express-head-divergence'; // TYPE 1：极速版镜像落后 HEAD 告警

export interface DeployStuckReconcileResult {
  branchId: string;
  projectId?: string;
  kind: StuckReconcileKind;
  /** 服务级收敛时指向具体 profileId；分支级 / 告警类为 undefined。 */
  profileId?: string;
  previousStatus?: string;
  nextStatus?: string;
  /** 触发收敛/告警的判定路径：'timestamp-evidence' | 'hard-timeout' | 'alarm'。 */
  via: 'timestamp-evidence' | 'hard-timeout' | 'alarm';
  ageMin?: number;
  reason: string;
}

export interface ReconcileStuckDeployOptions {
  now?: Date;
  source?: string;
  /** 非终结态硬超时（毫秒），缺省 STUCK_NON_TERMINAL_HARD_TIMEOUT_MS。 */
  hardTimeoutMs?: number;
  serverEventLogStore?: ServerEventLogSink | null;
  /** 取该分支当前生效的 build profiles（用于 branchUsesPrebuiltMode 判定）。 */
  getBuildProfiles?: (branch: BranchEntry) => BuildProfile[];
  /**
   * 判定 ciTargetSha..githubCommitSha 这段 divergent commit 是否含**运行时**
   * 改动（非纯文档）。生产环境接到 worktree 里的 `git diff` → analyzeChangeImpact；
   * 单测里 mock。返回 true ⇒ 有未部署的代码改动 ⇒ 告警；false ⇒ 纯文档 ⇒ 不告警。
   * 不提供时跳过 TYPE 1 告警（保守：无证据不喊）。
   */
  diffRuntimePaths?: (branch: BranchEntry) => boolean;
  /** 收敛/告警时追加一条分支 op-log（注入以保持纯函数可测）。 */
  appendLog?: (branchId: string, log: OperationLog) => void;
  /** 收敛/告警后发 branch.updated 事件让 UI 刷新（注入以保持纯函数可测）。 */
  emitBranchUpdated?: (branch: BranchEntry) => void;
}

function parseTime(value?: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function createTraceId(branchId: string, anchor: string, source: string): string {
  const digest = createHash('sha1')
    .update(`${branchId}\0${anchor}\0${source}`)
    .digest('hex')
    .slice(0, 12);
  return `op_stuck_${digest}`;
}

function recordEvent(
  store: ServerEventLogSink | null | undefined,
  branch: BranchEntry,
  source: string,
  action: string,
  message: string,
  details: Record<string, unknown>,
): void {
  if (!store) return;
  const operationId = createTraceId(branch.id, action, source);
  const requestId = `stuck_${operationId.slice('op_stuck_'.length)}`;
  store.record({
    category: 'system',
    severity: 'warn',
    source,
    action,
    message,
    projectId: branch.projectId,
    branchId: branch.id,
    requestId,
    operationId,
    details: {
      operationId,
      requestId,
      actor: 'system:deploy-stuck-reconciler',
      trigger: 'system',
      ...details,
    },
  });
}

/**
 * TYPE 2 分支级：判断卡死的非终结 branch.status 应收敛到什么终态，并给出判定路径。
 * 返回 null 表示「未卡死 / 仍在合理进行中」，不应触碰。
 */
function decideBranchFinalization(
  branch: BranchEntry,
  nowMs: number,
  hardTimeoutMs: number,
): { nextStatus: BranchEntry['status']; via: 'timestamp-evidence' | 'hard-timeout'; ageMin: number; reason: string } | null {
  const status = branch.status;
  if (!NON_TERMINAL_STATES.has(status)) return null;

  const readyMs = parseTime(branch.lastReadyAt);
  const startMs = parseTime(branch.lastDeployStartedAt);
  const stoppedMs = parseTime(branch.lastStoppedAt);

  // 证据路径 A：starting/building/restarting 但 lastReadyAt >= lastDeployStartedAt，
  // 说明它**确实**起来过 —— status 是陈旧的。再看是否随后被停（lastStoppedAt 更新）：
  // 停了 ⇒ idle；没停 ⇒ running。
  if ((status === 'starting' || status === 'building' || status === 'restarting') && readyMs > 0 && readyMs >= startMs) {
    if (stoppedMs >= readyMs) {
      return {
        nextStatus: 'idle',
        via: 'timestamp-evidence',
        ageMin: startMs > 0 ? Math.floor((nowMs - startMs) / 60_000) : 0,
        reason: `状态机看门狗：${status} 已就绪（lastReadyAt 晚于 lastDeployStartedAt）后又被停止（lastStoppedAt），状态陈旧，收敛为 idle`,
      };
    }
    return {
      nextStatus: 'running',
      via: 'timestamp-evidence',
      ageMin: startMs > 0 ? Math.floor((nowMs - startMs) / 60_000) : 0,
      reason: `状态机看门狗：${status} 实际已就绪（lastReadyAt 晚于 lastDeployStartedAt），状态陈旧，收敛为 running`,
    };
  }

  // 证据路径 B：stopping 但 lastStoppedAt 已落戳且晚于本轮停止触发的起点，
  // 说明停止已完成 —— 收敛为 idle（分支级无 'stopped' 终态，停妥即 idle）。
  if (status === 'stopping' && stoppedMs > 0) {
    const triggerMs = Math.max(startMs, readyMs);
    if (stoppedMs >= triggerMs) {
      return {
        nextStatus: 'idle',
        via: 'timestamp-evidence',
        ageMin: Math.floor((nowMs - stoppedMs) / 60_000),
        reason: `状态机看门狗：stopping 已完成（lastStoppedAt 已落戳），状态陈旧，收敛为 idle`,
      };
    }
  }

  // 硬超时兜底（最后手段）：拿不到时间戳证据时，仅当非终结态持续超过保守阈值
  // 才收敛。锚点优先取本轮构建起点，退而取最近就绪 / 创建时间。
  const anchorMs = startMs || readyMs || parseTime(branch.createdAt);
  if (anchorMs > 0) {
    const ageMs = nowMs - anchorMs;
    if (ageMs >= hardTimeoutMs) {
      const ageMin = Math.floor(ageMs / 60_000);
      const next: BranchEntry['status'] = status === 'stopping' ? 'idle' : 'error';
      return {
        nextStatus: next,
        via: 'hard-timeout',
        ageMin,
        reason: `状态机看门狗：${status} 超过 ${Math.floor(hardTimeoutMs / 60_000)} 分钟未终结（已持续 ${ageMin} 分钟），已收敛为 ${next}`,
      };
    }
  }

  return null;
}

export function reconcileStuckDeployStates(
  branches: BranchEntry[],
  options: ReconcileStuckDeployOptions = {},
): DeployStuckReconcileResult[] {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const source = options.source ?? 'deploy-stuck-reconciler';
  const hardTimeoutMs = options.hardTimeoutMs ?? STUCK_NON_TERMINAL_HARD_TIMEOUT_MS;
  const results: DeployStuckReconcileResult[] = [];

  for (const branch of branches) {
    let mutated = false;

    // ── TYPE 2 分支级：卡死非终结 branch.status 收敛 ──
    const branchDecision = decideBranchFinalization(branch, nowMs, hardTimeoutMs);
    if (branchDecision) {
      const previousStatus = branch.status;
      branch.status = branchDecision.nextStatus;
      if (branchDecision.nextStatus === 'error' && !branch.errorMessage) {
        branch.errorMessage = branchDecision.reason;
      }
      mutated = true;
      results.push({
        branchId: branch.id,
        projectId: branch.projectId,
        kind: 'branch-status-finalized',
        previousStatus,
        nextStatus: branchDecision.nextStatus,
        via: branchDecision.via,
        ageMin: branchDecision.ageMin,
        reason: branchDecision.reason,
      });
      options.appendLog?.(branch.id, {
        type: 'build',
        startedAt: branch.lastDeployStartedAt || branch.createdAt,
        finishedAt: now.toISOString(),
        status: branchDecision.nextStatus === 'error' ? 'error' : 'completed',
        events: [{
          step: 'stuck-state-finalize',
          status: branchDecision.via === 'hard-timeout' ? 'warning' : 'info',
          title: '状态机看门狗收敛卡死分支状态',
          log: branchDecision.reason,
          detail: {
            previousStatus,
            nextStatus: branchDecision.nextStatus,
            via: branchDecision.via,
            ageMin: branchDecision.ageMin,
            source,
          },
          timestamp: now.toISOString(),
        }],
      });
      recordEvent(options.serverEventLogStore, branch, source, 'branch.stuck-state.finalized', branchDecision.reason, {
        previousStatus,
        nextStatus: branchDecision.nextStatus,
        via: branchDecision.via,
        ageMin: branchDecision.ageMin,
        lastDeployStartedAt: branch.lastDeployStartedAt || null,
        lastReadyAt: branch.lastReadyAt || null,
        lastStoppedAt: branch.lastStoppedAt || null,
      });
    }

    // ── TYPE 2 服务级：卡死非终结 service.status 收敛 ──
    for (const [profileId, svc] of Object.entries(branch.services || {})) {
      if (!svc || !NON_TERMINAL_STATES.has(svc.status)) continue;
      const previousStatus = svc.status;
      const readyMs = parseTime(branch.lastReadyAt);
      const startMs = parseTime(branch.lastDeployStartedAt);
      const stoppedMs = parseTime(branch.lastStoppedAt);

      let nextStatus: typeof svc.status | null = null;
      let via: 'timestamp-evidence' | 'hard-timeout' | null = null;
      let reason = '';
      let ageMin = 0;

      // stopping + lastStoppedAt 落戳且晚于停止触发 ⇒ 终结为 stopped。
      if (svc.status === 'stopping' && stoppedMs > 0 && stoppedMs >= Math.max(startMs, readyMs)) {
        nextStatus = 'stopped';
        via = 'timestamp-evidence';
        ageMin = Math.floor((nowMs - stoppedMs) / 60_000);
        reason = `状态机看门狗：服务 ${profileId} stopping 已完成（lastStoppedAt 已落戳），收敛为 stopped`;
      } else if (
        (svc.status === 'starting' || svc.status === 'building' || svc.status === 'restarting')
        && readyMs > 0 && readyMs >= startMs
      ) {
        // 起来过 ⇒ running（除非随后被停，则 stopped）。
        const stopped = stoppedMs >= readyMs;
        nextStatus = stopped ? 'stopped' : 'running';
        via = 'timestamp-evidence';
        ageMin = startMs > 0 ? Math.floor((nowMs - startMs) / 60_000) : 0;
        reason = `状态机看门狗：服务 ${profileId} ${previousStatus} 实际已就绪，状态陈旧，收敛为 ${nextStatus}`;
      } else {
        // 硬超时兜底。
        const anchorMs = startMs || readyMs || parseTime(branch.createdAt);
        if (anchorMs > 0 && nowMs - anchorMs >= hardTimeoutMs) {
          nextStatus = svc.status === 'stopping' ? 'stopped' : 'error';
          via = 'hard-timeout';
          ageMin = Math.floor((nowMs - anchorMs) / 60_000);
          reason = `状态机看门狗：服务 ${profileId} ${previousStatus} 超过 ${Math.floor(hardTimeoutMs / 60_000)} 分钟未终结（已持续 ${ageMin} 分钟），已收敛为 ${nextStatus}`;
        }
      }

      if (!nextStatus || !via) continue;
      svc.status = nextStatus;
      if (nextStatus === 'error' && !svc.errorMessage) svc.errorMessage = reason;
      mutated = true;
      results.push({
        branchId: branch.id,
        projectId: branch.projectId,
        kind: 'service-status-finalized',
        profileId,
        previousStatus,
        nextStatus,
        via,
        ageMin,
        reason,
      });
      recordEvent(options.serverEventLogStore, branch, source, 'branch.stuck-state.service-finalized', reason, {
        profileId,
        previousStatus,
        nextStatus,
        via,
        ageMin,
      });
    }

    // ── TYPE 1：极速版镜像落后 HEAD 告警（只告警，不自动部署） ──
    const profiles = options.getBuildProfiles?.(branch);
    const isPrebuilt = profiles ? branchUsesPrebuiltMode(profiles, branch) : false;
    if (
      isPrebuilt
      && branch.ciImageStatus === 'ready'
      && branch.ciTargetSha
      && branch.githubCommitSha
      && branch.ciTargetSha !== branch.githubCommitSha
      && options.diffRuntimePaths
    ) {
      const hasRuntimeDiff = options.diffRuntimePaths(branch);
      if (hasRuntimeDiff) {
        const targetShort = branch.ciTargetSha.slice(0, 7);
        const headShort = branch.githubCommitSha.slice(0, 7);
        const reason = `极速版镜像落后 HEAD：sha-${targetShort} 已部署，但 HEAD ${headShort} 含未部署的代码改动（CI 认领可能漏处理）`;
        // 幂等：同一 target..head 组合不重复落同样的 ciImageError。
        if (branch.ciImageError !== reason) {
          branch.ciImageError = reason;
          mutated = true;
          results.push({
            branchId: branch.id,
            projectId: branch.projectId,
            kind: 'express-head-divergence',
            via: 'alarm',
            reason,
          });
          options.appendLog?.(branch.id, {
            type: 'build',
            startedAt: branch.lastPushAt || now.toISOString(),
            finishedAt: now.toISOString(),
            status: 'error',
            events: [{
              step: 'express-head-divergence',
              status: 'warning',
              title: '极速版镜像落后 HEAD',
              log: reason,
              detail: {
                ciTargetSha: branch.ciTargetSha,
                githubCommitSha: branch.githubCommitSha,
                source,
              },
              timestamp: now.toISOString(),
            }],
          });
          recordEvent(options.serverEventLogStore, branch, source, 'branch.express-image.head-divergence', reason, {
            ciTargetSha: branch.ciTargetSha,
            githubCommitSha: branch.githubCommitSha,
          });
        }
      }
    }

    if (mutated) options.emitBranchUpdated?.(branch);
  }

  return results;
}
