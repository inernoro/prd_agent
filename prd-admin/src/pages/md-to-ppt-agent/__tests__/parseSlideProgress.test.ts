import { describe, expect, it } from 'vitest';
import {
  buildLiveSlideDoc,
  extractCompletedSections,
  extractHeadAssets,
  parseSlideProgress,
} from '../MdToPptAgentPage';

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

// 守护「生成实况渲染」：iframe srcDoc 只有在新页闭合时才变化（字符串恒等 = 不重载不闪烁）
describe('live slide doc（实况渲染）', () => {
  const head =
    '<!DOCTYPE html><html><head>' +
    '<link rel="stylesheet" href="https://cdn.example/reveal.css">' +
    '<style>.reveal{color:#fff}</style></head><body>';

  it('抽取 head 里的 link 与完整 style 块', () => {
    const assets = extractHeadAssets(head + '<div class="reveal">');
    expect(assets).toContain('reveal.css');
    expect(assets).toContain('.reveal{color:#fff}');
  });

  it('未闭合的 style 块不抽取（避免半截 CSS 污染实况页）', () => {
    const assets = extractHeadAssets('<head><style>.reveal{col');
    expect(assets).toBe('');
  });

  it('section 闭合数量不变时，构出的文档字符串恒等（iframe 不重载）', () => {
    const s1 = head + '<section><h2>A</h2></section><section><h2>B 还在写';
    const s2 = s1 + '一些后续增量但 B 仍未闭合';
    const sec1 = extractCompletedSections(s1);
    const sec2 = extractCompletedSections(s2);
    expect(sec1).toEqual(sec2);
    const doc1 = buildLiveSlideDoc(extractHeadAssets(s1), sec1[sec1.length - 1]);
    const doc2 = buildLiveSlideDoc(extractHeadAssets(s2), sec2[sec2.length - 1]);
    expect(doc1).toBe(doc2);
  });

  it('新页闭合后文档变化，且包含该页内容与静态铺版 CSS', () => {
    const s = head + '<section><h2>A</h2></section><section><h2>B</h2></section>';
    const secs = extractCompletedSections(s);
    expect(secs).toHaveLength(2);
    const doc = buildLiveSlideDoc(extractHeadAssets(s), secs[1]);
    expect(doc).toContain('<h2>B</h2>');
    expect(doc).toContain('.reveal .slides section{display:flex !important');
    expect(doc).not.toContain('<h2>A</h2>');
  });
});
