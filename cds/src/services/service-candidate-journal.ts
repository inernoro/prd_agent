import type { BranchEntry, DeploymentCandidateRecord, ServiceState } from '../types.js';
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

  async prepare(runId: string, candidate: BranchEntry, stopBeforeStart?: readonly string[]): Promise<DeploymentCandidateRecord> {
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
}
