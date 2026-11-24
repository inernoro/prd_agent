/**
 * 可观测：功能监控与存活监控在列表里分开（2026-09-09）。
 *
 * 为什么必须分组：两者问的不是同一个问题——一个问「返回的东西对不对」，
 * 一个问「通不通」。混在一列会让人把「存活全绿」读成「一切正常」，
 * 而功能监控红着的时候，服务通常还活得好好的（接口通、产出不对）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupTargetsBySource, type UptimeTargetSummary } from '../../web/src/lib/monitorCenter.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), 'utf8');

function target(id: string, extra: Partial<UptimeTargetSummary> = {}): UptimeTargetSummary {
  return {
    id, name: id, source: 'custom', status: 'up', excluded: false, measured: true,
    buckets: [], availability24h: 1, incidentCount: 0, probeDescription: '', intervalSeconds: 60,
    timeoutMs: 5000, sampleCount24h: 1, openIncidentSince: null, statusSince: null,
    ...extra,
  } as unknown as UptimeTargetSummary;
}

describe('列表分组', () => {
  it('功能监控单独成组，且排在自定义存活之前', () => {
    const groups = groupTargetsBySource([
      target('alive-1'),
      target('func-1', { functional: true }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['functional', 'custom']);
    expect(groups[0].label).toBe('功能监控');
    expect(groups[0].targets.map((t) => t.id)).toEqual(['func-1']);
  });

  it('没有功能监控时行为与从前一致（不凭空多出空分组）', () => {
    const groups = groupTargetsBySource([target('alive-1')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('custom');
    expect(groups[0].label).toBe('自定义监控');
  });

  it('全是功能监控时不出现空的自定义分组', () => {
    const groups = groupTargetsBySource([target('f1', { functional: true })]);
    expect(groups.map((g) => g.key)).toEqual(['functional']);
  });

  it('分组标识唯一——两个 custom 组共用 source，只有 key 能区分', () => {
    const groups = groupTargetsBySource([
      target('a'), target('b', { functional: true }),
      target('r', { source: 'release' } as Partial<UptimeTargetSummary>),
    ]);
    const keys = groups.map((g) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
    // 两个分组的 source 都是 custom：拿 source 当 React key 会撞
    expect(groups.filter((g) => g.source === 'custom')).toHaveLength(2);
  });

  it('故障计数按分组各算各的', () => {
    const groups = groupTargetsBySource([
      target('f-down', { functional: true, status: 'down' }),
      target('alive-ok'),
    ]);
    expect(groups.find((g) => g.key === 'functional')?.down).toBe(1);
    expect(groups.find((g) => g.key === 'custom')?.down).toBe(0);
  });
});

describe('接线守卫', () => {
  it('列表用 group.key 做 React key —— 用 source 会让两个 custom 组撞在一起', () => {
    expect(read('cds/web/src/pages/status/TargetList.tsx')).toContain('key={group.key}');
  });

  it('详情页挂了功能监控证据区，否则产物画廊永远不出现', () => {
    const src = read('cds/web/src/pages/status/TargetDetail.tsx');
    expect(src).toContain('FunctionalEvidence');
    expect(src).toContain('target.functional && target.monitorId');
  });

  it('证据区读的是完整证据端点，不是从列表摘要里凑', () => {
    const src = read('cds/web/src/pages/status/FunctionalEvidence.tsx');
    expect(src).toContain('/observations');
    // 实际值必须渲染：没有它，判据红了还得自己再打一次接口
    expect(src).toContain('result.actual');
  });

  it('后端提供了那个端点', () => {
    expect(read('cds/src/routes/uptime.ts')).toContain("'/uptime/monitors/:id/observations'");
  });
});
