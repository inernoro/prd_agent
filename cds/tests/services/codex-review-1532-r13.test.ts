/**
 * Codex 第十三轮（PR #1532，reviewed commit ec13f34f2c）。
 *
 * 一条 A 类缺陷：窗口里的报告全都没填结论时，首屏会说「可以正常使用 · N 份验收全部通过」，
 * 而真实通过数是 0。verdict 在写入侧是可缺省的（POST /api/reports 不强制），
 * 所以这不是构造出来的输入。规则依据 conclusion-before-numbers §二「算不出来就不出这句」。
 */
import { describe, it, expect } from 'vitest';
import type { AcceptanceReportMeta } from '../../src/types.js';
import { buildReportsOverview } from '../../src/services/acceptance-overview.js';

let seq = 0;
function report(partial: Partial<AcceptanceReportMeta> & { title: string; createdAt: string }): AcceptanceReportMeta {
  seq += 1;
  return {
    id: partial.id ?? `r${seq}`,
    format: 'md',
    sizeBytes: 1,
    projectId: 'proj',
    updatedAt: partial.createdAt,
    ...partial,
  };
}

const TO = new Date('2026-09-07T00:00:00Z');

describe('没填结论的报告不算「测过」', () => {
  it('全窗口都没有 verdict 时判为「这次没测出来」，且不出现「全部通过」', () => {
    const reports = [
      report({ title: '功能验收 · 甲 · 2026-09-05', createdAt: '2026-09-05T10:00:00Z' }),
      report({ title: '功能验收 · 乙 · 2026-09-05', createdAt: '2026-09-05T11:00:00Z' }),
      report({ title: '每日验收 · 全量 · 2026-09-06', createdAt: '2026-09-06T10:00:00Z' }),
    ];
    const o = buildReportsOverview(reports, [], { to: TO, days: 7 });
    // 前置条件：夹具确实走到「零通过 + 三份未定」这一格，否则下面的断言是空转的。
    expect(o.totals.pass).toBe(0);
    expect(o.totals.undetermined).toBe(3);

    expect(o.headline.status).toBe('untested');
    expect(o.headline.statusLabel).not.toBe('可以正常使用');
    expect(o.headline.sentence).not.toContain('全部通过');
    expect(o.headline.sentence).toContain('3');
  });

  it('有通过也有未定时，通过数按真实通过算，未定单独交代', () => {
    const reports = [
      report({ title: '功能验收 · 甲 · 2026-09-05', createdAt: '2026-09-05T10:00:00Z', verdict: 'pass' }),
      report({ title: '功能验收 · 乙 · 2026-09-05', createdAt: '2026-09-05T11:00:00Z', verdict: 'pass' }),
      report({ title: '每日验收 · 全量 · 2026-09-06', createdAt: '2026-09-06T10:00:00Z' }),
    ];
    const o = buildReportsOverview(reports, [], { to: TO, days: 7 });
    expect(o.totals.pass).toBe(2);
    expect(o.totals.undetermined).toBe(1);

    expect(o.headline.status).toBe('ok');
    // 关键：不许拿 counted（3）冒充通过数。
    expect(o.headline.sentence).toContain('2 份验收全部通过');
    expect(o.headline.sentence).toContain('1 份没有填结论');
  });

  it('全部通过且没有未定时，不追加多余的交代', () => {
    const reports = [
      report({ title: '功能验收 · 甲 · 2026-09-05', createdAt: '2026-09-05T10:00:00Z', verdict: 'pass' }),
    ];
    const o = buildReportsOverview(reports, [], { to: TO, days: 7 });
    expect(o.headline.sentence).toBe('1 份验收全部通过，没有发现阻断。');
  });
});
