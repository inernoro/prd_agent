import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { consumeWakeOnce, resetWakeForTest } from '../wakeSweep';

const ROOT = resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
const strip = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^[ \t]*\/\/[^\n]*/gm, '');

const PAGE = 'src/pages/visual-agent/VisualAgentWorkspaceListPage.tsx';
const GLOBALS = 'src/styles/globals.css';

describe('唤醒只发生在整页刷新', () => {
  beforeEach(() => resetWakeForTest());

  it('第一次拿得到，之后一律拿不到', () => {
    expect(consumeWakeOnce()).toBe(true);
    expect(consumeWakeOnce()).toBe(false);
    expect(consumeWakeOnce()).toBe(false);
  });

  it('页面用 useState 的初始化函数消费，而不是在 render 里直接调', () => {
    // consumeWakeOnce 有副作用：读一次就没了。写成 useState(consumeWakeOnce())
    // 会在每次 render 求值——React 只用第一次的返回值，但机会已经被后续 render
    // 白白消费掉，于是 SPA 内再进这一页永远拿不到 true。必须是惰性初始化。
    const page = strip(read(PAGE));
    expect(page).toContain('useState(() => consumeWakeOnce())');
    expect(page).not.toMatch(/useState\(consumeWakeOnce\(\)\)/);
  });
});

describe('方向性：幕从左上退到右下 + 元素沿路依次点亮', () => {
  it('是「幕在退」不是「光带在扫」——幕必须用页面底色遮住，退到哪才显影到哪', () => {
    // 这条是这一版的核心判据。上一版做的是窄光带（加法高光），经过之后画面回到原样，
    // 观感就是「一闪而过」；用户要的是 Apple 壁纸那种不可逆的推进。
    // 两者的机械差别就在这里：幕里必须有一段**不透明的页面底色**。
    const css = read(GLOBALS);
    const body = css.slice(css.indexOf('.wake-veil {'), css.indexOf('@keyframes wake-illuminate'));
    expect(body).toContain('var(--bg-base)');
    // 起点必须是「遮住」的那一侧，否则第一帧就是亮的，没有被点亮的过程。
    expect(body).toMatch(/transform:\s*translate3d\(-\d+%,\s*-\d+%/);
  });

  it('几何参数是量出来的那一组，改了必须重跑探针', () => {
    // 这条守的不是「好看」，是**幕真的盖得住**。
    // translate 的百分比按元素自身算，而这个元素是父级的 3.4 倍，再叠 135deg 的斜向投影，
    // 手推必错：第一版 inset:-55% + translate:±55% 实际位移是父级的 115%，
    // 幕直接滑出画面，探针实测 t=0 四角 20/43/43/37——刚打开就漏了大半张图，
    // 「被点亮」这个过程压根不存在，而代码看上去完全正常。
    //
    // 所以这里钉死那一组实测通过的数值。要改就先跑 scripts/wake-veil-probe.mjs，
    // 确认 t=0 四角全等于页面底色、t=末全等于原图，再回来改这条。
    const css = read(GLOBALS);
    const body = css.slice(css.indexOf('.wake-veil {'), css.indexOf('@keyframes wake-illuminate'));
    expect(body).toContain('inset: -120%');
    expect(body).toContain('translate3d(-30%, -30%, 0)');
    expect(css).toContain('scripts/wake-veil-probe.mjs');
  });

  it('推进够慢，不会退回「闪一下」', () => {
    const ms = Number(read(GLOBALS).match(/animation: wake-illuminate (\d+)ms/)![1]);
    expect(ms).toBeGreaterThanOrEqual(1500);
  });

  it('幕存在，且只走一遍（forwards，不循环）', () => {
    const css = read(GLOBALS);
    const rule = css.slice(css.indexOf('.wake-veil {'));
    const body = rule.slice(0, rule.indexOf('}') + 1);
    expect(body).toContain('animation: wake-illuminate');
    expect(body).toContain('forwards');
    expect(body).not.toContain('infinite');
  });

  it('渐变是 135deg——正指右下，正交的方向读不出「从左上角点亮」', () => {
    const css = read(GLOBALS);
    const body = css.slice(css.indexOf('.wake-veil {'), css.indexOf('@keyframes wake-illuminate'));
    const deg = body.match(/linear-gradient\((\d+)deg/);
    expect(deg).not.toBeNull();
    // 135deg 在 CSS 里正指右下角，正是「从左上角点亮到右下角」的那条对角线。
    // 上一版这里写的是开区间 (90,135)，因为那版是 105deg 的窄光带；换成幕之后
    // 恰好该取 135，判据当场判红——该改的是判据。区间放到 [110,160]：
    // 再偏就退回横扫或下拉，读不出对角。
    const d = Number(deg![1]);
    expect(d).toBeGreaterThanOrEqual(110);
    expect(d).toBeLessThanOrEqual(160);
  });

  it('位移是左上 → 右下，不是反过来也不是横平竖直', () => {
    const css = read(GLOBALS);
    const kf = css.slice(css.indexOf('@keyframes wake-illuminate'));
    const block = kf.slice(0, kf.indexOf('\n}') + 2);
    const from = block.match(/from\s*\{[^}]*translate3d\((-?[\d.]+)%,\s*(-?[\d.]+)%/);
    const to = block.match(/to\s*\{[^}]*translate3d\((-?[\d.]+)%,\s*(-?[\d.]+)%/);
    expect(from).not.toBeNull();
    expect(to).not.toBeNull();
    // x 与 y 都必须净增：只增 x 是横扫，只增 y 是下拉，都没有「斜下来」。
    expect(Number(to![1])).toBeGreaterThan(Number(from![1]));
    expect(Number(to![2])).toBeGreaterThan(Number(from![2]));
  });

  it('页面元素沿光路依次亮，延迟单调递增', () => {
    // 只有幕在退、页面元素却一起淡入，就看不出是被那条推进线点亮的
    // （demo-causality-contract：先走到，再发生）。延迟必须铺满整个推进过程：
    // 上一版全挤在 40-600ms，光还在左上、右下的东西已经亮完了。
    const page = strip(read(PAGE));
    // 尾随的 `[,)]` 是必须的：rise 现在有第二个参数（base className），
    // 写死 `rise\((\d+)\)` 只匹配得到没传 base 的那几处，静默少数几站，
    // 而 length 断言又只要求 >= 4，于是「漏了两站」这件事根本不会红。
    const delays = [...page.matchAll(/rise\((\d+)\s*[,)]/g)].map((m) => Number(m[1]));
    const inline = [...page.matchAll(/'--wake-delay': '(\d+)ms'/g)].map((m) => Number(m[1]));
    const all = [...delays, ...inline].sort((a, b) => a - b);
    expect(all.length).toBeGreaterThanOrEqual(4);
    // 去重后仍应有多个不同档位——全都相同就是一起淡入，没有方向。
    expect(new Set(all).size).toBe(all.length);
    // 最后一站要落在幕的行程之内，否则幕早退完了元素才亮，因果就断了。
    const beamMs = Number(read(GLOBALS).match(/animation: wake-illuminate (\d+)ms/)![1]);
    expect(Math.max(...all)).toBeLessThan(beamMs);
  });

  it('rise() 的 className 不许被元素自己的 className 覆盖', () => {
    // 真实事故：<div className="w-full flex justify-center" {...rise(950)}>
    // JSX 的 spread 在后面，rise 返回的 className 把前面那串整个覆盖掉；
    // 包裹层丢了 w-full，父级又是 flex-col + items-center（块级子元素不拉伸），
    // 于是塌成内容宽，1300 的长输入框缩成三百多。
    //
    // 最阴的是它只在 wake 为 true 时发生——也就是**只有整页刷新时**，
    // SPA 内点进来完全正常，本地取证也照不出来（取证里宽度是写死的）。
    //
    // 所以判据盯形状：同一行里不许既有 className= 又有 {...rise(。
    // base 要走 rise 的第二个参数，合并由函数负责。
    //
    // 必须先剥注释：本仓库这个坑已经踩到第五次——判据扫源码，而源码里解释这条判据的
    // 注释本身就写着它要找的形状（上面第一行就是），于是守卫抓自己的说明文字。
    const src = strip(read(PAGE));
    // companion：确认剥完之后还剩真代码，否则上面那条会对着空字符串判绿。
    expect(src).toContain('{...rise(');
    const offenders = src
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => line.includes('{...rise(') && line.includes('className='));
    expect(offenders.map(([n, l]) => `${n}: ${l.trim()}`)).toEqual([]);
  });

  it('关掉动效时元素直接就位，不留下歪着或发暗的终态', () => {
    const css = read(GLOBALS);
    const mq = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('.wake-veil')));
    const block = mq.slice(0, mq.indexOf('\n}\n') + 3);
    expect(block).toContain('.wake-veil { display: none; }');
    // 只写 opacity 会留下 translate 与 brightness 的初值——页面歪着且发暗。
    for (const must of ['opacity: 1', 'transform: none', 'filter: none']) {
      expect(block).toContain(must);
    }
  });
});
