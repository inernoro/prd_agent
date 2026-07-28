/**
 * 远端发布现场巡检：周期读回 current / previous，判漂移并告警，顺带回收超期产物。
 *
 * 为什么另起一个 starter 而不塞进 startReleaseRunReaper：收割器只做「把执行体已消失的
 * run 收敛成失败」这一件纯内存 + 状态机的事，从不外呼。把 SSH 巡检混进去，一台目标机器
 * 不通就会让收割器的失败语义变糊（到底是收敛失败还是网络失败？），而收割器一旦被拖住，
 * 所有目标的在途 run 都释放不掉。两件事同频不同体。
 *
 * 只告警不自愈（计划第六节）：漂移只产出事件与快照，绝不下发任何修正命令。线上被人
 * 手工改过时自动纠正等于毁灭现场证据，而且很可能盖掉别人刚发上去的紧急修复。
 */

import type { ReleaseTarget } from '../types.js';
import type { ReleaseArtifactReclaimResult, ReleaseRemoteStateResult, ReleaseService } from './release-service.js';
import type { ReleaseRemoteDriftStatus } from './release-artifact-retention.js';

/** 巡检间隔。与 RELEASE_RECONCILE_INTERVAL_MS 同频：都是「五分钟内知道就够」的运维面。 */
export const RELEASE_REMOTE_WATCH_INTERVAL_MS = 5 * 60_000;

/**
 * 单轮回收上限。回收是 rm -rf 生产机器上的目录，一次删太多会长时间占住磁盘 IO，
 * 也让复盘时「这轮到底动了什么」不可读。宁可分几轮收干净。
 */
export const RELEASE_RECLAIM_MAX_PER_SWEEP = 20;

/** 巡检事件类型。名字与 cds-events-bus 的 CdsEventType 一一对应，由接线方转发。 */
export type ReleaseDriftEventType = 'release.drift-detected' | 'release.drift-cleared';

export interface ReleaseDriftEventData {
  targetId: string;
  projectId: string;
  targetName: string;
  status: ReleaseRemoteDriftStatus;
  /** 远端 current 解析出的版本（已剥自动恢复后缀并回溯）。 */
  remoteReleaseId?: string;
  /** CDS 认知的当前线上版本。 */
  expectedReleaseId?: string;
  message: string;
  detectedAt: string;
}

export type ReleaseDriftNotifier = (type: ReleaseDriftEventType, data: ReleaseDriftEventData) => void;

/**
 * 告警出口是**晚绑定**的，理由与 release-health-snapshot 的 setter 同源：
 * 巡检模块不该反向 import 事件总线并自己决定「这条要不要叫醒人」——那正是
 * 「存活监控一套、发布一套」两条分发逻辑的长法。总线的 CDS_EVENT_ALERT_CLASS
 * 是告警等级的唯一判定源，接线方一行 `cdsEventsBus.publish` 转发即可。
 *
 * 未注册时退化成 console.warn：**必须留痕**。静默丢弃告警是最难被发现的缺陷，
 * 没人会注意到一个从没响过的铃。
 */
let notifier: ReleaseDriftNotifier | null = null;

export function setReleaseDriftNotifier(next: ReleaseDriftNotifier | null): void {
  notifier = next;
}

function notify(type: ReleaseDriftEventType, data: ReleaseDriftEventData): void {
  if (!notifier) {
    console.warn(`[release-drift] ${type} 未接告警通道: ${data.targetName} ${data.message}`);
    return;
  }
  try {
    notifier(type, data);
  } catch (err) {
    console.warn(`[release-drift] 告警外发失败: ${(err as Error).message}`);
  }
}

/**
 * 边沿去重台账：targetId → 上一次已外发的漂移签名。
 *
 * 不去重的话 5 分钟一轮会把同一条漂移无限重发，人两天就学会忽略这个告警了
 * （release-events.ts 的 lastLifecycle 是同一套范式）。签名带上远端/期望版本：
 * 漂移**变成另一个版本**也是新事实，必须再响一次。
 */
const lastAlerted = new Map<string, string>();

/** 上限与 release-events 的去重台账同口径：内存有界，常见重放也吃得掉。 */
const MAX_TRACKED_TARGETS = 500;

function driftSignature(state: ReleaseRemoteStateResult): string {
  return [state.drift.status, state.drift.remoteReleaseId || '', state.drift.expectedReleaseId || ''].join('|');
}

export function resetReleaseDriftDedupe(): void {
  lastAlerted.clear();
}

/**
 * 把一次巡检结果转成告警动作。抽成纯函数是为了让「什么时候该响、什么时候不该响」
 * 可以被断言，而不是埋在定时器里靠跑一遍看日志。
 *
 * 三条口径：
 *  - drifted 且签名变化 → 报警；
 *  - 曾经 drifted、现在 in-sync / not-applicable → 报解除；
 *  - **unknown 不解除**：SSH 不通只是「看不见」，不是「已恢复」。此时发 cleared
 *    等于给出一个假的全清信号，比不发更糟。
 */
export function planDriftAlert(state: ReleaseRemoteStateResult): { type: ReleaseDriftEventType } | null {
  const previous = lastAlerted.get(state.targetId);
  if (state.drift.status === 'drifted') {
    const signature = driftSignature(state);
    if (previous === signature) return null;
    lastAlerted.set(state.targetId, signature);
    if (lastAlerted.size > MAX_TRACKED_TARGETS) {
      const oldest = lastAlerted.keys().next();
      if (!oldest.done) lastAlerted.delete(oldest.value);
    }
    return { type: 'release.drift-detected' };
  }
  if (state.drift.status === 'unknown') return null;
  if (!previous) return null;
  lastAlerted.delete(state.targetId);
  return { type: 'release.drift-cleared' };
}

export interface ReleaseRemoteWatcherDeps {
  listTargets(): ReleaseTarget[];
  releaseService: Pick<ReleaseService, 'readRemoteReleaseState' | 'reclaimRemoteReleaseArtifacts'>;
  /** 是否顺带回收产物。缺省读 CDS_RELEASE_ARTIFACT_RETENTION（设为 0 即只巡检不回收）。 */
  reclaim?: boolean;
  maxRemovalsPerSweep?: number;
}

export interface ReleaseRemoteSweepResult {
  scanned: number;
  drifted: number;
  unknown: number;
  reclaimed: number;
}

export function isReleaseArtifactRetentionEnabled(): boolean {
  // 逃生阀：生产上真出事时不需要改代码、不需要发版，改一个环境变量重启即可停手。
  return String(process.env.CDS_RELEASE_ARTIFACT_RETENTION ?? '1').trim() !== '0';
}

/**
 * 跑一轮巡检。任何单个目标失败都不能中断整轮——一台机器不通不该让别的目标也停摆。
 */
export async function sweepReleaseRemoteState(deps: ReleaseRemoteWatcherDeps): Promise<ReleaseRemoteSweepResult> {
  const reclaimEnabled = deps.reclaim ?? isReleaseArtifactRetentionEnabled();
  const result: ReleaseRemoteSweepResult = { scanned: 0, drifted: 0, unknown: 0, reclaimed: 0 };
  for (const target of deps.listTargets()) {
    if (!target.isEnabled || target.type !== 'ssh' || !target.ssh) continue;
    try {
      let state: ReleaseRemoteStateResult;
      let reclaimResult: ReleaseArtifactReclaimResult | undefined;
      if (reclaimEnabled) {
        // 回收内部本来就要先只读盘点，复用它的结果，别为同一件事打两次 SSH。
        reclaimResult = await deps.releaseService.reclaimRemoteReleaseArtifacts(target, {
          maxRemovals: deps.maxRemovalsPerSweep ?? RELEASE_RECLAIM_MAX_PER_SWEEP,
        });
        state = {
          targetId: reclaimResult.targetId,
          projectId: reclaimResult.projectId,
          mode: reclaimResult.mode,
          drift: reclaimResult.drift,
          readError: reclaimResult.readError,
          readAt: new Date().toISOString(),
        };
        result.reclaimed += reclaimResult.removedWorktrees.length + reclaimResult.removedVersions.length;
      } else {
        state = await deps.releaseService.readRemoteReleaseState(target);
      }
      result.scanned += 1;
      if (state.drift.status === 'drifted') result.drifted += 1;
      if (state.drift.status === 'unknown') result.unknown += 1;
      const alert = planDriftAlert(state);
      if (alert) {
        notify(alert.type, {
          targetId: target.id,
          projectId: target.projectId,
          targetName: target.name,
          status: state.drift.status,
          remoteReleaseId: state.drift.remoteReleaseId,
          expectedReleaseId: state.drift.expectedReleaseId,
          message: state.drift.message,
          detectedAt: state.readAt,
        });
      }
    } catch (err) {
      console.warn(`[release-drift] 巡检 ${target.id} 失败: ${(err as Error).message}`);
    }
  }
  return result;
}

export function startReleaseRemoteWatcher(
  deps: ReleaseRemoteWatcherDeps & { intervalMs?: number },
): { stop(): void } {
  const intervalMs = deps.intervalMs && deps.intervalMs > 0 ? deps.intervalMs : RELEASE_REMOTE_WATCH_INTERVAL_MS;
  let running = false;
  const tick = (): void => {
    // 上一轮还没跑完就跳过：一台慢机器不该把巡检堆成叠加的并发 SSH。
    if (running) return;
    running = true;
    void sweepReleaseRemoteState(deps)
      .catch((err) => console.warn(`[release-drift] 巡检轮次异常: ${(err as Error).message}`))
      .finally(() => { running = false; });
  };
  const timer = global.setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => global.clearInterval(timer) };
}
