// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptPdfDownloadRequest, pdfDownloadUrlMap, withPdfDownloadBridge } from './pdfDownloadBridge';
import { SRCDOC_PREVIEW_SANDBOX, DIRECT_PREVIEW_SANDBOX } from './previewHtml';

const context = { siteId: 'site-a', siteUrl: 'https://assets.example/site/.versions/v1/index.html?v=1',
  entryFile: 'index.html', nonce: 'current-frame', pdfFilePaths: ['downloads/教材.pdf'] };
const request = { type: 'map-hosted-pdf-download', siteId: context.siteId, nonce: context.nonce,
  filePath: context.pdfFilePaths[0], requestId: 'request-1' };

// 浏览器维护 isTrusted；这里执行真实注入脚本，用受控事件数据按 window→document
// 捕获阶段派发。子页面先注册 document 监听，防止测试靠注册先后掩盖原回归。
function executeBridgeClick(href: string, patch: Record<string, unknown> = {}) {
  type Click = Record<string, unknown> & { stopped: boolean; defaultPrevented: boolean };
  type Listener = (event: Click) => void;
  const listeners: { target: 'window' | 'document'; capture: boolean; listener: Listener }[] = [];
  const childDocument = vi.fn();
  listeners.push({ target: 'document', capture: true, listener: childDocument });
  const postMessage = vi.fn();
  const fakeWindow = { parent: { postMessage }, addEventListener: vi.fn(
    (_type: string, listener: Listener, capture: boolean) =>
      listeners.push({ target: 'window', capture, listener })) };
  const fakeDocument = new Proxy(document, { get(target, key) {
    if (key === 'addEventListener') return (_type: string, listener: Listener, capture: boolean) =>
      listeners.push({ target: 'document', capture, listener });
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const html = withPdfDownloadBridge('<main/>', context);
  const script = html.slice(html.indexOf('>(function(){') + 1, html.lastIndexOf('</script>'));
  new Function('window', 'document', 'Element', 'URL', 'crypto', script)(
    fakeWindow, fakeDocument, Element, URL, { randomUUID: () => 'trusted-click-1' });
  const link = document.createElement('a');
  link.href = href;
  document.body.append(link);
  const event: Click = { isTrusted: true, target: link, button: 0, defaultPrevented: false,
    ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, stopped: false, ...patch };
  const preventDefault = vi.fn(() => { event.defaultPrevented = true; });
  const stopImmediatePropagation = vi.fn(() => { event.stopped = true; });
  Object.assign(event, { preventDefault, stopImmediatePropagation });
  for (const target of ['window', 'document'] as const) {
    for (const item of listeners.filter(x => x.target === target && x.capture)) {
      if (event.stopped) break;
      item.listener(event);
    }
  }
  return { postMessage, childDocument, preventDefault, stopImmediatePropagation, fakeWindow };
}
afterEach(() => { document.body.innerHTML = ''; });

describe('受控 PDF 下载桥', () => {
  it('实际注入脚本由window优先接管登记PDF，只发一次请求且不启动子页面监听', () => {
    const click = executeBridgeClick('https://assets.example/site/.versions/v1/downloads/%E6%95%99%E6%9D%90.pdf?download=1#page=2');
    expect(click.fakeWindow.addEventListener).toHaveBeenCalledWith('click', expect.any(Function), true);
    expect(click.preventDefault).toHaveBeenCalledOnce();
    expect(click.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(click.postMessage).toHaveBeenCalledOnce();
    expect(click.postMessage).toHaveBeenCalledWith({ ...request, requestId: 'trusted-click-1' }, '*');
    expect(click.childDocument).not.toHaveBeenCalled();
  });
  it.each([
    'https://assets.example/site/.versions/v1/downloads/unknown.pdf',
    'https://attacker.example/downloads/%E6%95%99%E6%9D%90.pdf',
  ])('未登记PDF也在window阻止，不触发子页面或父层下载：%s', href => {
    const click = executeBridgeClick(href);
    expect(click.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(click.preventDefault).toHaveBeenCalledOnce();
    expect(click.postMessage).not.toHaveBeenCalled();
    expect(click.childDocument).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('未登记');
  });
  it.each([
    { isTrusted: false }, { defaultPrevented: true }, { button: 1 },
    { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true },
  ])('可信点击门禁仍有效：%j', patch => {
    const click = executeBridgeClick('https://assets.example/site/.versions/v1/downloads/%E6%95%99%E6%9D%90.pdf', patch);
    expect(click.postMessage).not.toHaveBeenCalled();
    expect(click.stopImmediatePropagation).not.toHaveBeenCalled();
  });
  it('普通HTML链接继续到达子页面监听', () => {
    const click = executeBridgeClick('https://assets.example/site/.versions/v1/next.html');
    expect(click.childDocument).toHaveBeenCalledOnce();
    expect(click.postMessage).not.toHaveBeenCalled();
    expect(click.preventDefault).not.toHaveBeenCalled();
  });

  it('只接受当前iframe、当前上下文和登记PDF的明确消息', () => {
    const frame = {} as Window;
    expect(acceptPdfDownloadRequest(request, frame, frame, context)).toBe(true);
    expect(acceptPdfDownloadRequest(request, {} as Window, frame, context)).toBe(false);
    for (const patch of [{ type: 'open-url' }, { siteId: 'other-site' }, { nonce: 'old-frame' },
      { filePath: 'https://attacker.example/a.pdf' }, { filePath: 'other.pdf' }, { filePath: 'index.html' }, { requestId: '' }]) {
      expect(acceptPdfDownloadRequest({ ...request, ...patch }, frame, frame, context)).toBe(false);
    }
  });
  it('按真实版本目录解析登记文件，支持嵌套HTML入口', () => {
    expect(pdfDownloadUrlMap(context)).toEqual({
      'https://assets.example/site/.versions/v1/downloads/%E6%95%99%E6%9D%90.pdf': 'downloads/教材.pdf',
    });
    expect(pdfDownloadUrlMap({ ...context, siteUrl: 'https://assets.example/site/chapter/index.html', entryFile: 'chapter/index.html' }))
      .toHaveProperty('https://assets.example/site/downloads/%E6%95%99%E6%9D%90.pdf');
  });
  it('注入仅捕获真实点击且防重复处理，保持所有sandbox标志不变', () => {
    const html = withPdfDownloadBridge('<main>lesson</main>', context);
    expect(html).toContain('event.isTrusted');
    expect(html).toContain('event.defaultPrevented');
    expect(html).toContain('event.preventDefault()');
    expect(html).toContain('map-hosted-pdf-download');
    expect(html).not.toContain('window.open');
    expect(SRCDOC_PREVIEW_SANDBOX).toBe('allow-scripts allow-popups allow-forms');
    expect(DIRECT_PREVIEW_SANDBOX).toBe('allow-scripts allow-same-origin allow-popups allow-forms');
  });
  it('生成的拦截脚本可执行，空白名单也明确阻止未知PDF导航', () => {
    const html = withPdfDownloadBridge('<main/>', { ...context, pdfFilePaths: [] });
    const script = html.slice(html.indexOf('>(function(){') + 1, html.lastIndexOf('</script>'));
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain('if(!/\\.pdf$/i.test(url.pathname))');
    expect(script).toContain('这份 PDF 未登记');
  });
  it('序列化脚本配置不能被文件名提前闭合', () => {
    expect(withPdfDownloadBridge('<main/>', { ...context, pdfFilePaths: ['</script>.pdf'] }))
      .not.toContain('"</script>.pdf"');
  });
});
