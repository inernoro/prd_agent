import { sanitizeCiTiming, type CiTimingTarget, type CiTimingRecord } from './deployment-ci-timing.js';
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
import { BranchOperationSupersededError, cancelsBranchDeployments, type BranchOperationCoordinator, type BranchOperationLease } from './branch-operation-coordinator.js';
import { captureDeploymentIntent, readDeploymentIntent, type DeploymentExecutionInput } from './deployment-intent.js';
import { isLocallyOwned } from './executor-ownership.js';

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
  operationGeneration?: number;
  operationAdmissionGeneration?: number;
  executionInput?: DeploymentExecutionInput;
  profileId?: string;
  initialStatus?: 'pending' | 'queued';
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
  /** 仅认可持有原代次资格、未超过截止时间的实际阶段待办，不续写假心跳。 */
  isExecutionWaiting?: (run: DeploymentRun, now: Date) => boolean;
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
  private readonly isExecutionWaiting: NonNullable<DeploymentRunServiceOptions['isExecutionWaiting']>;
  private readonly acceptanceWrites = new Map<string, Promise<void>>();
  private readonly boundCoordinators = new Set<BranchOperationCoordinator>();

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
    this.isExecutionWaiting = options.isExecutionWaiting || (() => false);
  }

  async begin(input: BeginDeploymentRunInput): Promise<DeploymentRun> {
    const at = this.nowIso();
    const phase = input.phase || 'accepted';
    const run: DeploymentRun = {
      id: this.idFactory(),
      projectId: input.projectId,
      branchId: input.branchId,
      trigger: input.trigger,
      status: input.initialStatus || 'pending',
      phase,
      seq: 1,
      firstEventSeq: 1,
      commitSha: input.commitSha,
      operationId: input.operationId,
      operationGeneration: input.operationGeneration,
      operationAdmissionGeneration: input.operationAdmissionGeneration ?? input.operationGeneration,
      profileId: input.profileId,
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
        status: input.initialStatus || 'pending',
        message: this.normalizeMessage(input.message || '部署请求已受理'),
      }],
    };
    const persisted = this.stateService.addDeploymentRun(run, input.executionInput ? captureDeploymentIntent(run, input.executionInput) : undefined);
    const write = this.stateService.flushDeploymentRun(persisted.id);
    this.acceptanceWrites.set(persisted.id, write);
    try { await write; return persisted; }
    finally { this.acceptanceWrites.delete(persisted.id); }
  }

  getForOperation(operationId: string, generation: number): DeploymentRun | undefined {
    return this.stateService.getDeploymentRunForOperation(operationId, generation);
  }

  /** 只有本节点归属和原操作作用域均明确时，才可豁免等待或撤销实际执行资格。 */
  private hasLocalExecution(run: DeploymentRun): boolean {
    const branch = this.stateService.getBranch(run.branchId);
    return !!branch && (branch.projectId || 'default') === run.projectId
      && isLocallyOwned(run.executorId) && isLocallyOwned(branch.executorId)
      && !!run.operationId && run.operationGeneration !== undefined && [...this.boundCoordinators].some(coordinator =>
      coordinator.getActiveOperations(run.branchId).some(active => active.operationId === run.operationId
        && active.generation === run.operationGeneration && !active.cancelled
        && active.request.branchId === run.branchId && (active.request.projectId || 'default') === run.projectId
        && (active.request.profileId || undefined) === run.profileId));
  }

  async waitForAcceptance(id: string): Promise<void> {
    await this.acceptanceWrites.get(id);
  }

  async flush(): Promise<void> {
    await this.stateService.flush();
  }

  /** 终止操作先确认覆盖范围内的取消记录，成功后才可停止或删除实际实例。 */
  async persistBranchCancellation(projectId: string, branchId: string, lease?: BranchOperationLease | null): Promise<void> {
    if (lease && (!cancelsBranchDeployments(lease.request.kind) || lease.branchId !== branchId || (lease.request.projectId || 'default') !== projectId)) {
      throw new Error('Durable cancellation requires the current terminating owner');
    }
    lease?.assertCurrent('before durable deployment cancellation');
    const profileId = lease?.request.profileId;
    const covered = this.list({ projectId, branchId }).filter((run) =>
      (!profileId || !run.profileId || run.profileId === profileId)
      && (!lease || run.operationGeneration === undefined || run.operationGeneration < lease.generation));
    for (const run of covered) {
      if (!TERMINAL_STATUSES.has(run.status)) this.cancel(run.id, '终止操作取消原部署，旧待办不再恢复', 'operation-stop');
    }
    await Promise.all(covered.map((run) => this.stateService.flushDeploymentRun(run.id)));
    lease?.assertCurrent('after durable deployment cancellation');
  }

  /** 领取必须先可靠迁移到 preparing，避免已执行任务仍以 queued 落盘而重复恢复。 */
  async claimQueued(id: string): Promise<void> {
    const run = this.get(id);
    if (!run || run.status !== 'queued') return;
    this.transition(id, 'preparing', { phase: 'admission-replay', message: '排队目标已领取，正在保存执行身份' });
    const write = this.stateService.flushDeploymentRun(id);
    this.acceptanceWrites.set(id, write);
    try { await write; } finally { if (this.acceptanceWrites.get(id) === write) this.acceptanceWrites.delete(id); }
  }

  /** Boot awaits the journal ACK before HTTP admission, watchers or in-memory replay can begin. */
  async restoreQueuedDurably(coordinator: BranchOperationCoordinator): Promise<DeploymentRun[]> {
    const release = coordinator.holdRecovery();
    try {
      const intents = this.stateService.getDeploymentIntents().sort((a, b) => a.admissionGeneration - b.admissionGeneration);
      for (const intent of intents) {
        const run = this.get(intent.runId);
        if (!run || run.status !== 'queued') continue;
        try {
          const branch = this.stateService.getBranch(run.branchId);
          const project = this.stateService.getProject(run.projectId);
          const identity = () => JSON.stringify([branch?.id, branch?.projectId, branch?.branch, branch?.worktreePath,
            branch?.createdAt, run.seq, run.startedAt, run.updatedAt, run.operationId, run.operationGeneration]);
          const frozenIdentity = identity();
          const current = () => {
            if (identity() !== frozenIdentity || !branch || !project || this.stateService.getBranch(run.branchId) !== branch
              || this.stateService.getProject(run.projectId) !== project || (branch.projectId || 'default') !== run.projectId
              || this.get(run.id) !== run || run.status !== 'queued'
              || this.stateService.getDeploymentIntents().find(row => row.runId === run.id)?.inputDigest !== intent.inputDigest)
              throw new Error('Deployment recovery identity changed');
            readDeploymentIntent(run, intent);
            if (this.list().some(candidate => candidate.branchId === run.branchId && candidate.projectId === run.projectId
              && candidate.operationAdmissionGeneration !== undefined && candidate.operationAdmissionGeneration > intent.admissionGeneration
              && (!candidate.profileId || candidate.profileId === run.profileId))) throw new Error('Deployment recovery superseded');
          };
          current();
          await coordinator.preparePendingRestoration({ operationId: intent.operationId, generation: intent.generation,
            branchId: run.branchId, request: intent.request, mergedCount: 1, updatedAt: run.startedAt }, current);
        } catch {
          // The original durable record remains authoritative; synchronous reconciliation explains invalid inputs.
        }
      }
      return this.restoreQueued(coordinator);
    } finally { release(); }
  }

  restoreQueued(coordinator: BranchOperationCoordinator): DeploymentRun[] {
    this.bindOperationCoordinator(coordinator);
    const runs = this.list();
    for (const run of runs) if (run.operationGeneration !== undefined) coordinator.seedGeneration(run.branchId, run.operationGeneration);
    const restored: DeploymentRun[] = [];
    const intents = this.stateService.getDeploymentIntents().sort((a, b) => a.admissionGeneration - b.admissionGeneration);
    for (const intent of intents) {
      const run = this.get(intent.runId);
      if (!run || run.status !== 'queued') continue;
      try {
        const branch = this.stateService.getBranch(run.branchId);
        if (!branch || (branch.projectId || 'default') !== run.projectId || !this.stateService.getProject(run.projectId)) throw new Error('Deployment intent owner missing');
        const input = readDeploymentIntent(run, intent);
        // 最新覆盖范围的已受理结果压住旧排队；重建续接使用原受理顺序，不能取消其后意图。
        const newer = runs.some((candidate) => candidate.branchId === run.branchId && candidate.projectId === run.projectId
          && candidate.operationAdmissionGeneration !== undefined && candidate.operationAdmissionGeneration > intent.admissionGeneration
          && (!candidate.profileId || candidate.profileId === run.profileId));
        if (newer) { this.cancel(run.id, '已有较新的覆盖范围部署，旧待办不再恢复', 'superseded'); continue; }
        const restoredPending = coordinator.restorePendingDeployment({ operationId: intent.operationId, generation: intent.generation, branchId: run.branchId,
          request: intent.request, mergedCount: 1, updatedAt: run.startedAt }, input);
        if (restoredPending) restored.push(run);
      } catch {
        this.fail(run.id, { code: 'cds.intent.unrecoverable', owner: 'cds', retryable: true,
          summary: '原排队部署的配置或身份无法可靠恢复，请重新部署', phase: 'recovery', evidenceRefs: [], suggestedAction: '重新部署当前目标' });
      }
    }
    return restored;
  }

  bindOperationCoordinator(coordinator: BranchOperationCoordinator): void {
    if (this.boundCoordinators.has(coordinator)) return;
    this.boundCoordinators.add(coordinator);
    coordinator.onOperationEnded((operationId, generation, status) => {
      const run = this.getForOperation(operationId, generation);
      if (!run || TERMINAL_STATUSES.has(run.status)) return;
      if (status === 'cancelled') this.cancel(run.id, '部署操作被更新的请求或终止操作取代', 'superseded');
      else this.fail(run.id, { code: `cds.operation.${status}`, owner: 'cds', retryable: true,
        summary: '部署操作未能继续执行，请查看最新部署结果', phase: 'operation-ended', evidenceRefs: [] });
    });
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
        || !(draft.status === 'pending' || (request.pendingReplay?.operationId === origin.operationId
          && request.pendingReplay.generation === origin.generation && draft.operationGeneration === lease.generation
          && draft.status === 'preparing' && draft.phase === 'admission-replay'))
        || (draft.operationId && draft.operationId !== lease.operationId)
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
    const offset = () => {
      const sample = this.timingClock(), base = this.timingBase;
      if (typeof sample !== 'number' || typeof base !== 'number' || !Number.isFinite(sample) || !Number.isFinite(base)) return null;
      const value = sample - base;
      return Number.isFinite(value) && value >= 0 ? value : null;
    };
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

  createCiTimingPublisher(id: string, operationId: string, target: CiTimingTarget, isCurrent: () => boolean): (value: CiTimingRecord | null) => void {
    const original = this.get(id), frozen = { ...target };
    const scope = original && { projectId: original.projectId, branchId: original.branchId };
    const boundAtStart = original?.operationId === operationId && original.commitSha === frozen.headSha && !TERMINAL_STATUSES.has(original.status);
    let published = false;
    return value => {
      if (published || !value) return;
      try {
        if (!boundAtStart || !original || this.get(id) !== original || original.id !== id || original.operationId !== operationId
          || !/^op_[a-zA-Z0-9_.-]{1,120}$/.test(operationId) || original.projectId !== scope?.projectId || original.branchId !== scope.branchId
          || original.commitSha !== frozen.headSha || TERMINAL_STATUSES.has(original.status) || !isCurrent()) return;
        const safe = sanitizeCiTiming(value, frozen); if (!safe) return;
        this.stateService.updateDeploymentRun(id, run => { if (!run.ciTiming) run.ciTiming = safe; }); published = true;
      } catch { /* Best effort immutable provider facts cannot change deploy result. */ }
    };
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
      if (run.status === 'queued' && run.operationId && run.operationGeneration !== undefined
        && [...this.boundCoordinators].some((coordinator) => coordinator.hasWaitingOperation(run.operationId!, run.operationGeneration!))) continue;
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
      // 排队尚未进入执行，不以执行心跳判超时；必须仍有协调器中的实际待办。
      if (run.status === 'queued' && run.operationId && run.operationGeneration !== undefined
        && [...this.boundCoordinators].some((coordinator) => coordinator.hasWaitingOperation(run.operationId!, run.operationGeneration!))) continue;
      // 等待查询可收敛过期重放凭据，观察器已更新终态时不得再次迁移。
      if (TERMINAL_STATUSES.has(run.status)) continue;
      const heartbeat = Date.parse(run.heartbeatAt || run.updatedAt || run.startedAt);
      if (!Number.isFinite(heartbeat) || now.getTime() - heartbeat < staleAfterMs) continue;
      const localExecution = this.hasLocalExecution(run);
      if (localExecution && this.isExecutionWaiting(run, now)) continue;
      reconciled.push(this.fail(run.id, {
        code: 'cds.run.interrupted',
        owner: 'cds',
        retryable: true,
        summary: '部署执行心跳已过期，CDS 已将本次运行收敛为失败',
        phase: run.phase,
        evidenceRefs: [],
        suggestedAction: '确认执行器与容器状态后重新部署',
      }));
      if (localExecution && run.operationId && run.operationGeneration !== undefined) {
        for (const coordinator of this.boundCoordinators) coordinator.revokeInterrupted({
          operationId: run.operationId, generation: run.operationGeneration,
          branchId: run.branchId, projectId: run.projectId, profileId: run.profileId,
        });
      }
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
