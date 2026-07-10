import crypto from 'node:crypto';
import type {
  DeploymentFailure,
  DeploymentRun,
  DeploymentRunEvent,
  DeploymentRunStatus,
  DeploymentRunTrigger,
} from '../types.js';
import type { StateService } from './state.js';

const TERMINAL_STATUSES = new Set<DeploymentRunStatus>(['running', 'failed', 'cancelled']);

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

  constructor(
    private readonly stateService: StateService,
    options: DeploymentRunServiceOptions = {},
  ) {
    this.now = options.now || (() => new Date());
    this.idFactory = options.idFactory || (() => `dr_${crypto.randomBytes(12).toString('hex')}`);
    this.maxEvents = Math.max(1, options.maxEvents || 500);
  }

  begin(input: BeginDeploymentRunInput): DeploymentRun {
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
    return this.stateService.addDeploymentRun(run);
  }

  get(id: string): DeploymentRun | undefined {
    return this.stateService.getDeploymentRun(id);
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

  transition(
    id: string,
    nextStatus: DeploymentRunStatus,
    input: {
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
    },
  ): DeploymentRun {
    return this.stateService.updateDeploymentRun(id, (run) => {
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
      if (TERMINAL_STATUSES.has(nextStatus)) run.finishedAt = at;
      this.appendEvent(run, {
        at,
        phase: input.phase,
        level: input.level || (nextStatus === 'failed' ? 'error' : 'info'),
        status: nextStatus,
        message: input.message,
        detail: input.detail,
        evidenceRefs: input.evidenceRefs,
      });
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
