import { createHash } from 'node:crypto';

import type {
  BranchEntry,
  BuildProfile,
  InfraService,
  RoutingRule,
  StandbyBranchSyncAction,
  StandbyBranchSyncPolicy,
  StandbyMirrorFingerprint,
} from '../types.js';
import { isSecretEnvKey } from './env-classifier.js';

const SECRET_PRESENT = '__cds_secret_present__';
const SECRET_MISSING = '__cds_secret_missing__';

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stable(item)]),
  );
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function scrubEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [
    key,
    isSecretEnvKey(key) ? (value ? SECRET_PRESENT : SECRET_MISSING) : value,
  ]));
}

function scrubProfile(profile: BuildProfile): BuildProfile {
  const { projectId: _projectId, ...portable } = profile;
  return {
    ...portable,
    ...(profile.env ? { env: scrubEnv(profile.env) } : {}),
    deployModes: profile.deployModes
      ? Object.fromEntries(Object.entries(profile.deployModes).map(([mode, config]) => [
          mode,
          { ...config, ...(config.env ? { env: scrubEnv(config.env) } : {}) },
        ]))
      : profile.deployModes,
  } as BuildProfile;
}

function scrubInfra(service: InfraService): InfraService {
  const { projectId: _projectId, ...portable } = service;
  return { ...portable, env: scrubEnv(service.env || {}) } as InfraService;
}

function scrubRule(rule: RoutingRule): RoutingRule {
  const { projectId: _projectId, ...portable } = rule;
  return portable as RoutingRule;
}

function branchName(branch: BranchEntry): string {
  return String(branch.branch || branch.id);
}

/**
 * 生成跨 CDS 可比较的项目指纹。
 *
 * 密钥值不会进入指纹载荷或响应；只保留「该 key 是否有值」。这样两台机器可以
 * 使用各自的生产密钥，同时仍能发现漏配。分支只带 commit/status，不带日志和环境。
 */
export function buildStandbyMirrorFingerprint(input: {
  projectId: string;
  repository?: string;
  defaultBranch?: string | null;
  profiles: BuildProfile[];
  env: Record<string, string>;
  infra: InfraService[];
  routingRules: RoutingRule[];
  branches: BranchEntry[];
  generatedAt?: string;
}): StandbyMirrorFingerprint {
  const env = scrubEnv(input.env);
  const secretKeys = Object.keys(input.env).filter(isSecretEnvKey).sort();
  const branches = input.branches
    .map((branch) => ({
      id: branch.id,
      name: branchName(branch),
      commitSha: branch.githubCommitSha || branch.pinnedCommit || null,
      status: branch.status,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const configPayload = {
    profiles: input.profiles.map(scrubProfile).sort((a, b) => a.id.localeCompare(b.id)),
    env,
    infra: input.infra.map(scrubInfra).sort((a, b) => a.id.localeCompare(b.id)),
    routingRules: input.routingRules.map(scrubRule).sort((a, b) => a.id.localeCompare(b.id)),
  };
  return {
    protocolVersion: 1,
    projectId: input.projectId,
    repository: input.repository || null,
    defaultBranch: input.defaultBranch || null,
    configHash: hash(configPayload),
    secretKeyHash: hash(secretKeys),
    secretKeyCount: secretKeys.length,
    branches,
    generatedAt: input.generatedAt || new Date().toISOString(),
  };
}

/**
 * 生成主站到备用站的分支收敛计划。
 *
 * 这里刻意不生成 delete/reset：目标独有分支可能承载本地排障，提交分叉也可能是
 * 人工回滚。自动删除或 reset 会把“备用”变成第二个破坏源，必须留给显式版本迁移。
 */
export function planStandbyBranchSync(
  source: StandbyMirrorFingerprint,
  target: StandbyMirrorFingerprint,
  policy: StandbyBranchSyncPolicy,
): StandbyBranchSyncAction[] {
  if (policy === 'audit-only') return [];
  const targetByName = new Map(target.branches.map((branch) => [branch.name, branch]));
  const actions: StandbyBranchSyncAction[] = [];

  for (const branch of source.branches) {
    const remote = targetByName.get(branch.name);
    if (!remote) {
      actions.push({
        name: branch.name,
        sourceStatus: branch.status,
        sourceCommit: branch.commitSha,
        kind: 'create',
        reason: '目标缺少该分支，先补齐分支目录',
      });
      if (policy === 'warm-running' && branch.status === 'running') {
        actions.push({
          name: branch.name,
          sourceStatus: branch.status,
          sourceCommit: branch.commitSha,
          kind: 'deploy',
          reason: '源站分支正在运行，创建后在备用站预热',
        });
      }
      continue;
    }

    if (branch.commitSha !== remote.commitSha) {
      actions.push({
        name: branch.name,
        sourceStatus: branch.status,
        sourceCommit: branch.commitSha,
        targetBranchId: remote.id,
        kind: 'divergent',
        reason: '两端提交不同，保留现场并阻止自动覆盖',
      });
      continue;
    }

    if (policy !== 'warm-running') continue;
    if (branch.status === 'running' && remote.status !== 'running') {
      actions.push({
        name: branch.name,
        sourceStatus: branch.status,
        sourceCommit: branch.commitSha,
        targetBranchId: remote.id,
        kind: 'deploy',
        reason: '源站运行、备用站未运行，补齐热备实例',
      });
    } else if (branch.status !== 'running' && remote.status === 'running') {
      actions.push({
        name: branch.name,
        sourceStatus: branch.status,
        sourceCommit: branch.commitSha,
        targetBranchId: remote.id,
        kind: 'stop',
        reason: '源站未运行、备用站仍运行，释放多余容量',
      });
    }
  }
  return actions;
}

export function percentile(samples: number[], ratio: number): number | null {
  if (samples.length === 0) return null;
  const sorted = samples.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return Math.round(sorted[index] * 10) / 10;
}

export function compareStandbyFingerprints(
  source: StandbyMirrorFingerprint,
  target: StandbyMirrorFingerprint,
): {
  configMatches: boolean;
  secretKeysMatch: boolean;
  repositoryMatches: boolean;
  defaultBranchMatches: boolean;
  missingBranches: string[];
  divergentBranches: Array<{ name: string; sourceCommit: string | null; targetCommit: string | null }>;
} {
  const targetByName = new Map(target.branches.map((branch) => [branch.name, branch]));
  const missingBranches: string[] = [];
  const divergentBranches: Array<{ name: string; sourceCommit: string | null; targetCommit: string | null }> = [];
  for (const branch of source.branches) {
    const remote = targetByName.get(branch.name);
    if (!remote) {
      missingBranches.push(branch.name);
      continue;
    }
    if (branch.commitSha !== remote.commitSha) {
      divergentBranches.push({ name: branch.name, sourceCommit: branch.commitSha, targetCommit: remote.commitSha });
    }
  }
  const defaultName = source.defaultBranch || 'main';
  const sourceDefault = source.branches.find((branch) => branch.name === defaultName);
  const targetDefault = target.branches.find((branch) => branch.name === defaultName);
  return {
    repositoryMatches: !!source.repository
      && !!target.repository
      && source.repository.toLowerCase() === target.repository.toLowerCase(),
    configMatches: source.configHash === target.configHash,
    secretKeysMatch: source.secretKeyHash === target.secretKeyHash,
    defaultBranchMatches: !!sourceDefault && !!targetDefault && sourceDefault.commitSha === targetDefault.commitSha,
    missingBranches,
    divergentBranches,
  };
}
