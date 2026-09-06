import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildLiveSlideDoc,
  estimatePages,
  extractCompletedSections,
  extractHeadAssets,
  looksLikeDeck,
  parseExplicitPages,
  parseSlideProgress,
  resolveNaturalPatchSlideIndex,
  recoverPatchParentRun,
  resolveRecoveredDeckState,
} from '../MdToPptAgentPage';
import type { MdToPptRunDetail } from '@/services/real/mdToPptService';

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

describe('estimatePages', () => {
  it('优先识别用户显式页数', () => {
    expect(parseExplicitPages('严格生成 2 页高级产品发布会 PPT')).toBe(2);
    expect(parseExplicitPages('做一份两页控制台演示')).toBe(2);
    expect(parseExplicitPages('输出十二页技术方案')).toBe(12);
    expect(estimatePages('严格生成 2 页高级产品发布会 PPT，' + '内容很长'.repeat(500))).toBe(2);
  });
});

describe('looksLikeDeck', () => {
  it('只接受正文中存在真实幻灯元素且完整闭合的文档', () => {
    const padding = '正文'.repeat(120);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head><style>.slide{color:red}</style></head><body>${padding}</body></html>`)).toBe(false);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head><style>.slide{color:red}</style></head>${padding}`)).toBe(false);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head></head><body><script>const fake = '<div class="deck"><section class="slide">x</section></div>';</script>${padding}</body></html>`)).toBe(false);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head></head><body><script>const fake = '<section class="slide">x</section>';${padding}</body></html>`)).toBe(false);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head><script>const fake='</head><body><section class="slide">x</section>${padding}</body></html>'`)).toBe(false);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head><script>const fake='</head><body><section class="slide">x</section>${padding}</body></html>';</script></head></html>`)).toBe(false);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head></head><body><div class="deck"><section class="slide active"><h1>${padding}</h1></section></div></body></html>`)).toBe(true);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head></head><body><div class="presentation"><div class="slide active"><h1>${padding}</h1></div></div></body></html>`)).toBe(true);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head></head><body><div class='reveal'><div class='slides'><section><h1>${padding}</h1></section></div></div></body></html>`)).toBe(true);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head></head><body><div class='SLIDE active'><h1>${padding}</h1></div></body></html>`)).toBe(true);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head><style>${padding}</style></head><body><section class="slide"></section></body></html>`)).toBe(false);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head></head><body><section class="slide"><h1>${padding}</h1></body></html>`)).toBe(false);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head><style>body{display:none}</style></head><body><section class="slide"><h1>${padding}</h1></section></body></html>`)).toBe(false);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head></head><body style="visibility:hidden"><section class="slide"><h1>${padding}</h1></section></body></html>`)).toBe(false);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head></head><body><main id="root"><section class="slide"><h1>${padding}</h1></section></main></body></html>`)).toBe(true);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head></head><body><section class="slide" hidden><h1>${padding}</h1></section></body></html>`)).toBe(false);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head></head><body><section class="slide" aria-hidden="true"><h1>${padding}</h1></section></body></html>`)).toBe(false);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head></head><body><section class="slide"><svg></svg></section>${padding}</body></html>`)).toBe(false);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head></head><body><section class="slide"><svg><defs><path d="M0 0"></path></defs><path d=""></path></svg></section>${padding}</body></html>`)).toBe(false);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head><style>.slide{display:none}</style></head><body><section class="slide"><h1>${padding}</h1></section></body></html>`)).toBe(false);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head><style>/* deck */ .slide{display:none}</style></head><body><section class="slide"><h1>${padding}</h1></section></body></html>`)).toBe(false);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head><style>@media print{body{display:none}}</style></head><body><section class="slide active"><h1>序</h1></section>${padding}</body></html>`)).toBe(true);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head><style>@media screen{body{display:none}}</style></head><body><section class="slide active"><h1>序</h1></section>${padding}</body></html>`)).toBe(false);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head><style>.slide .notes{display:none}</style></head><body><section class="slide active"><h1>序</h1><div class="notes">备注</div></section>${padding}</body></html>`)).toBe(true);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head><style>.slide:not(.active){display:none}</style></head><body><section class="slide active"><h1>序</h1></section>${padding}</body></html>`)).toBe(true);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head></head><body><div class="deck" hidden><section class="slide active"><h1>${padding}</h1></section></div></body></html>`)).toBe(false);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head><style>.deck{display:none}</style></head><body><div class="deck"><section class="slide active"><h1>${padding}</h1></section></div></body></html>`)).toBe(false);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head><style>.missing .deck{display:none}</style></head><body><div class="deck"><section class="slide active"><h1>${padding}</h1></section></div></body></html>`)).toBe(true);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head><style>.deck{display:none}.deck.active{display:block}</style></head><body><div class="deck active"><section class="slide active"><h1>${padding}</h1></section></div></body></html>`)).toBe(true);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head><style>.slide{opacity:0!important}.slide.active{opacity:1}</style></head><body><section class="slide active"><h1>${padding}</h1></section></body></html>`)).toBe(false);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head><style>.slide{opacity:0!important}.slide.active{opacity:1!important}</style></head><body><section class="slide active"><h1>${padding}</h1></section></body></html>`)).toBe(true);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head><style>.slide{display:none!important}.missing .slide.active{display:block!important}</style></head><body><section class="slide active"><h1>${padding}</h1></section></body></html>`)).toBe(false);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head><style>.slide{display:none}.slide.active{opacity:1}</style></head><body><section class="slide active"><h1>${padding}</h1></section></body></html>`)).toBe(false);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head><style>.reveal{display:none}</style></head><body><div class="reveal"><div class="slides"><section><h1>${padding}</h1></section></div></div></body></html>`)).toBe(false);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head><style>.reveal .slides section{display:none}</style></head><body><div class="reveal"><div class="slides"><section><h1>${padding}</h1></section></div></div></body></html>`)).toBe(false);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head></head><body><div class="reveal"><div class="slides"></div></div><template><section><h1>${padding}</h1></section></template></body></html>`)).toBe(false);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head></head><body><div class="reveal"><div class="slides"><section><h1>标题</h1></section><section></section></div></div>${padding}</body></html>`)).toBe(false);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head></head><body><div class="reveal"><div class="slides"><section><section><h1>${padding}</h1></section><section></section></section></div></div></body></html>`)).toBe(false);
    expect(looksLikeDeck(`<!DOCTYPE html><html><head></head><body><section class="slide">&#32;&#32;</section>${padding}</body></html>`)).toBe(false);
  });
});

describe('自然语言单页精修识别', () => {
  it('与后端保守路由保持一致', () => {
    expect(resolveNaturalPatchSlideIndex('增加第 3 页标题字号')).toBe(3);
    expect(resolveNaturalPatchSlideIndex('把第 3 页标题移动到左侧')).toBe(3);
    expect(resolveNaturalPatchSlideIndex('删除第 3 页')).toBeNull();
    expect(resolveNaturalPatchSlideIndex('第 2 页与第 3 页对调')).toBeNull();
    expect(resolveNaturalPatchSlideIndex('把第 3 页移到最后')).toBeNull();
    expect(resolveNaturalPatchSlideIndex('把第 3 页和封面交换')).toBeNull();
    expect(resolveNaturalPatchSlideIndex('将第 3 页与下一页对调')).toBeNull();
  });

  it('将自然语言解析的页码传给服务端，不退化为整稿精修', () => {
    const source = readFileSync(new URL('../MdToPptAgentPage.tsx', import.meta.url), 'utf8');
    expect(source).toContain('slideIndex: effectiveSlideIndex ?? undefined');
    expect(source).not.toMatch(/streamMdToPptPatch\(\{[\s\S]*?\n\s*slideIndex,\n/);
  });
});

describe('精修刷新恢复', () => {
  it('服务端返回规范化派生版本时使用派生 runId 与 HTML', () => {
    const requestedHistoricalRunId = 'legacy-run';
    const derived = {
      id: 'normalized-run',
      status: 'done',
      op: 'normalize',
      html: '<html>normalized</html>',
    } as MdToPptRunDetail;

    const recovered = resolveRecoveredDeckState(derived);

    expect(recovered.runId).toBe('normalized-run');
    expect(recovered.runId).not.toBe(requestedHistoricalRunId);
    expect(recovered.html).toContain('normalized');
  });

  it('子 run 失败时从 parentRunId 恢复上一份完整演示稿', async () => {
    const failed = { id: 'patch-1', parentRunId: 'parent-1', status: 'error', op: 'patch' } as MdToPptRunDetail;
    const parent = { id: 'parent-1', status: 'done', op: 'convert', html: '<html>parent</html>' } as MdToPptRunDetail;
    const loaded: string[] = [];

    const recovered = await recoverPatchParentRun(failed, async id => {
      loaded.push(id);
      return parent;
    });

    expect(loaded).toEqual(['parent-1']);
    expect(recovered?.id).toBe('parent-1');
    expect(recovered?.html).toContain('parent');
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
