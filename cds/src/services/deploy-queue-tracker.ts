/**
 * deploy-queue-tracker — 把 build-gate 的排队状态挂到 BranchEntry 上，
 * 让「排队中」在分支卡上可见（2026-07-09）。
 *
 * 历史问题：build-gate（全局构建并发闸）落地后，排队提示只写进部署日志的
 * SSE 流——用户必须打开部署日志才能看到；分支卡把排队时间一并计入
 * 「耗时 vs 预计」，排队中的分支显示为「构建中 + 已超预计(琥珀告警)」，
 * 无法区分「在排队」与「卡死/变慢」（expectation-management：不知道在干嘛
 * / 不知道还要多久，两种失控都命中）。
 *
 * 职责：
 * - onQueued：把服务加进 entry.buildQueue（首个排队者记 queuedAt），发
 *   branch.updated 让卡片立即出现排队 chip。
 * - refresh（15s 周期，由调用方的排队刷新 timer 驱动）：更新 ahead/active。
 * - onStart：从 serviceIds 移除该服务；集合清空时把「首入队 → 清空」的
 *   wall-clock 区间累进 entry.lastDeployQueueWaitMs（层内并行排队取并集，
 *   跨层自然累加），并清掉 buildQueue。
 * - dispose：部署 finalize / error 兜底——不管中途 throw 在哪，排队快照
 *   必须清干净，否则卡片永远显示「排队中」。
 *
 * 事件发射只带 { branchId, projectId }：SSE 层（branches.ts 的 anyHandler）
 * 收到 branch.updated 且 payload 无 branch 时会自己从 state 取最新分支并过
 * branchForView 脱敏管道——不要在 payload 里塞原始 entry（历史 Bugbot Medium
 * 「SSE leaks extra service secrets」）。
 *
 * 注意：远端 executor / remote-hosts 部署路径不经 build-gate，天然没有排队
 * chip——这是预期行为，不是遗漏。
 */

import type { BranchEntry } from '../types.js';
import { buildGateStatus } from './build-gate.js';

export interface DeployQueueTrackerDeps {
  entry: BranchEntry;
  /** 触发持久化（瞬态字段也 save：GET /api/branches 全量刷新要能看到）。 */
  save(): void;
  /** 发一条 branch.updated（只带 id，脱敏由 SSE 层完成）。 */
  emitBranchUpdated(): void;
}

export interface DeployQueueTracker {
  /** 服务进入排队。 */
  onQueued(profileId: string, info: { ahead: number; active: number; max: number }): void;
  /** 15s 排队刷新：更新位置快照（buildGateStatus 现值）。 */
  refresh(): void;
  /** 服务拿到槽位。 */
  onStart(profileId: string): void;
  /** 部署收尾/异常兜底：清残留排队快照。 */
  dispose(): void;
}

export function createDeployQueueTracker(deps: DeployQueueTrackerDeps): DeployQueueTracker {
  const { entry, save, emitBranchUpdated } = deps;

  const settleWait = (): void => {
    if (!entry.buildQueue) return;
    const queuedMs = Date.parse(entry.buildQueue.queuedAt);
    if (Number.isFinite(queuedMs)) {
      entry.lastDeployQueueWaitMs = (entry.lastDeployQueueWaitMs || 0) + Math.max(0, Date.now() - queuedMs);
    }
    entry.buildQueue = undefined;
  };

  return {
    onQueued(profileId, info) {
      if (!entry.buildQueue) {
        entry.buildQueue = {
          queuedAt: new Date().toISOString(),
          ahead: info.ahead,
          active: info.active,
          max: info.max,
          serviceIds: [profileId],
        };
      } else {
        if (!entry.buildQueue.serviceIds.includes(profileId)) {
          entry.buildQueue.serviceIds.push(profileId);
        }
        entry.buildQueue.ahead = Math.min(entry.buildQueue.ahead, info.ahead);
        entry.buildQueue.active = info.active;
        entry.buildQueue.max = info.max;
      }
      save();
      emitBranchUpdated();
    },

    refresh() {
      if (!entry.buildQueue) return;
      const s = buildGateStatus();
      // ahead 无法精确到"我前面还有几个"（闸门只知道总排队数），用
      // min(已知位置, 当前总排队数) 单调收敛——只会变小不会跳大。
      entry.buildQueue.ahead = Math.min(entry.buildQueue.ahead, s.queued);
      entry.buildQueue.active = s.active;
      entry.buildQueue.max = s.max;
      // 瞬态位置刷新不值一次全量持久化，只推事件。
      emitBranchUpdated();
    },

    onStart(profileId) {
      if (!entry.buildQueue) return;
      entry.buildQueue.serviceIds = entry.buildQueue.serviceIds.filter((id) => id !== profileId);
      if (entry.buildQueue.serviceIds.length === 0) {
        settleWait();
      }
      save();
      emitBranchUpdated();
    },

    dispose() {
      if (!entry.buildQueue) return;
      settleWait();
      save();
      emitBranchUpdated();
    },
  };
}
