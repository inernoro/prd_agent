import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DownloadDialog } from '../DocumentStorePage';

// 用户要求（2026-07-31）：下载要能选「当前文章 / 整个知识库」，且默认落在当前文章。
// 这条默认值一旦被改回整库，用户就又得为了一篇文章下载整个 ZIP，所以钉死在测试里。
describe('DownloadDialog', () => {
  const base = { storeName: 'MAP系统和设计', busy: false, onDownload: vi.fn(), onClose: vi.fn() };

  it('打开着文档时，默认范围是「当前文章」并说明只下这一篇', () => {
    const html = renderToStaticMarkup(<DownloadDialog {...base} entryTitle="以后怎么说" />);

    expect(html).toContain('当前文章');
    expect(html).toContain('只下载《以后怎么说》一篇');
    // 选中态靠 surface-action-accent 表达：它必须落在「当前文章」那颗按钮上
    const currentBtn = html.slice(html.indexOf('只下载《以后怎么说》') - 1200, html.indexOf('只下载《以后怎么说》'));
    expect(currentBtn).toContain('surface-action-accent');
  });

  it('没有打开文档时，「当前文章」禁用并回落到整库', () => {
    const html = renderToStaticMarkup(<DownloadDialog {...base} />);

    expect(html).toContain('disabled=""');
    expect(html).toContain('先打开一篇文档，才能单独下载它');
    expect(html).toContain('打包成一个 ZIP');
  });

  it('三种格式都列出来，默认选 Markdown', () => {
    const html = renderToStaticMarkup(<DownloadDialog {...base} entryTitle="以后怎么说" />);

    expect(html).toContain('Markdown (.md)');
    expect(html).toContain('纯文本 (.txt)');
    expect(html).toContain('原始文件');
    // 默认选中项在 Markdown 之前出现选中底色
    const mdIdx = html.indexOf('Markdown (.md)');
    expect(html.slice(0, mdIdx)).toContain('var(--selection-bg)');
  });

  it('导出中时禁用「开始下载」，不给重复点的机会', () => {
    const html = renderToStaticMarkup(<DownloadDialog {...base} entryTitle="以后怎么说" busy />);
    expect(html).toContain('导出中…');
  });
});
