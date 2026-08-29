import { describe, expect, it } from 'vitest';
import { detectSlideDeck } from './slideDeck';

describe('这份内容是不是一套幻灯片', () => {
  it('reveal.js 的容器结构算数', () => {
    expect(detectSlideDeck('<div class="reveal"><div class="slides"><section>一</section></div></div>')).toBe(true);
  });

  it('引了 reveal.js 脚本也算数（有些 deck 容器 class 是后加的）', () => {
    expect(detectSlideDeck('<script src="/assets/reveal.min.js"></script>')).toBe(true);
    expect(detectSlideDeck('<script>Reveal.initialize({ hash: true });</script>')).toBe(true);
  });

  it('impress / remark / deck.js 都要认，不只认 reveal', () => {
    expect(detectSlideDeck('<div id="impress"><div class="step">一</div></div>')).toBe(true);
    expect(detectSlideDeck('<script>var slideshow = remark.create();</script>')).toBe(true);
    expect(detectSlideDeck('<script src="deck.js"></script>')).toBe(true);
  });

  it('普通网页不算——宁可不提示，也不要在一篇文章上教人按方向键', () => {
    expect(detectSlideDeck('<article><h1>标题</h1><section>正文</section></article>')).toBe(false);
    expect(detectSlideDeck('<div class="slides-of-hand">手滑</div>')).toBe(false);
  });

  it('光有 class="reveal" 而没有 slides 容器不算——那可能只是个撞名的样式类', () => {
    expect(detectSlideDeck('<div class="reveal">一段会淡入的文字</div>')).toBe(false);
  });

  it('没取回正文时不下结论，返回 false 而不是猜', () => {
    expect(detectSlideDeck(null)).toBe(false);
    expect(detectSlideDeck(undefined)).toBe(false);
    expect(detectSlideDeck('')).toBe(false);
  });

  it('超大文档只扫前 200KB，不整篇跑正则', () => {
    const tail = '<div class="reveal"><div class="slides"></div></div>';
    // 痕迹被推到 200KB 之后 → 扫不到，如实返回 false（这是为速度付的已知代价）
    expect(detectSlideDeck('x'.repeat(200_001) + tail)).toBe(false);
    // 在窗口之内就必须扫到
    expect(detectSlideDeck('x'.repeat(1000) + tail)).toBe(true);
  });
});
