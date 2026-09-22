/**
 * Codex review（PR #1532）第二十六轮的 P2：台账的「不通过」视图与徽章还读原始 verdict。
 *
 * 上一轮把台账行改成按生效结论显示，于是一份标着通过却记了 P0 的报告在行里写「未通过」；
 * 可左侧「不通过」视图筛的仍是 `r.verdict === 'fail'`，那份报告点进去就不见了，徽章还是 0。
 * 首屏说有一条未通过，「不通过」视图说一条都没有——同一屏两种说法。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { effectiveVerdict } from '../../web/src/lib/defectCounts.js';

const pageSrc = readFileSync(
  fileURLToPath(new URL('../../web/src/pages/ReportsPage.tsx', import.meta.url)),
  'utf-8',
);

describe('「不通过」视图与徽章走生效结论', () => {
  it('前端这一份判据与后端同义', () => {
    expect(effectiveVerdict({ verdict: 'pass', defectCounts: { p0: 1 } })).toBe('fail');
    expect(effectiveVerdict({ verdict: 'pass', defectCounts: { p2: 9 } })).toBe('pass');
  });

  it('筛选与计数都不再比较原始 verdict', () => {
    // 前置：这两处代码确实存在，否则反面断言是空转。
    expect(pageSrc).toContain("activeFolder === 'failed'");
    expect(pageSrc).toContain('failed += 1');

    expect(pageSrc).not.toMatch(/r\.verdict === 'fail'/);
    expect(pageSrc).toMatch(/activeFolder === 'failed'\) return projectFilteredReports\.filter\(\(r\) => effectiveVerdict\(r\) === 'fail'\)/);
    expect(pageSrc).toMatch(/if \(effectiveVerdict\(r\) === 'fail'\) failed \+= 1;/);
  });
});
