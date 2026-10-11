/*
 * branch-extra-services — 分支级「临时额外服务」合并的纯函数 SSOT。
 *
 * 背景(2026-06-29 用户要求):项目级 build profiles 是**稳定底座**(改它走审批、影响全体);
 * 单条分支可在底座之上**临时追加自己的服务**(branch-local),只在本分支部署、跑在分支专属网里、
 * 不进项目、不需全局审批、删分支即消失。详见 BranchEntry.extraProfiles 与
 * doc/design.cds.branch-local-extra-services.md。
 *
 * 这里只做一件事:把「项目 profiles」与「分支 extraProfiles」合并成这条分支**实际要部署**的清单。
 */

import type { BuildProfile, BranchEntry } from '../types.js';

/** 分支额外服务 id 合法性:小写/数字开头,可含 - _,长度 1..63(对齐 docker/profile 命名习惯)。 */
export function isValidExtraProfileId(id: string): boolean {
  return typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(id);
}

/** Match actual logical branch identity; malformed declarations never qualify. */
export type DeploymentScopeContext = Pick<BranchEntry, 'id' | 'projectId' | 'branch'>;
export function isValidDeploymentScope(value: unknown): value is NonNullable<BuildProfile['deploymentScope']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return Object.keys(scope).length === 3 && ['projectId', 'branchId'].every(key =>
    typeof scope[key] === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(scope[key] as string))
    && typeof scope.repoBranch === 'string' && scope.repoBranch.length > 0 && scope.repoBranch.length <= 256
    && !/[\s\x00-\x1f\x7f]/.test(scope.repoBranch);
}
export function profileDeploymentScopeMatches(profile: Pick<BuildProfile, 'deploymentScope'>, branch?: DeploymentScopeContext): boolean {
  if (profile.deploymentScope === undefined) return true;
  const scope = profile.deploymentScope;
  return isValidDeploymentScope(scope) && !!branch && scope.projectId === (branch.projectId || 'default')
    && scope.branchId === branch.id && scope.repoBranch === branch.branch;
}
export function assertProfileDeploymentScopes(profiles: ReadonlyArray<Pick<BuildProfile, 'deploymentScope'>>, branch?: DeploymentScopeContext): void {
  if (profiles.some(profile => !profileDeploymentScopeMatches(profile, branch))) throw new Error('deployment_scope_mismatch');
}
/** Placement preflight for one service; missing/infra dependencies keep their existing admission contracts. */
export function singleServicePlacementProfiles(profiles: readonly BuildProfile[], profileId: string): BuildProfile[] {
  const byId = new Map(profiles.map(profile => [profile.id, profile]));
  const pending = [profileId];
  const visited = new Set<string>(pending);
  const result: BuildProfile[] = [];
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index];
    const profile = byId.get(id);
    if (!profile) continue;
    result.push(profile);
    for (const dependency of profile.dependsOn || []) {
      if (visited.has(dependency)) continue;
      visited.add(dependency); pending.push(dependency);
    }
  }
  return result;
}
/** Snapshot-copy only: do not filter live/effective profiles or modify the source. */
export function copyBranchDeploymentConfig(source: BranchEntry, target: DeploymentScopeContext, projectProfileIds: ReadonlySet<string>, excludedExtraProfileIds: ReadonlySet<string> = new Set()) {
  const skippedExtraProfileIds = [...new Set((source.extraProfiles || [])
    .filter(profile => excludedExtraProfileIds.has(profile.id) || !profileDeploymentScopeMatches(profile, target)).map(profile => profile.id))];
  const skipped = new Set(skippedExtraProfileIds);
  const extraProfiles = structuredClone((source.extraProfiles || []).filter(profile => !skipped.has(profile.id)));
  const overrides = structuredClone(source.profileOverrides || {});
  for (const id of skipped) if (!projectProfileIds.has(id)) delete overrides[id];
  return { extraProfiles, profileOverrides: Object.keys(overrides).length ? overrides : undefined, skippedExtraProfileIds };
}

type ExtraDeploymentMetadata = Pick<BuildProfile, 'prebuiltImage' | 'prebuiltCommitPolicy' | 'artifactSource' | 'deploymentScope' | 'activeDeployMode' | 'deployModes' | 'buildScope' | 'calls' | 'role'>;
/** Bounded metadata projection for the existing extra-services API. No runtime-owned IDs. */
export function parseExtraDeploymentMetadata(raw: Record<string, unknown>, previous?: BuildProfile): ExtraDeploymentMetadata {
  const out: ExtraDeploymentMetadata = {};
  const value = (key: keyof ExtraDeploymentMetadata): unknown => raw[key] === undefined ? previous?.[key] : raw[key];
  const invalid = (): never => { throw new Error('extra_deployment_metadata_invalid'); };
  const strings = (input: unknown, scope: boolean): string[] => {
    if (!Array.isArray(input) || input.length > 128) return invalid();
    return input.map(item => {
      if (typeof item !== 'string' || !item || item.length > 256) return invalid();
      if (scope ? (!/^[a-zA-Z0-9._/*?-]+$/.test(item) || item.startsWith('/') || item.split('/').includes('..')) : !isValidExtraProfileId(item)) return invalid();
      return item;
    });
  };
  const image = (input: unknown): string => {
    if (typeof input !== 'string' || input.length > 512
      || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/.test(input.replace(/\$\{CDS_COMMIT_SHA\}|\$\{CDS_BRANCH_SLUG\}/g, 'x'))) return invalid();
    return input;
  };
  const prebuilt = value('prebuiltImage');
  if (prebuilt !== undefined) {
    if (typeof prebuilt !== 'boolean') return invalid();
    out.prebuiltImage = prebuilt;
  }
  const policy = value('prebuiltCommitPolicy');
  if (policy !== undefined && policy !== null) {
    if (policy !== 'exact' || prebuilt !== true) return invalid();
    out.prebuiltCommitPolicy = policy;
  }
  const scope = value('deploymentScope');
  if (scope !== undefined && scope !== null) {
    if (!isValidDeploymentScope(scope)) return invalid();
    out.deploymentScope = { ...scope };
  }
  const source = value('artifactSource');
  if (source !== undefined && source !== null) {
    if (typeof source !== 'string' || !/^https:\/\/github\.com\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(source)) return invalid();
    out.artifactSource = source;
  }
  for (const key of ['buildScope', 'calls'] as const) {
    const input = value(key);
    if (input !== undefined && input !== null) out[key] = strings(input, key === 'buildScope');
  }
  const role = value('role');
  if (role !== undefined && role !== null) {
    if (role !== 'web' && role !== 'api' && role !== 'worker') return invalid();
    out.role = role;
  }
  const modes = value('deployModes');
  if (modes !== undefined && modes !== null) {
    if (typeof modes !== 'object' || Array.isArray(modes) || Object.keys(modes).length > 16) return invalid();
    out.deployModes = {};
    for (const [id, input] of Object.entries(modes)) {
      if (!isValidExtraProfileId(id) || ['__proto__', 'constructor', 'prototype'].includes(id)
        || !input || typeof input !== 'object' || Array.isArray(input)) return invalid();
      const mode = input as Record<string, unknown>;
      if (Object.keys(mode).some(key => !['label', 'dockerImage', 'prebuilt', 'commitPolicy', 'buildScope', 'containerPort'].includes(key))
        || mode.prebuilt !== true || mode.commitPolicy !== 'exact' || typeof mode.label !== 'string' || !mode.label || mode.label.length > 128) return invalid();
      const port = mode.containerPort;
      if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) return invalid();
      out.deployModes[id] = { label: mode.label, prebuilt: true, commitPolicy: 'exact',
        ...(mode.dockerImage !== undefined ? { dockerImage: image(mode.dockerImage) } : {}),
        ...(mode.buildScope !== undefined ? { buildScope: strings(mode.buildScope, true) } : {}),
        ...(port !== undefined ? { containerPort: port as number } : {}) };
    }
  }
  const active = value('activeDeployMode');
  if (active !== undefined && active !== null) {
    if (typeof active !== 'string' || !out.deployModes?.[active]) return invalid();
    out.activeDeployMode = active;
  }
  return out;
}

/**
 * 服务命名子域 label 合法性:单 DNS label —— 全小写字母/数字/连字符,不以连字符开头/结尾,长度 1..40。
 *
 * 约束来由:命名 URL 是 `<previewSlug>-<subdomain>.<rootDomain>`,整段 `<previewSlug>-<subdomain>`
 * 必须是**单级**子域才能落在 `*.<rootDomain>` 通配证书下(forwarder hostMatches 拒绝多级)。subdomain
 * 自身禁含 `.`(否则拼出两级)、禁大写(DNS 大小写不敏感但 host 比对走 lowercase)、限长以免和长 previewSlug
 * 拼接后超过 DNS label 63 上限。
 */
// 保留伪值:字符串 "null"/"undefined"/"none"/"true"/"false"/"nan" 虽是合法 DNS label 形状,
// 但几乎总是序列化/默认值漏网(如 JSON 字符串 "null" 或 compose label cds.subdomain: "null"),
// 当真子域用会发布 `<previewSlug>-null.<root>` 这类伪 host —— 与 JSON null 守卫要堵的是同一类问题
// (Cursor Bugbot)。在 shape 校验之外显式拒绝这组保留字。
const RESERVED_SUBDOMAIN_LABELS = new Set(['null', 'undefined', 'none', 'true', 'false', 'nan']);

export function isValidServiceSubdomain(sub: string): boolean {
  return (
    typeof sub === 'string' &&
    /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(sub) &&
    !RESERVED_SUBDOMAIN_LABELS.has(sub)
  );
}

/**
 * 合并「项目级 profile(稳定底座)」+「分支级临时额外服务」。
 *
 * 规则:
 *  - 分支没声明 extraProfiles(absent/空)→ **原样返回项目 profiles**(老行为零回归)。
 *  - 额外服务只能 ADD **新 id**;与项目 profile 撞 id → **以项目为准**,忽略该额外项
 *    (保护稳定底座不被分支意外改写;要按分支改项目服务用 profileOverrides)。
 *  - 额外服务之间 id 重复 → 保留首个,忽略后续。
 *  - 顺序:项目 profiles 在前,分支额外服务在后(稳定项先起,额外项后挂)。
 *
 * 纯函数,不读 state,便于单测。
 */
export function mergeBranchProfiles(
  projectProfiles: BuildProfile[],
  branch: Pick<BranchEntry, 'extraProfiles'> | undefined,
): BuildProfile[] {
  const extras = branch?.extraProfiles;
  if (!extras || extras.length === 0) return projectProfiles;
  const seen = new Set(projectProfiles.map((p) => p.id));
  const merged = projectProfiles.slice();
  for (const extra of extras) {
    if (!extra || !extra.id || !isValidExtraProfileId(extra.id)) continue;
    if (seen.has(extra.id)) continue; // 撞项目 id 或额外项内部重复 → 跳过(底座优先)
    seen.add(extra.id);
    merged.push(extra);
  }
  return merged;
}
