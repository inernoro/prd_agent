import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import ReactMarkdown from 'react-markdown';
import { buildInlineDiffBody, markLine } from '../selectionDiffMarkup';
import { DOC_REMARK_PLUGINS, DOC_REHYPE_PLUGINS } from '@/components/file-preview/MarkdownViewer';

/**
 * 用正文渲染器**真实的**插件链渲染，而不是另抄一条。
 * 断言的是运行时求值结果（渲染出来的 HTML），不是源码里写没写 <ins>
 * （predicate-and-wiring-discipline.md 形状 6/8：扫源码只能证明零件都在，不能证明装对了）。
 */
function render(markdown: string): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: DOC_REMARK_PLUGINS,
      rehypePlugins: DOC_REHYPE_PLUGINS,
      children: markdown,
    }),
  );
}

describe('markLine：块级结构留在标记外面', () => {
  it('有序列表：序号在外，正文在 <ins> 里', () => {
    expect(markLine('1. 第一条', 'ins')).toBe('1. <ins>第一条</ins>');
  });

  it('无序列表 / 任务框 / 标题 / 引用：前缀一律不进标记', () => {
    expect(markLine('- 条目', 'del')).toBe('- <del>条目</del>');
    expect(markLine('- [ ] 待办', 'ins')).toBe('- [ ] <ins>待办</ins>');
    expect(markLine('## 小标题', 'del')).toBe('## <del>小标题</del>');
    expect(markLine('> 引用行', 'ins')).toBe('> <ins>引用行</ins>');
  });

  it('表格：逐单元格标注，竖线与分隔行不动', () => {
    expect(markLine('| 名称 | 说明 |', 'ins')).toBe('| <ins>名称</ins> | <ins>说明</ins> |');
    expect(markLine('|---|:--:|', 'ins')).toBe('|---|:--:|');
  });

  it('空行与分隔线没有可标注的文字，原样返回', () => {
    expect(markLine('', 'ins')).toBe('');
    expect(markLine('   ', 'del')).toBe('   ');
    expect(markLine('---', 'del')).toBe('---');
  });
});

describe('buildInlineDiffBody：只改选区，前后文逐字保留', () => {
  const body = '开头段落。\n\n旧句子。\n\n结尾段落。\n';
  const range = { start: body.indexOf('旧句子。'), end: body.indexOf('旧句子。') + '旧句子。'.length };

  it('选区外的正文一个字都不动', () => {
    const r = buildInlineDiffBody(body, range, '新句子。');
    expect(r.body.startsWith('开头段落。\n\n')).toBe(true);
    expect(r.body.endsWith('\n\n结尾段落。\n')).toBe(true);
    expect(r.body).toContain('<del>旧句子。</del>');
    expect(r.body).toContain('<ins>新句子。</ins>');
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
    expect(r.codeChangeUnmarked).toBe(false);
  });

  it('流式期间的半截结果也能标注（增量就是产物本身在生长）', () => {
    const r = buildInlineDiffBody(body, range, '新句');
    expect(r.body).toContain('<ins>新句</ins>');
    expect(r.body).toContain('<del>旧句子。</del>');
  });

  it('结果与原文逐行相同的部分不标注（只标真正变了的行）', () => {
    const multi = '第一行\n第二行\n第三行';
    const b = `前言\n\n${multi}\n\n后记`;
    const rg = { start: b.indexOf(multi), end: b.indexOf(multi) + multi.length };
    const r = buildInlineDiffBody(b, rg, '第一行\n改过的第二行\n第三行');
    expect(r.body).toContain('第一行\n');
    expect(r.body).toContain('<del>第二行</del>');
    expect(r.body).toContain('<ins>改过的第二行</ins>');
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
  });

  it('代码围栏内的改动不标色，改后代码保持合法围栏并明说这一点', () => {
    const original = '```ts\nconst a = 1;\n```';
    const b = `说明\n\n${original}\n\n结束`;
    const rg = { start: b.indexOf(original), end: b.indexOf(original) + original.length };
    const r = buildInlineDiffBody(b, rg, '```ts\nconst a = 2;\n```');
    expect(r.codeChangeUnmarked).toBe(true);
    expect(r.body).toContain('const a = 2;');
    // 围栏内绝不能出现标记标签——它会被当成代码字符渲染出来
    expect(r.body).not.toContain('<del>const a = 1;</del>');
    expect(r.body).not.toContain('<ins>const a = 2;</ins>');
    // 围栏配对仍然成立（三处 ``` 会让后续正文全被吞进代码块）
    expect((r.body.match(/```/g) ?? []).length % 2).toBe(0);
  });

  it('流式停在半截围栏时补上收尾，不把后文吞进代码块', () => {
    const original = '旧代码说明';
    const b = `前言\n\n${original}\n\n后面还有正文\n`;
    const rg = { start: b.indexOf(original), end: b.indexOf(original) + original.length };
    // 模型刚吐到 ```ts 这一行，围栏还没闭合
    const r = buildInlineDiffBody(b, rg, '```ts\nconst a = 1;');
    expect((r.body.match(/```/g) ?? []).length % 2).toBe(0);
    expect(r.body.endsWith('后面还有正文\n')).toBe(true);
  });

  it('选区落在代码块内部时，删除行同样不标注', () => {
    const b = '```ts\nconst a = 1;\nconst b = 2;\n```\n';
    const target = 'const a = 1;';
    const rg = { start: b.indexOf(target), end: b.indexOf(target) + target.length };
    const r = buildInlineDiffBody(b, rg, 'const a = 42;');
    expect(r.body).not.toContain('<ins>');
    expect(r.body).not.toContain('<del>');
    expect(r.body).toContain('const a = 42;');
    expect(r.codeChangeUnmarked).toBe(true);
  });
});

describe('渲染契约：标记必须活到正文渲染器输出的 HTML 里', () => {
  it('<ins>/<del> 穿过 rehypeRaw + rehypeSanitize 成为真元素', () => {
    const html = render('段落 <del>旧的</del><ins>新的</ins>');
    expect(html).toContain('<del>旧的</del>');
    expect(html).toContain('<ins>新的</ins>');
    // 反证这条链上的 sanitize 真的在跑：不然「标记活下来了」只是因为没人过滤，
    // 断言就不再是对白名单的约束（形状 4a：断言行为，别断言巧合）
    expect(render('<script>alert(1)</script>')).not.toContain('<script>');
  });

  it('列表项被标注后仍然渲染成列表，不塌成纯文本', () => {
    const md = buildInlineDiffBody(
      '前言\n\n1. 旧条目\n\n结尾',
      { start: '前言\n\n'.length, end: '前言\n\n'.length + '1. 旧条目'.length },
      '1. 新条目',
    ).body;
    const html = render(md);
    expect(html).toContain('<li>');
    expect(html).toContain('<del>旧条目</del>');
    expect(html).toContain('<ins>新条目</ins>');
  });

  it('表格被标注后仍然渲染成表格', () => {
    const html = render('| <ins>名称</ins> | <del>说明</del> |\n|---|---|\n| a | b |');
    expect(html).toContain('<table>');
    expect(html).toContain('<ins>名称</ins>');
    expect(html).toContain('<del>说明</del>');
  });
});
