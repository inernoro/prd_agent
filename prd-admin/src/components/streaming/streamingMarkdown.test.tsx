import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { StreamingText } from './StreamingText';
import { closeOpenMarkdown, MARKDOWN_STREAM_CARET } from './streamingMarkdown';

/**
 * 2026-08-25 用户拍板：流式期也渲染 markdown。
 * 在此之前，`markdown` + `renderMarkdown` 齐备时流式期仍退化成纯文本，
 * 用户在整个生成过程里看着满屏 `**` `#` `-`，到完成那一刻才变成排版好的样子。
 */

const md = (src: string) => renderToStaticMarkup(
  createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], children: src }),
);

describe('closeOpenMarkdown：把写到一半的 markdown 补合法', () => {
  it('半截加粗补齐后能真的渲染成 <strong>，而不是把星号当文字', () => {
    const out = closeOpenMarkdown('1. **《标准》V0.1');
    expect(md(out)).toContain('<strong>');
    expect(md('1. **《标准》V0.1')).toContain('**'); // 反证：不处理就漏星号
  });

  it('末尾刚敲出半截标记时先摘掉，不会补成三颗星', () => {
    expect(closeOpenMarkdown('这是 **')).toBe('这是 ');
    expect(closeOpenMarkdown('这是 *')).toBe('这是 ');
  });

  it('行内代码与删除线同样补齐', () => {
    expect(closeOpenMarkdown('调用 `apiRequest')).toBe('调用 `apiRequest`');
    expect(closeOpenMarkdown('这段 ~~作废')).toBe('这段 ~~作废~~');
  });

  it('已经闭合的一个字都不动', () => {
    expect(closeOpenMarkdown('**加粗** 与 `代码`')).toBe('**加粗** 与 `代码`');
    // 刚吐完的斜体不许被摘掉尾巴（2026-08-21 code review 抓到过）
    expect(closeOpenMarkdown('*斜体*')).toBe('*斜体*');
    expect(md(closeOpenMarkdown('*斜体*'))).toContain('<em>');
    expect(closeOpenMarkdown('***粗斜***')).toBe('***粗斜***');
  });

  it('打到一半的斜体补上单个星号', () => {
    expect(closeOpenMarkdown('这是 *斜的')).toBe('这是 *斜的*');
    expect(md(closeOpenMarkdown('这是 *斜的'))).toContain('<em>');
  });

  it('没闭合的代码围栏补收尾——否则它后面的一切都被吞进代码块', () => {
    const half = '```js\nconst a = 1;';
    expect(closeOpenMarkdown(half)).toBe('```js\nconst a = 1;\n```');
    // 反证：不补的话后文会被吞
    const swallowed = md(`${half}\n\n后面这段正文`);
    expect(swallowed).toContain('后面这段正文');
    expect(md(closeOpenMarkdown(half) + '\n\n后面这段正文')).toContain('<p>后面这段正文</p>');
  });

  it('围栏里的星号是代码，不参与闭合判断', () => {
    const t = '```js\nconst a = b ** 2;\n```';
    expect(closeOpenMarkdown(t)).toBe(t);
  });
});

describe('StreamingText：流式期也渲染 markdown', () => {
  const render = (props: { text: string; streaming?: boolean; cursor?: boolean }) => renderToStaticMarkup(
    <StreamingText
      markdown
      renderMarkdown={(c) => createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], children: c })}
      {...props}
    />,
  );

  it('流式期把 markdown 渲染出来，而不是把语法当文字摆着', () => {
    const html = render({ text: '## 小标题\n\n- **要点**', streaming: true });
    expect(html).toContain('<h2>');
    expect(html).toContain('<li>');
    expect(html).toContain('<strong>');
    // 语法符号不该以文字形式留在页面上
    expect(html).not.toContain('## ');
  });

  it('流式期写到一半的加粗不会漏星号', () => {
    const html = render({ text: '- **要点写到一半', streaming: true });
    expect(html).toContain('<strong>');
    expect(html).not.toContain('**');
  });

  it('流式期末尾有光标，完成后没有', () => {
    expect(render({ text: '一段正文', streaming: true })).toContain(MARKDOWN_STREAM_CARET);
    expect(render({ text: '一段正文', streaming: false })).not.toContain(MARKDOWN_STREAM_CARET);
    // cursor={false} 时也不加
    expect(render({ text: '一段正文', streaming: true, cursor: false })).not.toContain(MARKDOWN_STREAM_CARET);
  });

  it('完成态的文本一个字都不动（不补标记、不加光标）', () => {
    const html = render({ text: '写到一半 **', streaming: false });
    expect(html).toContain('**');
  });

  it('没给 renderMarkdown 时仍退回纯文本词级动画（老行为不变）', () => {
    const html = renderToStaticMarkup(<StreamingText text="## 小标题" streaming markdown />);
    expect(html).toContain('streaming-u');
    expect(html).not.toContain('<h2>');
  });
});
