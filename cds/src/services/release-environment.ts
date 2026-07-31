/**
 * release-environment — 发布目标「环境」归一 / 标签 / 分组的**唯一判定源**。
 *
 * 为什么要单独一个模块：环境本来只是 ReleaseTarget 上一个可缺省字段，
 * 于是「缺省算什么」这件事此前散在三处各判一遍——路由的 normalizeEnvironment、
 * state 层的 canonical 唯一性约束、前端渲染左栏时自己 `?? 'production'`。
 * 三份判据只要有一处漏了新枚举值或改了缺省，同一个目标就会在不同页面
 * 落进不同的环境组，而且没有任何东西会变红（判据分裂，predicate-and-wiring-discipline 形状 3）。
 *
 * 归一口径是「白名单 + 其余一律 production」而不是「未知就报错」：
 * environment 是可缺省字段，存量目标一个都没有；把缺省解读成生产，
 * 与 state.ts 里 canonical 唯一性约束的既有语义完全一致，不新造语义。
 */

import type { ReleaseTarget } from '../types.js';

export type ReleaseEnvironment = NonNullable<ReleaseTarget['environment']>;

/** 展示顺序 = 关注度顺序：生产在最前，其他垫底。同时也是分组的输出顺序。 */
export const RELEASE_ENVIRONMENT_ORDER: readonly ReleaseEnvironment[] = ['production', 'staging', 'other'];

const ENVIRONMENT_LABELS: Record<ReleaseEnvironment, string> = {
  production: '生产',
  staging: '预发',
  other: '其他',
};

/**
 * 归一：只有字面量 'staging' / 'other' 是它们自己，其余（含 undefined / 未知字符串）
 * 一律 production。与 routes/releases.ts 迁移前的 normalizeEnvironment 完全同口径。
 */
export function normalizeReleaseEnvironment(value: unknown): ReleaseEnvironment {
  return value === 'staging' || value === 'other' ? value : 'production';
}

export function releaseEnvironmentLabel(value: unknown): string {
  return ENVIRONMENT_LABELS[normalizeReleaseEnvironment(value)];
}

export interface ReleaseEnvironmentGroup {
  environment: ReleaseEnvironment;
  /** 中文标签。后端给定，前端不再自己映射一份。 */
  label: string;
  /** 已排好序（canonical 优先，其余按名字），前端直接渲染左栏。 */
  targetIds: string[];
  /** 该环境当前生效的权威目标；没有启用的 canonical 时缺省。 */
  canonicalTargetId?: string;
  /** 组内被停用的活跃目标数。归档目标不在本组内，也不重复计。 */
  disabledCount: number;
}

/** 排序用的 canonical 判定：字段缺省即 true，与 POST/PATCH 的 `!== false` 同口径。 */
function isCanonicalTarget(target: ReleaseTarget): boolean {
  return target.isCanonical !== false;
}

/**
 * 按环境分组。归档目标直接排除——它们由 `GET /releases/targets` 的
 * archivedTargets 单独承载，混进环境组会让左栏出现点不动的死条目。
 */
export function groupReleaseTargetsByEnvironment(
  targets: ReadonlyArray<ReleaseTarget>,
): ReleaseEnvironmentGroup[] {
  const buckets = new Map<ReleaseEnvironment, ReleaseTarget[]>();
  for (const target of targets) {
    if (target.lifecycle === 'archived') continue;
    const env = normalizeReleaseEnvironment(target.environment);
    const bucket = buckets.get(env);
    if (bucket) bucket.push(target);
    else buckets.set(env, [target]);
  }

  const groups: ReleaseEnvironmentGroup[] = [];
  for (const environment of RELEASE_ENVIRONMENT_ORDER) {
    const bucket = buckets.get(environment);
    if (!bucket || bucket.length === 0) continue;
    const sorted = [...bucket].sort((a, b) => {
      const canonicalDelta = Number(isCanonicalTarget(b)) - Number(isCanonicalTarget(a));
      if (canonicalDelta !== 0) return canonicalDelta;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
    // canonical 指的是「当前真的在承载这个环境的那一个」，所以停用的不算：
    // state.ts 的唯一性约束本身也只对 isEnabled 的 canonical 生效。
    const canonical = sorted.find((target) => isCanonicalTarget(target) && target.isEnabled);
    groups.push({
      environment,
      label: releaseEnvironmentLabel(environment),
      targetIds: sorted.map((target) => target.id),
      ...(canonical ? { canonicalTargetId: canonical.id } : {}),
      disabledCount: sorted.filter((target) => !target.isEnabled).length,
    });
  }
  return groups;
}
