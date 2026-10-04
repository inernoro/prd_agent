import { describe, expect, it } from 'vitest';
import { buildMarkdownReportDocument } from '../../web/src/lib/report-document.js';

describe('Markdown 报告同页锚点', () => {
  it('在 srcDoc 内接管有效锚点并保留外部链接默认行为', () => {
    const document = buildMarkdownReportDocument(
      '<a href="#target">查看</a><h2 id="target">目标</h2><a href="https://example.com">外部</a>',
      'dark',
    );

    expect(document).toContain("source.closest('a[href^=\"#\"]')");
    expect(document).toContain("document.getElementById(targetId)");
    expect(document).toContain("event.preventDefault()");
    expect(document).toContain("target.scrollIntoView({ behavior: 'smooth', block: 'start' })");
    expect(document).not.toContain("location.hash =");
    expect(document).toContain('<a href="https://example.com">外部</a>');
  });

  it('按当前主题生成可读链接颜色', () => {
    expect(buildMarkdownReportDocument('', 'light')).toContain('#2563eb');
    expect(buildMarkdownReportDocument('', 'dark')).toContain('#60a5fa');
  });
});
