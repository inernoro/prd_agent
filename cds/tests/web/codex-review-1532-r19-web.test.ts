/**
 * Codex 第十九轮（PR #1532，reviewed commit 8bfb8c1c84）两条，都是缺陷计数的读法。
 *
 * 缺陷计数在写入侧不做校验：负数收、verdict 与 P0/P1 打架也收。于是每一处直接读它的
 * 地方都会各自漂一点，凑在同一屏上就互相矛盾。这组守卫把前后端两份读法钉在一起。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { blockingDefects as webBlocking, severityCount } from '@/lib/defectCounts';

const SRC = path.resolve(process.cwd(), '../cds/web/src');
const OVERVIEW = fs.readFileSync(path.join(SRC, 'pages/reports/ReportsOverview.tsx'), 'utf8');

describe('单档计数逐档夹到非负', () => {
  it('负数、NaN、Infinity 一律按零', () => {
    expect(severityCount(-1)).toBe(0);
    expect(severityCount(Number.NaN)).toBe(0);
    expect(severityCount(Number.POSITIVE_INFINITY)).toBe(0);
    expect(severityCount(undefined)).toBe(0);
    expect(severityCount(3)).toBe(3);
  });

  it('负数不会抵消掉真实的阻断数', () => {
    // 前置条件：直接相加确实会得零，否则这条断言是空转的。
    expect((2 as number) + (-2 as number)).toBe(0);
    expect(webBlocking({ p0: 2, p1: -2 })).toBe(2);
  });

  it('没有缺陷记录时是零，不是 NaN', () => {
    expect(webBlocking(null)).toBe(0);
    expect(webBlocking({})).toBe(0);
  });
});

describe('前端只有一处读法', () => {
  it('根因建议与缺陷胶囊都走共享判据，页面里没有第二份手写相加', () => {
    expect(OVERVIEW, '根因建议还在自己相加').toContain('blockingDefects(c.defectCounts)');
    expect(OVERVIEW, '胶囊还在直接渲染原始值').toContain('severityCount(counts.p0)');
    expect(OVERVIEW, '页面里残留手写的 p0 + p1').not.toMatch(/\(c\.defectCounts\.p0 \?\? 0\) \+/);
  });
});
