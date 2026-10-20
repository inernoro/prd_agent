// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildDeckPreviewPageDocs,
  buildLiveSlideDoc,
  countDeckPages,
  estimatePages,
  extractCompletedSections,
  extractHeadAssets,
  looksLikeDeck,
  mergeRuntimeModelCallCount,
  parseExplicitPages,
  parseSlideProgress,
  PptRuntimeLivePreview,
  PptRuntimeProgressHeader,
  isPreviewableDeck,
  resolveOutlineTargetPages,
  resolveNaturalPatchSlideIndex,
  recoverPatchParentRun,
  resolveRecoveredDeckState,
  selectRuntimeLivePreviewDoc,
} from '../MdToPptAgentPage';
import { NextStepBar } from '../NextStepBar';
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

  it('不把章节号、文档内页码或 P 开头的单词当成页数', () => {
    expect(parseExplicitPages('### 6.1 PR 的大小与标题')).toBeNull();
    expect(parseExplicitPages('请参考本文档第 20 页')).toBeNull();
    expect(parseExplicitPages('1 prompt 示例')).toBeNull();
  });

  it('只从用户需求识别显式页数，自动页数交给服务端按冻结来源容量计算', () => {
    const reference = '附件共 2 页\n### 6.1 PR 的大小与标题\n' + '资料'.repeat(8000);
    expect(resolveOutlineTargetPages('请把附件整理成演示稿', reference)).toBeUndefined();
    expect(resolveOutlineTargetPages('请生成 20 页演示稿', '附件共 2 页')).toBe(20);
    expect(resolveOutlineTargetPages('请生成 20p 演示稿', '附件共 2 页')).toBe(20);
    expect(resolveOutlineTargetPages('请生成 34 页演示稿', reference)).toBe(34);
    expect(resolveOutlineTargetPages('请生成 41 页演示稿', reference)).toBe(41);
  });

  it('大纲、确认与生成请求都把附件作为独立字段发送，不拼回普通需求 content', () => {
    const page = readFileSync(resolve(process.cwd(), 'src/pages/md-to-ppt-agent/MdToPptAgentPage.tsx'), 'utf8');
    const service = readFileSync(resolve(process.cwd(), 'src/services/real/mdToPptService.ts'), 'utf8');
    const outlineRequestStart = page.indexOf('const cleanup = streamMdToPptOutline({');
    const outlineRequestEnd = page.indexOf('onKnowledgeResolved:', outlineRequestStart);
    const outlineRequest = page.slice(outlineRequestStart, outlineRequestEnd);
    expect(outlineRequest).toContain('content: userText');
    expect(outlineRequest).toContain('attachmentText: attachmentText || undefined');
    expect(outlineRequest).not.toContain('[userText, attachmentText]');
    expect(page).toContain('attachmentText: attachmentText || undefined');
    expect(service.match(/attachmentText: options\.attachmentText/g)).toHaveLength(3);
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

describe('countDeckPages', () => {
  it('counts only top-level authored pages from OpenDesign previews', () => {
    expect(countDeckPages('<div class="reveal"><div class="slides"><section>A</section><section>B</section></div></div>')).toBe(2);
    expect(countDeckPages('<div class="deck"><section class="slide"><div class="slide">nested</div></section><section class="slide">B</section></div>')).toBe(2);
    expect(countDeckPages('<main><section>A</section></main>')).toBe(0);
  });
});

describe('OpenDesign 运行态可见信息', () => {
  it('脚本初始化导航的真实 Reveal 预览通过事件接受、拆页和桌面选择链', () => {
    const padding = '冻结来源正文'.repeat(80);
    const previewHtml = `<!doctype html><html><head><style>
      .slides>section{display:none;height:100%}
      .slides>section.present{display:flex}
    </style></head><body><div class="reveal"><div class="slides">
      <section><h1>第一页</h1><p>${padding}</p></section>
      <section><h1>第二页</h1><p>${padding}</p></section>
    </div></div><script>document.querySelector('.slides>section')?.classList.add('present')</script></body></html>`;
    expect(looksLikeDeck(previewHtml)).toBe(false);
    expect(isPreviewableDeck(previewHtml)).toBe(true);
    const generatedHtml = isPreviewableDeck(previewHtml) ? previewHtml : '';
    const previewPageDocs = buildDeckPreviewPageDocs(generatedHtml);
    expect(previewPageDocs).toHaveLength(2);
    expect(previewPageDocs.every(looksLikeDeck)).toBe(true);
    expect(selectRuntimeLivePreviewDoc({
      pagesTotal: 0,
      pagesLiveDoc: '',
      legacyLiveDoc: '',
      previewPageDocs,
      previewPageIndex: 1,
    })).toContain('第二页');
    expect(isPreviewableDeck(`<!doctype html><html><head></head><body><main><section style="display:none"><p>${padding}</p></section></main></body></html>`)).toBe(false);
    const staticHiddenReveal = `<!doctype html><html><head><style>.slides>section{display:none}</style></head><body><div class="reveal"><div class="slides"><section><p>${padding}</p></section></div></div></body></html>`;
    expect(isPreviewableDeck(staticHiddenReveal)).toBe(true);
    expect(buildDeckPreviewPageDocs(staticHiddenReveal).every(looksLikeDeck)).toBe(true);
    expect(isPreviewableDeck('<!doctype html><html><head></head><body><div class="reveal"><div class="slides"><section></section></div></div></body></html>')).toBe(false);

    const capturedPreviewPath = process.env.PPT_RUNTIME_REAL_PREVIEW_HTML;
    if (capturedPreviewPath) {
      const capturedPreview = readFileSync(capturedPreviewPath, 'utf8');
      expect(looksLikeDeck(capturedPreview)).toBe(false);
      expect(isPreviewableDeck(capturedPreview)).toBe(true);
      const capturedPages = buildDeckPreviewPageDocs(capturedPreview);
      expect(capturedPages).toHaveLength(34);
      expect(capturedPages.every(looksLikeDeck)).toBe(true);
      expect(selectRuntimeLivePreviewDoc({
        pagesTotal: 0,
        pagesLiveDoc: '',
        legacyLiveDoc: '',
        previewPageDocs: capturedPages,
        previewPageIndex: 33,
      })).not.toBe('');
    }
  });

  it('空预览与 legacy 实况优先级保持不变', () => {
    expect(isPreviewableDeck('')).toBe(false);
    expect(selectRuntimeLivePreviewDoc({
      pagesTotal: 0,
      pagesLiveDoc: '',
      legacyLiveDoc: '<html>legacy</html>',
      previewPageDocs: ['<html>runtime</html>'],
      previewPageIndex: 0,
    })).toBe('<html>legacy</html>');
    expect(selectRuntimeLivePreviewDoc({
      pagesTotal: 2,
      pagesLiveDoc: '<html>parallel</html>',
      legacyLiveDoc: '<html>legacy</html>',
      previewPageDocs: ['<html>runtime</html>'],
      previewPageIndex: 0,
    })).toBe('<html>parallel</html>');
  });

  it('无 legacy 帧时仍把 OpenDesign 运行中 HTML 渲染为只读未验收预览', () => {
    const previewHtml = '<!doctype html><html><head></head><body><div class="reveal"><div class="slides"><section><h1>运行中初稿</h1></section></div></div></body></html>';
    const html = renderToStaticMarkup(createElement(PptRuntimeLivePreview, {
      html: previewHtml,
      pageNumber: 1,
      allowScripts: false,
    }));

    expect(html).toContain('data-testid="runtime-live-preview"');
    expect(html).toContain('data-testid="runtime-live-preview-frame"');
    expect(html).toContain('设计中初稿');
    expect(html).toContain('尚未通过检查');
    expect(html).toContain('运行中初稿');
    expect(html).toContain('sandbox=""');
  });

  it('尚无 OpenDesign 或 legacy 页面时不伪造预览，继续由骨架承担等待反馈', () => {
    expect(renderToStaticMarkup(createElement(PptRuntimeLivePreview, {
      html: '',
      pageNumber: 0,
      allowScripts: false,
    }))).toBe('');
  });

  it('用捕获的阶段与预览事实渲染真实组件，页数、流程进度和模型调用次数互不冒充', () => {
    const captured = {
      phaseMessage: '正在修复质量问题',
      progress: 82,
      runtimeModelCallCount: 33,
      previewHtml: '<div class="reveal"><div class="slides">' + '<section>正文</section>'.repeat(20) + '</div></div>',
    };
    const previewPages = countDeckPages(captured.previewHtml);
    const html = renderToStaticMarkup(createElement(PptRuntimeProgressHeader, {
      stageText: captured.phaseMessage,
      elapsedSec: 465,
      draftDetail: `已形成 ${previewPages}/20 页真实初稿`,
      model: 'default-chat-curated',
      runtimeModelCallCount: captured.runtimeModelCallCount,
      processProgress: captured.progress,
      hasPreview: true,
    }));

    expect(html).toContain('正在修复质量问题');
    expect(html).toContain('已形成 20/20 页真实初稿');
    expect(html).toContain('模型调用 33 次');
    expect(html).toContain('aria-valuenow="82"');
    expect(html).toContain('width:82%');

    const fixtureOutput = process.env.PPT_RUNTIME_FIXTURE_OUTPUT;
    if (fixtureOutput) {
      const fixturePreviewPath = process.env.PPT_RUNTIME_FIXTURE_PREVIEW_HTML;
      const fixturePreviewHtml = fixturePreviewPath
        ? readFileSync(fixturePreviewPath, 'utf8')
        : captured.previewHtml;
      const fixturePreviewPages = countDeckPages(fixturePreviewHtml);
      const panel = renderToStaticMarkup(createElement('main', { 'data-provenance': 'captured-runtime-fields-and-preview-html' },
        createElement(PptRuntimeProgressHeader, {
          stageText: captured.phaseMessage,
          elapsedSec: 465,
          draftDetail: `已形成 ${previewPages}/20 页真实初稿`,
          model: 'default-chat-curated',
          runtimeModelCallCount: captured.runtimeModelCallCount,
          processProgress: captured.progress,
          hasPreview: true,
        }),
        createElement(PptRuntimeLivePreview, {
          html: fixturePreviewHtml,
          pageNumber: fixturePreviewPages,
          allowScripts: true,
        }),
        createElement(NextStepBar, {
          onPublish: () => undefined,
          publishBusy: false,
          publishDisabled: true,
          publishDisabledReason: '质量检查尚未通过，当前初稿只能预览，不能发布。',
          published: false,
          onDownload: () => undefined,
          onSeedPatch: () => undefined,
        }),
      ));
      writeFileSync(fixtureOutput, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PPT 捕获事件组件夹具</title><style>:root{color-scheme:dark;--text-secondary:#d6d8de;--text-tertiary:#9ba1ad;--accent-primary-solid:#b0523a}body{margin:0;padding:24px;background:#0d0f14;color:#f4f4f5;font-family:system-ui}main{max-width:960px;margin:auto;display:grid;gap:16px;padding:16px;border:1px solid #343946;border-radius:14px;background:#171a21}.flex{display:flex}.items-center{align-items:center}.gap-2{gap:.5rem}.gap-3{gap:.75rem}.min-w-0{min-width:0}.shrink-0{flex-shrink:0}.ml-auto{margin-left:auto}.w-full{width:100%}.h-full{height:100%}.rounded-full{border-radius:999px}.overflow-hidden{overflow:hidden}.bg-token-nested{background:#262b35}.text-sm{font-size:.875rem}.text-\\[11px\\],.text-\\[10px\\]{font-size:11px}.mt-0\\.5{margin-top:2px}.tabular-nums{font-variant-numeric:tabular-nums}.font-mono{font-family:monospace}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}iframe{display:block;width:100%;height:330px;border:1px solid #343946;border-radius:12px}button{font:inherit;color:inherit}</style></head><body>${panel}</body></html>`, 'utf8');
    }
  });

  it('乱序阶段事件不会让累计调用次数回退', () => {
    const observed = [1, 18, 33, 20];
    expect(observed.reduce(mergeRuntimeModelCallCount, 0)).toBe(33);
  });
});

describe('NextStepBar 移动端布局', () => {
  it('窄屏允许建议换行，并让下载与发布动作独占一行且右对齐', () => {
    const html = renderToStaticMarkup(createElement(NextStepBar, {
      onPublish: () => undefined,
      publishBusy: false,
      publishDisabled: true,
      publishDisabledReason: '质量检查尚未完成',
      published: false,
      onDownload: () => undefined,
      onSeedPatch: () => undefined,
    }));

    expect(html).toMatch(/data-testid="next-step-bar"[^>]*class="[^"]*max-sm:flex-wrap[^"]*"/);
    expect(html).toMatch(/class="[^"]*max-sm:basis-full[^"]*max-sm:justify-end[^"]*"/);
    expect(html).toContain('标题更有冲击力');
    expect(html).toContain('配色更商务');
    expect(html).toContain('加一页总结');
    expect(html).toContain('下载 HTML');
    expect(html).toContain('发布为网页');
    expect(html).toContain('disabled=""');
    expect(html).toContain('质量检查尚未完成');
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
    expect(resolveNaturalPatchSlideIndex('增加第 34 页标题字号')).toBe(34);
    expect(resolveNaturalPatchSlideIndex('增加第 41 页标题字号')).toBeNull();
  });

  it('将自然语言解析的页码传给服务端，不退化为整稿精修', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/pages/md-to-ppt-agent/MdToPptAgentPage.tsx'), 'utf8');
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
