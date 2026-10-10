import type { BranchEntry, DeploymentCandidateRecord, ServiceState } from '../types.js';
import type { StateService } from './state.js';
import { candidateRuntimeIdentity } from './service-candidate.js';

function snapshot(services: Record<string, ServiceState>): DeploymentCandidateRecord['services'] {
  const result: DeploymentCandidateRecord['services'] = Object.create(null);
  for (const [id, service] of Object.entries(services)) {
    // Explicit projection prevents logs, credentials and future arbitrary config fields entering this ledger.
    result[id] = { profileId: service.profileId, containerName: service.containerName, hostPort: service.hostPort,
      status: service.status, deployedMode: service.deployedMode, deployedImage: service.deployedImage,
      deployedArtifactRef: service.deployedArtifactRef, deployedPrebuilt: service.deployedPrebuilt,
      deployedCommitSha: service.deployedCommitSha };
  }
  return result;
}

/** Write-ahead ledger only. Preparing it never replaces the live graph or publishes routes. */
export class CandidateJournal {
  constructor(private readonly state: StateService) {}

  async prepare(runId: string, candidate: BranchEntry): Promise<DeploymentCandidateRecord> {
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
      networkName, phase: 'prepared', updatedAt: new Date().toISOString(), serving: snapshot(serving.services), services: snapshot(candidate.services) };
    this.state.updateDeploymentRun(runId, current => { current.candidate = record; });
    await this.state.flush(); // The caller must await this barrier before Docker create.
    return record;
  }
}
