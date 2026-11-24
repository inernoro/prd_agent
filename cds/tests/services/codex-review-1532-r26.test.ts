/**
 * Codex review（PR #1532）第二十六轮：生效结论没接到最外面那两个消费方。
 *
 * 边界换算（toRef）之后，CDS 自己这一屏一律按生效结论算：一份标着通过却记了 P0 的报告，
 * 首屏、发布闸、台账、跨项目流水线全按未通过。但两处还在读原始 verdict：
 *   1. 回写 GitHub（本文件）——PR Checks 面板会挂一个绿色的「CDS 验收」，而同一份报告在
 *      CDS 上是红的。对外发假绿灯比内部口径不一致更糟。
 *   2. 台账的「不通过」视图与徽章（见 web 侧同轮守卫）。
 *
 * 判据钉在纯函数上：回写用的结论必须由 effectiveVerdict 给出。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { effectiveVerdict } from '../../src/services/acceptance-overview.js';

const routeSrc = readFileSync(
  fileURLToPath(new URL('../../src/routes/reports.ts', import.meta.url)),
  'utf-8',
);

describe('回写 GitHub 用生效结论', () => {
  it('标着通过但记了阻断缺陷的报告，生效结论是未通过', () => {
    expect(effectiveVerdict({ verdict: 'pass', defectCounts: { p0: 1 } })).toBe('fail');
    expect(effectiveVerdict({ verdict: 'conditional', defectCounts: { P1: 2 } })).toBe('fail');
    // 没有阻断缺陷时原样放行，不许顺手把别的也判红。
    expect(effectiveVerdict({ verdict: 'pass', defectCounts: { p2: 5 } })).toBe('pass');
    expect(effectiveVerdict({ verdict: 'conditional', defectCounts: null })).toBe('conditional');
  });

  it('check-run 的 conclusion 与评论标题都取生效结论，不取 meta.verdict', () => {
    // 前置：这两处确实还在源码里，否则下面的反面断言是空转。
    expect(routeSrc).toContain('VERDICT_CONCLUSION[');
    expect(routeSrc).toContain('VERDICT_CN[');

    expect(routeSrc).not.toContain('VERDICT_CONCLUSION[meta.verdict]');
    expect(routeSrc).not.toContain('VERDICT_CN[meta.verdict]');
    expect(routeSrc).toContain('effectiveVerdict(meta)');
  });

  it('effectiveVerdict 是从聚合模块导出的同一份，不是路由里另抄一份', () => {
    expect(routeSrc).toMatch(/import \{[^}]*effectiveVerdict[^}]*\} from '\.\.\/services\/acceptance-overview\.js'/);
    // 路由里不许自己再判一次阻断缺陷——那就是判据分裂的起点。
    expect(routeSrc).not.toContain('function effectiveVerdict');
  });
});
