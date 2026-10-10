import type { BranchEntry, BuildProfile } from '../types.js';
import type { ManagedProjectPlan } from './managed-project.js';

/** 私有执行输入，禁止放入公开操作、run、事件或重放 HTTP body。 */
export interface DeploymentInputSnapshot {
  profiles: BuildProfile[];
  profileOverrides: BranchEntry['profileOverrides'];
  ciTargetSha: BranchEntry['ciTargetSha'];
  /** 完整固定提交在受理前即可解析模板，不借用会在受理后被更新的缓存 SHA。 */
  targetCommitSha?: string;
  configuredEnv: Record<string, string>;
  managedPlan?: ManagedProjectPlan | null;
  configHash?: string;
  agentRequest?: boolean;
  agentPrebuiltGated?: boolean;
}

export function captureDeploymentInput(
  branch: BranchEntry, profiles: BuildProfile[], configuredEnv: Record<string, string>, managedPlan?: ManagedProjectPlan | null, requestedCommitSha?: string,
): DeploymentInputSnapshot {
  return structuredClone({ profiles, configuredEnv, profileOverrides: branch.profileOverrides, ciTargetSha: branch.ciTargetSha, managedPlan,
    targetCommitSha: requestedCommitSha && /^[0-9a-f]{40}$/i.test(requestedCommitSha) ? requestedCommitSha.toLowerCase() : undefined });
}

/** 保留当前实际源码提交/运行身份，只使用受理时的配置覆盖及 CI 产物目标。 */
export function deploymentInputBranch(input: DeploymentInputSnapshot, branch: BranchEntry): BranchEntry {
  return { ...branch, profileOverrides: input.profileOverrides, ciTargetSha: input.ciTargetSha,
    githubCommitSha: input.targetCommitSha || branch.githubCommitSha };
}
