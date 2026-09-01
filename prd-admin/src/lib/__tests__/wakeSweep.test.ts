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

describe('方向性：一束光 + 沿光路依次点亮，两件都要有', () => {
  it('光带存在，且只走一遍（forwards，不循环）', () => {
    const css = read(GLOBALS);
    const rule = css.slice(css.indexOf('.wake-beam {'));
    const body = rule.slice(0, rule.indexOf('}') + 1);
    expect(body).toContain('animation: wake-beam-pass');
    expect(body).toContain('forwards');
    expect(body).not.toContain('infinite');
  });

  it('光带是斜的——正交的扫光没有「从左上下来」这个方向', () => {
    const css = read(GLOBALS);
    const body = css.slice(css.indexOf('.wake-beam {'), css.indexOf('@keyframes wake-beam-pass'));
    const deg = body.match(/linear-gradient\((\d+)deg/);
    expect(deg).not.toBeNull();
    const d = Number(deg![1]);
    expect(d).toBeGreaterThan(90);
    expect(d).toBeLessThan(135);
  });

  it('位移是左上 → 右下，不是反过来也不是横平竖直', () => {
    const css = read(GLOBALS);
    const kf = css.slice(css.indexOf('@keyframes wake-beam-pass'));
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
    // 只有光带 = 一道划过屏幕的高光，页面自己没反应，光就是贴上去的装饰
    // （demo-causality-contract：东西自己在变 / 光在动但什么都没被点亮）。
    // 依次亮起来才是「这束光把它们点亮了」。
    const page = strip(read(PAGE));
    const delays = [...page.matchAll(/rise\((\d+)\)/g)].map((m) => Number(m[1]));
    const inline = [...page.matchAll(/'--wake-delay': '(\d+)ms'/g)].map((m) => Number(m[1]));
    const all = [...delays, ...inline].sort((a, b) => a - b);
    expect(all.length).toBeGreaterThanOrEqual(4);
    // 去重后仍应有多个不同档位——全都相同就是一起淡入，没有方向。
    expect(new Set(all).size).toBe(all.length);
    // 最后一站要落在光带行程之内，否则光早走完了元素才亮，因果就断了。
    const beamMs = Number(read(GLOBALS).match(/animation: wake-beam-pass (\d+)ms/)![1]);
    expect(Math.max(...all)).toBeLessThan(beamMs);
  });

  it('关掉动效时元素直接就位，不留下歪着或发暗的终态', () => {
    const css = read(GLOBALS);
    const mq = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('.wake-beam')));
    const block = mq.slice(0, mq.indexOf('\n}\n') + 3);
    expect(block).toContain('.wake-beam { display: none; }');
    // 只写 opacity 会留下 translate 与 brightness 的初值——页面歪着且发暗。
    for (const must of ['opacity: 1', 'transform: none', 'filter: none']) {
      expect(block).toContain(must);
    }
  });
});
