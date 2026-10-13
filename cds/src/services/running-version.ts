import type { BranchEntry, DeploymentVersion } from '../types.js';

/** 只认服务实际运行的提交镜像，分支版本不能证明每个服务都已重启。 */
export function runningCommitSha(branch: BranchEntry, _version?: DeploymentVersion, profileId?: string): string | undefined {
  const services = Object.values(branch.services || {}).filter(s => s.status === 'running' && (!profileId || s.profileId === profileId));
  if (!services.length) return undefined;
  const commits = services.map(service => {
    // managed-project 的 sha 标签是配置指纹，不是 Git 提交。
    if (service.deployedImage?.startsWith('cds-managed/')) return undefined;
    const imageSha = service.deployedImage?.match(/:sha-([a-f0-9]{40})(?:@sha256:[a-f0-9]+)?$/i)?.[1];
    return imageSha?.toLowerCase();
  });
  return commits.every(sha => sha && sha === commits[0]) ? commits[0] : undefined;
}

export function branchVersionFacts(branch: BranchEntry, version?: DeploymentVersion) {
  return {
    runningCommitSha: runningCommitSha(branch, version) ?? null,
    targetCommitSha: branch.ciTargetSha || branch.githubCommitSha || null,
  };
}
