import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../MdToPptAgentPage.tsx', import.meta.url), 'utf8');
// 执行实际注入脚本，而不是复刻一个“等价”的测试实现。
const factory = source.slice(source.indexOf('function prepareIframeHtml('), source.indexOf('// 新版本在服务端生成阶段固化字体'));
const prepare = new Function('FONT_LINKS', ts.transpile(factory) + ';return prepareIframeHtml;')('') as (html: string, opts: { documentId: string; editor?: boolean }) => string;
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

  it('父层按当前文档身份解锁，替换后旧 ready 无效；按钮和处理器共用门禁，隔离保持', () => {
    expect(source).toContain('const previewReady = readyPreviewId === previewDocument.id');
    expect(source).toContain('if (d.documentId !== previewDocument.id) return;');
    expect(source).toContain('key={previewDocument.id}');
    expect(source).toContain('srcDoc={previewDocument.html}');
    expect(source).toContain('}, [generatedHtml, editMode])');
    expect(source.match(/disabled=\{!previewReady\}/g)).toHaveLength(2);
    expect(source).toContain('if (!previewReady) return;');
    expect(source).toContain('if (e.source !== iframeRef.current?.contentWindow) return;');
    const primaryFrame = source.slice(source.indexOf('key={previewDocument.id}'), source.indexOf('title="PPT 预览"'));
    expect(primaryFrame).toContain('sandbox="allow-scripts"');
    expect(primaryFrame).not.toContain('allow-same-origin');
  });
});
