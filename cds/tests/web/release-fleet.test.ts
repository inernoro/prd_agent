import { describe, expect, it } from 'vitest';
import {
  buildFleetMetrics,
  buildFleetVerdict,
  fleetAvailabilityText,
  fleetBehindText,
  formatFleetMinutes,
  formatFleetPercent,
  formatFleetRatio,
  sortFleet,
  type FleetEnv,
} from '../../web/src/lib/releaseFleet.js';

/**
 * 全环境矩阵的判据。设计稿把三条规则写进了「硬性约束」，它们都是**沉默失效**型的：
 * 写错了页面照样渲染，只是对着用户编数字。所以逐条钉死。
 */

const NOW = Date.parse('2026-08-14T10:00:00Z');

function env(overrides: Partial<FleetEnv> = {}): FleetEnv {
  return {
    id: overrides.id || 'e1',
    name: overrides.name || 'prod-main',
    host: 'a.example.com',
    type: 'production',
    isPrimary: false,
    enabled: true,
    liveSha: 'abc1234',
    behindMain: 0,
    health: 'healthy',
    availability24h: 99.9,
    lastRelease: null,
    canRollback: false,
    promotableSha: null,
    dora: null,
    ...overrides,
  };
}

describe('量纲：极端值不许退化成噪音', () => {
  it('占比小于 0.1% 写「不足 0.1%」，不写 0.05%', () => {
    expect(formatFleetPercent(0.05)).toBe('不足 0.1%');
    expect(formatFleetPercent(99.9)).toBe('99.90%');
    expect(formatFleetPercent(100)).toBe('100%');
    // null 是「算不出」，不是 0
    expect(formatFleetPercent(null)).toBeNull();
  });

  it('时长不足 1 小时写分钟，不写「0 小时」', () => {
    expect(formatFleetMinutes(22)).toBe('22 分钟');
    expect(formatFleetMinutes(108)).toBe('1 小时 48 分');
    expect(formatFleetMinutes(120)).toBe('2 小时');
    expect(formatFleetMinutes(null)).toBeNull();
  });

  it('比值超过三倍换成 ×N，不写 +1500%', () => {
    expect(formatFleetRatio(48, 3)).toBe('×16');
    expect(formatFleetRatio(4, 3)).toBe('+33%');
    expect(formatFleetRatio(5, 0)).toBeNull();
  });
});

describe('缺数据必须明说缺什么，绝不渲染成 0 或 100%', () => {
  it('未监测环境的可用率写「未监测」', () => {
    expect(fleetAvailabilityText(env({ health: 'unmonitored', availability24h: null }))).toBe('未监测');
  });

  it('有探测但拿不到样本的写「无数据」，仍然不是 0%', () => {
    expect(fleetAvailabilityText(env({ health: 'healthy', availability24h: null }))).toBe('无数据');
  });

  it('落后数算不出写「无法计算」，不是「已是最新」', () => {
    expect(fleetBehindText(env({ behindMain: null }))).toBe('无法计算');
    expect(fleetBehindText(env({ behindMain: 0 }))).toBe('已是最新');
    expect(fleetBehindText(env({ behindMain: 48 }))).toBe('落后 48 个');
  });
});

describe('判断句：算不出就不出，禁止放到任何团队都成立的空话', () => {
  it('有失败环境时点名是谁、多久之前、可用率多少', () => {
    const verdict = buildFleetVerdict([
      env({ id: 'a', name: 'prod-main', health: 'failed', availability24h: 96.2, lastRelease: { atMs: NOW - 2 * 3600_000, by: '陈越', durationSec: 252, ok: false } }),
      env({ id: 'b', name: 'staging' }),
    ], NOW);
    const text = verdict.segments.map((s) => s.text).join('');
    expect(verdict.tone).toBe('bad');
    expect(text).toContain('2 个启用环境里，1 个健康检查失败：');
    expect(text).toContain('prod-main');
    expect(text).toContain('2 小时前发布失败（陈越）');
    expect(text).toContain('96.20%');
    // 环境名必须是可下钻的那一段
    expect(verdict.segments.find((s) => s.envId === 'a')?.text).toBe('prod-main');
    expect(verdict.actionEnvId).toBe('a');
  });

  it('没有失败环境时也要挂数字，不写「整体运行良好」', () => {
    const verdict = buildFleetVerdict([env({ id: 'a' }), env({ id: 'b', name: 's' })], NOW);
    const text = verdict.segments.map((s) => s.text).join('');
    expect(text).toContain('2 个启用环境里 2 个健康检查通过');
    expect(text).not.toContain('良好');
    expect(verdict.actionEnvId).toBeNull();
  });

  it('没有落后环境时整段不出现，不留一句空壳', () => {
    const verdict = buildFleetVerdict([env({ behindMain: 1 })], NOW);
    expect(verdict.segments.map((s) => s.text).join('')).not.toContain('落后主干');
  });

  it('未监测环境要点名，并声明比率不含它们', () => {
    const verdict = buildFleetVerdict([env({ id: 'a' }), env({ id: 'b', name: 'staging-eu', health: 'unmonitored', availability24h: null })], NOW);
    expect(verdict.gap).toContain('staging-eu');
    expect(verdict.gap).toContain('本页所有比率均不含这些环境');
  });
});

describe('归因指标：算不出的那一块直接不出，归因从真实数据推', () => {
  it('全都没有 DORA 时只剩落后那一块', () => {
    const metrics = buildFleetMetrics([env({ behindMain: 5 })]);
    expect(metrics.map((m) => m.key)).toEqual(['behind']);
  });

  it('落后也算不出时一块都不给，不占位', () => {
    expect(buildFleetMetrics([env({ behindMain: null })])).toEqual([]);
  });

  it('归因指名道姓，且数字来自真实的那一条', () => {
    const metrics = buildFleetMetrics([
      env({ id: 'a', name: 'prod-main', behindMain: 3, dora: { deploys: 14, changeFailureRatio: 0.071, medianRecoveryMin: 22 } }),
      env({ id: 'b', name: 'staging', behindMain: 48, dora: { deploys: 41, changeFailureRatio: 0.02, medianRecoveryMin: 108 } }),
    ]);
    const byKey = Object.fromEntries(metrics.map((m) => [m.key, m]));
    expect(byKey.deploys.value).toBe('55 次');
    expect(byKey.deploys.attributionName).toBe('staging');
    expect(byKey.deploys.attributionDetail).toBe('占 41 次');
    // 变更失败率取最高的那个环境，不是拍一个写死的名字
    expect(byKey.changeFailure.value).toBe('7.10%');
    expect(byKey.changeFailure.attributionName).toBe('prod-main');
    expect(byKey.changeFailure.attributionDetail).toBe('最高');
    expect(byKey.recovery.attributionName).toBe('staging');
    expect(byKey.recovery.attributionDetail).toBe('为 1 小时 48 分');
    expect(byKey.behind.value).toBe('48 个提交');
    // 两个环境时中位数是两者均值 25.5，不是「取上面那个」（那会得出 +0%，读作没差距）
    expect(byKey.behind.attributionName).toBe('staging');
    expect(byKey.behind.attributionDetail).toBe('中位数的 +88%');
  });

  it('超过三倍才换 ×N 量纲', () => {
    const metrics = buildFleetMetrics([
      env({ id: 'a', name: 'prod', behindMain: 1 }),
      env({ id: 'b', name: 'stg', behindMain: 3 }),
      env({ id: 'c', name: 'docs-site', behindMain: 48 }),
    ]);
    expect(metrics.find((m) => m.key === 'behind')?.attributionDetail).toBe('中位数的 ×16');
  });

  it('只有一个环境时不说「中位数的 +0%」那种废话', () => {
    const metrics = buildFleetMetrics([env({ name: 'only', behindMain: 7 })]);
    expect(metrics.find((m) => m.key === 'behind')?.attributionName).toBe('only');
    // 只有一个环境时「最多 vs 中位」恒等，那半句不出
    expect(metrics.find((m) => m.key === 'behind')?.attributionDetail).toBe('');
  });
});

describe('排序', () => {
  it('默认严重度：失败 → 健康 → 未监测，同档按落后数降序', () => {
    const list = [
      env({ id: 'ok', health: 'healthy', behindMain: 2 }),
      env({ id: 'un', health: 'unmonitored', availability24h: null }),
      env({ id: 'bad', health: 'failed' }),
      env({ id: 'ok2', health: 'healthy', behindMain: 30 }),
    ];
    expect(sortFleet(list, 'severity').map((e) => e.id)).toEqual(['bad', 'ok2', 'ok', 'un']);
  });

  /** 算不出落后数的排最后：它不是「落后 0」，混进最新那一头会被读成「最新」。 */
  it('按落后排序时，算不出的排在最后而不是当成 0', () => {
    const list = [env({ id: 'unknown', behindMain: null }), env({ id: 'zero', behindMain: 0 }), env({ id: 'many', behindMain: 9 })];
    expect(sortFleet(list, 'behind').map((e) => e.id)).toEqual(['many', 'zero', 'unknown']);
  });
});

/**
 * 量纲换算的回归。后端 availability24h 是**比率 0..1**，这一层统一成百分数。
 * 漏乘 100 会把 100% 显示成 1.00%——它看着像个正常数字，不会有人怀疑，
 * 只会以为线上可用率崩了。2026-08-14 真实发生过一次。
 */
describe('可用率量纲：后端给比率，这一层换成百分数', () => {
  it('0.99xx 的比率换算成 99.xx%，不是 0.99%', async () => {
    const { toFleetEnv } = await import('../../web/src/lib/releaseFleet.js');
    const row = {
      target: { id: 't', name: 'prod', environment: 'production', isCanonical: true, isEnabled: true, type: 'ssh' },
      currentVersion: '', currentCommit: 'abc1234', healthStatus: 'healthy',
      health: { status: 'healthy', url: 'u', checkedAt: '', availability24h: 0.9986 },
      canRollback: false,
    } as never;
    expect(toFleetEnv(row).availability24h).toBeCloseTo(99.86, 2);
    expect(fleetAvailabilityText(toFleetEnv(row))).toBe('99.86%');
  });

  it('没有探测记录时仍是 null，不是 0', async () => {
    const { toFleetEnv } = await import('../../web/src/lib/releaseFleet.js');
    const row = {
      target: { id: 't', name: 'x', environment: 'other', isEnabled: true, type: 'ssh' },
      currentVersion: '', currentCommit: '', healthStatus: 'unknown', canRollback: false,
    } as never;
    expect(toFleetEnv(row).availability24h).toBeNull();
  });
});

describe('落后最多：全都追平时不出这一块', () => {
  it('最大值是 0 时整块不渲染', () => {
    const metrics = buildFleetMetrics([env({ behindMain: 0 }), env({ id: 'b', behindMain: 0 })]);
    expect(metrics.find((m) => m.key === 'behind')).toBeUndefined();
  });
});
