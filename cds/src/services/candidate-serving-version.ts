import { assertProfileDeploymentScopes } from './branch-extra-services.js';
import type { BranchEntry, CandidateRecoveryProof, DeploymentVersionProfile } from '../types.js';
import type { StateService } from './state.js';
import { deploymentVersionFingerprint } from './deployment-version.js';

function validProbe(value: DeploymentVersionProfile['readinessProbe']): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (value.path === undefined || typeof value.path === 'string' && value.path.startsWith('/')) &&
    (value.noHttp === undefined || typeof value.noHttp === 'boolean') &&
    [value.intervalSeconds, value.timeoutSeconds].every(number => number === undefined ||
      typeof number === 'number' && Number.isFinite(number) && number > 0);
}

type VersionProof = NonNullable<CandidateRecoveryProof['servingVersion']>;

/** The incoming profile cannot redefine whether a stopped original consumer is ready. */
export function captureServingVersion(state: Pick<StateService, 'getDeploymentVersion'>, branch: BranchEntry,
  profileIds: readonly string[]): { proof: VersionProof; profiles: ReadonlyMap<string, DeploymentVersionProfile> } {
  const version = branch.currentVersionId && state.getDeploymentVersion(branch.currentVersionId);
  if (!version || version.id !== branch.currentVersionId || version.branchId !== branch.id || version.projectId !== branch.projectId ||
    typeof version.commitSha !== 'string' || !/^[a-f0-9]{40}$/.test(version.commitSha) ||
    typeof version.configHash !== 'string' || !version.configHash || !Array.isArray(version.profiles) ||
    version.profiles.some(profile => !profile || typeof profile.profileId !== 'string') ||
    new Set(version.profiles.map(profile => profile.profileId)).size !== version.profiles.length) {
    throw new Error('candidate_serving_version: complete original version required before stopping');
  }
  assertProfileDeploymentScopes(version.profiles, branch);
  const profiles = new Map<string, DeploymentVersionProfile>();
  for (const id of profileIds) {
    const profile = version.profiles.find(profile => profile.profileId === id); const service = branch.services[id];
    if (!profile || profile.replacementContractVersion !== 1 || !validProbe(profile.readinessProbe) ||
      (profile.startupSignal !== undefined && typeof profile.startupSignal !== 'string') || !service || service.deployedCommitSha !== version.commitSha ||
      !/^sha256:[a-f0-9]{64}$/.test(service.deployedImage || '') ||
      profile.artifactImage !== (service.deployedArtifactRef || service.deployedImage) ||
      !Number.isInteger(profile.containerPort) || profile.containerPort < 1 || profile.containerPort > 65535) {
      throw new Error('candidate_serving_version: original runtime and readiness identity mismatch');
    }
    profiles.set(id, structuredClone(profile));
  }
  return { proof: { id: version.id, fingerprint: deploymentVersionFingerprint(version) }, profiles };
}

export function assertServingVersion(state: Pick<StateService, 'getDeploymentVersion'>, branch: BranchEntry, proof: VersionProof): void {
  const current = state.getDeploymentVersion(proof.id);
  if (!current || branch.currentVersionId !== proof.id || current.branchId !== branch.id || current.projectId !== branch.projectId ||
    deploymentVersionFingerprint(current) !== proof.fingerprint) throw new Error('candidate_serving_version: original recovery contract changed');
}
