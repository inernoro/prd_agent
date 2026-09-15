/*
 * 守卫：脉搏墙与盲区地图的判据。
 *
 * 这两张图各有一条「写错了不会有任何东西变红」的判据，这里就是那两条的红绿闭环：
 *   脉搏墙：**没有采样的那一段必须断开**。补成 0 会让一段没人检查的时间
 *           渲染成一条贴着地板、看起来很健康的线——这条链要治的病的图形版。
 *   盲区地图：**没有业务监控的格子不许是绿的**。把「没人盯」渲染成绿色，
 *           等于用一个假绿把最该管的项目藏起来。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  PULSE_GEOMETRY, buildPulse, describePulse, hasPulseInk, buildBlindspotMap, describeBlindspots,
} from '../../web/src/lib/pulseWall.js';
import type { MonitorEnvironment, UptimeBucket, UptimeTargetSummary } from '../../web/src/lib/monitorCenter.js';

const NOW = 1_700_000_000_000;
const LABELS: Record<MonitorEnvironment, string> = {
  production: '生产', staging: '预发', other: '其他', preview: '分支预览',
};

function bucket(over: Partial<UptimeBucket> = {}): UptimeBucket {
  return { from: 0, to: 1, up: 1, down: 0, avgLatencyMs: 40, status: 'up', ...over } as UptimeBucket;
}
const empty = (): UptimeBucket => bucket({ up: 0, down: 0, avgLatencyMs: null, status: 'none' });

function target(over: Partial<UptimeTargetSummary> & { name: string; environment: MonitorEnvironment; projectId: string }): UptimeTargetSummary {
  return {
    id: `t@${over.projectId}-${over.name}-${over.environment}`,
    source: 'custom', branchId: '', profileId: 'p', probeKind: 'http',
    status: 'up', lastSample: { t: NOW - 10_000, up: true, ms: 40 },
    availability24h: 1, availability7d: 1, avgLatencyMs24h: 40, sampleCount24h: 10,
    buckets: [], openIncidentSince: null, statusSince: null, incidentCount: 0,
    probeDescription: '', intervalSeconds: 600, timeoutMs: 8000, measured: true,
    environmentLabel: LABELS[over.environment], observeMode: 'active',
    ...over,
  } as UptimeTargetSummary;
}

describe('脉搏墙：缺口就是证据', () => {
  // 这一条是整张图的存在理由。
  it('中间没有采样的那一段真的断开，不连成一条线', () => {
    const pulse = buildPulse([bucket(), bucket(), empty(), empty(), bucket(), bucket()]);
    expect(pulse.segments).toHaveLength(2);
    expect(pulse.filled).toBe(4);
    expect(pulse.total).toBe(6);
  });

  // 补 0 是最容易犯、最难被发现的错：0 在这张图上读作「零延迟」。
  it('空桶不补成 0 —— 折线里不许出现贴着地板的点', () => {
    const floor = (PULSE_GEOMETRY.height - PULSE_GEOMETRY.pad).toFixed(1);
    const pulse = buildPulse([bucket(), empty(), bucket()]);
    for (const seg of pulse.segments) {
      expect(seg.includes(`,${floor}`), `折线里出现了地板点：${seg}`).toBe(false);
    }
  });

  // 2026-09-15 线上实测发现的真问题：6 小时探一次的监控在 90 段桶里只落四个孤立
  // 样本，要求两点成段会让这样一整行凭空消失，看起来像「这条监控不存在」。
  it('孤立样本画成点，不许因为连不成线就丢掉', () => {
    const pulse = buildPulse([empty(), bucket(), empty(), bucket({ avgLatencyMs: 80 }), empty()]);
    expect(pulse.segments).toHaveLength(0);
    expect(pulse.dots).toHaveLength(2);
    expect(hasPulseInk(pulse)).toBe(true);
    expect(describePulse(pulse)).toContain('连不成线');
  });

  it('孤立的失败点也标成失败色', () => {
    const pulse = buildPulse([empty(), bucket({ down: 1, status: 'down' }), empty()]);
    expect(pulse.dots[0]?.down).toBe(true);
  });

  // 「一次都没采到」与「采到了但没测出耗时」的下一步完全不同，不许合成一句。
  it('一次采样都没有时说的是「没人在查它」', () => {
    const pulse = buildPulse([empty(), empty()]);
    expect(hasPulseInk(pulse)).toBe(false);
    expect(pulse.segments).toHaveLength(0);
    expect(pulse.peakMs).toBeNull();
    expect(pulse.sampled).toBe(0);
    expect(describePulse(pulse)).toContain('没人在查它');
  });

  it('有采样但没测到耗时是另一句话', () => {
    const pulse = buildPulse([bucket({ avgLatencyMs: null }), bucket({ avgLatencyMs: null })]);
    expect(pulse.sampled).toBe(2);
    expect(describePulse(pulse)).toContain('这条线画不出来');
  });

  // 一条 30ms 的和一条 3 秒的放同一把尺子上，前者会被压成直线。
  it('纵轴按每行自己的峰值归一，峰值落在顶部', () => {
    const pulse = buildPulse([bucket({ avgLatencyMs: 10 }), bucket({ avgLatencyMs: 100 })]);
    expect(pulse.peakMs).toBe(100);
    const ys = pulse.segments[0].split(' ').map((p) => Number(p.split(',')[1]));
    expect(Math.min(...ys)).toBeCloseTo(PULSE_GEOMETRY.pad, 1);
  });

  it('全是 0ms 也不炸，压到地板而不是除以 0', () => {
    const pulse = buildPulse([bucket({ avgLatencyMs: 0 }), bucket({ avgLatencyMs: 0 })]);
    expect(pulse.segments).toHaveLength(1);
    expect(pulse.segments[0]).not.toContain('NaN');
  });

  it('失败的那几段单独标点', () => {
    const pulse = buildPulse([bucket(), bucket({ down: 2, status: 'down' }), bucket()]);
    expect(pulse.downs).toHaveLength(1);
  });

  it('线断得厉害要用文字说，不能指望人从缺口数出来', () => {
    const buckets = [bucket(), bucket(), ...Array.from({ length: 18 }, empty)];
    expect(describePulse(buildPulse(buckets))).toContain('线是断的');
  });
});

describe('盲区地图：没人盯不许是绿的', () => {
  const targets = [
    target({ projectId: 'map', name: 'MAP 后端', environment: 'production' }),
    target({ projectId: 'map', name: 'MAP 数据库', environment: 'production' }),
    // 有基础设施目标，但没有一条业务监控 —— 这就是洞
    target({ projectId: 'bde', name: '容器', environment: 'production', source: 'branch' as never }),
    target({ projectId: 'bde', name: '容器', environment: 'preview', source: 'branch' as never }),
  ];

  it('有业务监控 = watched，有目标没业务 = blind，没目标 = absent', () => {
    const map = buildBlindspotMap(targets, NOW);
    const bde = map.rows.find((r) => r.id === 'bde');
    const mapRow = map.rows.find((r) => r.id === 'map');
    expect(bde?.cells.find((c) => c.environment === 'production')?.kind).toBe('blind');
    expect(mapRow?.cells.find((c) => c.environment === 'production')?.kind).toBe('watched');
    // map 项目在分支预览没有任何目标 —— 「不适用」，不是「该盯没盯」
    expect(mapRow?.cells.find((c) => c.environment === 'preview')?.kind).toBe('absent');
  });

  it('blind 与 absent 必须分开 —— 混作一谈会把该刺眼的图稀释成一片灰', () => {
    const map = buildBlindspotMap(targets, NOW);
    const kinds = new Set(map.rows.flatMap((r) => r.cells.map((c) => c.kind)));
    expect(kinds.has('blind')).toBe(true);
    expect(kinds.has('absent')).toBe(true);
  });

  it('头条说的是「几个没人盯」，不是「几个项目」', () => {
    const map = buildBlindspotMap(targets, NOW);
    expect(map.blindProjects).toBe(1);
    expect(map.watchedProjects).toBe(1);
    expect(describeBlindspots(map)).toContain('1 个没有一条业务监控');
  });

  it('全都有人盯时不假装有盲区', () => {
    const map = buildBlindspotMap([targets[0], targets[1]], NOW);
    expect(map.blindProjects).toBe(0);
    expect(describeBlindspots(map)).toContain('都有业务监控');
  });

  it('一个项目都没有时说实话', () => {
    expect(describeBlindspots(buildBlindspotMap([], NOW))).toContain('还没有任何项目');
  });

  it('坏的排最前，没人盯的排在好着的前面', () => {
    const withBad = [
      ...targets,
      target({ projectId: 'zzz', name: '好着的', environment: 'production' }),
      target({ projectId: 'aaa', name: '坏了的', environment: 'production', status: 'down' }),
    ];
    const order = buildBlindspotMap(withBad, NOW).rows.map((r) => r.id);
    expect(order[0]).toBe('aaa');
    expect(order.indexOf('bde')).toBeLessThan(order.indexOf('zzz'));
  });

  // 覆盖度不该被当前筛选裁掉——判据只认传进来的那一份，所以这一条守的是调用方。
  it('列只出现真实存在过的环境', () => {
    const map = buildBlindspotMap(targets, NOW);
    expect(map.environments).toEqual(['production', 'preview']);
    expect(map.environmentLabels).toEqual(['生产', '分支预览']);
  });
});

describe('两张图都接上线了', () => {
  const src = readFileSync(fileURLToPath(new URL('../../web/src/pages/status/OwnerBoard.tsx', import.meta.url)), 'utf8');

  it('面板真的渲染了脉搏墙与盲区地图', () => {
    expect(src).toMatch(/<PulseWall\s/);
    expect(src).toMatch(/<BlindspotMap\s/);
    expect(src).toContain("layout === 'chart'");
  });

  // 盲区地图按当前环境筛选算 = 把它要喊的那件事直接过滤没了：
  // 默认只看非预览，而多数没人盯的项目恰恰只有分支预览。
  it('盲区地图吃的是未经环境筛选的那一份', () => {
    expect(src).toMatch(/buildBlindspotMap\(projectTargets, now\)/);
  });

  it('脉搏墙拿的是演练后的探测器状态 —— 演练停摆那一档在这张图上也要成立', () => {
    expect(src).toMatch(/prober=\{stage\.ctx\.prober\}/);
  });
});
