import { describe, expect, it } from 'vitest';
import { acceptPdfDownloadRequest, pdfDownloadUrlMap, withPdfDownloadBridge } from './pdfDownloadBridge';
import { SRCDOC_PREVIEW_SANDBOX, DIRECT_PREVIEW_SANDBOX } from './previewHtml';

const context = { siteId: 'site-a', siteUrl: 'https://assets.example/site/.versions/v1/index.html?v=1',
  entryFile: 'index.html', nonce: 'current-frame', pdfFilePaths: ['downloads/教材.pdf'] };
const request = { type: 'map-hosted-pdf-download', siteId: context.siteId, nonce: context.nonce,
  filePath: context.pdfFilePaths[0], requestId: 'request-1' };

describe('受控 PDF 下载桥', () => {
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
