import { createHash, createHmac, randomBytes } from 'node:crypto';

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
import { toCdsCompose } from './compose-parser.js';
import { mergeBranchProfiles } from './branch-extra-services.js';
import { resolveEffectiveProfile } from './container.js';
import { confirmedRunningRevisionSha } from './running-version.js';
import { normalizeRepositoryIdentity } from './release-strategy.js';
import { configuredProfileEnvLayers } from './branch-env-layers.js';
import { effectiveDbInit } from './db-init-mode.js';

const SECRET_PRESENT = '__cds_secret_present__';
const SECRET_MISSING = '__cds_secret_missing__';
// A process-local opaque precondition, never an access credential or persisted secret.
const CONFIG_REVISION_KEY = randomBytes(32);

/** Reject partial/cross-project protocol replies before storing or dereferencing them. */
export function assertStandbyFingerprint(value: unknown, projectId: string): asserts value is StandbyMirrorFingerprint {
  const invalid = (field: string, item: unknown, present = true): never => {
    const state = !present ? 'missing' : item === null ? 'null' : item === '' ? 'empty'
      : typeof item === 'string' && !item.trim() ? 'whitespace' : `invalid-${Array.isArray(item) ? 'array' : typeof item}`;
    throw new Error(`目标指纹字段 ${field} 为 ${state}`);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('response', value);
  const record = value as Record<string, any>;
  if (record.protocolVersion !== 1) invalid('protocolVersion', record.protocolVersion, 'protocolVersion' in record);
  if (record.projectId !== projectId) invalid('projectId', record.projectId, 'projectId' in record);
  for (const name of ['configHash', 'secretKeyHash']) if (typeof record[name] !== 'string' || !/^[a-f0-9]{64}$/i.test(record[name])) invalid(name, record[name], name in record);
  for (const name of ['repository', 'defaultBranch']) if (record[name] !== null && typeof record[name] !== 'string') invalid(name, record[name], name in record);
  if (!Number.isInteger(record.secretKeyCount) || record.secretKeyCount < 0) invalid('secretKeyCount', record.secretKeyCount, 'secretKeyCount' in record);
  if (typeof record.generatedAt !== 'string' || !Number.isFinite(Date.parse(record.generatedAt))) invalid('generatedAt', record.generatedAt, 'generatedAt' in record);
  if (!Array.isArray(record.branches)) invalid('branches', record.branches, 'branches' in record);
  const ids = new Set<string>(), names = new Set<string>();
  for (const [index, branch] of record.branches.entries()) {
    if (!branch || typeof branch !== 'object') invalid(`branches.${index}`, branch);
    for (const field of ['id', 'name', 'status']) if (typeof branch[field] !== 'string' || !branch[field].trim() || branch[field].length > 256) invalid(`branches.${index}.${field}`, branch[field], field in branch);
    if (ids.has(branch.id) || names.has(branch.name)) invalid(`branches.${index}.identity`, null);
    ids.add(branch.id); names.add(branch.name);
    if (branch.commitSha !== null && (typeof branch.commitSha !== 'string' || !/^[a-f0-9]{40}$/i.test(branch.commitSha))) invalid(`branches.${index}.commitSha`, branch.commitSha, 'commitSha' in branch);
    if (branch.pinnedCommit != null && (typeof branch.pinnedCommit !== 'string' || !/^[a-f0-9]{40}$/i.test(branch.pinnedCommit))) invalid(`branches.${index}.pinnedCommit`, branch.pinnedCommit);
    for (const field of ['commitIdentityConfirmed', 'runtimeIdentityConfirmed']) if (branch[field] !== undefined && typeof branch[field] !== 'boolean') invalid(`branches.${index}.${field}`, branch[field]);
    if (record.capabilities?.runtimeIdentity && branch.status === 'running' && typeof branch.runtimeIdentityConfirmed !== 'boolean') invalid(`branches.${index}.runtimeIdentityConfirmed`, branch.runtimeIdentityConfirmed, false);
    if (record.capabilities?.branchConfigIdentity) for (const field of ['configHash', 'secretKeyHash', 'configurationRevision']) {
      if (typeof branch[field] !== 'string' || !/^[a-f0-9]{64}$/i.test(branch[field])) invalid(`branches.${index}.${field}`, branch[field], field in branch);
    }
  }
}

/** The action budget cannot split a missing branch's create/deploy transaction plan. */
export function limitStandbySyncActions(actions: StandbyBranchSyncAction[], limit = 100): StandbyBranchSyncAction[] {
  const groups = new Map<string, StandbyBranchSyncAction[]>();
  for (const action of actions) groups.set(action.name, [...(groups.get(action.name) || []), action]);
  const selected: StandbyBranchSyncAction[] = [];
  let executableCount = 0;
  for (const group of groups.values()) {
    const cost = group.filter(action => action.kind !== 'divergent').length;
    if (executableCount + cost > limit) continue;
    selected.push(...group);
    executableCount += cost;
  }
  return selected;
}

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

function scrubProfile(profile: BuildProfile, depth = 0): BuildProfile {
  const { projectId: _projectId, sourceFallbackProfile, ...portable } = profile;
  return {
    ...portable,
    ...(profile.env ? { env: scrubEnv(profile.env) } : {}),
    ...(sourceFallbackProfile && depth < 2 ? { sourceFallbackProfile: scrubProfile(sourceFallbackProfile, depth + 1) } : {}),
    ...(profile.cacheMounts ? { cacheMounts: profile.cacheMounts.map(portableMount) } : {}),
    deployModes: profile.deployModes
      ? Object.fromEntries(Object.entries(profile.deployModes).map(([mode, config]) => [
          mode,
          { ...config, ...(config.env ? { env: scrubEnv(config.env) } : {}) },
        ]))
      : profile.deployModes,
  } as BuildProfile;
}

function portableMount<T extends { name?: string; hostPath?: string; storage?: import('../types.js').StorageBinding }>(mount: T): T {
  if (!mount.storage) return mount;
  const { instanceId: _instanceId, projectId: _projectId, branchId: _branchId, ...logical } = mount.storage;
  const name = `storage-${logical.scope}-${logical.serviceId}-${logical.mountKey}`;
  return { ...mount, name, ...(mount.hostPath !== undefined ? { hostPath: name } : {}), storage: logical as import('../types.js').StorageBinding };
}

function scrubInfra(service: InfraService): string {
  const { projectId: _projectId, ...portable } = service;
  return toCdsCompose([], {}, [stable({ ...portable, env: scrubEnv(service.env || {}), volumes: (service.volumes || []).map(portableMount) }) as InfraService], []);
}

function repositoryIdentity(value: string | null): string {
  if (!value) return '';
  const scp = value.match(/^[^@\s]+@([^:\s]+):/);
  let host = scp?.[1]?.toLowerCase() || 'github.com';
  let repository = value;
  if (!scp) {
    try { host = new URL(value).hostname.toLowerCase(); }
    catch {
      const canonical = value.match(/^([^/]+\.[^/]+)\/(.+)$/);
      if (canonical) { host = canonical[1].toLowerCase(); repository = canonical[2]; }
    }
  }
  return `${host.replace(/^www\./, '')}/${normalizeRepositoryIdentity(repository)}`;
}

function scrubRule(rule: RoutingRule): RoutingRule {
  const { projectId: _projectId, ...portable } = rule;
  return portable as RoutingRule;
}

function branchName(branch: BranchEntry): string {
  return String(branch.branch || branch.id);
}

/** Runtime isolation is not part of Compose export; keep its effective intent explicitly. */
function databaseIsolationIdentity(profile: BuildProfile, depth = 0): unknown {
  return { scope: profile.dbScope || 'shared', init: profile.dbScope === 'per-branch' ? effectiveDbInit(profile) : null,
    ...(profile.sourceFallbackProfile && depth < 2 ? { fallback: databaseIsolationIdentity(profile.sourceFallbackProfile, depth + 1) } : {}) };
}

/** Portable configured layers only; node-derived runtime IDs/URLs are deliberately excluded. */
export function buildStandbyBranchConfiguration(input: {
  profiles: BuildProfile[]; env: Record<string, string>; branch?: BranchEntry; branchEnv?: Record<string, string>;
  infra: InfraService[]; routingRules: RoutingRule[];
}): { configHash: string; secretKeyHash: string; secretKeyCount: number; configurationRevision: string } {
  const baseEnv = { ...input.env, ...input.branchEnv };
  const secretKeys = new Set(Object.keys(baseEnv).filter(isSecretEnvKey));
  const secretScopes: Array<{ profile: string; keys: string[] }> = [];
  const localProfiles: Array<{ id: string; config: string; database: unknown }> = [];
  const profiles = mergeBranchProfiles(input.profiles, input.branch).map(baseline => {
    const layers = configuredProfileEnvLayers(baseline, input.branch, !!input.branch?.extraProfiles?.some(profile => profile.id === baseline.id));
    const env = Object.assign({}, baseEnv, ...layers.map(layer => layer.env)) as Record<string, string>;
    const keys = Object.keys(env).filter(isSecretEnvKey).sort(); keys.forEach(key => secretKeys.add(key));
    secretScopes.push({ profile: baseline.id, keys });
    const resolved = resolveEffectiveProfile(baseline, input.branch, { preserveImageTemplates: true });
    const effective = { ...resolved, workDir: resolved.workDir || '.' };
    const database = databaseIsolationIdentity(effective);
    localProfiles.push({ id: baseline.id, config: toCdsCompose([stable({ ...effective, env }) as BuildProfile], {}, [], []), database });
    return { id: baseline.id, database, config: toCdsCompose([stable({ ...scrubProfile(effective), env: scrubEnv(env) }) as BuildProfile], {}, [], []) };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const configHash = hash({ profiles, env: scrubEnv(baseEnv),
    infra: [...input.infra].sort((a, b) => a.id.localeCompare(b.id)).map(scrubInfra),
    routingRules: input.routingRules.map(scrubRule).sort((a, b) => a.id.localeCompare(b.id)) });
  const localInfra = [...input.infra].sort((a, b) => a.id.localeCompare(b.id)).map(service => toCdsCompose([], {}, [stable(service) as InfraService], []));
  const configurationRevision = createHmac('sha256', CONFIG_REVISION_KEY).update(JSON.stringify(stable({
    profiles: localProfiles, env: baseEnv, infra: localInfra, routingRules: input.routingRules.map(scrubRule),
  }))).digest('hex');
  return { configHash, secretKeyHash: hash({ project: Object.keys(baseEnv).filter(isSecretEnvKey).sort(),
    profiles: secretScopes.sort((a, b) => a.profile.localeCompare(b.profile)) }), secretKeyCount: secretKeys.size, configurationRevision };
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
  branchEnvs?: Record<string, Record<string, string>>;
  generatedAt?: string;
}): StandbyMirrorFingerprint {
  const configurationFor = (branch?: BranchEntry) => buildStandbyBranchConfiguration({ ...input, branch,
    branchEnv: branch ? input.branchEnvs?.[branch.id] : undefined });
  const branches = input.branches
    .map((branch) => {
      const actualCommit = confirmedRunningRevisionSha(branch);
      const configuration = configurationFor(branch);
      return {
      id: branch.id,
      name: branchName(branch),
      commitSha: branch.pinnedCommit || actualCommit || branch.githubCommitSha || null,
      pinnedCommit: branch.pinnedCommit || null,
      commitIdentityConfirmed: !!branch.githubCommitSha && (!branch.pinnedCommit || branch.pinnedCommit === branch.githubCommitSha)
        && (!actualCommit || actualCommit === branch.githubCommitSha),
      runtimeIdentityConfirmed: branch.status === 'running' ? !!actualCommit : undefined,
      configHash: configuration.configHash,
      secretKeyHash: configuration.secretKeyHash,
      configurationRevision: configuration.configurationRevision,
      status: branch.status,
    }; })
    .sort((a, b) => a.name.localeCompare(b.name));
  const defaultEntry = input.branches.find(branch => branchName(branch) === input.defaultBranch);
  const defaultConfiguration = configurationFor(defaultEntry);
  return {
    protocolVersion: 1,
    capabilities: { expectedCommitCreate: true, pinAwareIdentity: true, runtimeIdentity: true, branchConfigIdentity: true },
    projectId: input.projectId,
    repository: input.repository ? repositoryIdentity(input.repository) : null,
    defaultBranch: input.defaultBranch || null,
    ...defaultConfiguration,
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
    if (policy === 'warm-running' && (!branch.configHash || !branch.secretKeyHash
      || (remote && (remote.configHash !== branch.configHash || remote.secretKeyHash !== branch.secretKeyHash)))) {
      actions.push({ name: branch.name, sourceStatus: branch.status, sourceCommit: branch.commitSha, targetBranchId: remote?.id,
        kind: 'divergent', configurationDivergence: true, reason: '分支生效配置或密钥项身份不一致/未知，保留目标配置并拒绝预热' });
      continue;
    }
    if (!branch.commitSha || branch.commitIdentityConfirmed === false || (remote && (!remote.commitSha || remote.commitIdentityConfirmed === false))
      || (policy === 'warm-running' && ((branch.status === 'running' && branch.runtimeIdentityConfirmed === false)
        || (remote?.status === 'running' && remote.runtimeIdentityConfirmed === false)))) {
      actions.push({ name: branch.name, sourceStatus: branch.status, sourceCommit: branch.commitSha,
        targetBranchId: remote?.id, kind: 'divergent', reason: '提交身份尚未确认，保留现场并阻止同步与预热' });
      continue;
    }
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

    if (!branch.commitSha || !remote.commitSha || branch.commitSha !== remote.commitSha) {
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

    if (policy !== 'warm-running' || remote.pinnedCommit) continue;
    // building 仍可能保留正在服务的旧 runtime，错误/过渡态都不是停机意图。
    const sourceStopped = branch.status === 'idle' || branch.status === 'stopped';
    const targetStopped = remote.status === 'idle' || remote.status === 'stopped';
    if (branch.status === 'running' && targetStopped) {
      actions.push({
        name: branch.name,
        sourceStatus: branch.status,
        sourceCommit: branch.commitSha,
        targetBranchId: remote.id,
        kind: 'deploy',
        reason: '源站运行、备用站未运行，补齐热备实例',
      });
    } else if (sourceStopped && remote.status === 'running') {
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
    if (!branch.commitSha || !remote.commitSha || branch.commitIdentityConfirmed === false || remote.commitIdentityConfirmed === false || branch.commitSha !== remote.commitSha) {
      divergentBranches.push({ name: branch.name, sourceCommit: branch.commitSha, targetCommit: remote.commitSha });
    }
  }
  const defaultName = source.defaultBranch || 'main';
  const sourceDefault = source.branches.find((branch) => branch.name === defaultName);
  const targetDefault = target.branches.find((branch) => branch.name === defaultName);
  return {
    repositoryMatches: !!source.repository
      && !!target.repository
      && repositoryIdentity(source.repository) === repositoryIdentity(target.repository),
    configMatches: source.configHash === target.configHash,
    secretKeysMatch: source.secretKeyHash === target.secretKeyHash,
    defaultBranchMatches: !!source.defaultBranch && source.defaultBranch === target.defaultBranch && !!sourceDefault?.commitSha && !!targetDefault?.commitSha
      && sourceDefault.status === 'running' && targetDefault.status === 'running'
      && sourceDefault.runtimeIdentityConfirmed === true && targetDefault.runtimeIdentityConfirmed === true
      && sourceDefault.commitIdentityConfirmed !== false && targetDefault.commitIdentityConfirmed !== false
      && sourceDefault.commitSha === targetDefault.commitSha,
    missingBranches,
    divergentBranches,
  };
}
