import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { buildMarkdownReportDocument } from '../../web/src/lib/report-document.js';

describe('Markdown 报告同页锚点', () => {
  it('返回顶部的空片段只滚动当前文档，不触发 srcDoc 默认导航', () => {
    const html = buildMarkdownReportDocument('[返回顶部](#)\n\n## 正文', 'light');
    let listener: (event: unknown) => void = () => { throw new Error('未注册点击监听'); };
    let prevented = false;
    let top: unknown;
    class Anchor {
      closest() { return this; }
      getAttribute() { return '#'; }
    }
    runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
      Element: Anchor,
      document: { addEventListener: (_: string, callback: typeof listener) => { listener = callback; } },
      window: { scrollTo: (options: unknown) => { top = options; } },
    });
    listener({ target: new Anchor(), preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
    expect(top).toEqual({ top: 0, behavior: 'smooth' });
  });

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

  it('显式锚点与同名 Markdown 标题各自获得唯一 ID', () => {
    const document = buildMarkdownReportDocument(
      '[查看](#关联测试方法)\n\n<a id="关联测试方法"></a>\n## 关联测试方法',
      'light',
    );

    expect(document).toContain('<a id="关联测试方法"></a>');
    expect(document).toContain('<h2 id="关联测试方法-1">关联测试方法</h2>');
    expect(document.match(/id="关联测试方法"/g)).toHaveLength(1);
  });

  it('按当前主题生成可读链接颜色', () => {
    expect(buildMarkdownReportDocument('', 'light')).toContain('#2563eb');
    expect(buildMarkdownReportDocument('', 'dark')).toContain('#60a5fa');
  });
});
