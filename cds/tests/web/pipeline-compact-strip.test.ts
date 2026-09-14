/**
 * 首页紧凑条的守卫（2026-09-14，B 稿落地）。
 *
 * 这一版的核心是三件事，坏了都不报错：
 *
 * 1. **三段点阵共用同一个分母**（都是 changes 个格子，各自点亮几个）。
 *    一旦有人把某一段的分母改成它自己的条数，三段就不能对看了——而画面上
 *    只是点变密了一点，没人看得出来。
 * 2. **点子尺寸随条数反向变化**：数据少时格子大。上一版最大的毛病就是
 *    数据一少画面就空，这条是专门针对它的。
 * 3. **颜色一律走 token**。CDS 的 token 是 HSL 三元组，写死颜色在白天主题
 *    会直接变成暗底——这是本仓库被指出过十几次的老问题。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { dotMetrics } from '../../web/src/pages/reports/CompactStrip';

const src = readFileSync(resolve(__dirname, '../..', 'web/src/pages/reports/CompactStrip.tsx'), 'utf8');

/** 只看真正会渲染的样式，别把文档注释里提到的 hsl() 当成写死颜色（第一版就栽在这）。 */
const css = (() => {
  const m = src.match(/export const STRIP_CSS = `([\s\S]*?)\n`;/);
  expect(m, '找不到 STRIP_CSS').not.toBeNull();
  return m![1];
})();

describe('点子尺寸：数据越少，格子越大', () => {
  it('5 条时的格子明显大于 71 条时', () => {
    expect(dotMetrics(5).dot).toBeGreaterThan(dotMetrics(71).dot * 2);
  });

  it('条数越多格子只会越小，不会反弹', () => {
    let prev = Infinity;
    for (const n of [1, 5, 8, 9, 24, 25, 60, 71, 140, 320, 900]) {
      const d = dotMetrics(n).dot;
      expect(d, `n=${n} 的格子反而变大了`).toBeLessThanOrEqual(prev);
      prev = d;
    }
  });

  it('再多也留得住最小可见尺寸', () => {
    for (const n of [900, 5000, 100000]) {
      expect(dotMetrics(n).dot).toBeGreaterThanOrEqual(3);
      expect(dotMetrics(n).gap).toBeGreaterThanOrEqual(1);
    }
  });

  it('空数据不会算出负数或零尺寸', () => {
    for (const n of [0, -1, Number.NaN]) {
      const m = dotMetrics(n);
      expect(m.dot).toBeGreaterThan(0);
      expect(m.height).toBeGreaterThan(0);
    }
  });
});

describe('三段点阵必须共用同一个分母', () => {
  it('三个 Stage 的 total 都传 changes', () => {
    const stages = [...src.matchAll(/<Stage[\s\S]{0,400}?\/>/g)].map((m) => m[0]);
    expect(stages.length, '没找到三段').toBe(3);
    for (const st of stages) {
      expect(st, `这一段的分母不是 changes：${st.slice(0, 80)}`).toMatch(/total=\{changes\}/);
    }
  });

  it('每段点亮的是自己那一档，不是同一个数', () => {
    const stages = [...src.matchAll(/<Stage[\s\S]{0,400}?\/>/g)].map((m) => m[0]);
    const ns = stages.map((st) => st.match(/n=\{([^}]+)\}/)?.[1]);
    expect(new Set(ns).size, `三段点亮的是同一个数：${ns.join(' / ')}`).toBe(3);
  });
});

describe('项目条：宽度是条数，填充是验过的比例', () => {
  it('flex 按改动数分配', () => {
    expect(src).toMatch(/flex: ch > 0 \? `\$\{ch\} 1 8px`/);
  });

  it('填充高度是验过 / 改动，不是别的比例', () => {
    expect(src).toMatch(/height: `\$\{\(acc \/ ch\) \* 100\}%`/);
  });

  it('零改动的项目画成空槽而不是消失', () => {
    // 宽度归零它就没了，读者会以为这个项目不存在。
    expect(src).toMatch(/track empty/);
    expect(src).toMatch(/'0 0 8px'/);
  });

  it('验过数会被夹在 0 与改动数之间，脏数据不会撑爆填充', () => {
    expect(src).toMatch(/Math\.min\(ch, p\.funnel\.accepted\)/);
  });
});

describe('颜色一律走 token', () => {
  it('没有写死的颜色字面量', () => {
    // 十六进制、rgb()、以及 hsl() 里直接写数字（而不是 var(--x)）都算写死。
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/rgba?\(/);
    const hardHsl = [...css.matchAll(/hsl\(\s*[0-9.]/g)];
    expect(hardHsl.length, `有 ${hardHsl.length} 处 hsl() 直接写了数字`).toBe(0);
  });

  it('每个 hsl() 都包着 var(--token)', () => {
    const calls = [...css.matchAll(/hsl\([^)]*\)/g)].map((m) => m[0]);
    expect(calls.length).toBeGreaterThan(10);
    for (const c of calls) {
      expect(c, `这处 hsl 没走 token：${c}`).toMatch(/var\(--/);
    }
  });

  it('没有 emoji', () => {
    expect(src).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});

describe('窄屏不许塌', () => {
  it('默认竖排，宽屏才横排', () => {
    // 桌面那套 176px 定高 + 五栏横排塞进手机屏会互相重叠。
    expect(css).toMatch(/\.cs\{display:flex;flex-direction:column/);
    expect(css).toMatch(/@media \(min-width:1024px\)\{\s*\.cs\{flex-direction:row/);
  });

  it('竖排时不带定高', () => {
    const base = css.slice(css.indexOf('.cs{'), css.indexOf('@media (min-width:1024px)'));
    expect(base).not.toMatch(/height:\d/);
  });
});

describe('点亮的点必须真的亮', () => {
  // 真实数据上栽过一次：点亮色写在 `.cs .d` 基础规则**之前**，同特异性后写的赢，
  // 于是三段点阵全是浅灰、一个都不亮。页面照常渲染、类名照常挂上、测试照常绿。
  const idx = (re: RegExp): number => css.search(re);

  it('三档点亮色都定义了', () => {
    for (const tone of ['f1', 'f2', 'f3']) {
      expect(css, `缺 .d.${tone} 的点亮色`).toMatch(new RegExp(`\\.cs \\.d\\.${tone}\\{`));
    }
  });

  it('点亮色写在基础底色之后（同特异性，后写才赢）', () => {
    const base = idx(/\.cs \.d\{/);
    expect(base).toBeGreaterThan(-1);
    for (const tone of ['f1', 'f2', 'f3']) {
      const lit = idx(new RegExp(`\\.cs \\.d\\.${tone}\\{`));
      expect(lit, `.d.${tone} 写在 .d 之前，会被底色整条盖掉`).toBeGreaterThan(base);
    }
  });

  it('点亮色与底色不是同一个值', () => {
    const baseBg = css.match(/\.cs \.d\{[^}]*background:([^;}]+)/)?.[1]?.trim();
    expect(baseBg).toBeTruthy();
    for (const tone of ['f1', 'f2', 'f3']) {
      const litBg = css.match(new RegExp(`\\.cs \\.d\\.${tone}\\{background:([^;}]+)`))?.[1]?.trim();
      expect(litBg, `.d.${tone} 没有自己的颜色`).toBeTruthy();
      expect(litBg, `.d.${tone} 的颜色和底色一样，点亮等于没亮`).not.toBe(baseBg);
    }
  });
});
