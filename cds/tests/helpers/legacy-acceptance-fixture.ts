import type { StateService } from '../../src/services/state.js';
import { acceptanceResourceDigest } from '../../src/services/acceptance-resource-run.js';

/** Test-only persisted legacy snapshot. This is NOT evidence of a new register or an executable migration. */
export async function seedPersistedLegacyRegistered(state: StateService, id: string): Promise<void> {
  const previous = state.getState().acceptanceResourceRuns![id], branch = state.getBranch(previous.branchId)!;
  const profiles = branch.extraProfiles?.filter(p => p.id === previous.profileId) || [];
  const service = branch.services[previous.profileId], deployment = state.getDeploymentRun(branch.lastDeploymentRunId!);
  if (previous.stage !== 'active' || previous.creationIntent || profiles.length !== 1 || !service?.containerId
    || deployment?.status !== 'running' || deployment.commitSha !== previous.targetSha) throw Error('invalid persisted legacy fixture');
  state.getState().acceptanceResourceRuns![id] = { ...previous, seq: previous.seq + 1, stage: 'registered',
    resource: { configDigest: acceptanceResourceDigest([profiles[0], branch.profileOverrides?.[previous.profileId] || null]),
      containerId: service.containerId, deploymentRunId: deployment.id } };
  state.save([{ kind: 'branches', id: branch.id }, { kind: 'global' }]); await state.flush();
}
