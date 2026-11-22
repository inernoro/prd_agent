import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import MarkdownRenderer from '../MarkdownRenderer';
import { safePrdUrlTransform } from '../markdownSecurity';
vi.mock('../MermaidBlock', () => ({ default: () => null }));

const render = (content: string) => renderToStaticMarkup(<MarkdownRenderer content={content} />);

describe('untrusted desktop Markdown boundary', () => {
  it('removes embedded documents, scripts, forms, handlers and style injection', () => {
    const html = render(`<iframe srcdoc="<script>parent.__TAURI_INTERNALS__.invoke('upload_attachment')</script>"></iframe>
<script>localStorage.getItem('auth')</script><object data="file:///tmp/sentinel"></object>
<img src="https://example.com/a.png" onerror="alert(1)" style="position:fixed;inset:0" />
<form action="https://example.com"><input name="password" /></form>
<svg id="attacker-svg"><a xlink:href="javascript:alert(1)">bad</a></svg>`);
    expect(html).not.toMatch(/<iframe|srcdoc|<script|<object|onerror|position:fixed|<form|attacker-svg|javascript:/i);
  });
  it('retains tables, code, safe formatting, links, anchors and raster data images', () => {
    const html = render('| A | B |\n|---|---|\n| one | two |\n\n```ts\nconst x = 1;\n```\n\n<strong>bold</strong> [link](https://example.com) [jump](#a)\n\n![pixel](data:image/png;base64,YQ==)');
    expect(html).toContain('<table');
    expect(html).toContain('language-ts');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="#a"');
    expect(html).toContain('src="data:image/png;base64,YQ=="');
  });
  it.each(['javascript:alert(1)', 'java\nscript:alert(1)', 'file:///tmp/sentinel', 'asset://localhost/tmp/sentinel', 'data:text/html,<script>x</script>', 'data:image/svg+xml;base64,WA==', 'blob:http://tauri.localhost/id', '//evil.test', '/local', 'http:\\evil.test'])('rejects active/local URL %s', (url) => {
    expect(safePrdUrlTransform(url, 'href')).toBe('');
    expect(safePrdUrlTransform(url, 'src')).toBe('');
  });
  it('does not allow raster data images as navigation targets', () => {
    expect(safePrdUrlTransform('data:image/png;base64,YQ==', 'href')).toBe('');
  });
});
