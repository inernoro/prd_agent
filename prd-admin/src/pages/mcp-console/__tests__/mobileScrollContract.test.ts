/**
 * 窄屏不许把整页锁死在一屏内。
 *
 * 这一页在宽屏是「左右两列各自滚」——内容多的一列不会把另一列顶下去，是有意的。
 * 但窄屏是单列：同一套 `h-full` + `flex-1 min-h-0` + `overflow-y-auto` 会让整页高度
 * 恰好等于一屏，外层 `<main>`（overflow-auto）没得可滚，每列在一个很矮的盒子里自己滚。
 *
 * 390 宽实测的后果不是「要多滚两下」：第二台客户端与「断开」按钮**根本不在 DOM 里**，
 * 用户既看不见也够不着。
 *
 * 量它的时候别去量 document —— 这一页的滚动归 AppShell 的内容容器，
 * `document.scrollHeight === innerHeight` 修好前后都成立，判不出任何东西。
 * 真正的判据是那个 overflow 容器的 scrollHeight 有没有超出 clientHeight，
 * 以及「断开」按钮到底有几个（坏的时候是 0，好的时候等于客户端台数）。
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

  /**
   * 窄屏折行之后，对齐规则必须跟着一起换。
   *
   * `ml-auto` 的意思是「把我推到这一行的最右端」。在 `flex-wrap` 容器里，
   * 换行之后它**照样生效** —— 只是那一行现在只剩它自己，于是排出一个
   * 左边空一片、右边孤零零一个元素的 Z 字。页头（切页组 / 刷新 / 接入新的）、
   * 客户端卡片头（今天 N 次）、能力条（看清单）都栽在这同一件事上。
   *
   * 这类事删掉不会红：去掉断点前缀，类型过、lint 过、全量用例过，
   * 桌面截图一模一样，只有真的用手机视口打开才现形。所以判据钉在源码上。
   */
  it('每一处 ml-auto 都显式处理过窄屏，不是宽屏思维直接写下来的', () => {
    const bad = [...source.matchAll(/className="([^"]*)"/g)]
      .map((m) => m[1])
      .filter((c) => c.split(/\s+/).includes('ml-auto'))
      .filter((c) => !c.includes('lg:order-last'));
    expect(
      bad,
      'ml-auto 在 flex-wrap 里换行后仍然靠右，会孤零零占掉一整行；' +
        '窄屏要么让它跟着 w-full 兄弟留在第一行（配 lg:order-last 还原宽屏排序），要么别用它',
    ).toEqual([]);
  });

  it('每个 lg:order-last 都配着一句 w-full，否则它照样孤零零占一行', () => {
    // 这个修法是**一对**：右对齐的那个元素提到 DOM 靠前的位置（宽屏用 order-last 还原），
    // 同时让被它挤下去的那句话 `w-full` 独占第二行。只做前半边，窄屏第一行仍然只有它自己。
    //
    // 判据必须认这一对，不能只认某个原子类：`lg:w-auto` 在刷新按钮上是
    // 「窄屏方形图标钮、宽屏按内容宽」，跟独占一行毫无关系（写这条守卫时就先撞上了这个）。
    const classes = [...source.matchAll(/className="([^"]*)"/g)].map((m) => m[1]);
    const pinned = classes.filter((c) => c.includes('lg:order-last'));
    const spans = classes.filter((c) => {
      const t = c.split(/\s+/);
      return t.includes('w-full') && t.includes('lg:w-auto');
    });
    expect(pinned.length, '找不到 lg:order-last —— 布局被重写了？').toBeGreaterThan(0);
    // 是「至少」不是「恰好」：`w-full lg:w-auto` 本身是通用的「窄屏独占一行」手法，
    // 别处（客户端区标题旁那句说明）正当用它，不该把这条守卫判红。
    expect(
      spans.length,
      `有 ${pinned.length} 处 lg:order-last，却只有 ${spans.length} 句 w-full lg:w-auto 兜着它们`,
    ).toBeGreaterThanOrEqual(pinned.length);
  });

  it('区块标题不许被旁边的说明挤到折行', () => {
    // flex 项默认可收缩，而说明句往往比标题长得多、抢得也多 ——
    // 390 宽下被压到最窄的是标题：「连着的客户端」折成「连着的客户 / 端」。
    // 标题是这一屏的骨架，宁可让说明换行，也不能让它散架。
    const h2 = [...source.matchAll(/<h2\s+className="([^"]*)"/g)].map((m) => m[1]);
    expect(h2.length, '找不到区块标题 —— 布局被重写了？').toBeGreaterThan(0);
    for (const c of h2) {
      expect(c.split(/\s+/), `${c} 少了 shrink-0，窄屏会被旁边的说明压到折行`).toContain('shrink-0');
    }
  });

  it('页头窄屏是竖排，不靠 flex-wrap 兜底', () => {
    const t = tokensOfClassNameContaining('lg:flex-row lg:flex-wrap');
    expect(t).toContain('flex-col');
    expect(t, '裸 flex-wrap 会让页头在窄屏自动折行，而折行后的对齐没人管').not.toContain('flex-wrap');
  });

  it('主体栅格：撑满剩余高度只在 lg 生效', () => {
    const t = tokensOfClassNameContaining('lg:grid-cols-[minmax(0,1fr)_320px]');
    expect(t).toContain('lg:flex-1');
    expect(t).toContain('lg:min-h-0');
    expect(t).not.toContain('flex-1');
    expect(t).not.toContain('min-h-0');
  });
});
