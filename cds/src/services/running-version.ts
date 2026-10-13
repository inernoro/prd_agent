import type { BranchEntry, DeploymentVersion } from '../types.js';

/** 只认已运行产物与成功版本，绝不拿推送目标冒充运行版本。 */
export function runningCommitSha(branch: BranchEntry, version?: DeploymentVersion, profileId?: string): string | undefined {
  const services = Object.values(branch.services || {}).filter(s => s.status === 'running' && (!profileId || s.profileId === profileId));
  if (!services.length) return undefined;
  const validVersion = version && version.id === branch.currentVersionId && version.branchId === branch.id && version.projectId === branch.projectId ? version : undefined;
  const commits = services.map(service => {
    const imageSha = service.deployedImage?.match(/:sha-([a-f0-9]{40})(?:@sha256:[a-f0-9]+)?$/i)?.[1];
    if (imageSha) return imageSha.toLowerCase();
    const artifact = validVersion?.profiles.find(p => p.profileId === service.profileId);
    return artifact && service.deployedImage && artifact.artifactImage === service.deployedImage
      ? validVersion?.commitSha : undefined;
  });
  return commits.every(sha => sha && sha === commits[0]) ? commits[0] : undefined;
}

export function branchVersionFacts(branch: BranchEntry, version?: DeploymentVersion) {
  return {
    runningCommitSha: runningCommitSha(branch, version) ?? null,
    targetCommitSha: branch.ciTargetSha || branch.githubCommitSha || null,
  };
}
