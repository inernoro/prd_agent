/**
 * 环境归一 / 分组的唯一判定源回归。
 *
 * 为什么这几条值得钉：environment 是可缺省字段，「缺省算什么」此前散在路由、
 * state 约束、前端渲染三处各判一遍。任何一处漏改，同一个目标就会在不同页面
 * 落进不同的环境组——而且没有任何东西会变红（判据分裂，只会静默漂移）。
 */
import { describe, expect, it } from 'vitest';
import type { ReleaseTarget } from '../../src/types.js';
import {
  groupReleaseTargetsByEnvironment,
  normalizeReleaseEnvironment,
  releaseEnvironmentLabel,
} from '../../src/services/release-environment.js';

function target(id: string, overrides: Partial<ReleaseTarget> = {}): ReleaseTarget {
  return {
    id,
    projectId: 'proj-a',
    name: id,
    type: 'ssh',
    createdAt: '2026-01-01T00:00:00.000Z',
    isEnabled: true,
    ...overrides,
  } as ReleaseTarget;
}

describe('environment 归一', () => {
  it('未设 / 未知字符串一律算生产——缺省语义与 state 的 canonical 约束同口径', () => {
    expect(normalizeReleaseEnvironment(undefined)).toBe('production');
    expect(normalizeReleaseEnvironment('')).toBe('production');
    expect(normalizeReleaseEnvironment('PRODUCTION')).toBe('production');
    expect(normalizeReleaseEnvironment('prod')).toBe('production');
    expect(normalizeReleaseEnvironment(42)).toBe('production');
  });

  it('staging / other 保持自己', () => {
    expect(normalizeReleaseEnvironment('staging')).toBe('staging');
    expect(normalizeReleaseEnvironment('other')).toBe('other');
  });

  it('标签是中文，且由后端给定（前端不再自己映射一份）', () => {
    expect(releaseEnvironmentLabel('production')).toBe('生产');
    expect(releaseEnvironmentLabel('staging')).toBe('预发');
    expect(releaseEnvironmentLabel(undefined)).toBe('生产');
  });
});

describe('按环境分组', () => {
  it('canonical 排在组首，其余按名字', () => {
    const groups = groupReleaseTargetsByEnvironment([
      target('t-b', { name: 'B 站点', isCanonical: false }),
      target('t-a', { name: 'A 站点', isCanonical: false }),
      target('t-c', { name: 'Z 权威站点' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].environment).toBe('production');
    expect(groups[0].label).toBe('生产');
    // 事故值：按名字排就会把权威目标（Z 开头）排到最后，用户第一眼看到的不是线上那一个。
    expect(groups[0].targetIds).toEqual(['t-c', 't-a', 't-b']);
    expect(groups[0].canonicalTargetId).toBe('t-c');
  });

  it('组的输出顺序恒为 生产 → 预发 → 其他，且空组不出现', () => {
    const groups = groupReleaseTargetsByEnvironment([
      target('t-other', { environment: 'other' }),
      target('t-prod', { environment: 'production' }),
      target('t-stage', { environment: 'staging' }),
    ]);

    expect(groups.map((g) => g.environment)).toEqual(['production', 'staging', 'other']);

    const onlyStaging = groupReleaseTargetsByEnvironment([target('t-stage', { environment: 'staging' })]);
    expect(onlyStaging.map((g) => g.environment)).toEqual(['staging']);
  });

  it('停用的 canonical 不算当前权威目标，但仍留在组里', () => {
    const groups = groupReleaseTargetsByEnvironment([
      target('t-off', { isEnabled: false }),
    ]);

    expect(groups[0].targetIds).toEqual(['t-off']);
    // 事故值：把停用目标当成 canonical，左栏会指着一个根本不会被发布的目标说「线上是它」。
    expect(groups[0].canonicalTargetId).toBeUndefined();
    expect(groups[0].disabledCount).toBe(1);
  });

  it('归档目标整个排除，也不进 disabledCount', () => {
    const groups = groupReleaseTargetsByEnvironment([
      target('t-live'),
      target('t-dead', { lifecycle: 'archived', isEnabled: false }),
    ]);

    expect(groups[0].targetIds).toEqual(['t-live']);
    // 归档目标由 GET /releases/targets 的 archivedTargets 单独承载，
    // 混进来会让左栏出现点不动的死条目，也会把「有几个被停用」这个数字虚高。
    expect(groups[0].disabledCount).toBe(0);
  });

  it('未设 environment 的存量目标与显式 production 的目标落在同一组', () => {
    const groups = groupReleaseTargetsByEnvironment([
      target('t-legacy'),
      target('t-new', { environment: 'production' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].targetIds.sort()).toEqual(['t-legacy', 't-new']);
  });
});
