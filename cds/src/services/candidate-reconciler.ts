import type { BranchEntry, DeploymentCandidateRecord, ServiceState } from '../types.js';
import type { StateService } from './state.js';
import { BranchOperationCoordinator } from './branch-operation-coordinator.js';
import { candidateControlFingerprint, candidateSettlementFingerprint } from './candidate-recovery-evidence.js';
import { snapshotCandidateServices } from './service-candidate-journal.js';
import { captureServingVersion, assertServingVersion } from './candidate-serving-version.js';
import { OwnedContainerLifecycle, type OwnedContainerReference } from './owned-container-lifecycle.js';
import { OwnedCandidateNetworkLifecycle } from './owned-candidate-network.js';
import type { ContainerService } from './container.js';

export interface CandidateReconcileResult {
  runId: string;
  status: 'released' | 'blocked' | 'busy';
  reason?: string;
}

/** Conservative old-graph recovery. Published candidates and unknown external results remain reserved. */
export class CandidateReconciler {
  private scanning = false;
  private cursor = 0;
  constructor(private readonly state: StateService, private readonly coordinator: BranchOperationCoordinator,
    private readonly lifecycle: OwnedContainerLifecycle, private readonly networks: OwnedCandidateNetworkLifecycle,
    private readonly containers: Pick<ContainerService, 'waitForReadiness' | 'waitForStartupSignal'>,
    private readonly acknowledge: (branch: BranchEntry, signal: AbortSignal) => Promise<boolean>, private readonly canReconcile: () => boolean = () => true) {}

  async scan(limit = 1): Promise<CandidateReconcileResult[]> {
    if (this.scanning) return [];
    if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error('candidate_reconcile_limit');
    this.scanning = true;
    try {
      const runs = this.state.getDeploymentRuns().filter(run => run.candidate && run.candidate.phase !== 'released' &&
        ['failed', 'cancelled'].includes(run.status));
      const results: CandidateReconcileResult[] = [];
      for (let index = 0; index < Math.min(limit, runs.length); index++) {
        const run = runs[(this.cursor + index) % runs.length]; results.push(await this.reconcile(run.id));
      }
      if (runs.length) this.cursor = (this.cursor + Math.min(limit, runs.length)) % runs.length;
      return results;
    } finally { this.scanning = false; }
  }

  async reconcile(runId: string): Promise<CandidateReconcileResult> {
    const run = this.state.getDeploymentRun(runId);
    if (!run) return { runId, status: 'blocked', reason: 'candidate_reconcile_missing' };
    const decision = this.coordinator.begin({ kind: 'candidate-reconcile', trigger: 'system', source: 'candidate-reconciler',
      branchId: run.branchId, projectId: run.projectId, reconcileRunId: runId });
    if (decision.status !== 'started' || !decision.lease) return { runId, status: 'busy', reason: 'candidate_reconcile_admission' };
    const lease = decision.lease; const timeout = AbortSignal.timeout(30_000);
    const signal = lease.signal ? AbortSignal.any([lease.signal, timeout]) : timeout;
    const record = run.candidate; const branch = this.state.getBranch(run.branchId);
    const facts = record && JSON.stringify(record);
    const owner = { projectId: run.projectId, branchId: run.branchId, operationId: run.operationId! };
    const keys = (value: object) => JSON.stringify(Object.keys(value).sort());
    const stops = record?.stopBeforeStart || [];
    const fence = () => {
      lease.assertCurrent('candidate-reconcile'); signal.throwIfAborted();
      if (!this.canReconcile() || this.state.getProjects().find(project => project.id === owner.projectId)?.paused) throw new Error('candidate_reconcile_draining_or_paused');
      if (!record || !branch || this.state.getDeploymentRun(runId) !== run || run.candidate !== record ||
        JSON.stringify(record) !== facts || run.operationId !== record.operationId || run.commitSha !== record.targetSha ||
        run.configHash !== record.configHash || run.branchId !== owner.branchId || run.projectId !== owner.projectId ||
        !['failed', 'cancelled'].includes(run.status) || this.state.getBranch(run.branchId) !== branch ||
        branch.projectId !== owner.projectId || candidateControlFingerprint(branch) !== record.servingControlFingerprint) {
        throw new Error('candidate_reconcile_drift');
      }
      const actual = snapshotCandidateServices(branch.services);
      for (const id of stops) if (actual[id] && ['running', 'stopped'].includes(actual[id].status)) actual[id].status = record.serving[id]?.status;
      if (JSON.stringify(actual) !== JSON.stringify(record.serving)) throw new Error('candidate_reconcile_published_graph');
      if (record.recoveryProof?.servingVersion) assertServingVersion(this.state, branch, record.recoveryProof.servingVersion);
    };
    let status: 'completed' | 'failed' = 'failed';
    try {
      fence();
      if (record!.executorSettlement?.version !== 1 || typeof record!.executorSettlement.finishedAt !== 'string' || !Number.isFinite(Date.parse(record!.executorSettlement.finishedAt)) ||
        record!.executorSettlement.fingerprint !== candidateSettlementFingerprint(record!)) throw new Error('candidate_reconcile_unsettled');
      const proof = record!.recoveryProof;
      const intents = record!.createIntents || []; const created = record!.createdContainers || {};
      const validId = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
      const validDigest = (value: unknown) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
      if (proof?.version !== 1 || keys(proof.serving) !== keys(record!.serving) || keys(proof.artifacts) !== keys(record!.services) ||
        new Set(stops).size !== stops.length || stops.some(id => !record!.serving[id] || record!.serving[id].status !== 'stopped' || !proof.serving[id]?.wasRunning) ||
        new Set(intents).size !== intents.length || JSON.stringify([...intents].sort()) !== keys(created) ||
        Object.entries(created).some(([id, ref]) => !validId(ref.id) || !validDigest(ref.fingerprint) ||
          ref.id !== record!.services[id]?.containerId || ref.image !== proof.artifacts[id]?.image || !validDigest(ref.image)) ||
        Object.values(proof.artifacts).some(artifact => artifact.targetSha !== record!.targetSha || !validDigest(artifact.image)) ||
        (record!.networkCreation?.intent && (!validId(record!.networkCreation.identity?.id) || !validDigest(record!.networkCreation.identity?.fingerprint))) ||
        (intents.length > 0 && !record!.networkCreation?.identity)) throw new Error('candidate_reconcile_unknown_external_result');
      const originalIds = Object.keys(record!.serving);
      const version = originalIds.length ? captureServingVersion(this.state, branch!, originalIds) : undefined;
      if (originalIds.length && (!proof.servingVersion || version!.proof.fingerprint !== proof.servingVersion.fingerprint)) {
        throw new Error('candidate_reconcile_original_version');
      }
      const originals = new Map<string, OwnedContainerReference>();
      // Verify every original before retiring anything. Never substitute a recreated Docker name.
      for (const [id, service] of Object.entries(branch!.services)) {
        const original = proof.serving[id];
        if (!original || !validId(original.id) || !validDigest(original.fingerprint) || original.id !== service.containerId ||
          original.name !== service.containerName || typeof original.wasRunning !== 'boolean') throw new Error('candidate_reconcile_original_identity');
        const actual = await this.lifecycle.capture(owner, service, fence, signal); fence();
        if (actual.id !== original.id || actual.image !== original.image || actual.fingerprint !== original.fingerprint ||
          (!stops.includes(id) && actual.wasRunning !== original.wasRunning)) throw new Error('candidate_reconcile_original_drift');
        originals.set(id, actual);
      }
      // Durable old mapping alone is not proof that Forwarder stopped serving the candidate.
      if (!await this.acknowledge(branch!, signal)) throw new Error('candidate_reconcile_route_ack');
      fence();
      for (const [id, ref] of Object.entries(created)) {
        const service = record!.services[id];
        const reference: OwnedContainerReference = Object.freeze({ owner: Object.freeze({ ...owner, profileId: id }),
          ...ref, name: service.containerName, wasRunning: false, writableMounts: Object.freeze([]) });
        await this.lifecycle.remove(reference, fence, signal); fence();
      }
      if (record!.networkCreation?.identity) {
        await this.networks.remove(Object.freeze({ owner: Object.freeze(owner), name: record!.networkName,
          ...record!.networkCreation.identity }), fence, signal); fence();
      }
      for (const [id, original] of originals) {
        if (!proof.serving[id].wasRunning) continue;
        const service = branch!.services[id]; const profile = version!.profiles.get(id)!;
        if (!original.wasRunning) { await this.lifecycle.start(original, fence, signal); fence(); }
        if (profile.startupSignal && !await this.containers.waitForStartupSignal(service.containerName, profile.startupSignal,
          undefined, profile.readinessProbe?.timeoutSeconds || 300, signal)) throw new Error('candidate_reconcile_original_readiness');
        fence();
        if (!await this.containers.waitForReadiness(service.hostPort, profile.readinessProbe, undefined, undefined,
          service.containerName, signal)) throw new Error('candidate_reconcile_original_readiness');
        fence(); if (stops.includes(id)) service.status = 'running';
      }
      this.state.save(); await this.state.flush(); fence();
      if (!await this.acknowledge(branch!, signal)) throw new Error('candidate_reconcile_route_ack');
      fence();
      await this.state.updateDeploymentRunDurably(runId, draft => {
        draft.candidate!.phase = 'released'; draft.candidate!.updatedAt = new Date().toISOString();
      }, () => this.state.flush(), fence);
      status = 'completed'; return { runId, status: 'released' };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const reason = message.match(/^candidate_reconcile_[a-z_]+/)?.[0] || 'candidate_reconcile_external_unconfirmed';
      return { runId, status: 'blocked', reason };
    } finally { this.coordinator.complete(lease, status); }
  }
}
