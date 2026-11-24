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
import { normalizeProjectProfileDependencies } from './project-profile-dependencies.js';

/** 分支额外服务 id 合法性:小写/数字开头,可含 - _,长度 1..63(对齐 docker/profile 命名习惯)。 */
export function isValidExtraProfileId(id: string): boolean {
  return typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(id);
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
  branch: Pick<BranchEntry, 'extraProfiles' | 'excludedProjectProfileIds'> | undefined,
): BuildProfile[] {
  const extras = branch?.extraProfiles;
  const excluded = new Set(branch?.excludedProjectProfileIds || []);
  if ((!extras || extras.length === 0) && excluded.size === 0) return projectProfiles;
  const seen = new Set(projectProfiles.map((p) => p.id));
  // Reserve every baseline id, including excluded ids: an extra must never adopt it.
  const merged = projectProfiles.filter(p => !excluded.has(p.id));
  for (const extra of extras || []) {
    if (!extra || !extra.id || !isValidExtraProfileId(extra.id)) continue;
    if (seen.has(extra.id)) continue; // 撞项目 id 或额外项内部重复 → 跳过(底座优先)
    seen.add(extra.id);
    merged.push(extra);
  }
  return merged;
}

/** Validate only explicitly isolated branches; legacy branches keep their existing behavior. */
export function assertBranchServiceIsolation(
  projectProfiles: BuildProfile[], branch: BranchEntry, infraIds: string[] = [], idSuffix = '',
): void {
  const excluded = branch.excludedProjectProfileIds;
  if (excluded == null || (Array.isArray(excluded) && excluded.length === 0)) return;
  const baselineIds = new Set(projectProfiles.map(p => p.id));
  if (!Array.isArray(excluded) || new Set(excluded).size !== excluded.length
    || excluded.some(id => !isValidExtraProfileId(id) || !baselineIds.has(id))) {
    throw new Error('分支排除清单必须是不重复的项目服务标识');
  }
  const all = normalizeProjectProfileDependencies(
    mergeBranchProfiles(projectProfiles, { ...branch, excludedProjectProfileIds: [] }), idSuffix,
    branch.profileOverrides,
  );
  const retained = all.filter(p => !excluded.includes(p.id));
  if (!retained.length) throw new Error('分支至少保留一项服务');
  const ids = new Set(retained.map(p => p.id));
  const allowed = new Set([...ids, ...infraIds]);
  for (const p of retained) {
    for (const target of [...(p.dependsOn || []), ...(p.calls || [])]) {
      if (!allowed.has(target)) throw new Error(`服务 ${p.id} 仍引用已排除或不存在的服务 ${target}`);
    }
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const byId = new Map(retained.map(p => [p.id, p]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('分支服务启动依赖存在循环');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of byId.get(id)?.dependsOn || []) if (ids.has(next)) visit(next);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
}
