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
  | 'auto-restart'
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
  continueWith?: 'deploy' | 'deploy-profile' | null;
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

interface ReservedContinuation {
  operationId: string;
  branchId: string;
  generation: number;
  request: BranchOperationRequest;
  reservedAt: string;
  expiresAt: number;
  continueWith: 'deploy' | 'deploy-profile';
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
  if (req.kind === 'auto-restart') return 35;
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
  private readonly reservedContinuations = new Map<string, ReservedContinuation>();
  private generations = new Map<string, number>();

  constructor(private readonly events?: ServerEventLogSink | null) {}

  begin(request: BranchOperationRequest): BranchOperationDecision {
    const branchId = request.branchId;
    const active = this.findBlockingActive(request);
    if (!active) {
      const reserved = this.getUsableReservedContinuation(branchId, request);
      if (reserved) return this.beginAgainstReservedContinuation(request, reserved);
      return this.start(request);
    }

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
      for (const item of this.findBlockingActives(request)) {
        item.cancelled = true;
        item.cancelReason = `superseded by ${request.kind}`;
        this.record('branch.operation.cancelled', item.request, item.operationId, item.generation, 'warn', {
          reason: item.cancelReason,
          supersededBy: request.kind,
          supersededByTrigger: request.trigger,
        });
      }
      if (TERMINAL_KINDS.has(request.kind) || request.kind === 'stop') {
        this.cancelPendingWebhookDeploy(branchId, `superseded by ${request.kind}`);
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
    const activeEntry = this.findActiveEntryByOperation(lease.operationId);
    const active = activeEntry?.active;
    if (activeEntry && active?.operationId === lease.operationId) {
      this.active.delete(activeEntry.key);
    }
    this.record(`branch.operation.${status}`, lease.request, lease.operationId, lease.generation, status === 'failed' ? 'error' : status === 'cancelled' ? 'warn' : 'info', {
      error: error || null,
      cancelled: active?.cancelled || false,
      cancelReason: active?.cancelReason || null,
    });
    if (
      status === 'completed'
      && lease.request.kind === 'force-rebuild'
      && (lease.request.continueWith === 'deploy' || lease.request.continueWith === 'deploy-profile')
    ) {
      this.reserveContinuation(lease, lease.request.continueWith);
      return null;
    }
    const pending = this.pendingWebhookDeploys.get(lease.branchId) || null;
    if (pending) this.pendingWebhookDeploys.delete(lease.branchId);
    return pending;
  }

  cancelBranch(branchId: string, reason: string): void {
    const activeEntries = [...this.active.entries()].filter(([, active]) => active.branchId === branchId);
    for (const [key, active] of activeEntries) {
      active.cancelled = true;
      active.cancelReason = reason;
      this.record('branch.operation.cancelled', active.request, active.operationId, active.generation, 'warn', { reason });
      this.active.delete(key);
    }
    const pending = this.pendingWebhookDeploys.get(branchId);
    if (pending) {
      this.pendingWebhookDeploys.delete(branchId);
      this.record('branch.operation.cancelled', pending.request, pending.operationId, pending.generation, 'warn', { reason, pending: true });
    }
    const reserved = this.reservedContinuations.get(branchId);
    if (reserved) {
      this.reservedContinuations.delete(branchId);
      this.record('branch.operation.cancelled', reserved.request, reserved.operationId, reserved.generation, 'warn', { reason, reserved: true });
    }
  }

  interruptAll(reason: string, source: string): void {
    for (const active of this.active.values()) {
      this.record('branch.operation.interrupted', active.request, active.operationId, active.generation, 'warn', {
        reason,
        source,
        startedAt: active.startedAt,
        cancelled: active.cancelled,
        cancelReason: active.cancelReason || null,
      });
    }
    for (const pending of this.pendingWebhookDeploys.values()) {
      this.record('branch.operation.interrupted', pending.request, pending.operationId, pending.generation, 'warn', {
        reason,
        source,
        pending: true,
        mergedCount: pending.mergedCount,
        updatedAt: pending.updatedAt,
      });
    }
    for (const reserved of this.reservedContinuations.values()) {
      this.record('branch.operation.interrupted', reserved.request, reserved.operationId, reserved.generation, 'warn', {
        reason,
        source,
        reserved: true,
        reservedAt: reserved.reservedAt,
        continueWith: reserved.continueWith,
      });
    }
  }

  isCurrent(branchId: string, operationId: string, generation: number): boolean {
    const active = [...this.active.values()].find((item) => item.branchId === branchId && item.operationId === operationId);
    return Boolean(active && active.operationId === operationId && active.generation === generation && !active.cancelled);
  }

  getActive(branchId: string, profileId?: string | null): ActiveOperation | undefined {
    if (profileId) {
      return this.active.get(this.profileKey(branchId, profileId));
    }
    return [...this.active.values()].find((active) => active.branchId === branchId);
  }

  getPendingWebhookDeploy(branchId: string): PendingWebhookDeploy | undefined {
    return this.pendingWebhookDeploys.get(branchId);
  }

  clearForTest(): void {
    this.active.clear();
    this.pendingWebhookDeploys.clear();
    this.reservedContinuations.clear();
    this.generations.clear();
  }

  private start(request: BranchOperationRequest, existing?: { operationId: string; generation?: number; continuedFrom?: BranchOperationRequest }): BranchOperationDecision {
    const branchId = request.branchId;
    const key = this.operationKey(request);
    const generation = existing?.generation ?? this.nextGeneration(branchId);
    const operationId = existing?.operationId ?? this.createOperationId();
    const active: ActiveOperation = {
      operationId,
      branchId,
      generation,
      request,
      startedAt: nowIso(),
      cancelled: false,
    };
    this.active.set(key, active);
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
    this.record('branch.operation.started', request, operationId, generation, 'info', {
      continuedFromKind: existing?.continuedFrom?.kind || null,
      continuedFromSource: existing?.continuedFrom?.source || null,
    });
    return { status: 'started', operationId, generation, lease };
  }

  private beginAgainstReservedContinuation(
    request: BranchOperationRequest,
    reserved: ReservedContinuation,
  ): BranchOperationDecision {
    if (isWebhookDeploy(request)) {
      const existing = this.pendingWebhookDeploys.get(request.branchId);
      const generation = this.nextGeneration(request.branchId);
      const operationId = existing?.operationId || this.createOperationId();
      this.pendingWebhookDeploys.set(request.branchId, {
        operationId,
        branchId: request.branchId,
        generation,
        request,
        mergedCount: (existing?.mergedCount || 0) + 1,
        updatedAt: nowIso(),
      });
      this.record('branch.operation.merged', request, operationId, generation, 'info', {
        activeOperationId: reserved.operationId,
        activeKind: reserved.request.kind,
        reservedContinuation: true,
        mergedCount: (existing?.mergedCount || 0) + 1,
        commitSha: request.commitSha || null,
      });
      return {
        status: 'merged',
        operationId,
        generation,
        activeOperationId: reserved.operationId,
        activeKind: reserved.request.kind,
        pendingCommitSha: request.commitSha || null,
        reason: 'webhook deploy merged while force-rebuild waits for its deploy continuation',
      };
    }

    if (this.requestMatchesContinuation(request, reserved)) {
      this.reservedContinuations.delete(request.branchId);
      const generation = this.nextGeneration(request.branchId);
      this.record('branch.operation.continued', request, reserved.operationId, generation, 'info', {
        reservedAt: reserved.reservedAt,
        continueWith: reserved.continueWith,
        previousGeneration: reserved.generation,
      });
      return this.start(request, {
        operationId: reserved.operationId,
        generation,
        continuedFrom: reserved.request,
      });
    }

    const incomingPriority = priorityOf(request);
    const reservedPriority = priorityOf(reserved.request);
    if (incomingPriority > reservedPriority || TERMINAL_KINDS.has(request.kind) || request.kind === 'stop') {
      this.reservedContinuations.delete(request.branchId);
      this.record('branch.operation.cancelled', reserved.request, reserved.operationId, reserved.generation, 'warn', {
        reason: `reserved continuation superseded by ${request.kind}`,
        reserved: true,
      });
      if (TERMINAL_KINDS.has(request.kind) || request.kind === 'stop') {
        this.cancelPendingWebhookDeploy(request.branchId, `reserved continuation superseded by ${request.kind}`);
      }
      return this.start(request);
    }

    this.record('branch.operation.rejected', request, this.createOperationId(), this.currentGeneration(request.branchId), 'warn', {
      activeOperationId: reserved.operationId,
      activeKind: reserved.request.kind,
      reservedContinuation: true,
      reason: 'branch is waiting for force-rebuild deploy continuation',
    });
    return {
      status: 'rejected',
      operationId: reserved.operationId,
      generation: reserved.generation,
      activeOperationId: reserved.operationId,
      activeKind: reserved.request.kind,
      reason: 'branch is waiting for force-rebuild deploy continuation',
    };
  }

  private requestMatchesContinuation(request: BranchOperationRequest, reserved: ReservedContinuation): boolean {
    if (request.trigger !== reserved.request.trigger) return false;
    if (reserved.continueWith === 'deploy' && request.kind === 'deploy') return true;
    return reserved.continueWith === 'deploy-profile'
      && request.kind === 'deploy-profile'
      && request.profileId === reserved.request.profileId;
  }

  private reserveContinuation(lease: BranchOperationLease, continueWith: 'deploy' | 'deploy-profile'): void {
    const expiresAt = Date.now() + 5 * 60 * 1000;
    this.reservedContinuations.set(lease.branchId, {
      operationId: lease.operationId,
      branchId: lease.branchId,
      generation: lease.generation,
      request: lease.request,
      reservedAt: nowIso(),
      expiresAt,
      continueWith,
    });
    this.record('branch.operation.queued', lease.request, lease.operationId, lease.generation, 'info', {
      reason: 'force-rebuild cleanup finished; waiting for deploy continuation',
      continueWith,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  private cancelPendingWebhookDeploy(branchId: string, reason: string): void {
    const pending = this.pendingWebhookDeploys.get(branchId);
    if (!pending) return;
    this.pendingWebhookDeploys.delete(branchId);
    this.record('branch.operation.cancelled', pending.request, pending.operationId, pending.generation, 'warn', {
      reason,
      pending: true,
      mergedCount: pending.mergedCount,
      updatedAt: pending.updatedAt,
    });
  }

  private getUsableReservedContinuation(branchId: string, request?: BranchOperationRequest): ReservedContinuation | null {
    const reserved = this.reservedContinuations.get(branchId);
    if (!reserved) return null;
    if (request && !this.operationsConflict(request, reserved.request)) return null;
    if (Date.now() <= reserved.expiresAt) return reserved;
    this.reservedContinuations.delete(branchId);
    this.record('branch.operation.cancelled', reserved.request, reserved.operationId, reserved.generation, 'warn', {
      reason: 'reserved continuation expired',
      reserved: true,
    });
    const pending = this.pendingWebhookDeploys.get(branchId);
    if (pending) {
      this.pendingWebhookDeploys.delete(branchId);
      this.record('branch.operation.cancelled', pending.request, pending.operationId, pending.generation, 'warn', {
        reason: 'reserved continuation expired before manual deploy continuation arrived',
        pending: true,
      });
    }
    return null;
  }

  private nextGeneration(branchId: string): number {
    const next = (this.generations.get(branchId) || 0) + 1;
    this.generations.set(branchId, next);
    return next;
  }

  private currentGeneration(branchId: string): number {
    return this.generations.get(branchId) || 0;
  }

  private findActiveEntryByOperation(operationId: string): { key: string; active: ActiveOperation } | null {
    for (const [key, active] of this.active.entries()) {
      if (active.operationId === operationId) return { key, active };
    }
    return null;
  }

  private findBlockingActive(request: BranchOperationRequest): ActiveOperation | undefined {
    return this.findBlockingActives(request)[0];
  }

  private findBlockingActives(request: BranchOperationRequest): ActiveOperation[] {
    return [...this.active.values()].filter((active) => this.operationsConflict(request, active.request));
  }

  private operationsConflict(a: BranchOperationRequest, b: BranchOperationRequest): boolean {
    if (a.branchId !== b.branchId) return false;
    if (this.isBranchWide(a) || this.isBranchWide(b)) return true;
    return (a.profileId || null) === (b.profileId || null);
  }

  private operationKey(request: BranchOperationRequest): string {
    return this.isBranchWide(request)
      ? this.branchKey(request.branchId)
      : this.profileKey(request.branchId, request.profileId || '');
  }

  private branchKey(branchId: string): string {
    return `${branchId}::*`;
  }

  private profileKey(branchId: string, profileId: string): string {
    return `${branchId}::${profileId}`;
  }

  private isBranchWide(request: BranchOperationRequest): boolean {
    if (!request.profileId) return true;
    return !(
      request.kind === 'deploy-profile' ||
      request.kind === 'force-rebuild' ||
      request.kind === 'auto-restart'
    );
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
      operationId,
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
