import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { BranchEntry, AcceptanceReportMeta, ServiceState } from '../types.js';
import type { StateService } from './state.js';
import type { OwnedContainerLifecycle, OwnedContainerReference } from './owned-container-lifecycle.js';
import type { BranchOperationCoordinator } from './branch-operation-coordinator.js';
import { acceptanceResourceProfile } from './acceptance-resource-profile.js';

export interface AcceptanceResourceReleaseBindings {
  coordinator: BranchOperationCoordinator;
  lifecycle: OwnedContainerLifecycle;
  /** Only a bound executor may inspect or mutate this branch's registered resource. */
  canExecute: (branch: Readonly<BranchEntry>) => boolean;
}

/** Persist before any stop; phase records confirmed facts, never client/Daemon uncertainty. */
export interface AcceptanceResourceReleaseIntent {
  version: 1;
  phase: 'prepared' | 'stopped' | 'removed';
  startedAt: string;
  reference: OwnedContainerReference;
  serviceDigest: string;
}

export interface AcceptanceResourceRun {
  id: string;
  seq: number;
  projectId: string;
  branchId: string;
  branchIdentity: string;
  targetSha: string;
  isolationRunId: string;
  profileId: string;
  ownerHash: string;
  startedAt: string;
  stage: 'active' | 'registered' | 'finished' | 'released';
  resource?: { configDigest: string; containerId: string; deploymentRunId: string };
  terminal?: { reportId: string; metaDigest: string; bodyDigest: string; verdict: NonNullable<AcceptanceReportMeta['verdict']>; finishedAt: string };
  creationIntent?: { version: 1; phase: 'configured' | 'deploying'; profileDigest: string; startedAt: string; deploymentRunId?: string };
  releaseIntent?: AcceptanceResourceReleaseIntent;
}
/** An uncommitted write intent is retained across restart; it is not a published terminal receipt. */
export interface AcceptanceResourcePublication {
  draft: AcceptanceResourceRun;
  previous?: AcceptanceResourceRun;
}
export type AcceptanceResourceView = Omit<AcceptanceResourceRun, 'ownerHash'>;
const SHA = /^[a-f0-9]{40}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const CONTAINER = /^[a-f0-9]{64}$/;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, stable(v)]));
  return value;
}
export const acceptanceResourceDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const digest = acceptanceResourceDigest;
/** Monitor status/logs may change after stop, but cannot change the captured service identity. */
export const acceptanceResourceServiceDigest = (service: Readonly<ServiceState>) => digest([
  service.profileId, service.containerId, service.containerName, service.hostPort,
  service.deployedCommitSha, service.deployedImage || null,
]);
const bodyDigest = (value: string) => createHash('sha256').update(value).digest('hex');
const branchIdentity = (b: BranchEntry) => digest([b.id, b.projectId, b.branch, b.createdAt, b.worktreePath]);
function view(run: AcceptanceResourceRun): AcceptanceResourceView {
  const { ownerHash: _secret, ...rest } = structuredClone(run);
  return rest;
}
const budgets = new WeakMap<StateService, { operations: Set<string>; reads: Set<string> }>();

/** Ownership/receipt kernel only: it does not grant HTTP access or remove Docker/filesystem resources. */
export class AcceptanceResourceRunService {
  constructor(private readonly state: StateService, private readonly now: () => Date = () => new Date(),
    private readonly reportTimeoutMs = 5000, private readonly releaseBindings?: AcceptanceResourceReleaseBindings) {
    if (!Number.isFinite(reportTimeoutMs) || reportTimeoutMs <= 0 || reportTimeoutMs > 5000) throw new Error('acceptance_report_budget_invalid');
    if (!budgets.has(state)) budgets.set(state, { operations: new Set(), reads: new Set() });
  }

  private async operation<T>(id: string, work: () => Promise<T>): Promise<T> {
    const active = budgets.get(this.state)!.operations;
    if (active.has(id)) throw new Error('acceptance_run_busy');
    if (active.size >= 8) throw new Error('acceptance_operation_capacity');
    active.add(id);
    try { return await work(); } finally { active.delete(id); }
  }

  private async readReport(id: string, reportId: string): Promise<string | undefined> {
    const active = budgets.get(this.state)!.reads;
    if (active.has(id)) throw new Error('acceptance_report_pending');
    if (active.size >= 8) throw new Error('acceptance_report_capacity');
    active.add(id);
    const task = Promise.resolve().then(() => this.state.readAcceptanceReportContentAsync(reportId));
    // An observer deadline cannot cancel filesystem/object-store IO. Keep its permit until it really ends.
    void task.then(() => active.delete(id), () => active.delete(id));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([task, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('acceptance_report_timeout')), this.reportTimeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  get(id: string): AcceptanceResourceView | undefined {
    const run = this.state.getState().acceptanceResourceRuns?.[id];
    return run ? view(run) : undefined;
  }

  async begin(input: { projectId: string; branchId: string; targetSha: string; isolationRunId: string; profileId: string }): Promise<{ run: AcceptanceResourceView; ownerToken: string }> {
    const id = `ar_${randomBytes(16).toString('hex')}`;
    return this.operation(id, () => this.beginNow(input, id));
  }

  private async beginNow(input: { projectId: string; branchId: string; targetSha: string; isolationRunId: string; profileId: string }, id: string): Promise<{ run: AcceptanceResourceView; ownerToken: string }> {
    if (!ID.test(input.projectId) || !ID.test(input.branchId) || !ID.test(input.profileId)
      || !SHA.test(input.targetSha) || !/^[a-z0-9][a-z0-9_]{2,23}$/.test(input.isolationRunId)) throw new Error('acceptance_scope_invalid');
    const branch = this.state.getBranch(input.branchId);
    if (!branch || branch.projectId !== input.projectId) throw new Error('acceptance_scope_mismatch');
    const absent = () => {
      if (this.state.getBranch(input.branchId) !== branch || branchIdentity(branch) !== identity) throw new Error('acceptance_branch_changed');
      if (branch.extraProfiles?.some(p => p.id === input.profileId) || branch.services[input.profileId] || branch.profileOverrides?.[input.profileId]
        || this.state.getBuildProfile(input.profileId)) throw new Error('acceptance_resource_already_exists');
    };
    const identity = branchIdentity(branch); absent();
    const ownerToken = randomBytes(32).toString('hex');
    const row: AcceptanceResourceRun = { ...input, id, seq: 1,
      branchIdentity: identity, ownerHash: bodyDigest(ownerToken), startedAt: this.now().toISOString(), stage: 'active' };
    await this.state.writeAcceptanceResourceRunDurably(row, undefined, absent);
    return { run: view(row), ownerToken };
  }

  /** Configuration only. Deployment must later bind its own actual server creation run. */
  async createProfile(id: string, ownerToken: string, proposal: unknown): Promise<AcceptanceResourceView> {
    return this.operation(id, async () => {
      const run = this.owned(id, ownerToken); this.requireResolvedPublication(id);
      if (run.stage !== 'active' || run.creationIntent) throw new Error('acceptance_run_stage');
      const branch = this.branch(run), profile = acceptanceResourceProfile(proposal, run, ownerToken);
      const bindings = this.releaseBindings;
      if (!bindings || !bindings.canExecute(branch)) throw new Error('acceptance_creation_unavailable');
      const decision = bindings.coordinator.begin({ projectId: run.projectId, branchId: run.branchId,
        kind: 'acceptance-create', trigger: 'system', source: 'acceptance-resource-create',
        acceptanceRunId: id, commitSha: run.targetSha });
      if (decision.status !== 'started' || !decision.lease) throw new Error('acceptance_creation_busy');
      const lease = decision.lease; let completed = false;
      try {
        const runDigest = digest(run);
        const fence = () => {
          if (!lease.isCurrent() || lease.signal?.aborted) throw new Error('acceptance_creation_cancelled');
          if (!bindings.canExecute(branch) || this.owned(id, ownerToken) !== run || digest(run) !== runDigest
            || this.branch(run) !== branch) throw new Error('acceptance_branch_changed');
        };
        fence();
        const row: AcceptanceResourceRun = { ...run, seq: run.seq + 1,
          creationIntent: { version: 1, phase: 'configured', profileDigest: digest(profile), startedAt: this.now().toISOString() } };
        await this.state.writeAcceptanceResourceProfileDurably(row, run.seq, profile, fence);
        completed = true; return view(row);
      } finally {
        bindings.coordinator.complete(lease, completed ? 'completed' : lease.signal?.aborted ? 'cancelled' : 'failed');
      }
    });
  }

  private owned(id: string, ownerToken: string): AcceptanceResourceRun {
    const run = this.state.getState().acceptanceResourceRuns?.[id];
    if (!run || !/^[a-f0-9]{64}$/.test(ownerToken) || !/^[a-f0-9]{64}$/.test(run.ownerHash)
      || !timingSafeEqual(Buffer.from(run.ownerHash, 'hex'), Buffer.from(bodyDigest(ownerToken), 'hex'))) throw new Error('acceptance_owner_required');
    this.branch(run);
    return run;
  }

  private requireResolvedPublication(id: string): void {
    if (this.state.getState().acceptanceResourcePublications?.[id]) throw new Error('acceptance_run_recovery_required');
  }

  private branch(run: AcceptanceResourceRun): BranchEntry {
    const b = this.state.getBranch(run.branchId);
    if (!b || branchIdentity(b) !== run.branchIdentity) throw new Error('acceptance_branch_changed');
    return b;
  }

  private resource(run: AcceptanceResourceRun): NonNullable<AcceptanceResourceRun['resource']> {
    const b = this.branch(run);
    const profile = b.extraProfiles?.find(p => p.id === run.profileId);
    const service = b.services[run.profileId];
    const env = { ...profile?.env, ...b.profileOverrides?.[run.profileId]?.env };
    // Registration binds the successful creation. A later branch deployment can fail
    // without replacing this exact resource or revoking its report/cleanup ownership.
    if (run.creationIntent && (run.creationIntent.phase !== 'deploying' || !run.creationIntent.deploymentRunId)) throw new Error('acceptance_resource_unconfirmed');
    const deploymentRunId = run.resource ? run.resource.deploymentRunId : run.creationIntent?.deploymentRunId || b.lastDeploymentRunId;
    const deployment = deploymentRunId ? this.state.getDeploymentRun(deploymentRunId) : undefined;
    if (!profile || profile.projectId !== run.projectId || env.IMP_HEALTH_RUN_ID !== run.isolationRunId || env.IMP_TARGET_SHA !== run.targetSha
      || !service || !CONTAINER.test(service.containerId || '') || service.deployedCommitSha !== run.targetSha
      || !deployment || deployment.projectId !== run.projectId || deployment.branchId !== run.branchId
      || deployment.commitSha !== run.targetSha || deployment.status !== 'running' || deployment.startedAt < run.startedAt) throw new Error('acceptance_resource_unconfirmed');
    return { configDigest: digest([profile, b.profileOverrides?.[run.profileId] || null]), containerId: service.containerId!, deploymentRunId: deployment.id };
  }

  private sameResource(run: AcceptanceResourceRun): void {
    if (!run.resource || digest(this.resource(run)) !== digest(run.resource)) throw new Error('acceptance_resource_changed');
  }

  async register(id: string, ownerToken: string): Promise<AcceptanceResourceView> {
    return this.operation(id, () => this.registerNow(id, ownerToken));
  }
  private async registerNow(id: string, ownerToken: string): Promise<AcceptanceResourceView> {
    const run = this.owned(id, ownerToken);
    this.requireResolvedPublication(id);
    if (run.stage !== 'active') throw new Error('acceptance_run_stage');
    const branch = this.branch(run);
    const resource = this.resource(run);
    const row = { ...run, seq: run.seq + 1, stage: 'registered' as const, resource };
    await this.state.writeAcceptanceResourceRunDurably(row, run.seq, () => {
      this.owned(id, ownerToken);
      if (this.branch(run) !== branch) throw new Error('acceptance_branch_changed');
      if (digest(this.resource(run)) !== digest(resource)) throw new Error('acceptance_resource_changed');
    });
    return view(row);
  }

  private report(run: AcceptanceResourceRun, reportId: string): AcceptanceReportMeta {
    const meta = this.state.getAcceptanceReport(reportId);
    if (!meta || meta.acceptanceRunId !== run.id || meta.projectId !== run.projectId || meta.branchId !== run.branchId
      || meta.commitSha !== run.targetSha || meta.createdAt < run.startedAt || !['pass', 'conditional', 'fail'].includes(meta.verdict || '')) throw new Error('acceptance_report_mismatch');
    return meta;
  }

  /** Bind an existing report producer; archiving does not publish a terminal receipt. */
  async createBoundReport(input: { id: string; ownerToken: string; projectId: string; branchId: string; commitSha: string },
    create: (assertCurrent: () => void) => Promise<AcceptanceReportMeta>): Promise<AcceptanceReportMeta> {
    return this.operation(input.id, async () => {
      const run = this.owned(input.id, input.ownerToken);
      this.requireResolvedPublication(input.id);
      if (run.stage !== 'registered') throw new Error('acceptance_run_stage');
      if (run.projectId !== input.projectId || run.branchId !== input.branchId || run.targetSha !== input.commitSha) throw new Error('acceptance_report_mismatch');
      const branch = this.branch(run);
      const assertCurrent = () => {
        if (this.state.getState().acceptanceResourceRuns?.[input.id] !== run) throw new Error('acceptance_run_conflict');
        this.owned(input.id, input.ownerToken);
        this.requireResolvedPublication(input.id);
        if (this.branch(run) !== branch) throw new Error('acceptance_branch_changed');
        this.sameResource(run);
      };
      assertCurrent();
      const meta = await create(assertCurrent);
      assertCurrent();
      const metaDigest = digest(this.report(run, meta.id));
      await this.state.flush();
      assertCurrent();
      if (digest(this.report(run, meta.id)) !== metaDigest) throw new Error('acceptance_report_changed');
      return meta;
    });
  }

  async finish(id: string, ownerToken: string, reportId: string): Promise<AcceptanceResourceView> {
    return this.operation(id, () => this.finishNow(id, ownerToken, reportId));
  }
  private async finishNow(id: string, ownerToken: string, reportId: string): Promise<AcceptanceResourceView> {
    const run = this.owned(id, ownerToken);
    this.requireResolvedPublication(id);
    if (run.stage !== 'registered') throw new Error('acceptance_run_stage');
    const branch = this.branch(run);
    this.sameResource(run);
    const meta = this.report(run, reportId); const metaDigest = digest(meta);
    const content = await this.readReport(id, reportId);
    if (!content?.trim()) throw new Error('acceptance_report_unreadable');
    const assertCurrent = () => {
      this.owned(id, ownerToken);
      if (this.branch(run) !== branch) throw new Error('acceptance_branch_changed');
      this.sameResource(run);
      if (digest(this.report(run, reportId)) !== metaDigest) throw new Error('acceptance_report_changed');
    };
    assertCurrent();
    const row: AcceptanceResourceRun = { ...run, seq: run.seq + 1, stage: 'finished', terminal: {
      reportId, metaDigest, bodyDigest: bodyDigest(content), verdict: meta.verdict!, finishedAt: this.now().toISOString() } };
    await this.state.writeAcceptanceResourceRunDurably(row, run.seq, assertCurrent, async () => {
      const currentContent = await this.readReport(id, reportId);
      if (currentContent === undefined || bodyDigest(currentContent) !== row.terminal!.bodyDigest) throw new Error('acceptance_report_changed');
    });
    return view(row);
  }

  /** A receipt is a prerequisite, never proof that the daemon has stopped/deleted the resource. */
  async requireCleanupEvidence(id: string, ownerToken: string): Promise<AcceptanceResourceView & { daemonVerificationRequired: true }> {
    return this.operation(id, () => this.cleanupEvidenceNow(id, ownerToken));
  }
  private async cleanupEvidenceNow(id: string, ownerToken: string): Promise<AcceptanceResourceView & { daemonVerificationRequired: true }> {
    const run = this.owned(id, ownerToken);
    if (run.stage !== 'finished' || !run.terminal) throw new Error('acceptance_terminal_receipt_required');
    this.requireResolvedPublication(id);
    const branch = this.branch(run);
    this.sameResource(run);
    const meta = this.report(run, run.terminal.reportId);
    if (digest(meta) !== run.terminal.metaDigest) throw new Error('acceptance_report_changed');
    const content = await this.readReport(id, meta.id);
    this.owned(id, ownerToken);
    if (this.branch(run) !== branch) throw new Error('acceptance_branch_changed');
    this.sameResource(run);
    if (digest(this.report(run, meta.id)) !== run.terminal.metaDigest || content === undefined || bodyDigest(content) !== run.terminal.bodyDigest) throw new Error('acceptance_report_changed');
    return { ...view(run), daemonVerificationRequired: true };
  }

  async release(id: string, ownerToken: string): Promise<AcceptanceResourceView> {
    return this.operation(id, async () => {
      let run = this.owned(id, ownerToken);
      this.requireResolvedPublication(id);
      if (run.stage === 'released') return view(run);
      await this.cleanupEvidenceNow(id, ownerToken);
      const bindings = this.releaseBindings;
      const branch = this.branch(run);
      if (!bindings || !bindings.canExecute(branch)) throw new Error('acceptance_release_unavailable');
      const service = branch.services[run.profileId];
      const serviceDigest = acceptanceResourceServiceDigest(service);
      let runDigest = digest(run);
      const decision = bindings.coordinator.begin({ projectId: run.projectId, branchId: run.branchId,
        commitSha: run.targetSha, acceptanceRunId: id, kind: 'acceptance-release', trigger: 'system', source: 'acceptance-resource-release' });
      if (decision.status !== 'started' || !decision.lease) throw new Error('acceptance_release_busy');
      const lease = decision.lease;
      let completed = false;
      const fence = () => {
        lease.assertCurrent(); lease.signal?.throwIfAborted();
        if (!bindings.canExecute(branch)) throw new Error('acceptance_release_unavailable');
        if (this.owned(id, ownerToken) !== run || digest(run) !== runDigest) throw new Error('acceptance_run_conflict');
        if (this.branch(run) !== branch) throw new Error('acceptance_branch_changed');
        this.requireResolvedPublication(id); this.sameResource(run);
        if (this.state.getBuildProfile(run.profileId) || acceptanceResourceServiceDigest(branch.services[run.profileId]) !== serviceDigest) throw new Error('acceptance_resource_changed');
        if (!run.terminal || digest(this.report(run, run.terminal.reportId)) !== run.terminal.metaDigest) throw new Error('acceptance_report_changed');
      };
      const reportFence = async () => {
        fence();
        const content = await this.readReport(id, run.terminal!.reportId); fence();
        if (content === undefined || bodyDigest(content) !== run.terminal!.bodyDigest) throw new Error('acceptance_report_changed');
      };
      const persist = async (intent: AcceptanceResourceReleaseIntent) => {
        const row = { ...run, seq: run.seq + 1, releaseIntent: intent };
        await this.state.writeAcceptanceResourceRunDurably(row, run.seq, fence, reportFence);
        run = this.owned(id, ownerToken); runDigest = digest(run); fence();
      };
      try {
        await reportFence();
        if (!run.releaseIntent) {
          const reference = await bindings.lifecycle.capture({ projectId: run.projectId, branchId: run.branchId, operationId: lease.operationId }, service, fence, lease.signal);
          fence();
          if (reference.id !== run.resource!.containerId || reference.writableMounts.length) throw new Error('acceptance_release_scope');
          await persist({ version: 1, phase: 'prepared', reference, serviceDigest, startedAt: this.now().toISOString() });
        }
        const intent = run.releaseIntent!;
        if (intent.version !== 1 || !['prepared', 'stopped', 'removed'].includes(intent.phase)
          || intent.reference.id !== run.resource!.containerId || intent.serviceDigest !== serviceDigest
          || intent.reference.owner.projectId !== run.projectId || intent.reference.owner.branchId !== run.branchId
          || intent.reference.owner.profileId !== run.profileId || intent.reference.writableMounts.length) throw new Error('acceptance_release_scope');
        const reference = intent.reference;
        let actual = await bindings.lifecycle.releaseState(reference, fence, lease.signal); await reportFence();
        if (run.releaseIntent!.phase === 'prepared' && actual !== 'absent') {
          if (actual === 'running') { await bindings.lifecycle.stop(reference, fence, lease.signal); await reportFence(); }
          await persist({ ...intent, phase: 'stopped' });
          actual = await bindings.lifecycle.releaseState(reference, fence, lease.signal); await reportFence();
        }
        if (actual !== 'absent') {
          if (run.releaseIntent!.phase !== 'stopped' || actual !== 'stopped') throw new Error('container_stop_unconfirmed');
          await bindings.lifecycle.removeStopped(reference, fence, lease.signal); await reportFence();
        }
        if (run.releaseIntent!.phase !== 'removed') await persist({ ...intent, phase: 'removed' });
        const verifyRemoved = async () => {
          await reportFence();
          if (await bindings.lifecycle.releaseState(reference, fence, lease.signal) !== 'absent') throw new Error('container_remove_unconfirmed');
          await reportFence();
        };
        await verifyRemoved();
        const released = { ...run, seq: run.seq + 1, stage: 'released' as const };
        await this.state.writeAcceptanceResourceReleaseDurably(released, run.seq, fence, verifyRemoved);
        completed = true; return view(this.owned(id, ownerToken));
      } catch (error) {
        if (!lease.isCurrent() || lease.signal?.aborted) throw new Error('acceptance_release_cancelled');
        throw error;
      } finally {
        bindings.coordinator.complete(lease, completed ? 'completed' : lease.signal?.aborted ? 'cancelled' : 'failed');
      }
    });
  }
}
