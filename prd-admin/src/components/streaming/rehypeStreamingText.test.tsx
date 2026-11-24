// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { rehypeStreamingText, StreamingMarkdownSpan } from './rehypeStreamingText';

const components = { span: StreamingMarkdownSpan };
let container: HTMLDivElement;
let root: Root;
const render = (text: string, streaming = true) => act(() => root.render(
  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize, [rehypeStreamingText, { streaming }]]}
    components={components}>{text}</ReactMarkdown>,
));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });

describe('Markdown 复用共享 StreamingText 动效', () => {
  it.each(['', '**要点**', '- 第一条\n- 第二条', '| 维度 | 说明 |\n| --- | --- |\n| 风险 | 判断 |'])('空白、段落、列表和表格都只有一个末尾品牌光标：%s', (text) => {
    render(text);
    expect(container.querySelectorAll('.streaming-text-caret')).toHaveLength(1);
    expect(container.textContent?.trimEnd().endsWith('M')).toBe(true);
    if (text) expect(container.querySelector('.streaming-text--blur .streaming-u')).not.toBeNull();
    if (text.startsWith('|')) {
      expect(container.querySelectorAll('td')).toHaveLength(2);
      expect(container.querySelector('td:last-child .streaming-text-caret')).not.toBeNull();
    }
    render(text, false);
    expect(container.querySelector('.streaming-text-caret')).toBeNull();
    expect(container.querySelector('.streaming-u')).toBeNull();
  });

  it('不拆分代码文本，代码块后的光标不回到之前段落', () => {
    render('前文\n\n```js\nconst value = 1;\n```');
    expect(container.querySelector('code')?.textContent).toBe('const value = 1;\n');
    expect(container.querySelector('code .streaming-u')).toBeNull();
    expect(container.lastElementChild?.querySelector('.streaming-text-caret')).not.toBeNull();
  });

  it('新增内容不重挂已有文字，链接与过滤后的安全语义保留', () => {
    render('已输出 [来源](https://example.com)');
    const first = container.querySelector('.streaming-u');
    render('已输出 [来源](https://example.com) 新内容 <script>alert(1)</script>');
    expect(container.querySelector('.streaming-u')).toBe(first);
    expect(container.querySelector('a')?.href).toBe('https://example.com/');
    expect(container.querySelector('script')).toBeNull();
  });
});
