import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 行内 <code> 一旦直接摊在 flex 容器下，会被 blockify 成 display:block
 * 再压到 min-content 宽——390px 手机上实测压到 48px，「[[标题]]」折成两行
 * 跟右边的文字错位叠字（2026-08-11 外部验收实测，深浅主题都复现）。
 *
 * 这是「删掉不会红」的那类接线：把包裹层去掉、或把 nowrap 删掉，
 * 编译和所有行为测试都照样绿，只有真人在手机上才看得出来。所以钉源码。
 */
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');

describe('行内代码不能直接做 flex item', () => {
  it('BacklinksPanel 的 [[标题]] 包在普通块里，且带 nowrap', () => {
    const source = read('../BacklinksPanel.tsx');
    // 定位真正的 <code> 元素，不是注释里提到的那一处
    const at = source.indexOf('<code style=');
    const chip = source.slice(Math.max(0, at - 400), at + 400);
    expect(chip).toContain("whiteSpace: 'nowrap'");
    // 包裹层：chip 前面必须先开一个 <span>，它才不是 flex 容器的直接子项
    expect(chip).toMatch(/<span style=\{\{ lineHeight/);
  });

  it('宇宙图空状态的 [[标题]] 也带 nowrap，且颜色走 token 不写死', () => {
    const source = read('../../../pages/document-store/UniverseGraphPage.tsx');
    const at = source.indexOf('<code style=');
    const chip = source.slice(Math.max(0, at - 300), at + 400);
    expect(chip).toContain("whiteSpace: 'nowrap'");
    // 原来写死 #2a2a2a，浅色主题下会是一块黑疙瘩（admin-dual-theme）
    expect(chip).not.toContain('#2a2a2a');
    expect(chip).toContain('var(--bg-nested)');
  });
});
