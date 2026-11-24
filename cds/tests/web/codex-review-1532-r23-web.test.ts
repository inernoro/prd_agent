/**
 * Codex 第二十三轮（PR #1532，reviewed commit 3f85ff147f）两条，仍是同一屏上两处说法打架。
 *
 * 一条在台账列（读原始 verdict，而聚合那边已经换算成生效结论），
 * 一条在结论分布条（只画三档，全是无结论的上窗显示成空条配 0）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { effectiveVerdict } from '@/lib/defectCounts';

const SRC = path.resolve(process.cwd(), '../cds/web/src');
const PAGE = fs.readFileSync(path.join(SRC, 'pages/ReportsPage.tsx'), 'utf8');
const OVERVIEW = fs.readFileSync(path.join(SRC, 'pages/reports/ReportsOverview.tsx'), 'utf8');

describe('前端这一侧的生效结论判据', () => {
  it('写着通过却带 P0 的报告，判为未通过', () => {
    expect(effectiveVerdict({ verdict: 'pass', defectCounts: { p0: 1 } })).toBe('fail');
  });
  it('负数缺陷不算阻断', () => {
    expect(effectiveVerdict({ verdict: 'pass', defectCounts: { p0: -3 } })).toBe('pass');
  });
  it('只有 P2 时照旧按报告写的结论', () => {
    expect(effectiveVerdict({ verdict: 'pass', defectCounts: { p2: 9 } })).toBe('pass');
  });
  it('没填结论就是没填', () => {
    expect(effectiveVerdict({ defectCounts: { p2: 1 } })).toBeNull();
  });
});

describe('台账行不再自己读原始 verdict', () => {
  const row = (() => {
    const start = PAGE.indexOf('const ref = refById.get(r.id);');
    expect(start, '找不到台账行').toBeGreaterThan(0);
    return PAGE.slice(start, start + 1600);
  })();

  it('结论与左侧色条都取生效值', () => {
    expect(row, '没算出生效结论').toContain('const rowVerdict = ref?.verdict ?? effectiveVerdict(r);');
    expect(row, '色条还在读原始 verdict').not.toMatch(/const rail = r\.verdict/);
    expect(row).toContain("rowVerdict === 'fail' ? 'hsl(var(--bad))'");
  });

  it('缺陷数逐档夹过再显示，不会出现负数', () => {
    expect(row).toContain('severityCount(dc.p0 ?? dc.P0)');
    expect(row).not.toMatch(/const p0 = dc\.p0 \?\? dc\.P0 \?\? 0/);
  });
});

describe('结论分布条把无结论也算进去', () => {
  it('两根条的总数与分段都含 undetermined', () => {
    expect(OVERVIEW, '总数还是只加三档').toContain('r.pass + r.conditional + r.fail + r.undetermined');
    expect(OVERVIEW, '分段里没有无结论那一档').toContain("{ key: 'undetermined', n: r.undetermined }");
    expect(OVERVIEW, '无结论占用了语义三档的颜色').toContain("k === 'undetermined' ? 'hsl(var(--hairline-strong))'");
  });

  it('读屏文案也报出无结论份数', () => {
    expect(OVERVIEW).toContain('无结论 ${r.undetermined}');
  });
});
