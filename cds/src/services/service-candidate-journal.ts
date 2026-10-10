import type { BranchEntry, DeploymentCandidateRecord, ServiceState, CandidateRecoveryProof } from '../types.js';
import type { StateService } from './state.js';
import { candidateRuntimeIdentity } from './service-candidate.js';

export function snapshotCandidateServices(services: Record<string, ServiceState>): DeploymentCandidateRecord['services'] {
  const result: DeploymentCandidateRecord['services'] = Object.create(null);
  for (const [id, service] of Object.entries(services).sort(([a], [b]) => a.localeCompare(b))) {
    // Explicit projection prevents logs, credentials and future arbitrary config fields entering this ledger.
    result[id] = { profileId: service.profileId, containerName: service.containerName, containerId: service.containerId, hostPort: service.hostPort,
      status: service.status, deployedMode: service.deployedMode, deployedImage: service.deployedImage,
      deployedArtifactRef: service.deployedArtifactRef, deployedPrebuilt: service.deployedPrebuilt,
      deployedCommitSha: service.deployedCommitSha };
  }
  return result;
}

export function candidateIdentityKey(services: DeploymentCandidateRecord['services']): string {
  return JSON.stringify(Object.entries(services).sort(([a], [b]) => a.localeCompare(b))
    .map(([id, service]) => [id, service.profileId, service.containerName, service.hostPort]));
}

export function assertCandidateReady(graph: BranchEntry, record: DeploymentCandidateRecord): void {
  if (!Object.keys(graph.services).length || candidateIdentityKey(graph.services) !== candidateIdentityKey(record.services) ||
    graph.deploymentTargetSha !== record.targetSha || Object.values(graph.services).some(service =>
      service.status !== 'running' || service.deployedPrebuilt !== true || !service.deployedImage ||
      service.deployedCommitSha !== record.targetSha)) throw new Error('candidate_ready: complete exact runtime graph required');
  if (record.phase === 'ready' && JSON.stringify(snapshotCandidateServices(graph.services)) !== JSON.stringify(record.services)) {
    throw new Error('candidate_ready: frozen readiness facts changed');
  }
}

type Phase = DeploymentCandidateRecord['phase'];
const NEXT: Record<Phase, readonly Phase[]> = {
  prepared: ['starting', 'reconciling'], starting: ['ready', 'reconciling'],
  ready: ['switch-intent', 'reconciling'], 'switch-intent': ['routed', 'rollback-intent', 'reconciling'],
  routed: ['released', 'reconciling'], 'rollback-intent': ['rollback-verified', 'reconciling'],
  'rollback-verified': ['released', 'reconciling'], reconciling: [], released: [],
};

/** Write-ahead ledger only. Preparing it never replaces the live graph or publishes routes. */
export class CandidateJournal {
  constructor(private readonly state: StateService) {}

  async prepare(runId: string, candidate: BranchEntry, stopBeforeStart?: readonly string[], recoveryProof?: CandidateRecoveryProof): Promise<DeploymentCandidateRecord> {
    const run = this.state.getDeploymentRun(runId);
    const serving = this.state.getBranch(candidate.id);
    if (!run || !serving || run.branchId !== candidate.id || run.projectId !== candidate.projectId ||
      serving.projectId !== candidate.projectId || !run.operationId || !run.configHash || run.candidate ||
      !['pending', 'queued', 'preparing', 'building', 'starting', 'verifying'].includes(run.status)) throw new Error('candidate_journal_owner: active owned run required');
    const target = candidate.deploymentTargetSha || candidate.githubCommitSha || '';
    if (!/^[0-9a-f]{40}$/.test(target) || run.commitSha !== target) throw new Error('candidate_journal_target: frozen target mismatch');
    const identities = Object.entries(candidate.services);
    if (identities.length === 0) throw new Error('candidate_journal_graph: nonempty graph required');
    const reserved = new Set<number>();
    for (const branch of this.state.getAllBranches()) {
      for (const service of Object.values(branch.services)) reserved.add(service.hostPort);
      for (const replica of Object.values(branch.replicaSets || {})) for (const member of replica.members) if (member.hostPort) reserved.add(member.hostPort);
      for (const db of branch.replicaDbSnapshots || []) if (db.dedicatedHostPort) reserved.add(db.dedicatedHostPort);
    }
    for (const infra of this.state.getState().infraServices || []) if (infra.hostPort) reserved.add(infra.hostPort);
    for (const previous of this.state.getDeploymentRuns()) {
      if (!previous.candidate || previous.candidate.phase === 'released') continue;
      for (const service of Object.values(previous.candidate.services)) reserved.add(service.hostPort);
      for (const service of Object.values(previous.candidate.serving)) reserved.add(service.hostPort);
    }
    let networkName = '';
    for (const [id, service] of identities) {
      const identity = candidateRuntimeIdentity(candidate.id, id, run.operationId);
      if (service.profileId !== id || service.containerName !== identity.containerName || service.status !== 'idle' ||
        service.deployedImage || !Number.isInteger(service.hostPort) || service.hostPort < 1 || service.hostPort > 65535 ||
        reserved.has(service.hostPort)) throw new Error('candidate_journal_identity: fresh owned identity and reserved port required');
      reserved.add(service.hostPort); networkName = identity.networkName;
    }
    const record: DeploymentCandidateRecord = { operationId: run.operationId, targetSha: target, configHash: run.configHash,
      networkName, phase: 'prepared', updatedAt: new Date().toISOString(), serving: snapshotCandidateServices(serving.services), services: snapshotCandidateServices(candidate.services) };

    if (recoveryProof !== undefined) {
      const plainRecord = (value: unknown): boolean => !!value && typeof value === 'object' &&
        !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
      const validImage = (value: unknown) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
      const sameKeys = (a: object, b: object) => JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort());
      if (!plainRecord(recoveryProof) || recoveryProof.version !== 1 || !plainRecord(recoveryProof.serving) || !plainRecord(recoveryProof.artifacts) ||
        !sameKeys(recoveryProof.serving, record.serving) || !sameKeys(recoveryProof.artifacts, record.services) ||
        Object.entries(recoveryProof.serving).some(([id, proof]) => !plainRecord(proof) || record.serving[id].profileId !== id ||
          typeof proof.id !== 'string' || !/^[a-f0-9]{64}$/.test(proof.id) || proof.id !== record.serving[id].containerId ||
          proof.name !== record.serving[id].containerName || !validImage(proof.image) ||
          !validImage(proof.fingerprint) || typeof proof.wasRunning !== 'boolean') ||
        Object.values(recoveryProof.artifacts).some(proof => !plainRecord(proof) || !validImage(proof.image) || proof.targetSha !== target)) {
        throw new Error('candidate_recovery_proof: complete frozen inspected identities and artifacts required');
      }
      // Explicit projection, not a clone of extensible Docker data or caller configuration.
      record.recoveryProof = { version: 1,
        serving: Object.fromEntries(Object.entries(recoveryProof.serving).map(([id, p]) => [id,
          { id: p.id, name: p.name, image: p.image, wasRunning: p.wasRunning, fingerprint: p.fingerprint }])),
        artifacts: Object.fromEntries(Object.entries(recoveryProof.artifacts).map(([id, p]) => [id, { image: p.image, targetSha: p.targetSha }])) };
    }
    if (stopBeforeStart?.length) {
      if (new Set(stopBeforeStart).size !== stopBeforeStart.length || stopBeforeStart.some(id => !/^[a-f0-9]{64}$/.test(serving.services[id]?.containerId || ''))) {
        throw new Error('candidate_stop_intent: captured serving identity required');
      }
      record.stopBeforeStart = [...stopBeforeStart].sort();
    }
    this.state.updateDeploymentRun(runId, current => { current.candidate = record; });
    await this.state.flush(); // The caller must await this barrier before Docker create.
    return record;
  }

  /** Compare-and-set phase, with immutable target/identity and an explicit durability barrier. */
  async advance(runId: string, expected: Phase, next: Phase, graph?: BranchEntry): Promise<void> {
    const run = this.state.getDeploymentRun(runId); const record = run?.candidate;
    if (!run || !record || record.phase !== expected || !NEXT[expected]?.includes(next) ||
      run.operationId !== record.operationId || run.commitSha !== record.targetSha || run.configHash !== record.configHash) {
      throw new Error('candidate_journal_phase: owned frozen phase required');
    }
    if (graph) {
      if (graph.id !== run.branchId || graph.projectId !== run.projectId ||
        graph.deploymentTargetSha !== record.targetSha || candidateIdentityKey(graph.services) !== candidateIdentityKey(record.services)) throw new Error('candidate_journal_identity: graph changed');
      if (next === 'ready') assertCandidateReady(graph, record);
    }
    if (next === 'ready' && !graph) throw new Error('candidate_ready: runtime evidence required');
    const frozen = { branchId: run.branchId, projectId: run.projectId, operationId: record.operationId,
      targetSha: record.targetSha, configHash: record.configHash, record: JSON.stringify(record),
      graph: graph ? JSON.stringify(snapshotCandidateServices(graph.services)) : undefined };
    await this.state.updateDeploymentRunDurably(runId, current => {
      if (graph) current.candidate!.services = snapshotCandidateServices(graph.services);
      current.candidate!.phase = next; current.candidate!.updatedAt = new Date().toISOString();
    }, () => this.state.flush(), () => {
      const current = this.state.getDeploymentRun(runId);
      if (current !== run || current.candidate !== record || JSON.stringify(record) !== frozen.record ||
        current.branchId !== frozen.branchId || current.projectId !== frozen.projectId ||
        current.operationId !== frozen.operationId || current.commitSha !== frozen.targetSha || current.configHash !== frozen.configHash ||
        (next !== 'reconciling' && !['pending', 'queued', 'preparing', 'building', 'starting', 'verifying'].includes(current.status)) ||
        (graph && (graph.id !== frozen.branchId || graph.projectId !== frozen.projectId || graph.deploymentTargetSha !== frozen.targetSha ||
          JSON.stringify(snapshotCandidateServices(graph.services)) !== frozen.graph))) {
        throw new Error('candidate_journal_phase: frozen facts changed during persistence');
      }
    });
  }

  async recordRecoveryFailure(runId: string, stage: NonNullable<DeploymentCandidateRecord['recoveryFailure']>['stage'],
    assertCurrent: () => void): Promise<void> {
    assertCurrent();
    if (!['ownership', 'daemon-create', 'candidate-remove', 'serving-start', 'serving-readiness', 'serving-persist', 'route-ack'].includes(stage)) {
      throw new Error('candidate_recovery_stage: bounded recovery code required');
    }
    const run = this.state.getDeploymentRun(runId); const record = run?.candidate;
    if (!run || !record || !['pending', 'queued', 'preparing', 'building', 'starting', 'verifying'].includes(run.status) ||
      run.operationId !== record.operationId || run.commitSha !== record.targetSha || run.configHash !== record.configHash) {
      throw new Error('candidate_recovery_owner: frozen owned journal required');
    }
    const frozen = JSON.stringify(record);
    await this.state.updateDeploymentRunDurably(runId, draft => {
      draft.candidate!.recoveryFailure = { stage, observedAt: new Date().toISOString() };
    }, () => this.state.flush(), () => {
      assertCurrent();
      if (this.state.getDeploymentRun(runId) !== run || run.candidate !== record || JSON.stringify(record) !== frozen ||
        run.operationId !== record.operationId || run.commitSha !== record.targetSha || run.configHash !== record.configHash) {
        throw new Error('candidate_recovery_owner: owner or facts changed during persistence');
      }
    });
  }

  /** Only a durable pre-start phase proves this executor has never issued stop/create. */
  async releaseUnstarted(runId: string, assertCurrent: () => void): Promise<void> {
    assertCurrent();
    const run = this.state.getDeploymentRun(runId); const record = run?.candidate;
    const branch = run && this.state.getBranch(run.branchId);
    const owner = run && { branchId: run.branchId, projectId: run.projectId, operationId: run.operationId, targetSha: run.commitSha, configHash: run.configHash };
    const validate = () => {
      assertCurrent();
      if (!run || !record || !branch || !owner || this.state.getDeploymentRun(runId) !== run || run.candidate !== record ||
        run.branchId !== owner.branchId || run.projectId !== owner.projectId || run.operationId !== owner.operationId ||
        run.commitSha !== owner.targetSha || run.configHash !== owner.configHash || branch.id !== owner.branchId || branch.projectId !== owner.projectId ||
        (branch.deploymentTargetSha || branch.githubCommitSha) !== owner.targetSha || this.state.getBranch(run.branchId) !== branch || record.phase !== 'prepared' || run.operationId !== record.operationId ||
        run.commitSha !== record.targetSha || run.configHash !== record.configHash ||
        !['pending', 'queued', 'preparing', 'building', 'starting', 'verifying'].includes(run.status) ||
        Object.values(record.services).some(service => service.status !== 'idle' || service.containerId || service.deployedImage) ||
        JSON.stringify(snapshotCandidateServices(branch.services)) !== JSON.stringify(record.serving)) {
        throw new Error('candidate_release_unstarted: unchanged owned pre-start facts required');
      }
    };
    validate(); const frozen = JSON.stringify(record);
    await this.state.updateDeploymentRunDurably(runId, draft => {
      draft.candidate!.phase = 'released'; draft.candidate!.updatedAt = new Date().toISOString();
    }, () => this.state.flush(), () => {
      validate(); if (JSON.stringify(record) !== frozen) throw new Error('candidate_release_unstarted: journal changed during persistence');
    });
  }

  /** Record an owned, inspected stop; arbitrary serving drift cannot be re-frozen as recovery evidence. */
  async recordServingStopped(runId: string, profileId: string, assertCurrent: () => void): Promise<void> {
    const run = this.state.getDeploymentRun(runId); const record = run?.candidate;
    const branch = run && this.state.getBranch(run.branchId); const service = branch?.services[profileId];
    const original = record?.serving[profileId];
    assertCurrent();
    if (!run || !record || !branch || !service || !original || !record.stopBeforeStart?.includes(profileId) ||
      !['prepared', 'starting'].includes(record.phase) || service.status !== 'stopped' ||
      !/^[a-f0-9]{64}$/.test(service.containerId || '') ||
      JSON.stringify(snapshotCandidateServices({ [profileId]: { ...service, status: original.status } })) !==
        JSON.stringify({ [profileId]: original })) throw new Error('candidate_serving_stop: frozen inspected identity required');
    const frozenRecord = JSON.stringify(record); const frozenService = JSON.stringify(snapshotCandidateServices({ [profileId]: service }));
    const frozen = { operationId: record.operationId, targetSha: record.targetSha, configHash: record.configHash };
    await this.state.updateDeploymentRunDurably(runId, draft => {
      draft.candidate!.serving[profileId].status = 'stopped'; draft.candidate!.updatedAt = new Date().toISOString();
    }, () => this.state.flush(), () => {
      assertCurrent();
      const current = this.state.getDeploymentRun(runId);
      if (current !== run || current.candidate !== record || JSON.stringify(record) !== frozenRecord ||
        current.operationId !== frozen.operationId || current.commitSha !== frozen.targetSha || current.configHash !== frozen.configHash ||
        this.state.getBranch(run.branchId) !== branch || JSON.stringify(snapshotCandidateServices({ [profileId]: branch.services[profileId] })) !== frozenService) {
        throw new Error('candidate_serving_stop: owner or facts changed during persistence');
      }
    });
  }
}
