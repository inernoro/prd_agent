import { randomUUID } from 'node:crypto';
import type { ServerEventLogSink } from './server-event-log-store.js';

export type BranchOperationKind =
  | 'deploy'
  | 'deploy-profile'
  | 'force-rebuild'
  | 'stop'
  | 'delete'
  | 'cleanup-damaged'
  | 'cleanup-orphans'
  | 'factory-reset'
  | 'scheduler-cooling'
  | 'auto-lifecycle-redeploy'
  | 'janitor-remove';

export type BranchOperationTrigger = 'manual' | 'webhook' | 'auto-lifecycle' | 'scheduler' | 'janitor' | 'system';

export interface BranchOperationRequest {
  branchId: string;
  projectId?: string | null;
  profileId?: string | null;
  kind: BranchOperationKind;
  trigger: BranchOperationTrigger;
  actor?: string | null;
  requestId?: string | null;
  commitSha?: string | null;
  source?: string | null;
  reason?: string | null;
}

export interface BranchOperationLease {
  operationId: string;
  branchId: string;
  generation: number;
  request: BranchOperationRequest;
  startedAt: string;
  isCurrent(): boolean;
  assertCurrent(step?: string): void;
}

export interface BranchOperationDecision {
  status: 'started' | 'merged' | 'rejected';
  operationId: string;
  generation: number;
  reason?: string;
  activeOperationId?: string;
  activeKind?: BranchOperationKind;
  pendingCommitSha?: string | null;
  lease?: BranchOperationLease;
}

interface ActiveOperation {
  operationId: string;
  branchId: string;
  generation: number;
  request: BranchOperationRequest;
  startedAt: string;
  cancelled: boolean;
  cancelReason?: string;
}

export interface PendingWebhookDeploy {
  operationId: string;
  branchId: string;
  generation: number;
  request: BranchOperationRequest;
  mergedCount: number;
  updatedAt: string;
}

export class BranchOperationSupersededError extends Error {
  constructor(
    readonly operationId: string,
    readonly branchId: string,
    step?: string,
  ) {
    super(`Branch operation ${operationId} for ${branchId} is no longer current${step ? ` at ${step}` : ''}`);
    this.name = 'BranchOperationSupersededError';
  }
}

const TERMINAL_KINDS = new Set<BranchOperationKind>([
  'delete',
  'cleanup-orphans',
  'factory-reset',
  'janitor-remove',
]);

function priorityOf(req: BranchOperationRequest): number {
  if (req.trigger === 'manual' && TERMINAL_KINDS.has(req.kind)) return 100;
  if (req.trigger === 'manual' && req.kind === 'stop') return 95;
  if (req.trigger === 'webhook' && req.kind === 'delete') return 90;
  if (req.trigger === 'manual' && (req.kind === 'force-rebuild' || req.kind === 'deploy' || req.kind === 'deploy-profile')) return 80;
  if (req.kind === 'cleanup-damaged') return 45;
  if (req.trigger === 'webhook' && (req.kind === 'deploy' || req.kind === 'deploy-profile')) return 50;
  if (req.trigger === 'auto-lifecycle') return 40;
  if (req.trigger === 'scheduler') return 30;
  if (req.trigger === 'janitor') return 25;
  return 10;
}

function isWebhookDeploy(req: BranchOperationRequest): boolean {
  return req.trigger === 'webhook' && (req.kind === 'deploy' || req.kind === 'deploy-profile');
}

function nowIso(): string {
  return new Date().toISOString();
}

export class BranchOperationCoordinator {
  private readonly active = new Map<string, ActiveOperation>();
  private readonly pendingWebhookDeploys = new Map<string, PendingWebhookDeploy>();
  private generations = new Map<string, number>();

  constructor(private readonly events?: ServerEventLogSink | null) {}

  begin(request: BranchOperationRequest): BranchOperationDecision {
    const branchId = request.branchId;
    const active = this.active.get(branchId);
    if (!active) return this.start(request);

    if (isWebhookDeploy(request)) {
      const existing = this.pendingWebhookDeploys.get(branchId);
      const generation = this.nextGeneration(branchId);
      const operationId = existing?.operationId || this.createOperationId();
      this.pendingWebhookDeploys.set(branchId, {
        operationId,
        branchId,
        generation,
        request,
        mergedCount: (existing?.mergedCount || 0) + 1,
        updatedAt: nowIso(),
      });
      this.record('branch.operation.merged', request, operationId, generation, 'info', {
        activeOperationId: active.operationId,
        activeKind: active.request.kind,
        mergedCount: (existing?.mergedCount || 0) + 1,
        commitSha: request.commitSha || null,
      });
      return {
        status: 'merged',
        operationId,
        generation,
        activeOperationId: active.operationId,
        activeKind: active.request.kind,
        pendingCommitSha: request.commitSha || null,
        reason: 'webhook deploy merged into latest pending operation',
      };
    }

    const incomingPriority = priorityOf(request);
    const activePriority = priorityOf(active.request);
    if (incomingPriority > activePriority) {
      active.cancelled = true;
      active.cancelReason = `superseded by ${request.kind}`;
      this.record('branch.operation.cancelled', active.request, active.operationId, active.generation, 'warn', {
        reason: active.cancelReason,
        supersededBy: request.kind,
        supersededByTrigger: request.trigger,
      });
      if (TERMINAL_KINDS.has(request.kind) || request.kind === 'stop') {
        this.pendingWebhookDeploys.delete(branchId);
      }
      return this.start(request);
    }

    this.record('branch.operation.rejected', request, this.createOperationId(), this.currentGeneration(branchId), 'warn', {
      activeOperationId: active.operationId,
      activeKind: active.request.kind,
      activeTrigger: active.request.trigger,
      reason: 'branch operation already running',
    });
    return {
      status: 'rejected',
      operationId: active.operationId,
      generation: active.generation,
      activeOperationId: active.operationId,
      activeKind: active.request.kind,
      reason: 'branch operation already running',
    };
  }

  complete(lease: BranchOperationLease, status: 'completed' | 'failed' | 'cancelled', error?: string): PendingWebhookDeploy | null {
    const active = this.active.get(lease.branchId);
    if (active?.operationId === lease.operationId) {
      this.active.delete(lease.branchId);
    }
    this.record(`branch.operation.${status}`, lease.request, lease.operationId, lease.generation, status === 'failed' ? 'error' : status === 'cancelled' ? 'warn' : 'info', {
      error: error || null,
      cancelled: active?.cancelled || false,
      cancelReason: active?.cancelReason || null,
    });
    const pending = this.pendingWebhookDeploys.get(lease.branchId) || null;
    if (pending) this.pendingWebhookDeploys.delete(lease.branchId);
    return pending;
  }

  cancelBranch(branchId: string, reason: string): void {
    const active = this.active.get(branchId);
    if (active) {
      active.cancelled = true;
      active.cancelReason = reason;
      this.record('branch.operation.cancelled', active.request, active.operationId, active.generation, 'warn', { reason });
    }
    const pending = this.pendingWebhookDeploys.get(branchId);
    if (pending) {
      this.pendingWebhookDeploys.delete(branchId);
      this.record('branch.operation.cancelled', pending.request, pending.operationId, pending.generation, 'warn', { reason, pending: true });
    }
  }

  isCurrent(branchId: string, operationId: string, generation: number): boolean {
    const active = this.active.get(branchId);
    return Boolean(active && active.operationId === operationId && active.generation === generation && !active.cancelled);
  }

  getActive(branchId: string): ActiveOperation | undefined {
    return this.active.get(branchId);
  }

  getPendingWebhookDeploy(branchId: string): PendingWebhookDeploy | undefined {
    return this.pendingWebhookDeploys.get(branchId);
  }

  clearForTest(): void {
    this.active.clear();
    this.pendingWebhookDeploys.clear();
    this.generations.clear();
  }

  private start(request: BranchOperationRequest): BranchOperationDecision {
    const branchId = request.branchId;
    const generation = this.nextGeneration(branchId);
    const operationId = this.createOperationId();
    const active: ActiveOperation = {
      operationId,
      branchId,
      generation,
      request,
      startedAt: nowIso(),
      cancelled: false,
    };
    this.active.set(branchId, active);
    const lease: BranchOperationLease = {
      operationId,
      branchId,
      generation,
      request,
      startedAt: active.startedAt,
      isCurrent: () => this.isCurrent(branchId, operationId, generation),
      assertCurrent: (step?: string) => {
        if (!this.isCurrent(branchId, operationId, generation)) {
          throw new BranchOperationSupersededError(operationId, branchId, step);
        }
      },
    };
    this.record('branch.operation.started', request, operationId, generation, 'info');
    return { status: 'started', operationId, generation, lease };
  }

  private nextGeneration(branchId: string): number {
    const next = (this.generations.get(branchId) || 0) + 1;
    this.generations.set(branchId, next);
    return next;
  }

  private currentGeneration(branchId: string): number {
    return this.generations.get(branchId) || 0;
  }

  private createOperationId(): string {
    return `op_${randomUUID().slice(0, 12)}`;
  }

  private record(
    action: string,
    request: BranchOperationRequest,
    operationId: string,
    generation: number,
    severity: 'info' | 'warn' | 'error',
    details: Record<string, unknown> = {},
  ): void {
    this.events?.record({
      category: 'system',
      severity,
      source: 'branch-operation-coordinator',
      action,
      message: `${action}: ${request.branchId} ${request.kind}`,
      projectId: request.projectId || null,
      branchId: request.branchId,
      profileId: request.profileId || null,
      requestId: request.requestId || null,
      details: {
        operationId,
        generation,
        kind: request.kind,
        trigger: request.trigger,
        actor: request.actor || null,
        commitSha: request.commitSha || null,
        source: request.source || null,
        reason: request.reason || null,
        priority: priorityOf(request),
        ...details,
      },
    });
  }
}
