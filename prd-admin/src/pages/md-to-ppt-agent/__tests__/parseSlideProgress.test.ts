import { describe, expect, it } from 'vitest';
import { parseSlideProgress } from '../MdToPptAgentPage';

// 守护「生成等待面板逐页点亮」：从流式 HTML 里解析已闭合 <section> 的页标题，
// 以及是否有正在绘制（已开口未闭合）的页。
describe('parseSlideProgress', () => {
  it('空流：零页、无绘制中', () => {
    const p = parseSlideProgress('');
    expect(p.titles).toEqual([]);
    expect(p.building).toBe(false);
  });

  it('头部 CSS 阶段（无 section）：零页', () => {
    const p = parseSlideProgress('<!DOCTYPE html><html><head><style>.reveal{}</style>');
    expect(p.titles).toEqual([]);
    expect(p.building).toBe(false);
  });

  it('已闭合 section 抽出首个标题，未闭合的算绘制中', () => {
    const html =
      '<div class="slides">' +
      '<section><h1 class="title-xl">新品发布</h1><p>lead</p></section>' +
      '<section><div class="eyebrow">01</div><h2>市场现状</h2><ul><li>a</li></ul></section>' +
      '<section><h2>产品亮点';
    const p = parseSlideProgress(html);
    expect(p.titles).toEqual(['新品发布', '市场现状']);
    expect(p.building).toBe(true);
  });

  it('标题含内联标签时剥掉标签只留文本', () => {
    const p = parseSlideProgress('<section><h2>季度<span class="hl">业绩</span> 回顾</h2></section>');
    expect(p.titles).toEqual(['季度业绩 回顾']);
    expect(p.building).toBe(false);
  });

  it('无标题的页给空串占位（渲染层兜底显示"已生成"）', () => {
    const p = parseSlideProgress('<section><p>only text</p></section>');
    expect(p.titles).toEqual(['']);
  });
});
