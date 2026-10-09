import { describe, expect, it } from 'vitest';
import { buildMarkdownReportDocument } from '../../web/src/lib/report-document.js';

describe('Markdown 报告同页锚点', () => {
  it('在 srcDoc 内接管有效锚点并保留外部链接默认行为', () => {
    const document = buildMarkdownReportDocument(
      '[查看](#目标)\n\n## 目标\n\n[外部](https://example.com)',
      'dark',
    );

    expect(document).toContain("source.closest('a[href^=\"#\"]')");
    expect(document).toContain("document.getElementById(targetId)");
    expect(document).toContain("event.preventDefault()");
    expect(document).toContain("target.scrollIntoView({ behavior: 'smooth', block: 'start' })");
    expect(document).not.toContain("location.hash =");
    expect(document).toContain('<h2 id="目标">目标</h2>');
    expect(document).toContain('<a href="https://example.com">外部</a>');
  });

  it('用真实 Markdown 渲染链路为英文标题与重复标题生成稳定 ID', () => {
    const document = buildMarkdownReportDocument(
      '[首个](#hello-world)\n\n## Hello World\n\n## Hello World',
      'light',
    );

    expect(document).toContain('<h2 id="hello-world">Hello World</h2>');
    expect(document).toContain('<h2 id="hello-world-1">Hello World</h2>');
  });

  it('先保留显式标题 ID，再为 Markdown 标题分配未占用的后缀', () => {
    const document = buildMarkdownReportDocument(
      '## Foo\n\n<h2 id="foo">显式标题</h2>\n\n<h2 id=foo-1>显式后缀</h2>\n\n## Foo',
      'light',
    );

    expect(document).toContain('<h2 id="foo-2">Foo</h2>');
    expect(document).toContain('<h2 id="foo">显式标题</h2>');
    expect(document).toContain('<h2 id=foo-1>显式后缀</h2>');
    expect(document).toContain('<h2 id="foo-3">Foo</h2>');
  });

  it('按当前主题生成可读链接颜色', () => {
    expect(buildMarkdownReportDocument('', 'light')).toContain('#2563eb');
    expect(buildMarkdownReportDocument('', 'dark')).toContain('#60a5fa');
  });
});
