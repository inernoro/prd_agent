import { describe, expect, it } from 'vitest';
import { directPreviewSandbox, resolvePreviewSource, shouldFetchPreviewHtml } from './previewHtml';

const site = {
  siteUrl: 'https://storage.example/sites/demo/index.html?v=2',
  entryFile: 'index.html',
};

describe('托管预览按文件结构选择运行环境', () => {
  it('多文件应用首次渲染就用真实地址，不等待正文或被迟到正文替换', () => {
    const fetchable = shouldFetchPreviewHtml({ ...site, contentShape: 'multi-file' });
    expect(fetchable).toBe(false);
    for (const inlineHtml of [null, '<main>迟到的旧正文</main>']) {
      expect(resolvePreviewSource({ fetchable, inlineHtml, settled: false, waitedOut: false })).toBe('direct');
    }
    expect(() => new URL('product.html', 'about:srcdoc')).toThrow();
    expect(new URL('product.html', site.siteUrl).href).toBe('https://storage.example/sites/demo/product.html');
  });

  it.each(['self-contained-html', undefined] as const)('自包含站与旧服务端保持兼容流程：%s', (contentShape) => {
    const fetchable = shouldFetchPreviewHtml({ ...site, contentShape });
    expect(fetchable).toBe(true);
    expect(resolvePreviewSource({ fetchable, inlineHtml: null, settled: false, waitedOut: false })).toBe('pending');
    expect(resolvePreviewSource({ fetchable, inlineHtml: '<main>原预览</main>', settled: true, waitedOut: false })).toBe('srcdoc');
    expect(resolvePreviewSource({ fetchable, inlineHtml: null, settled: true, waitedOut: false })).toBe('direct');
  });

  it('Markdown 的 HTML 和源文件虽然组成多文件，仍保留内联正文流程', () => {
    expect(shouldFetchPreviewHtml({ ...site, contentShape: 'multi-file', wrappedAssetType: 'markdown' })).toBe(true);
  });

  it('带登记 PDF 附件的课程保留内联下载桥，不因多文件分类破坏下载', () => {
    expect(shouldFetchPreviewHtml({ ...site, contentShape: 'multi-file', pdfFilePaths: ['课程.pdf'] })).toBe(true);
    expect(shouldFetchPreviewHtml({ ...site, contentShape: 'multi-file', pdfFilePaths: [] })).toBe(false);
    expect(shouldFetchPreviewHtml({ ...site, contentShape: 'multi-file', requiresPreviewBridge: true })).toBe(true);
  });

  it.each(['pdf', 'video', 'unknown'])('包装资产不改变原有专用流程：%s', (wrappedAssetType) => {
    expect(shouldFetchPreviewHtml({ ...site, contentShape: 'multi-file', wrappedAssetType })).toBe(false);
  });

  it('PDF 原生阅读器与非 HTML 入口仍跳过正文', () => {
    expect(shouldFetchPreviewHtml({ ...site, pdfAssetUrl: 'https://storage.example/a.pdf' })).toBe(false);
    expect(shouldFetchPreviewHtml({ ...site, entryFile: 'video.mp4' })).toBe(false);
  });
});

describe('原地址预览的来源隔离', () => {
  it('独立托管源可以保留自身来源，同站不同端口也属于跨源', () => {
    expect(directPreviewSandbox(site.siteUrl, 'https://admin.example')).toContain('allow-same-origin');
    expect(directPreviewSandbox('http://localhost:8001/index.html', 'http://localhost:8000')).toContain('allow-same-origin');
  });

  it.each(['https://admin.example/upload/index.html', '/upload/index.html', 'blob:https://admin.example/id', 'data:text/html,hello', 'javascript:alert(1)', 'https://['])('不能给同源或不可信地址后台权限：%s', url => {
    expect(directPreviewSandbox(url, 'https://admin.example')).not.toContain('allow-same-origin');
  });
});
