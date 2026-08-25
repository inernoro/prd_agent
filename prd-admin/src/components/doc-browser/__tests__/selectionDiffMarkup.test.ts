import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  buildInlineDiffBody, markLine,
  STREAM_ANCHOR_DOM_ID, STREAM_ANCHOR_HTML, STREAM_ANCHOR_SELECTOR,
} from '../selectionDiffMarkup';
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

  it('删除的列表与新增的列表分成两个 ol，新条目从 1 重新编号', () => {
    const original = '1. 旧一\n2. 旧二';
    const body = `前言\n\n${original}\n\n结尾`;
    const range = { start: body.indexOf(original), end: body.indexOf(original) + original.length };
    const md = buildInlineDiffBody(body, range, '1. 新一\n2. 新二\n3. 新三').body;
    const html = render(md);
    // 不分开的话六条会连成一个列表，新条目从 3. 开始编号，读起来像「原来有五条」
    expect((html.match(/<ol/g) ?? []).length).toBe(2);
    expect(html).not.toContain('start="');
  });

  it('流式期间新增段落不会被上一条被删列表项吸进列表里', () => {
    const original = '1. 旧一\n2. 旧二';
    const body = `前言\n\n${original}\n\n结尾`;
    const range = { start: body.indexOf(original), end: body.indexOf(original) + original.length };
    // 模型刚吐出第一句（还没换行），此时它紧跟在被删的列表项后面
    const md = buildInlineDiffBody(body, range, '改写后的开头一句').body;
    const html = render(md);
    // 任何 li 内部都不该出现新增内容——出现就说明它成了上一条列表项的延续行
    expect(/<li>(?:(?!<\/li>)[\s\S])*<ins>/.test(html)).toBe(false);
    expect(html).toContain('<ins>改写后的开头一句</ins>');
  });

  it('表格逐行改写时不插分隔，表格不被切成两半', () => {
    const original = '| 名称 | 说明 |\n|---|---|\n| 旧值 | 旧说明 |';
    const body = `前言\n\n${original}\n\n结尾`;
    const range = { start: body.indexOf(original), end: body.indexOf(original) + original.length };
    const md = buildInlineDiffBody(body, range, '| 名称 | 说明 |\n|---|---|\n| 新值 | 新说明 |');
    const html = render(md.body);
    expect((html.match(/<table/g) ?? []).length).toBe(1);
    expect(html).toContain('<ins>新值</ins>');
    expect(html).toContain('<del>旧值</del>');
  });

  it('表格被标注后仍然渲染成表格', () => {
    const html = render('| <ins>名称</ins> | <del>说明</del> |\n|---|---|\n| a | b |');
    expect(html).toContain('<table>');
    expect(html).toContain('<ins>名称</ins>');
    expect(html).toContain('<del>说明</del>');
  });
});

/**
 * 流式锚点。
 *
 * 2026-08-25 用户："你不懂自己去增加这种绘制，本系统里面就有全局绘制组件。"
 * 确实——doc/rule.frontend.streaming-text.md 明令流式文本走 StreamingText，
 * 「流式期间使用轻量纯文本动效，完成后再切换完整 Markdown 渲染」，
 * 并禁止「每个 chunk 都执行完整 Markdown 高亮和布局」。
 * 之前这条链自己把已吐出的文字拼进 markdown 逐 token 重渲染，两条都违反了，
 * 表现就是正文整棵重挂、进场动画无限重启、「一闪一闪像老电脑」。
 *
 * 现在流式档正文里只有一个空锚点，正在写的那段由 StreamingText 用 portal 画进去。
 */
describe('流式锚点：正文这一层在流式期间完全不动', () => {
  const DOC = '# 标题\n\n第一阶段建议：\n\n1. 甲\n2. 乙\n\n结尾。\n';
  const SEL = '第一阶段建议：\n\n1. 甲\n2. 乙';
  const RANGE = { start: DOC.indexOf(SEL), end: DOC.indexOf(SEL) + SEL.length };

  it('锚点能穿过 rehypeRaw + sanitize 活到 DOM 里，且是块级、不被 ins 包住', () => {
    const html = render(buildInlineDiffBody(DOC, RANGE, STREAM_ANCHOR_HTML).body);
    // 块级：正在写的那段按 markdown 渲染（标题/列表都是块级元素），
    // 塞进 span 会被浏览器判成 <p> 里嵌块级元素，排版当场错位
    expect(html).toMatch(/<div id="[^"]*doc-rewrite-stream"><\/div>/);
    // 不能被 <ins> 包住：ins 是行内元素，包住整块 markdown 的圆角底色会糊成一团。
    // 「这是新写的」由 portal 里那个容器自己的样式（.doc-rewrite-stream）表达。
    expect(html).not.toMatch(/<ins>\s*<div id/);
    // 原选区照旧压成 del，用户看得见「这段正在被替换」
    expect(html).toContain('<del>第一阶段建议：</del>');
  });

  it('DOM 里的 id 带 user-content- 前缀——查节点必须用真正生效的那个', () => {
    // sanitize 会给正文内嵌 HTML 的 id 加前缀防撞车。按写进 markdown 的那个 id 去
    // getElementById 会永远查不到，流式文字一个字都画不出来（形状 6）。
    const html = render(buildInlineDiffBody(DOC, RANGE, STREAM_ANCHOR_HTML).body);
    const id = /<div id="([^"]+)"/.exec(html)?.[1];
    expect(id, '锚点没渲染出来').toBeTruthy();
    expect(id).toBe(STREAM_ANCHOR_DOM_ID);
    expect(STREAM_ANCHOR_SELECTOR).toContain(`#${id}`);
  });

  it('流式档的正文是常量：与「已经吐出多少字」无关', () => {
    const a = buildInlineDiffBody(DOC, RANGE, STREAM_ANCHOR_HTML).body;
    const b = buildInlineDiffBody(DOC, RANGE, STREAM_ANCHOR_HTML).body;
    expect(a).toBe(b);
    // 反证：老写法把已吐出的文字拼进去，每多一个字正文就是一个新字符串
    expect(buildInlineDiffBody(DOC, RANGE, '新句').body)
      .not.toBe(buildInlineDiffBody(DOC, RANGE, '新句子').body);
  });
});

/**
 * 接线守卫（predicate-and-wiring-discipline.md 形状 2）：
 * 上面那些性质删掉都不会红——真正会退化的是「DocBrowser 有没有照着用」。
 * 所以直接扫调用方源码，断言这条链没有偷偷回到自己拼 markdown 的老路。
 */
describe('接线：DocBrowser 的流式档确实走共享组件', () => {
  const SRC = readFileSync(resolve(__dirname, '../DocBrowser.tsx'), 'utf-8');

  it('流式文本用的是 StreamingText，不是自己写的打字机', () => {
    expect(SRC).toContain("import { StreamingText } from '@/components/streaming'");
    expect(SRC).toMatch(/createPortal\(\s*<StreamingText/);
  });

  it('流式档正文的 memo 依赖里没有已吐出的文字', () => {
    // 依赖项一旦混进 rewriteOutput / rewrite.text，正文就会逐 token 重算，
    // 「一闪一闪」当场复发，而任何现有断言都不会红。
    const block = /const streamingDiff = useMemo\([\s\S]*?\}, \[([^\]]*)\]\);/.exec(SRC);
    expect(block, '找不到 streamingDiff 这个 memo').toBeTruthy();
    expect(block![1]).not.toMatch(/rewriteOutput|rewrite\.text/);
    expect(block![0]).toContain('STREAM_ANCHOR_HTML');
  });
});
