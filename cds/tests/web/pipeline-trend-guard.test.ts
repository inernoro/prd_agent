/**
 * 走向折线的守卫（2026-09-14）。
 *
 * 折线这块有四种坏法，一种都不会报错：
 *
 * 1. **滚动均值算错开头**。不足窗口的那几天如果按窗口长度除，会凭空造出一段
 *    从零爬升的斜坡，读者会当成「那时候确实很少」。
 * 2. **紧凑态画了当日细线**。62px 高度上 90 条竖刺会糊成一片，走向反而没了。
 * 3. **刻度上限不写在图上**。两态刻度不同（紧凑按滚动峰值、放大按当日峰值），
 *    不写出来同一条线在两态高低不同就会被误读。
 * 4. **补一条部署线**。源头没有部署历史，任何这样的线都是编的。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { linePath, niceMax, rolling } from '../../web/src/pages/reports/TrendCharts';

const src = readFileSync(resolve(__dirname, '../..', 'web/src/pages/reports/TrendCharts.tsx'), 'utf8');
const panel = readFileSync(resolve(__dirname, '../..', 'web/src/pages/reports/PipelinePanel.tsx'), 'utf8');

const css = (() => {
  const m = src.match(/export const TREND_CSS = `([\s\S]*?)\n`;/);
  expect(m, '找不到 TREND_CSS').not.toBeNull();
  return m![1];
})();

describe('滚动均值：开头不许造出假斜坡', () => {
  it('前几天按实际可用天数取均，不按窗口长度', () => {
    // 全是 7 的序列，滚动均值应当从第一天起就是 7；
    // 按窗口长度除会得到 1,2,3,4,5,6,7 —— 一条不存在的爬升。
    expect(rolling([7, 7, 7, 7, 7, 7, 7], 7)).toEqual([7, 7, 7, 7, 7, 7, 7]);
  });

  it('窗口满了之后是真正的尾部滚动', () => {
    const r = rolling([0, 0, 0, 7, 0, 0, 0, 0], 7);
    expect(r[3]).toBeCloseTo(7 / 4, 6);
    expect(r[6]).toBeCloseTo(7 / 7, 6);
    // 第 8 天时那个 7 仍在 7 天窗内（下标 1..7），滚出窗口要到下一天。
    expect(r[7]).toBeCloseTo(7 / 7, 6);
  });

  it('长度恒等于输入，空数组不炸', () => {
    expect(rolling([], 7)).toEqual([]);
    expect(rolling([1, 2, 3], 7)).toHaveLength(3);
  });

  it('窗口参数非法时退回 1，不产生 NaN', () => {
    expect(rolling([1, 2], 0).every(Number.isFinite)).toBe(true);
    expect(rolling([1, 2], -5)).toEqual([1, 2]);
  });
});

describe('刻度：全零也不许除以零', () => {
  it('niceMax 永远 >= 1', () => {
    for (const v of [0, -3, Number.NaN, 0.2]) expect(niceMax(v)).toBeGreaterThanOrEqual(1);
  });

  it('单调不减，且能容下输入', () => {
    let prev = 0;
    for (const v of [1, 2, 5, 9, 16, 24, 70, 128, 319, 1000]) {
      const m = niceMax(v);
      expect(m, `${v} 的上限装不下它`).toBeGreaterThanOrEqual(v);
      expect(m).toBeGreaterThanOrEqual(prev);
      prev = m;
    }
  });
});

describe('路径：空数据不产出坏元素', () => {
  const g = { w: 100, h: 50, max: 10, x: (i: number) => i * 10, y: (v: number) => 50 - v * 5 };
  it('空数组给空串，调用方据此不渲染 path', () => {
    expect(linePath([], g)).toBe('');
    expect(src, '空串没被用来跳过渲染').toMatch(/d \? <path/);
  });

  it('全零也画得出一条贴零的线，不是不画', () => {
    // 「这段时间一件都没有」是真实信息，线消失会被读成没有数据。
    const d = linePath([0, 0, 0], g);
    expect(d).toMatch(/^M0\.0 50\.0 L/);
  });
});

describe('两态：紧凑不画当日细线，刻度上限写在图上', () => {
  it('当日细线关在 zoom 里', () => {
    expect(src).toMatch(/\{zoom\s*\?\s*lines\.map/);
  });

  it('滚动粗线两态都画（不在 zoom 条件里）', () => {
    // 粗线是读数层，紧凑态唯一的信息来源，一旦被关进 zoom，紧凑态就是空图。
    // 锚点必须落在 JSX 上：'读数层' 三个字在上面的 CSS 注释里也出现过，
    // 按它切会切到样式段，于是这条守卫查的根本不是渲染分支。
    const jsx = src.slice(src.indexOf('function Chart('));
    const block = jsx.slice(jsx.indexOf('读数层'), jsx.indexOf('每天一根透明列'));
    expect(block).toMatch(/lines\.map/);
    expect(block).not.toMatch(/zoom \?/);
  });

  it('刻度上限与它的口径都印在图上', () => {
    expect(src).toMatch(/上限 \{max\} 件\/日/);
    expect(src).toMatch(/当日峰值/);
    expect(src).toMatch(/7 日均/);
  });

  it('紧凑态按滚动峰值定刻度，放大态按当日峰值', () => {
    expect(src).toMatch(/niceMax\(zoom \? peak : rollPeak\)/);
  });
});

describe('画布高度要跟着整站尺度缩', () => {
  it('SVG 不用数值型 height 属性', () => {
    // SVG 的 height="62" 等于 62px，不跟根字号走。整站是 80/85/100 三档尺度
    // （html{font-size:85%}），于是会出现「周围的字缩了、画布没缩」。
    // rem-scale-guard 只扫 px 字面量与 style={{}} 里的数字，扫不到 SVG 属性，
    // 所以这条改动删掉不会有任何东西变红——那就得自己钉一条。
    expect(src, 'svg 用了数值型 height 属性').not.toMatch(/<svg[^>]*\sheight=\{[^}]*\}/);
    expect(src).toMatch(/style=\{\{ height: `\$\{h \/ 16\}rem` \}\}/);
  });
});

describe('部署那条线不许被补回来', () => {
  it('组件里没有任何部署序列的引用', () => {
    expect(src).not.toMatch(/deployed\s*[:.[]/);
    expect(src).not.toMatch(/lastDeployAt\s*\[/);
  });

  it('放大态照实说明为什么没有这条线', () => {
    expect(src).toMatch(/没有画的线/);
    expect(src).toMatch(/lastDeployAt/);
  });
});

describe('颜色一律走 token，且不是唯一编码', () => {
  it('没有写死的颜色字面量', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/rgba?\(/);
    expect([...css.matchAll(/hsl\(\s*[0-9.]/g)]).toHaveLength(0);
  });

  it('每个 hsl() 都包着 var(--token)', () => {
    const calls = [...css.matchAll(/hsl\([^)]*\)/g)].map((m) => m[0]);
    expect(calls.length).toBeGreaterThan(8);
    for (const c of calls) expect(c, `这处 hsl 没走 token：${c}`).toMatch(/var\(--/);
  });

  it('三档结论各有不同的线型，颜色之外还有第二编码', () => {
    // 白天主题下这三色的色觉分辨 ΔE 是 7.7，落在 6-8 的地板区，
    // 按 dataviz 的判据「只有配了第二编码才合法」。线型就是那个第二编码。
    const ok = css.match(/\.tc \.t-ok\{([^}]*)\}/)?.[1] ?? '';
    const warn = css.match(/\.tc \.t-warn\{([^}]*)\}/)?.[1] ?? '';
    const bad = css.match(/\.tc \.t-bad\{([^}]*)\}/)?.[1] ?? '';
    expect(ok).toBeTruthy();
    const dashes = [ok, warn, bad].map((s) => s.match(/stroke-dasharray:([^;]*)/)?.[1] ?? 'solid');
    expect(new Set(dashes).size, `三档线型不全互不相同：${dashes.join(' / ')}`).toBe(3);
  });

  it('图例的线型与线本身一致，不是各画各的', () => {
    for (const k of ['ok', 'warn', 'bad']) {
      expect(css, `图例缺 .d-${k}`).toMatch(new RegExp(`\\.tc \\.d-${k}\\{`));
    }
  });

  it('没有 emoji', () => {
    expect(src).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});

describe('窄屏不许塌', () => {
  it('默认竖排，宽屏才三张并排', () => {
    expect(css).toMatch(/\.tc \.row\{display:flex;flex-direction:column/);
    expect(css).toMatch(/@media \(min-width:1024px\)\{[\s\S]*?\.tc \.row\{flex-direction:row/);
  });
});

describe('接线：两态都渲染，缺 series 时整块消失而不是崩', () => {
  it('series 为 null 时不渲染走向', () => {
    expect(panel).toMatch(/series \? <TrendCharts series=\{series\} zoom=\{zoom\} \/> : null/);
  });

  it('紧凑态和放大态都挂了这一块', () => {
    const branch = panel.slice(panel.indexOf('{zoom ? ('));
    const zoomPart = branch.slice(0, branch.indexOf(') : ('));
    const compactPart = branch.slice(branch.indexOf(') : ('));
    expect(zoomPart, '放大态没有走向').toContain('{trends}');
    expect(compactPart, '紧凑态没有走向').toContain('{trends}');
  });

  it('样式表挂上了', () => {
    expect(panel).toMatch(/<style>\{TREND_CSS\}<\/style>/);
  });

  it('悬浮走面板已有的委托，没另造一套浮层', () => {
    expect(src).toMatch(/data-tip=\{tipFor\(i\)\}/);
    expect(src).not.toMatch(/onMouseOver|createPortal/);
  });
});
