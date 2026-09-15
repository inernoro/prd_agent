/**
 * Codex 第二十一轮（PR #1532，reviewed commit 3ff82b566c）两条。
 *
 * 两条同源：上一轮把「阻断缺陷压过安全结论」只接到了首屏那一个消费方，
 * 发布闸与簇内求和各自照旧，于是同一个响应里一边说「有功能坏了」一边说「可以发布」。
 * 这次把判据收敛成 effectiveVerdict，三处共用。
 */
import { describe, it, expect } from 'vitest';
import type { AcceptanceReportMeta } from '../../src/types.js';
import { buildReportsOverview } from '../../src/services/acceptance-overview.js';

let seq = 0;
function report(partial: Partial<AcceptanceReportMeta> & { title: string; createdAt: string }): AcceptanceReportMeta {
  seq += 1;
  return { id: partial.id ?? `s${seq}`, format: 'md', sizeBytes: 1, projectId: 'proj', updatedAt: partial.createdAt, ...partial };
}
const TO = new Date('2026-09-07T00:00:00Z');

describe('发布闸与首屏读同一个生效结论', () => {
  it('发布验收标为通过但带 P0 时，闸门不是 open', () => {
    const o = buildReportsOverview([
      report({ title: '发布验收 · 主干 · 2026-09-05', createdAt: '2026-09-05T10:00:00Z', verdict: 'pass', defectCounts: { p0: 1 } }),
    ], [], { to: TO, days: 7 });
    // 前置条件：夹具写的是 pass，生效结论已被阻断缺陷压成 fail。
    expect(o.totals.counted).toBe(1);
    expect(o.totals.pass).toBe(0);
    expect(o.totals.fail).toBe(1);
    expect(o.releaseGate.state).not.toBe('open');
    expect(o.headline.status).toBe('broken');
    // 措辞要让矛盾看得见：既说它自称通过，也说阻断缺陷几个。
    expect(o.releaseGate.reason).toContain('标为通过');
    expect(o.releaseGate.reason).toContain('阻断缺陷 1 个');
  });

  it('干净的发布验收通过时闸门照常开', () => {
    const o = buildReportsOverview([
      report({ title: '发布验收 · 主干 · 2026-09-05', createdAt: '2026-09-05T10:00:00Z', verdict: 'pass', defectCounts: { p2: 3 } }),
    ], [], { to: TO, days: 7 });
    expect(o.releaseGate.state).toBe('open');
    expect(o.headline.status).toBe('ok');
  });

  it('「上一次通过」也按生效结论算，不认带阻断的那次', () => {
    const o = buildReportsOverview([
      report({ title: '发布验收 · 主干 · 2026-09-06', createdAt: '2026-09-06T10:00:00Z', verdict: 'fail', defectCounts: { p0: 2 } }),
      report({ title: '发布验收 · 主干 · 2026-09-05', createdAt: '2026-09-05T10:00:00Z', verdict: 'pass', defectCounts: { p1: 1 } }),
    ], [], { to: TO, days: 7 });
    expect(o.releaseGate.state).toBe('blocked');
    expect(o.releaseGate.reason).toContain('此前没有通过记录');
  });
});

describe('簇内求和先夹再加', () => {
  it('同一簇里正负相抵不会把阻断缺陷抹平', () => {
    const o = buildReportsOverview([
      // 同一对象、不同目标日：两份都留得住（同标题同日会被版本折叠成一份，那样测不到求和）。
      report({ title: '功能验收 · 甲 · 2026-09-05', createdAt: '2026-09-05T10:00:00Z', verdict: 'fail', defectCounts: { p0: 2 } }),
      report({ title: '功能验收 · 甲 · 2026-09-04', createdAt: '2026-09-04T10:00:00Z', verdict: 'fail', defectCounts: { p0: -2 } }),
    ], [], { to: TO, days: 7 });
    const c = o.clusters.find((x) => x.target === '甲');
    expect(c, '夹具没造出这个簇').toBeTruthy();
    // 前置条件：这个簇里确实有两份报告在参与求和，否则判据是空转的。
    expect(c!.count).toBe(2);
    expect(2 + -2).toBe(0);
    expect(c!.defectCounts.p0 ?? 0).toBeGreaterThan(0);
  });
});
