/**
 * 窄屏不许把整页锁死在一屏内。
 *
 * 这一页在宽屏是「左右两列各自滚」——内容多的一列不会把另一列顶下去，是有意的。
 * 但窄屏是单列：同一套 `h-full` + `flex-1 min-h-0` + `overflow-y-auto` 会让整页高度
 * 恰好等于一屏，外层 `<main>`（overflow-auto）没得可滚，每列在一个很矮的盒子里自己滚。
 *
 * 390 宽实测的后果不是「要多滚两下」：`document.scrollHeight === innerHeight`，
 * 第二台客户端与「断开」按钮**根本不在 DOM 里**，用户既看不见也够不着。
 *
 * 这类事删掉不会红：类型过、lint 过、59 条用例过、桌面截图好看，
 * 只有真的用手机视口打开才现形。所以判据钉在源码上。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'McpConsolePage.tsx'),
  'utf8',
);

/** className="..." 里出现的每一个原子类（含断点前缀）。 */
function classTokens(): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/className="([^"]*)"/g)) out.push(...m[1].split(/\s+/).filter(Boolean));
  return out;
}

describe('接入台窄屏滚动契约', () => {
  it('内部滚动必须带断点前缀，不许裸 overflow-y-auto', () => {
    const bare = classTokens().filter((t) => t === 'overflow-y-auto');
    expect(bare, '裸的 overflow-y-auto 会在窄屏把内容关进一个很矮的盒子').toEqual([]);
  });

  it('两列的内部滚动都挂在 lg: 上', () => {
    expect(classTokens().filter((t) => t === 'lg:overflow-y-auto').length).toBe(2);
  });

  /**
   * 取某一个 className 的原子类。只管本页的布局容器 ——
   * `flex-1` / `h-full` 在别处（loader 容器、行内文本截断、进度条）是合法的，
   * 全局禁掉会把守卫变成噪音，然后被人整条注释掉。
   */
  function tokensOfClassNameContaining(needle: string): string[] {
    const hit = [...source.matchAll(/className="([^"]*)"/g)].map((m) => m[1]).find((c) => c.includes(needle));
    expect(hit, `找不到含 ${needle} 的 className —— 布局被重写了？`).toBeTruthy();
    return hit!.split(/\s+/).filter(Boolean);
  }

  it('页根：窄屏 min-h-full（自然高度），h-full 只在 lg 生效', () => {
    // h-full 在窄屏会把内容截到一屏；min-h-full 让它长出去、由 <main> 滚
    const t = tokensOfClassNameContaining('gap-3.5 py-3');
    expect(t).toContain('min-h-full');
    expect(t).toContain('lg:h-full');
    expect(t).not.toContain('h-full');
  });

  it('主体栅格：撑满剩余高度只在 lg 生效', () => {
    const t = tokensOfClassNameContaining('lg:grid-cols-[minmax(0,1fr)_320px]');
    expect(t).toContain('lg:flex-1');
    expect(t).toContain('lg:min-h-0');
    expect(t).not.toContain('flex-1');
    expect(t).not.toContain('min-h-0');
  });
});
