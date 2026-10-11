import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isTimingBoundary, TIMING_INTERVAL_LIMIT, type DeploymentTimingObserver, type DeploymentTimingInterval } from './deployment-stage-timing.js';
import type {
  DeploymentFailure,
  DeploymentRun,
  DeploymentRunEvent,
  DeploymentRunStatus,
  DeploymentRunTrigger,
} from '../types.js';
import type { StateService } from './state.js';
import { BranchOperationSupersededError, type BranchOperationLease } from './branch-operation-coordinator.js';

/**
 * 部署 run 的终态。导出是为了让「这条 run 还在跑吗」只有一个判据——
 * 2026-09-08 并入在途部署时要在路由层问同一个问题，抄第二份必然漂移。
 */
export const DEPLOYMENT_RUN_TERMINAL_STATUSES: ReadonlySet<DeploymentRunStatus> = new Set<DeploymentRunStatus>(['running', 'failed', 'cancelled']);
const TERMINAL_STATUSES = DEPLOYMENT_RUN_TERMINAL_STATUSES;

const ALLOWED_TRANSITIONS: Record<DeploymentRunStatus, ReadonlySet<DeploymentRunStatus>> = {
  pending: new Set(['queued', 'preparing', 'failed', 'cancelled']),
  queued: new Set(['preparing', 'failed', 'cancelled']),
  preparing: new Set(['building', 'starting', 'failed', 'cancelled']),
  building: new Set(['starting', 'failed', 'cancelled']),
  starting: new Set(['verifying', 'failed', 'cancelled']),
  verifying: new Set(['running', 'failed', 'cancelled']),
  running: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export interface DeploymentRunTransitionInput {
  phase: string;
  message: string;
  level?: DeploymentRunEvent['level'];
  detail?: Record<string, unknown>;
  evidenceRefs?: string[];
  versionId?: string;
  commitSha?: string;
  configHash?: string;
  operationId?: string;
  executorId?: string;
  failure?: DeploymentFailure;
}

export interface BeginDeploymentRunInput {
  projectId: string;
  branchId: string;
  trigger: DeploymentRunTrigger;
  commitSha?: string;
  operationId?: string;
  executorId?: string;
  versionId?: string;
  configHash?: string;
  phase?: string;
  message?: string;
}

export interface DeploymentRunServiceOptions {
  now?: () => Date;
  idFactory?: () => string;
  maxEvents?: number;
  pendingOriginTimeoutMs?: number;
  timingClock?: () => number;
}

export interface DeploymentRunEventsAfter {
  run: DeploymentRun;
  events: DeploymentRunEvent[];
  truncated: boolean;
}

export class DeploymentRunService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly maxEvents: number;
  private readonly pendingOriginTimeoutMs: number;
  private readonly timingClock: () => number;
  private readonly timingBase: number;
  private readonly timingEpochId = `pt_${crypto.randomBytes(12).toString('hex')}`;

  constructor(
    private readonly stateService: StateService,
    options: DeploymentRunServiceOptions = {},
  ) {
    this.now = options.now || (() => new Date());
    this.idFactory = options.idFactory || (() => `dr_${crypto.randomBytes(12).toString('hex')}`);
    this.maxEvents = Math.max(1, options.maxEvents || 500);
    this.timingClock = options.timingClock || (() => performance.now());
    this.timingBase = this.timingClock();
    this.pendingOriginTimeoutMs = Math.min(5000, Math.max(1, options.pendingOriginTimeoutMs || 5000));
  }

  async begin(input: BeginDeploymentRunInput): Promise<DeploymentRun> {
    const at = this.nowIso();
    const phase = input.phase || 'accepted';
    const run: DeploymentRun = {
      id: this.idFactory(),
      projectId: input.projectId,
      branchId: input.branchId,
      trigger: input.trigger,
      status: 'pending',
      phase,
      seq: 1,
      firstEventSeq: 1,
      commitSha: input.commitSha,
      operationId: input.operationId,
      executorId: input.executorId,
      versionId: input.versionId,
      configHash: input.configHash,
      startedAt: at,
      updatedAt: at,
      heartbeatAt: at,
      events: [{
        seq: 1,
        at,
        phase,
        level: 'info',
        status: 'pending',
        message: this.normalizeMessage(input.message || '部署请求已受理'),
      }],
    };
    const persisted = this.stateService.addDeploymentRun(run);
    await this.stateService.flush();
    return persisted;
  }

  get(id: string): DeploymentRun | undefined {
    return this.stateService.getDeploymentRun(id);
  }

  async bindPendingOrigin(id: string, lease: BranchOperationLease, assertCurrent: () => void): Promise<DeploymentRun> {
    const request = lease.request;
    const origin: NonNullable<DeploymentRun['pendingOrigin']> = {
      version: 1, operationId: request.pendingOperationId || '',
      generation: request.pendingGeneration || 0, profileId: request.profileId || null,
    };
    if (!/^op_[a-zA-Z0-9_.-]{1,120}$/.test(origin.operationId) || !Number.isSafeInteger(origin.generation) || origin.generation < 1
      || !['deploy', 'deploy-profile'].includes(request.kind)
      || (request.kind === 'deploy-profile' ? !origin.profileId : Boolean(origin.profileId))) throw new Error('pending_origin_invalid');
    const check = () => { lease.assertCurrent('pending-origin'); assertCurrent(); };
    check();
    return this.stateService.updateDeploymentRunDurably(id, draft => {
      if (draft.projectId !== (request.projectId || 'default') || draft.branchId !== lease.branchId || request.branchId !== lease.branchId
        || draft.status !== 'pending' || (draft.operationId && draft.operationId !== lease.operationId)
        || (draft.pendingOrigin && JSON.stringify(draft.pendingOrigin) !== JSON.stringify(origin))) throw new Error('pending_origin_scope');
      draft.pendingOrigin = origin; draft.operationId = lease.operationId;
    }, async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => this.stateService.flush()),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('pending_origin_unavailable')), this.pendingOriginTimeoutMs); }),
          new Promise<never>((_, reject) => {
            abort = () => reject(new BranchOperationSupersededError(lease.operationId, lease.branchId, 'pending-origin'));
            if (lease.signal?.aborted) abort(); else lease.signal?.addEventListener('abort', abort, { once: true });
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        if (abort) lease.signal?.removeEventListener('abort', abort);
      }
    }, check);
  }

  createTimingObserver(id: string, operationId: string, isCurrent: () => boolean): DeploymentTimingObserver {
    const original = this.get(id);
    const originScope = original && { projectId: original.projectId, branchId: original.branchId, operationId: original.operationId };
    const active = () => {
      try { return Boolean(original && this.get(id) === original && original.id === id && original.projectId === originScope?.projectId && original.branchId === originScope.branchId && original.operationId === originScope.operationId && (!original.operationId || original.operationId === operationId)
        && !TERMINAL_STATUSES.has(original.status) && isCurrent()); } catch { return false; }
    };
    const offset = () => { const value = this.timingClock() - this.timingBase; return Number.isFinite(value) && value >= 0 ? value : null; };
    const observer: DeploymentTimingObserver = {
      begin: (stage, boundary, profileId = null) => {
        const nothing = () => {};
        if (!active() || !/^op_[a-zA-Z0-9_.-]{1,120}$/.test(operationId) || !isTimingBoundary(stage, boundary)
          || (profileId !== null && (typeof profileId !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(profileId)))) return nothing;
        let interval: DeploymentTimingInterval | undefined;
        try {
          this.stateService.updateDeploymentRun(id, run => {
            if (run.timing && (run.timing.version !== 1 || run.timing.operationId !== operationId || run.timing.epochId !== this.timingEpochId || !Array.isArray(run.timing.intervals))) return;
            const timing = run.timing ||= { version: 1, operationId, epochId: this.timingEpochId, intervals: [], truncated: false };
            if (timing.intervals.length >= TIMING_INTERVAL_LIMIT) { timing.truncated = true; return; }
            interval = { id: `ti_${crypto.randomBytes(12).toString('hex')}`, stage, boundary, profileId, commitShaAtStart: /^[a-f0-9]{40}$/i.test(run.commitSha || '') ? run.commitSha! : null,
              startedAt: this.nowIso(), startOffsetMs: offset(), durationMs: null, outcome: 'open' };
            timing.intervals.push(interval);
            this.appendEvent(run, { phase: 'timing', level: 'info', status: run.status, message: '部署阶段开始', detail: { stage, boundary, profileId } });
          });
        } catch { return nothing; }
        if (!interval) return nothing;
        let finished = false; const started = { ...interval };
        return outcome => {
          if (finished) return; finished = true;
          if (!active() || !['completed', 'failed', 'cancelled'].includes(outcome)) return;
          try {
            this.stateService.updateDeploymentRun(id, run => {
              if (run.timing?.version !== 1 || run.timing.epochId !== this.timingEpochId || run.timing.operationId !== operationId
                || !Array.isArray(run.timing.intervals)) return;
              // Durable publication replaces nested objects. Match the original measurement,
              // not its old object reference, without adopting altered start facts.
              const matches = run.timing.intervals.slice(0, TIMING_INTERVAL_LIMIT).filter(item => item?.id === started.id);
              const ownInterval = matches.length === 1 ? matches[0] : undefined;
              if (!ownInterval || ownInterval.outcome !== 'open' || ownInterval.stage !== started.stage || ownInterval.boundary !== started.boundary
                || ownInterval.profileId !== started.profileId || ownInterval.commitShaAtStart !== started.commitShaAtStart
                || ownInterval.startedAt !== started.startedAt || ownInterval.startOffsetMs !== started.startOffsetMs) return;
              const end = offset(), start = ownInterval.startOffsetMs;
              ownInterval.endOffsetMs = end; ownInterval.endedAt = this.nowIso(); ownInterval.outcome = outcome;
              ownInterval.durationMs = start !== null && end !== null && end >= start ? end - start : null;
              this.appendEvent(run, { phase: 'timing', level: 'info', status: run.status, message: '部署阶段结束', detail: { stage, boundary, profileId, outcome } });
            });
          } catch { /* Missing measurement cannot change the original work result. */ }
        };
      },
      measure: (stage, boundary, profileId, work, successful) => {
        const finish = observer.begin(stage, boundary, profileId);
        try { return work().then(value => {
          try { finish(successful && !successful(value) ? 'failed' : 'completed'); } catch { /* Observer cannot replace work result. */ }
          return value;
        }, error => {
          let cancelled = false; try { cancelled = !isCurrent(); } catch { cancelled = true; }
          finish(cancelled ? 'cancelled' : 'failed'); throw error;
        }); }
        catch (error) { finish('failed'); throw error; }
      },
    };
    return observer;
  }

  list(filters: { projectId?: string; branchId?: string; status?: DeploymentRunStatus } = {}): DeploymentRun[] {
    return this.stateService.getDeploymentRuns(filters);
  }

  append(
    id: string,
    event: Omit<DeploymentRunEvent, 'seq' | 'at'> & { at?: string },
  ): DeploymentRun {
    return this.stateService.updateDeploymentRun(id, (run) => {
      this.assertActive(run);
      this.appendEvent(run, event);
    });
  }

  transition(id: string, nextStatus: DeploymentRunStatus, input: DeploymentRunTransitionInput): DeploymentRun {
    return this.stateService.updateDeploymentRun(id, run => this.applyTransition(run, nextStatus, input));
  }

  async completeDurably(id: string, input: DeploymentRunTransitionInput,
    flush: () => Promise<void>, assertCurrent: () => void): Promise<DeploymentRun> {
    return this.stateService.updateDeploymentRunDurably(id,
      draft => this.applyTransition(draft, 'running', input), flush, assertCurrent);
  }

  private applyTransition(run: DeploymentRun, nextStatus: DeploymentRunStatus, input: DeploymentRunTransitionInput): void {
    this.assertTransition(run, nextStatus);
    const at = this.nowIso();
    run.status = nextStatus;
    run.phase = input.phase;
    run.updatedAt = at;
    run.heartbeatAt = at;
    if (input.versionId !== undefined) run.versionId = input.versionId;
    if (input.commitSha !== undefined) run.commitSha = input.commitSha;
    if (input.configHash !== undefined) run.configHash = input.configHash;
    if (input.operationId !== undefined) run.operationId = input.operationId;
    if (input.executorId !== undefined) run.executorId = input.executorId;
    if (input.failure !== undefined) run.failure = input.failure;
    if (TERMINAL_STATUSES.has(nextStatus)) {
      run.finishedAt = at;
      for (const interval of Array.isArray(run.timing?.intervals) ? run.timing.intervals.slice(0, TIMING_INTERVAL_LIMIT) : []) if (interval?.outcome === 'open') {
        interval.outcome = 'unknown'; interval.durationMs = null;
      }
    }
    this.appendEvent(run, {
      at,
      phase: input.phase,
      level: input.level || (nextStatus === 'failed' ? 'error' : 'info'),
      status: nextStatus,
      message: input.message,
      detail: input.detail,
      evidenceRefs: input.evidenceRefs,
    });
  }

  heartbeat(id: string, phase?: string): DeploymentRun {
    return this.stateService.updateDeploymentRun(id, (run) => {
      this.assertActive(run);
      const at = this.nowIso();
      run.heartbeatAt = at;
      run.updatedAt = at;
      if (phase) run.phase = phase;
    });
  }

  attachVersion(id: string, versionId: string, configHash: string): DeploymentRun {
    return this.stateService.updateDeploymentRun(id, (run) => {
      this.assertActive(run);
      run.versionId = versionId;
      run.configHash = configHash;
      run.updatedAt = this.nowIso();
    });
  }

  fail(id: string, failure: DeploymentFailure): DeploymentRun {
    return this.transition(id, 'failed', {
      phase: failure.phase || 'failed',
      message: failure.summary,
      failure,
      evidenceRefs: failure.evidenceRefs,
      level: 'error',
    });
  }

  cancel(id: string, message: string, phase = 'cancelled'): DeploymentRun {
    return this.transition(id, 'cancelled', { phase, message, level: 'warn' });
  }

  getEventsAfter(id: string, afterSeq: number): DeploymentRunEventsAfter {
    const run = this.stateService.getDeploymentRun(id);
    if (!run) throw new Error(`DeploymentRun not found: ${id}`);
    const normalizedAfter = Number.isFinite(afterSeq) ? Math.max(0, Math.floor(afterSeq)) : 0;
    return {
      run,
      events: run.events.filter((event) => event.seq > normalizedAfter),
      truncated: normalizedAfter < run.firstEventSeq - 1,
    };
  }

  /**
   * 启动收尸：心跳早于本进程启动时刻的非终态 run，一定是被上一个进程带走的——
   * 心跳只由本进程写（分支侧部署循环），进程一换，没有任何人会再推它往前走。
   * 周期收割按「心跳停跳 15 分钟」判，重启后前 15 分钟这些 run 会一直挂着 building；
   * 2026-09-16 自检第一轮就抓到七个。这里不看停了多久，只看「是不是上一个进程的」。
   */
  reconcileOrphanedByRestart(processStartedAt: Date): DeploymentRun[] {
    const boundary = processStartedAt.getTime();
    if (!Number.isFinite(boundary)) return [];
    const reconciled: DeploymentRun[] = [];
    for (const run of this.stateService.getDeploymentRuns()) {
      if (TERMINAL_STATUSES.has(run.status)) continue;
      const heartbeat = Date.parse(run.heartbeatAt || run.updatedAt || run.startedAt);
      if (!Number.isFinite(heartbeat) || heartbeat >= boundary) continue;
      reconciled.push(this.fail(run.id, {
        code: 'cds.run.interrupted-by-restart',
        owner: 'cds',
        retryable: true,
        summary: 'CDS 进程重启把这次部署打断了，已收敛为失败；重新部署即可',
        phase: run.phase,
        evidenceRefs: [],
        suggestedAction: '重新部署（push 一次或在分支面板点部署）',
      }));
    }
    return reconciled;
  }

  reconcileInterrupted(now = this.now(), staleAfterMs = 15 * 60 * 1000): DeploymentRun[] {
    const reconciled: DeploymentRun[] = [];
    for (const run of this.stateService.getDeploymentRuns()) {
      if (TERMINAL_STATUSES.has(run.status)) continue;
      const heartbeat = Date.parse(run.heartbeatAt || run.updatedAt || run.startedAt);
      if (!Number.isFinite(heartbeat) || now.getTime() - heartbeat < staleAfterMs) continue;
      reconciled.push(this.fail(run.id, {
        code: 'cds.run.interrupted',
        owner: 'cds',
        retryable: true,
        summary: '部署执行心跳已过期，CDS 已将本次运行收敛为失败',
        phase: run.phase,
        evidenceRefs: [],
        suggestedAction: '确认执行器与容器状态后重新部署',
      }));
    }
    return reconciled;
  }

  private appendEvent(
    run: DeploymentRun,
    event: Omit<DeploymentRunEvent, 'seq' | 'at'> & { at?: string },
  ): void {
    const at = event.at || this.nowIso();
    const seq = run.seq + 1;
    run.seq = seq;
    run.updatedAt = at;
    run.heartbeatAt = at;
    run.events.push({
      ...event,
      seq,
      at,
      message: this.normalizeMessage(event.message),
      evidenceRefs: event.evidenceRefs?.slice(0, 20),
    });
    if (run.events.length > this.maxEvents) {
      run.events = run.events.slice(-this.maxEvents);
    }
    run.firstEventSeq = run.events[0]?.seq || run.seq;
  }

  private assertActive(run: DeploymentRun): void {
    if (TERMINAL_STATUSES.has(run.status)) {
      throw new Error(`DeploymentRun ${run.id} is terminal: ${run.status}`);
    }
  }

  private assertTransition(run: DeploymentRun, nextStatus: DeploymentRunStatus): void {
    this.assertActive(run);
    if (!ALLOWED_TRANSITIONS[run.status].has(nextStatus)) {
      throw new Error(`Invalid DeploymentRun transition: ${run.status} -> ${nextStatus}`);
    }
  }

  private normalizeMessage(message: string): string {
    return String(message || '').slice(0, 4 * 1024);
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}
