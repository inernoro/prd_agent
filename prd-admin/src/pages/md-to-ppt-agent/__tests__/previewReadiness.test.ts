import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../MdToPptAgentPage.tsx', import.meta.url), 'utf8');
// 执行实际注入脚本，而不是复刻一个“等价”的测试实现。
const factory = source.slice(source.indexOf('function prepareIframeHtml('), source.indexOf('// 新版本在服务端生成阶段固化字体'));
const prepare = new Function('FONT_LINKS', ts.transpile(factory) + ';return prepareIframeHtml;')('') as (html: string, opts: { documentId: string; editor?: boolean; assetBaseUrl?: string }) => string;
const publishFactory = source.slice(source.indexOf('const PERSISTED_FONT_LINK'), source.indexOf('// 从生成 HTML 提取'));
const preparePublish = new Function(ts.transpile(publishFactory.replace('export function', 'function')) + ';return preparePublishHtml;')() as (html: string, runtime?: string) => string;
const html = prepare('<html><head></head><body></body></html>', { documentId: 'current-document' });
const control = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('function slides()'))!;

function runtime(reveal?: { isReady: () => boolean; getIndices: () => { h: number }; on: () => void }) {
  const messages: Array<{ type: string; documentId: string }> = [];
  const intervals = new Map<number, () => void>();
  const tasks: Array<() => void> = [];
  const events = new Map<string, (event?: unknown) => void>();
  let next = 0;
  let navigations = 0;
  const node = { getAttribute: () => 'slide active', getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100 }), classList: { contains: () => true } };
  const document = { readyState: 'loading', querySelectorAll: () => [node], dispatchEvent: () => { navigations++; } };
  vm.runInNewContext(control, {
    document, parent: { postMessage: (message: { type: string; documentId: string }) => messages.push(message) },
    window: { Reveal: reveal, innerWidth: 100, innerHeight: 100, getComputedStyle: () => ({ opacity: '1' }), addEventListener: (type: string, listener: () => void) => events.set(type, listener) },
    Reveal: reveal, MutationObserver: class { observe() {} }, KeyboardEvent: class {},
    setInterval: (callback: () => void) => { intervals.set(++next, callback); return next; },
    clearInterval: (id: number) => intervals.delete(id), setTimeout: (callback: () => void) => tasks.push(callback),
  });
  return { messages, document, events, tasks, tick: () => [...intervals.values()].forEach(callback => callback()), navigations: () => navigations };
}

describe('PPT 文档导航就绪合同', () => {
  it('OpenDesign 完成稿按权威原字节发布，旧历史仍保留字体规范化', () => {
    const prefix = '<!DOCTYPE html><html><head><title>完成稿</title></head><body>';
    const suffix = '</body></html>';
    const bodyBytes = 41013 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    const sourceHtml = prefix + '正文'.repeat(Math.floor(bodyBytes / 6)) + 'x'.repeat(bodyBytes % 6) + suffix;
    expect(Buffer.byteLength(sourceHtml)).toBe(41013);
    expect(sourceHtml).not.toContain('data-mdppt-fonts');
    expect(preparePublish(sourceHtml, 'open-design')).toBe(sourceHtml);

    const legacy = preparePublish(sourceHtml, 'legacy');
    expect(legacy).not.toBe(sourceHtml);
    expect(legacy).toContain('data-mdppt-fonts');
    expect(preparePublish(legacy, 'legacy')).toBe(legacy);
  });

  it('有 slide 但正文尚未解析完时不报告 ready；等 DOMContentLoaded 全部监听执行后才允许首个导航', () => {
    const frame = runtime();
    frame.tick();
    expect(frame.messages).toEqual([]);
    frame.document.readyState = 'interactive';
    frame.events.get('DOMContentLoaded')!();
    expect(frame.messages).toEqual([]);
    frame.tasks.splice(0).forEach(task => task());
    frame.tick();
    expect(frame.messages).toContainEqual({ type: 'map-ppt-ready', documentId: 'current-document' });
    frame.events.get('message')!({ data: { type: 'map-ppt-nav', dir: 'next' } });
    expect(frame.navigations()).toBe(1);
  });

  it('Reveal API 已存在不等于已初始化；isReady 前不报告 ready', () => {
    let ready = false;
    const frame = runtime({ getIndices: () => ({ h: 0 }), isReady: () => ready, on: () => {} });
    frame.document.readyState = 'interactive';
    frame.events.get('DOMContentLoaded')!();
    frame.tasks.splice(0).forEach(task => task());
    frame.tick();
    expect(frame.messages).toEqual([]);
    ready = true; frame.tick();
    expect(frame.messages).toContainEqual({ type: 'map-ppt-ready', documentId: 'current-document' });
  });

  it('圈选回复和编辑回传保留当前文档身份，父层过滤不会丢失合法响应', () => {
    const frame = runtime();
    frame.events.get('message')!({ data: { type: 'map-ppt-rect-query', id: 'selection-1' } });
    expect(frame.messages).toContainEqual({ type: 'map-ppt-rect-info', documentId: 'current-document', id: 'selection-1', slide: 1, texts: [] });
    const editable = prepare('<html><head></head><body></body></html>', { documentId: 'edited-document', editor: true });
    expect(editable).toContain('type:"map-ppt-html",documentId:"edited-document"');
    // 同文档同模式的内容恒等：父组件普通重渲染不会制造 srcDoc 重载。
    expect(prepare('<html><head></head><body></body></html>', { documentId: 'edited-document', editor: true })).toBe(editable);
  });

  it('隔离编辑允许既有正文目标，不要求 Reveal 或特定演示稿容器', () => {
    const editable = prepare(
      '<html><head></head><body>' +
        '<main class="deck"><section class="slide"><h1 id="deck-title" data-od-id="opening-title">标题</h1></section></main>' +
        '<div class="reveal"><div class="slides"><section><h2 id="reveal-title">Reveal 标题</h2></section></div></div>' +
        '<deck-stage><h3 id="custom-title">自定义标题</h3></deck-stage>' +
      '</body></html>',
      { documentId: 'editable-layouts', editor: true },
    );
    const editor = [...editable.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
      .map(match => match[1])
      .find(script => script.includes('var SEL=') && script.includes('var cur=null'));
    expect(editor).toBeTruthy();

    const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
      JSDOM: new (html: string, options: { runScripts: 'outside-only' }) => {
        window: Window & typeof globalThis;
      };
    };
    const dom = new JSDOM(
      editable.replace(/<script[^>]*>[\s\S]*?<\/script>/g, ''),
      { runScripts: 'outside-only' },
    );
    dom.window.eval(editor!);

    const click = (selector: string) => {
      dom.window.document.querySelector<HTMLElement>(selector)!.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    };
    click('#deck-title');
    expect(dom.window.document.querySelector('#deck-title')?.getAttribute('contenteditable')).toBe('true');
    click('#reveal-title');
    expect(dom.window.document.querySelector('#reveal-title')?.getAttribute('contenteditable')).toBe('true');
    click('#custom-title');
    expect(dom.window.document.querySelector('#custom-title')?.getAttribute('contenteditable')).toBe('true');

    click('#__map_editor_toolbar__');
    expect(dom.window.document.querySelector('#custom-title')?.getAttribute('contenteditable')).toBe('true');
    dom.window.document.querySelector('.reveal')?.remove();
    dom.window.document.querySelector('deck-stage')?.remove();
    click('#deck-title');
    const deckTitle = dom.window.document.querySelector<HTMLElement>('#deck-title')!;
    deckTitle.dispatchEvent(new dom.window.InputEvent('beforeinput', { bubbles: true }));
    deckTitle.textContent = '已修改标题';
    const toolbarBeforeUndo = dom.window.document.querySelector('#__map_editor_toolbar__');
    click('#__map_editor_toolbar__ [data-act="undo"]');
    expect(dom.window.document.querySelector('#deck-title')?.textContent).toBe('标题');
    const toolbarAfterUndo = dom.window.document.querySelector('#__map_editor_toolbar__');
    expect(toolbarAfterUndo).toBe(toolbarBeforeUndo);
    click('#deck-title');
    click('#__map_editor_toolbar__ [data-act="plus"]');
    expect(dom.window.document.querySelector<HTMLElement>('#deck-title')?.style.fontSize).not.toBe('');

    dom.window.document.body.classList.add('lead');
    click('body');
    expect(dom.window.document.body.hasAttribute('contenteditable')).toBe(false);
    dom.window.document.documentElement.classList.add('lead');
    click('html');
    expect(dom.window.document.documentElement.hasAttribute('contenteditable')).toBe(false);
    expect(dom.window.document.querySelector('#deck-title')?.hasAttribute('contenteditable')).toBe(false);
    dom.window.close();
  });

  it('多文件成品进入隔离编辑时保留父站点资源基址，序列化时不会把基址写回草稿', () => {
    const editable = prepare(
      '<html><head><link rel="stylesheet" href="assets/deck.css"></head><body></body></html>',
      { documentId: 'multi-file-draft', editor: true, assetBaseUrl: 'https://preview.example/decks/revision-1/' },
    );
    expect(editable).toContain('<base href="https://preview.example/decks/revision-1/" data-map-inject>');
    expect(editable).toContain('href="assets/deck.css"');
    expect(editable).toContain('querySelectorAll("[data-map-inject],#__map_editor_toolbar__")');
  });

  it('父层按当前文档身份解锁，替换后旧 ready 无效；按钮和处理器共用门禁，隔离保持', () => {
    expect(source).toContain('const previewReady = readyPreviewId === previewDocument.id');
    expect(source).toContain('if (d.documentId !== previewDocument.id) return;');
    expect(source).toContain('key={previewDocument.id}');
    expect(source).toContain('? { src: previewDocument.url }');
    expect(source).toContain(': { srcDoc: previewDocument.html }');
    expect(source).toContain("type: 'map-ppt-init'");
    expect(source).toContain('documentId: previewDocument.id');
    expect(source).toContain('const useEditableDraft = editMode');
    expect(source).toContain('assetBaseUrl: artifactSiteUrl');
    expect(source).toContain("url: useEditableDraft ? '' : artifactSiteUrl");
    expect(source).toContain('}, [generatedHtml, artifactSiteUrl, editMode])');
    expect(source.match(/disabled=\{!previewReady\}/g)).toHaveLength(2);
    expect(source).toContain('if (!previewReady) return;');
    expect(source).toContain('if (e.source !== iframeRef.current?.contentWindow) return;');
    const primaryFrame = source.slice(source.indexOf('key={previewDocument.id}'), source.indexOf('title="PPT 预览"'));
    expect(primaryFrame).toContain('sandbox="allow-scripts"');
    expect(primaryFrame).not.toContain('allow-same-origin');
  });

  it('手动草稿只通过 patch 冻结并质量检查，失败时不清除草稿或改写原版本', () => {
    expect(source).toContain('manualEditHtml,');
    expect(source).toContain('if (manualEditHtml) return;');
    expect(source).toContain("toast.error('保存编辑失败', '当前草稿和原版本都已保留，可检查后再次保存。')");
    expect(source).not.toContain('persistMdToPptLocalEdit(');
    expect(source).toContain("{editMode ? (dirtyEdits ? '保存并检查' : '退出编辑') : '编辑内容'}");
  });

  it('生成态展示 OpenDesign 真实预览并以服务端进度和模型调用次数为准', () => {
    expect(source).toContain('const previewPageCount = countDeckPages(generatedHtml)');
    expect(source).toContain('const deckThumbDocs = useMemo(() => buildDeckPreviewPageDocs(generatedHtml), [generatedHtml])');
    expect(source).toContain('const runtimeLivePreviewDoc = selectRuntimeLivePreviewDoc({');
    expect(source).toContain('const effLiveDoc = runtimeLivePreviewDoc');
    expect(source).toContain('<PptRuntimeLivePreview');
    expect(source).toContain('html={runtimeLivePreviewDoc}');
    expect(source).toContain('尚未通过检查 · 只读');
    expect(source).toContain('设计中初稿 · 尚未通过检查 · 只读 · 第 {effLiveIdx + 1} 页');
    expect(source).toContain("? '任务未完成 · 只读初稿'");
    expect(source).toContain("? '初稿未通过检查，不能编辑、保存或发布'");
    expect(source).toContain('OpenDesign 正在设计并检查演示稿；初稿仅供只读查看，检查完成后才能编辑、保存或发布。');
    expect(source).not.toContain('8 页会按 4 路并行生成');
    expect(source).toContain('setArtifactProgress(phase.progress)');
    expect(source).toContain('setRuntimeModelCallCount((current) => mergeRuntimeModelCallCount(current, phase.runtimeModelCallCount))');
    expect(source).toContain('模型调用 {runtimeModelCallCount} 次');
  });

  it('OpenDesign 预览判定覆盖事件、终态、恢复、历史、编辑与发布消费端', () => {
    expect(source.match(/!mountedRef\.current \|\| !isPreviewableDeck\(preview\.html\)/g)).toHaveLength(2);
    expect(source.match(/if \(!isPreviewableDeck\(html\)\)/g)).toHaveLength(2);
    expect(source).toContain('run.latestPreviewHtml && isPreviewableDeck(run.latestPreviewHtml)');
    expect(source).toContain("d.type === 'map-ppt-html' && typeof d.html === 'string' && isPreviewableDeck(d.html)");
    expect(source).toContain('editedHtmlRef.current && isPreviewableDeck(editedHtmlRef.current)');
    expect(source).toContain('!isPreviewableDeck(editedHtml) || !activeRunId');
    expect(source).toContain("const completedHtml = run?.status === 'done'");
    expect(source).toContain('&& run.html && isPreviewableDeck(run.html)');
    expect(source).toContain("const failedPreviewHtml = run?.status === 'error'");
    expect(source).toContain('&& run.latestPreviewHtml');
    expect(source).toContain('setRepairableRunId(!isCompleted && isRestartablePresentationQualityRun(run) ? run.id : \'\')');
    expect(source).toContain('if (!isPreviewableDeck(base))');
    expect(source.match(/looksLikeDeck\(/g)).toHaveLength(2);
  });

  it('质量拒绝后保留预览但不能从前端发起发布', () => {
    expect(source).toContain("const canPublish = artifactPhase === 'done' && Boolean(activeRunId)");
    expect(source).toContain('publishDisabled={!canPublish}');
    expect(source).toContain('disabled={isPublishing || !canPublish}');
  });
});
