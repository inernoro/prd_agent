// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RichTextMarkdownContent } from '../RichTextMarkdownContent';
import { SharedReportSection } from '../SharedReportSection';
import { ReportInputType } from '@/services/contracts/reportAgent';

vi.mock('@/components/ui/MermaidDiagram', () => ({ MermaidDiagram: ({ code }: { code: string }) => <div data-diagram-source={code}>图表</div> }));
vi.mock('@/components/ui/ImagePreviewDialog', () => ({ ImagePreviewDialog: () => null }));

const fixedReport = `# 很长的日报周报月度总结与验收标题：全部关键内容保留且可以阅读

| 项目 | 负责人 | 诊断结果 | 后续行动 |
| --- | --- | --- | --- |
| CDS | 作者甲 | 完整结果 | 重试 |
| LLMGW | 作者乙 | 最后一格不能丢失 | 返回 |

\`\`\`typescript
const longLink = 'https://example.com/reports/long/path?source=llmgw';
console.log(longLink);
\`\`\`

\`\`\`mermaid
flowchart LR
  A[生成] --> B[阅读]
\`\`\`

\`\`\`mermaid
timeline
  title 诊断时间线
  2026-11-12 : 开始诊断 : 完整结束
\`\`\`

[完整链接](https://example.com/reports/long/path?source=llmgw)

![真实图片](https://example.com/evidence.png)

文末完整性标记 REPORT-END`;

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe('报告助理共享阅读内容', () => {
  it.each(['dark', 'light'])('同一样本在 %s 主题保留所有列、代码、图表源码、链接和文末', theme => {
    document.documentElement.dataset.theme = theme;
    const html = renderToStaticMarkup(<RichTextMarkdownContent content={fixedReport} />);
    const node = document.createElement('div'); node.innerHTML = html;
    expect(node.querySelectorAll('th')).toHaveLength(4);
    expect(node.querySelectorAll('td')).toHaveLength(8);
    expect(node.textContent).toContain('最后一格不能丢失');
    expect(node.querySelector('code')?.textContent).toContain('console.log(longLink)');
    expect(node.querySelectorAll('[data-diagram-source]')).toHaveLength(2);
    expect(node.querySelector('a')?.href).toBe('https://example.com/reports/long/path?source=llmgw');
    expect(node.querySelector('img')?.alt).toBe('真实图片');
    expect(node.textContent).toContain('REPORT-END');
    expect(node.querySelector('[role="region"]')?.getAttribute('tabindex')).toBe('0');
  });

  it('团队分享按原表格结构渲染并保留超出历史列定义的单元格', () => {
    const html = renderToStaticMarkup(<SharedReportSection section={{
      templateSection: { title: '宽表', isRequired: false, sortOrder: 0, inputType: ReportInputType.Table, tableColumns: ['内容', '进度'] },
      items: [{ content: '旧镜像', source: 'manual', cells: ['原内容', '完成', '历史附加内容不能截断'] }],
    }} />);
    const node = document.createElement('div'); node.innerHTML = html;
    expect(node.querySelectorAll('th')).toHaveLength(3);
    expect(node.querySelectorAll('td')).toHaveLength(3);
    expect(node.textContent).toContain('历史附加内容不能截断');
  });

  it('团队分享保留 Markdown 与附加图片', () => {
    const html = renderToStaticMarkup(<SharedReportSection section={{ items: [{ content: '**关键结论**', source: 'manual', imageUrls: ['https://example.com/attachment.png'] }] }} />);
    const node = document.createElement('div'); node.innerHTML = html;
    expect(node.querySelector('strong')?.textContent).toBe('关键结论');
    expect(node.querySelector('img')?.src).toBe('https://example.com/attachment.png');
  });

  it('附加图片地址沿用 Markdown 的安全协议限制', () => {
    const html = renderToStaticMarkup(<RichTextMarkdownContent content="安全正文" imageUrls={['javascript:alert(1)']} />);
    expect(html).toContain('图片地址无效');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('src="javascript:');
  });

  it('图片失败显示可理解的重试与原图入口，重试保留正文', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<RichTextMarkdownContent content={'![证据](https://example.com/missing.png)\n\n完整正文'} />));
    await act(async () => container.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(container.textContent).toContain('图片加载失败：证据');
    expect(container.querySelector('a')?.href).toBe('https://example.com/missing.png');
    await act(async () => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '重新加载图片')!.click());
    expect(container.querySelector('img')).not.toBeNull();
    expect(container.textContent).toContain('完整正文');
    await act(async () => root.unmount());
  });
});
