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
import { splitFunnel } from '@/lib/pipelineFunnel';
import { dotMetrics, rowSplit } from '../../web/src/pages/reports/CompactStrip';
import { splitChanges } from '../../web/src/pages/reports/PipelinePanel';
import type { PipelineFunnel } from '../../web/src/lib/api';

const src = readFileSync(resolve(__dirname, '../..', 'web/src/pages/reports/CompactStrip.tsx'), 'utf8');
const panel = readFileSync(resolve(__dirname, '../..', 'web/src/pages/reports/PipelinePanel.tsx'), 'utf8');

function funnel(p: Partial<PipelineFunnel>): PipelineFunnel {
  return {
    changes: 0, deployed: 0, accepted: 0, merged: 0,
    pass: 0, conditional: 0, fail: 0, undetermined: 0, ...p,
  };
}

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
    // 不认单位：钉的是「flex 基数取 ch」，不是当时用 px 还是 rem 写的 basis。
    expect(src).toMatch(/flex: ch > 0 \? `\$\{ch\} 1 [\d.]+(?:px|rem)`/);
  });

  it('填充高度是验过 / 改动，不是别的比例', () => {
    expect(src).toMatch(/height: `\$\{\(acc \/ ch\) \* 100\}%`/);
  });

  it('零改动的项目画成空槽而不是消失', () => {
    // 宽度归零它就没了，读者会以为这个项目不存在。
    expect(src).toMatch(/track empty/);
    expect(src).toMatch(/'0 0 [\d.]+(?:px|rem)'/);
  });

  it('验过数会被夹在 0 与改动数之间，脏数据不会撑爆填充', () => {
    // 原先这条钉的是 `Math.min(ch, p.funnel.accepted)` 这段字面实现，于是它反锁住了
    // 一个比需要更窄的判据：只夹到 changes，不夹到 deployed。改成断言行为本身——
    // 无论多脏的输入，这一垛用的 acc 都落在 [0, ch] 里，且与图、明细行同源。
    expect(src, '项目垛必须和总览条、明细行读同一个函数').toContain('splitFunnel(p.funnel).accepted');
    const dirty = [
      { changes: 4, deployed: 1, accepted: 9, merged: 0, pass: 0, conditional: 0, fail: 0, undetermined: 0 },
      { changes: 0, deployed: 5, accepted: 5, merged: 0, pass: 0, conditional: 0, fail: 0, undetermined: 0 },
      { changes: -3, deployed: -1, accepted: -7, merged: 0, pass: 0, conditional: 0, fail: 0, undetermined: 0 },
      { changes: 6, deployed: 6, accepted: 6, merged: 0, pass: 0, conditional: 0, fail: 0, undetermined: 0 },
    ];
    for (const f of dirty) {
      const ch = Math.max(0, f.changes);
      const acc = splitFunnel(f).accepted;
      expect(acc, `脏输入 ${JSON.stringify(f)} 把填充撑出了 [0, ch]`).toBeGreaterThanOrEqual(0);
      expect(acc).toBeLessThanOrEqual(ch);
    }
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

  // 中性三档（各段自己的深浅）+ 结论三档（已验完那段按 pass/conditional/fail 分色）。
  // 结论三档是 2026-09-14 补的：此前主体全是灰阶，用户原话「我看起来图标非常的清淡」。
  const TONES = ['f1', 'f2', 'f3', 'v-ok', 'v-warn', 'v-bad'];

  it('结论三档在 JSX 里真的被算出来并挂上去', () => {
    // 少了这条，CSS 里三档颜色齐全、JSX 一个都不发，页面照样是一片灰。
    for (const cls of ['v-ok', 'v-warn', 'v-bad']) {
      expect(src, `没有任何地方产出 ${cls}`).toContain(`'${cls}'`);
    }
    // 三档分别来自 pass / conditional / fail，不是同一个数填三遍。
    expect(src).toMatch(/t\.pass[\s\S]{0,40}'v-ok'/);
    expect(src).toMatch(/t\.conditional[\s\S]{0,40}'v-warn'/);
    expect(src).toMatch(/t\.fail[\s\S]{0,40}'v-bad'/);
  });

  it('六档点亮色都定义了', () => {
    for (const tone of TONES) {
      expect(css, `缺 .d.${tone} 的点亮色`).toMatch(new RegExp(`\\.cs \\.d\\.${tone}\\{`));
    }
  });

  it('点亮色写在基础底色之后（同特异性，后写才赢）', () => {
    const base = idx(/\.cs \.d\{/);
    expect(base).toBeGreaterThan(-1);
    for (const tone of TONES) {
      const lit = idx(new RegExp(`\\.cs \\.d\\.${tone}\\{`));
      expect(lit, `.d.${tone} 写在 .d 之前，会被底色整条盖掉`).toBeGreaterThan(base);
    }
  });

  it('点亮色与底色不是同一个值', () => {
    const baseBg = css.match(/\.cs \.d\{[^}]*background:([^;}]+)/)?.[1]?.trim();
    expect(baseBg).toBeTruthy();
    for (const tone of TONES) {
      const litBg = css.match(new RegExp(`\\.cs \\.d\\.${tone}\\{background:([^;}]+)`))?.[1]?.trim();
      expect(litBg, `.d.${tone} 没有自己的颜色`).toBeTruthy();
      expect(litBg, `.d.${tone} 的颜色和底色一样，点亮等于没亮`).not.toBe(baseBg);
    }
  });
});

/* 下面两段是厂房剖面那版守卫（pipeline-scale-guard）里唯一与几何无关、
   因而在这一版仍然成立的判据，随文件删除一并搬过来，不是新写的。 */

describe('三段相加必须等于总数（总览与每一行同一套拆法）', () => {
  const cases: PipelineFunnel[] = [
    // 主实例真实形状：71 条改动 / 70 条部署过 / 5 条验过。
    funnel({ changes: 71, deployed: 70, accepted: 5, pass: 1, conditional: 1, fail: 3 }),
    // 预览实例的演示数据量级。
    funnel({ changes: 5, deployed: 5, accepted: 2, pass: 1, conditional: 1 }),
    funnel({}),
    funnel({ changes: 1, deployed: 0 }),
    funnel({ changes: 900, deployed: 880, accepted: 400 }),
    // 口径错位的脏数据（验过的比部署的还多）也不许把三段算成负数。
    funnel({ changes: 3, deployed: 1, accepted: 9 }),
  ];

  it.each(cases.map((f, i) => [i, f] as const))('第 %i 组：总览三段非负且加得回 changes', (_i, f) => {
    const { accepted, heap, undeployed } = splitChanges(f);
    expect(accepted).toBeGreaterThanOrEqual(0);
    expect(heap).toBeGreaterThanOrEqual(0);
    expect(undeployed).toBeGreaterThanOrEqual(0);
    if (f.deployed >= f.accepted && f.changes >= f.deployed) {
      expect(accepted + heap + undeployed).toBe(f.changes);
    }
  });

  it.each(cases.map((f, i) => [i, f] as const))('第 %i 组：放大态每行三段恒等于 changes', (_i, f) => {
    const { accepted, heap, undeployed } = rowSplit(f);
    expect(accepted).toBeGreaterThanOrEqual(0);
    expect(heap).toBeGreaterThanOrEqual(0);
    expect(undeployed).toBeGreaterThanOrEqual(0);
    // rowSplit 自己把脏数据夹住，所以这条对六组全都成立，没有前置条件。
    expect(accepted + heap + undeployed).toBe(Math.max(0, f.changes));
  });
});

describe('紧凑态与放大态是同一张图，不是两套编码', () => {
  it('放大态渲染的仍是同一个 CompactStrip 实例', () => {
    // 之前放大态是另一套厂房剖面，读者要在两种编码之间来回翻译。
    // 这里钉住「两态共用同一个 strip 变量」，换成另建一棵树就会红。
    expect(panel).toMatch(/const strip = \(\s*<CompactStrip/);
    const zoomBranch = panel.slice(panel.indexOf('{zoom ? ('));
    expect(zoomBranch).toMatch(/<Card>\{strip\}<\/Card>/);
    expect(zoomBranch).toMatch(/<ExpandedPanel/);
  });

  it('紧凑态给的仍是同一个 strip，没有被换成另一棵树', () => {
    const zoomBranch = panel.slice(panel.indexOf('{zoom ? ('));
    const compact = zoomBranch.slice(zoomBranch.indexOf(') : ('));
    // 2026-09-14 走向折线落地后，紧凑态是「存量 strip + 走向」两块，不再是光秃秃
    // 一个 strip。判据跟着从「只能是 strip」改成「必须包含那个 strip 变量」——
    // 它防的事没变：存量那张图两态同源，不许在紧凑态另建一棵树。
    expect(compact, '紧凑态没有渲染那个 strip 变量').toMatch(/\{strip\}/);
    // 另建一棵树的样子就是这里又出现一次 <CompactStrip ...>。
    expect(compact, '紧凑态自己又建了一个 CompactStrip').not.toMatch(/<CompactStrip/);
  });

  it('放大态的样式表跟着一起挂上了', () => {
    // EXPAND_CSS 忘了挂 <style> 的话，放大出来是一张没有样式的裸表格。
    expect(panel).toMatch(/<style>\{EXPAND_CSS\}<\/style>/);
    expect(panel).toMatch(/<style>\{STRIP_CSS\}<\/style>/);
  });
});
