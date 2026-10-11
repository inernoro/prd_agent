import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { BranchEntry, AcceptanceReportMeta } from '../types.js';
import type { StateService } from './state.js';

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
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
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
    private readonly reportTimeoutMs = 5000) {
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
    if (!ID.test(input.projectId) || !ID.test(input.branchId) || !ID.test(input.profileId)
      || !SHA.test(input.targetSha) || !/^[a-z0-9][a-z0-9_]{2,23}$/.test(input.isolationRunId)) throw new Error('acceptance_scope_invalid');
    const branch = this.state.getBranch(input.branchId);
    if (!branch || branch.projectId !== input.projectId) throw new Error('acceptance_scope_mismatch');
    const absent = () => {
      if (this.state.getBranch(input.branchId) !== branch || branchIdentity(branch) !== identity) throw new Error('acceptance_branch_changed');
      if (branch.extraProfiles?.some(p => p.id === input.profileId) || branch.services[input.profileId]
        || this.state.getBuildProfile(input.profileId)) throw new Error('acceptance_resource_already_exists');
    };
    const identity = branchIdentity(branch); absent();
    const ownerToken = randomBytes(32).toString('hex');
    const row: AcceptanceResourceRun = { ...input, id: `ar_${randomBytes(16).toString('hex')}`, seq: 1,
      branchIdentity: identity, ownerHash: bodyDigest(ownerToken), startedAt: this.now().toISOString(), stage: 'active' };
    await this.state.writeAcceptanceResourceRunDurably(row, undefined, absent);
    return { run: view(row), ownerToken };
  }

  private owned(id: string, ownerToken: string): AcceptanceResourceRun {
    const run = this.state.getState().acceptanceResourceRuns?.[id];
    if (!run || !/^[a-f0-9]{64}$/.test(ownerToken) || !/^[a-f0-9]{64}$/.test(run.ownerHash)
      || !timingSafeEqual(Buffer.from(run.ownerHash, 'hex'), Buffer.from(bodyDigest(ownerToken), 'hex'))) throw new Error('acceptance_owner_required');
    this.branch(run);
    return run;
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
    const deploymentRunId = b.lastDeploymentRunId;
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
    if (run.stage !== 'active') throw new Error('acceptance_run_stage');
    const resource = this.resource(run);
    const row = { ...run, seq: run.seq + 1, stage: 'registered' as const, resource };
    await this.state.writeAcceptanceResourceRunDurably(row, run.seq, () => {
      this.owned(id, ownerToken);
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

  async finish(id: string, ownerToken: string, reportId: string): Promise<AcceptanceResourceView> {
    return this.operation(id, () => this.finishNow(id, ownerToken, reportId));
  }
  private async finishNow(id: string, ownerToken: string, reportId: string): Promise<AcceptanceResourceView> {
    const run = this.owned(id, ownerToken);
    if (run.stage !== 'registered') throw new Error('acceptance_run_stage');
    this.sameResource(run);
    const meta = this.report(run, reportId); const metaDigest = digest(meta);
    const content = await this.readReport(id, reportId);
    if (!content?.trim()) throw new Error('acceptance_report_unreadable');
    const assertCurrent = () => {
      this.owned(id, ownerToken); this.sameResource(run);
      if (digest(this.report(run, reportId)) !== metaDigest) throw new Error('acceptance_report_changed');
    };
    assertCurrent();
    const row: AcceptanceResourceRun = { ...run, seq: run.seq + 1, stage: 'finished', terminal: {
      reportId, metaDigest, bodyDigest: bodyDigest(content), verdict: meta.verdict!, finishedAt: this.now().toISOString() } };
    await this.state.writeAcceptanceResourceRunDurably(row, run.seq, assertCurrent);
    return view(row);
  }

  /** A receipt is a prerequisite, never proof that the daemon has stopped/deleted the resource. */
  async requireCleanupEvidence(id: string, ownerToken: string): Promise<AcceptanceResourceView & { daemonVerificationRequired: true }> {
    return this.operation(id, () => this.cleanupEvidenceNow(id, ownerToken));
  }
  private async cleanupEvidenceNow(id: string, ownerToken: string): Promise<AcceptanceResourceView & { daemonVerificationRequired: true }> {
    const run = this.owned(id, ownerToken);
    if (run.stage !== 'finished' || !run.terminal) throw new Error('acceptance_terminal_receipt_required');
    this.sameResource(run);
    const meta = this.report(run, run.terminal.reportId);
    if (digest(meta) !== run.terminal.metaDigest) throw new Error('acceptance_report_changed');
    const content = await this.readReport(id, meta.id);
    this.owned(id, ownerToken); this.sameResource(run);
    if (digest(this.report(run, meta.id)) !== run.terminal.metaDigest || content === undefined || bodyDigest(content) !== run.terminal.bodyDigest) throw new Error('acceptance_report_changed');
    return { ...view(run), daemonVerificationRequired: true };
  }
}
