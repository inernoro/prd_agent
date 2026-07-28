import { EventEmitter } from 'node:events';
import type { DeploymentFailure, ReleaseLogEntry, ReleaseRun, ReleaseRunStatus } from '../types.js';
import { cdsEventsBus } from './cds-events-bus.js';

export type ReleaseEventEnvelope =
  | { type: 'release.log'; payload: { releaseId: string; log: ReleaseLogEntry } }
  | { type: 'release.status'; payload: { releaseId: string; run: ReleaseRun } };

/** 发布生命周期在 cds-events-bus 上的事件类型（CdsEventType 的子集）。 */
export type ReleaseLifecycleEventType =
  | 'release.started'
  | 'release.succeeded'
  | 'release.failed'
  | 'release.rolled-back';

/**
 * ReleaseRunStatus → 总线事件的**唯一**判定源。
 *
 * 穷尽 Record 而不是 switch：新增 ReleaseRunStatus 时这里少一个键 TS 直接报错，
 * 逼作者显式回答「这个状态要不要外发」。写成 switch + default 的话新状态会被静默
 * 归进 default 什么都不发 —— 发布失败没人知道，且这种缺陷不会有任何报错，
 * 属于「没人会注意到没响过的铃」那一类。
 *
 * 三处口径值得记下来：
 *  - queued 与 running 都映射 started：run 建出来是 queued，patchStatus 第一跳才到
 *    running，两者都属于「这次发布开始了」，靠去重保证只外发一次；
 *  - healthchecking 不外发：started 已经发过，成败等终态再说，中间态外发纯噪声；
 *  - rollback_running 也映射 started：回滚是一次**独立的** ReleaseRun（自己的
 *    releaseId），它的开始就是一次发布动作的开始；消费方靠 data.rollbackOf 区分。
 */
const RELEASE_STATUS_EVENT: Record<ReleaseRunStatus, ReleaseLifecycleEventType | null> = {
  queued: 'release.started',
  running: 'release.started',
  healthchecking: null,
  success: 'release.succeeded',
  failed: 'release.failed',
  rollback_running: 'release.started',
  rollback_success: 'release.rolled-back',
  rollback_failed: 'release.failed',
};

export function releaseEventTypeForStatus(status: ReleaseRunStatus): ReleaseLifecycleEventType | null {
  return RELEASE_STATUS_EVENT[status] ?? null;
}

/** 上总线的发布事件载荷。projectId 必须在 —— 见 publishLifecycle 的注释。 */
export interface ReleaseLifecycleEventData {
  releaseId: string;
  projectId: string;
  targetId: string;
  branchId: string;
  commitSha: string;
  status: ReleaseRunStatus;
  startedAt: string;
  finishedAt?: string;
  operator?: string;
  rollbackOf?: string;
  errorMessage?: string;
  failure?: DeploymentFailure;
}

/**
 * 去重台账上限。
 *
 * 选「有界保留」而不是「终态即删」：终态删掉后，任何一次对已终态 run 的重复
 * release.status（收割器绕过状态机强制终态化那条旁路、存量数据重放）都会把终态
 * 事件再外发一遍。告警重复会把人训练成忽略告警，代价不比漏报小。保留条目 + 淘汰
 * 最老两头都兜住：内存有上界，常见重放也吃得掉。被淘汰的老 run 若真再来一次状态
 * 事件会重复外发一次，是刻意接受的取舍。
 */
const MAX_TRACKED_RUNS = 500;

class ReleaseEventBus extends EventEmitter {
  /** releaseId → 最近一次已外发到总线的事件类型。 */
  private lastLifecycle = new Map<string, ReleaseLifecycleEventType>();

  constructor() {
    super();
    this.setMaxListeners(0);
  }

  emitEvent(envelope: ReleaseEventEnvelope): ReleaseEventEnvelope {
    try {
      this.emit(envelope.type, envelope.payload);
      this.emit('any', envelope);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[release-events] listener threw:', (err as Error).message);
    }
    // 放在本地 emit 之后：总线是新增的旁路，它出问题绝不能拖累发布中心那条 SSE。
    if (envelope.type === 'release.status') {
      this.publishLifecycle(envelope.payload.run);
    }
    return envelope;
  }

  /**
   * 把发布状态投影到 cds-events-bus。
   *
   * 去重是必需的、不是优化：步骤推进（patchProgress）刻意复用 release.status 事件，
   * 一次发布会在**同一个 status 上**连发好几条。不去重的话跑到第 3/5 步就已经外发了
   * 三条「发布开始」。
   *
   * data.projectId 必须带：GET /api/cds-events 对 project-scoped key 只放行
   * data.projectId 命中自己项目的事件（routes/cds-events.ts 的 envelopeAllowed）。
   * 漏掉它不会报错，只会让项目 key 一条发布事件都收不到 —— 静默失效。
   */
  private publishLifecycle(run: ReleaseRun): void {
    try {
      const type = releaseEventTypeForStatus(run.status);
      if (!type) return;
      if (this.lastLifecycle.get(run.releaseId) === type) return;
      this.lastLifecycle.set(run.releaseId, type);
      if (this.lastLifecycle.size > MAX_TRACKED_RUNS) {
        const oldest = this.lastLifecycle.keys().next();
        if (!oldest.done) this.lastLifecycle.delete(oldest.value);
      }
      const data: ReleaseLifecycleEventData = {
        releaseId: run.releaseId,
        projectId: run.projectId,
        targetId: run.targetId,
        branchId: run.branchId,
        commitSha: run.commitSha,
        status: run.status,
        startedAt: run.startedAt,
        ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
        ...(run.operator ? { operator: run.operator } : {}),
        ...(run.rollbackOf ? { rollbackOf: run.rollbackOf } : {}),
        ...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
        ...(run.failure ? { failure: run.failure } : {}),
      };
      cdsEventsBus.publish(type, data);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[release-events] cds-events-bus publish failed:', (err as Error).message);
    }
  }

  /** 仅供测试：清空去重台账，避免用例之间因复用 releaseId 互相影响（bus 是模块单例）。 */
  resetLifecycleDedupeForTest(): void {
    this.lastLifecycle.clear();
  }
}

export const releaseEvents = new ReleaseEventBus();
