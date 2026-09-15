import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { placeAnchoredPanel, type AnchorRect } from '../anchoredPanel';

const ROOT = resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
const strip = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^[ \t]*\/\/[^\n]*/gm, '');
const VIEWPORT = { width: 1280, height: 800 };
const anchor = (o: Partial<AnchorRect> = {}): AnchorRect => ({ top: 600, bottom: 636, left: 300, right: 420, ...o });

/** 面板真正占据的竖向区间，用来断言「在不在视口里」。 */
const box = (p: { top: number; maxHeight: number }) => ({ top: p.top, bottom: p.top + p.maxHeight });

describe('贴着触发器弹出的浮层落点', () => {
  it('空间够时按首选方向来', () => {
    const above = placeAnchoredPanel({ anchor: anchor(), viewport: VIEWPORT, prefer: 'above', width: 260, maxHeight: 320 });
    expect(above.side).toBe('above');
    expect(above.maxHeight).toBe(320);
    // 面板底边应贴在触发器上方一个 gap 处。
    expect(box(above).bottom).toBe(600 - 6);

    const below = placeAnchoredPanel({ anchor: anchor(), viewport: VIEWPORT, prefer: 'below', width: 260, maxHeight: 320 });
    expect(below.side).toBe('below');
    expect(below.top).toBe(636 + 6);
  });

  it('【关键】页面滚到触发器接近视口顶部时不许把面板顶出屏幕', () => {
    // 这就是线上那个形态：恒定往上顶一整个面板高（最高 320），
    // 触发器离顶部只有 40px 时，面板整个跑到视口上方，一个选项都看不见。
    const p = placeAnchoredPanel({
      anchor: anchor({ top: 40, bottom: 76 }), viewport: VIEWPORT, prefer: 'above', width: 260, maxHeight: 320,
    });
    expect(box(p).top, '面板顶边不许越过视口上沿').toBeGreaterThanOrEqual(0);
    expect(box(p).bottom, '面板底边不许越过视口下沿').toBeLessThanOrEqual(VIEWPORT.height);
    // 上面装不下、下面装得下 → 翻到下面，而不是硬挤在上面。
    expect(p.side).toBe('below');
    expect(p.top).toBe(76 + 6);
  });

  it('【关键】上下都不宽裕时选更宽裕的那一侧，并把高度压到装得下', () => {
    const shortViewport = { width: 1280, height: 300 };
    const p = placeAnchoredPanel({
      anchor: anchor({ top: 200, bottom: 236 }), viewport: shortViewport, prefer: 'above', width: 260, maxHeight: 320,
    });
    // 上方 200-6-8=186，下方 300-236-6-8=50 → 留在上方，高度压到 186。
    expect(p.side).toBe('above');
    expect(p.maxHeight).toBe(186);
    expect(box(p).top).toBeGreaterThanOrEqual(0);
    expect(box(p).bottom).toBeLessThanOrEqual(shortViewport.height);
  });

  it('横向夹回视口：窄屏下右对齐也不会溢出左右边', () => {
    const narrow = { width: 360, height: 800 };
    const p = placeAnchoredPanel({
      anchor: anchor({ left: 300, right: 350 }), viewport: narrow, prefer: 'below', align: 'end', width: 320,
    });
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.left + p.width).toBeLessThanOrEqual(narrow.width - 8);
  });

  it('视口比面板还窄时宽度按视口来，不撑破', () => {
    const tiny = { width: 200, height: 800 };
    const p = placeAnchoredPanel({ anchor: anchor(), viewport: tiny, prefer: 'below', width: 320 });
    expect(p.width).toBe(200 - 16);
    expect(p.left).toBe(8);
  });

  it('不传 maxHeight 就用满那一侧的可用空间', () => {
    const p = placeAnchoredPanel({ anchor: anchor({ top: 100, bottom: 136 }), viewport: VIEWPORT, prefer: 'below', width: 320 });
    expect(p.maxHeight).toBe(800 - 136 - 6 - 8);
  });

  it('高度不会低于 minHeight——比那还矮的浮层已经没法用了', () => {
    const p = placeAnchoredPanel({
      anchor: anchor({ top: 10, bottom: 790 }), viewport: VIEWPORT, prefer: 'below', width: 260, maxHeight: 320, minHeight: 120,
    });
    expect(p.maxHeight).toBe(120);
    // 但 minHeight 撑出来的那部分也得留在屏幕里：触发器几乎贴着底边时，
    // 面板要往上盖住它，而不是把 120px 全挂到视口外面去。
    expect(box(p).bottom).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it('【关键】视口比 minHeight 还矮时以视口为准，不许把面板撑出屏幕', () => {
    // 输入法弹起来 / 横屏手机：视觉视口可能只剩一两百 px，两侧都装不下 minHeight。
    // 老写法 Math.max(minHeight, ...) 在这里会强行给 120，面板比屏幕还高；
    // 它是 fixed 定位，自己的 overflowY 救不了露在屏幕外的那半截（Codex PR #1476 P2）。
    const squashed = { width: 375, height: 190 };
    for (const prefer of ['above', 'below'] as const) {
      const p = placeAnchoredPanel({
        anchor: anchor({ top: 120, bottom: 156, left: 20, right: 140 }),
        viewport: squashed, prefer, width: 260, maxHeight: 320, minHeight: 120,
      });
      expect(p.maxHeight, `${prefer}: 不许高过视口减两条安全边`).toBeLessThanOrEqual(190 - 16);
      expect(box(p).top, `${prefer}: 顶边不许越过视口上沿`).toBeGreaterThanOrEqual(0);
      expect(box(p).bottom, `${prefer}: 底边不许越过视口下沿`).toBeLessThanOrEqual(squashed.height);
    }
  });

  it('【关键】任意极端视口下，面板都留在屏幕里（扫一遍，不挑一两个点)', () => {
    // 单点用例只能证明我想到的那几种情形。这里把触发器沿着视口从上扫到下，
    // 视口高度也从「装得下」扫到「比 minHeight 还矮」，逐个断言不出屏。
    for (const height of [1000, 800, 400, 190, 120, 60, 20]) {
      for (let top = 0; top <= height; top += 17) {
        for (const prefer of ['above', 'below'] as const) {
          const p = placeAnchoredPanel({
            anchor: anchor({ top, bottom: top + 36, left: 20, right: 140 }),
            viewport: { width: 375, height }, prefer, width: 260, maxHeight: 320, minHeight: 120,
          });
          const b = box(p);
          expect(b.top, `h=${height} top=${top} ${prefer}`).toBeGreaterThanOrEqual(0);
          expect(b.bottom, `h=${height} top=${top} ${prefer}`).toBeLessThanOrEqual(height);
          expect(p.left).toBeGreaterThanOrEqual(0);
          expect(p.left + p.width).toBeLessThanOrEqual(375);
        }
      }
    }
  });
});

describe('两处浮层都走这一份算法（形状 3 守卫）', () => {
  // 同一个 PR 里出现两处「按视口夹紧」的算术就已经是分裂的开始。
  // 这条钉住：谁也不许在组件里自己再算一遍落点。
  it.each([
    'src/pages/visual-agent/VisualAgentWorkspaceListPage.tsx',
    'src/components/visual-agent/BackdropSettings.tsx',
  ])('%s 消费共享落点函数', (rel) => {
    expect(read(rel)).toContain('placeAnchoredPanel(');
  });

  it('【关键】模型选择器不再用 CSS 把面板往上顶一整个高度', () => {
    // translateY(-100%) 是把「面板多高」这件事交给渲染后的实际高度，
    // 落点算的时候根本不知道它会顶到哪去——正是跑出视口的那个写法。
    //
    // 必须先剥注释。本仓库这个坑踩到第六次了：判据扫源码，而源码里**解释这条判据的
    // 那句注释**本身就写着它要找的形状（上一行就是），于是守卫抓到自己的说明文字判红。
    const src = strip(read('src/pages/visual-agent/VisualAgentWorkspaceListPage.tsx'));
    const at = src.indexOf('function ModelPickerButton');
    const body = src.slice(at, src.indexOf('\nfunction ', at + 10));
    expect(body).not.toContain('translateY(-100%)');
    expect(body, '滚动与改窗口都要重算，否则浮层会和触发器脱开').toMatch(/addEventListener\('scroll'/);
    expect(body).toMatch(/addEventListener\('resize'/);
  });
});
