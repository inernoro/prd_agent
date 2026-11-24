import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync(new URL('../WebPagesPage.tsx', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../../layouts/AppShell.tsx', import.meta.url), 'utf8');

/**
 * 「左窄上宽」（用户 2026-09-15）。实测：侧栏右缘 x=68，卡片 x=85 → 左 17px；
 * 卡片 y=29 → 上 29px。多出来的那一截由两笔构成，两笔都得治：
 *
 *  1. 外壳 px-4 py-3 本身就是左右 16、上下 12，有方向差；
 *  2. 页面里一个「桌面端恒为空」的 flex 包裹层高度为 0、却仍是 flex item，
 *     和下一个子元素之间实打实吃掉根上的 gap-4，把整页又推下去 16px。
 *
 * 第 2 条是这类缺陷的典型形状：它自己不可见、不报错、通读也看不出是谁干的，
 * 只有量出来才知道（判据与接线纪律：删掉不会红的东西需要一条守卫）。
 */
describe('主区外边距四边同宽', () => {
  it('外壳桌面分支用 p-4，不再左右上下分开给', () => {
    // companion：确实截到了那段分支（它上面有 isHomePage 的 p-0）。
    expect(shell).toContain("isHomePage");
    expect(shell, '外壳又回到了有方向差的写法').not.toContain("'px-4 py-3'");
    expect(shell).toMatch(/isHomePage\s*\n\s*\?\s*'p-0'[\s\S]{0,400}?:\s*'p-4'/);
  });

  it('桌面端不渲染那个空的 toolbar 包裹层——空 flex item 会白吃一个 gap', () => {
    const idx = page.indexOf('className="flex flex-col gap-3" style={{ display: workspaceTab');
    expect(idx, 'toolbar 包裹层不见了，契约可能被挪走了').toBeGreaterThan(-1);
    // 包裹层前面必须有 isMobile 闸；否则桌面端又会渲染出一个高度为 0 的 flex item。
    const before = page.slice(Math.max(0, idx - 500), idx);
    expect(before, '桌面端仍会渲染这个空壳，整页会被往下推 16px').toContain('{isMobile && (');
  });
});
