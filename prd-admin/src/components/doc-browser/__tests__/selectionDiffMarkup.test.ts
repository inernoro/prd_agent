import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import ReactMarkdown from 'react-markdown';
import { buildInlineDiffBody, closeDanglingInlineMarks, markLine, STREAM_CURSOR } from '../selectionDiffMarkup';
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

describe('closeDanglingInlineMarks：流式半截的行内标记不许露脸', () => {
  it('打到一半的加粗补上闭合，星号不作为文字渲染', () => {
    const out = closeDanglingInlineMarks('1. **《标准》V0.1');
    expect(out).toBe('1. **《标准》V0.1**');
    expect(render(out)).toContain('<strong>');
    expect(render('1. **《标准》V0.1')).toContain('**'); // 反证：不处理就会漏星号
  });

  it('末尾刚敲出半截标记时先摘掉，不会补成三颗星', () => {
    expect(closeDanglingInlineMarks('这是 **')).toBe('这是 ');
    expect(closeDanglingInlineMarks('这是 *')).toBe('这是 ');
  });

  it('行内代码与删除线同样补齐', () => {
    expect(closeDanglingInlineMarks('调用 `apiRequest')).toBe('调用 `apiRequest`');
    expect(closeDanglingInlineMarks('这段 ~~作废')).toBe('这段 ~~作废~~');
  });

  it('已经闭合的不动', () => {
    expect(closeDanglingInlineMarks('**加粗** 与 `代码`')).toBe('**加粗** 与 `代码`');
  });

  it('刚吐完的斜体不许被摘掉尾巴（2026-08-21 code review）', () => {
    // 上一版无条件摘末尾标记再补，而补齐清单里没有单个星号，
    // 于是完成态的 `*斜体*` 被摘成 `*斜体`，星号反倒露了出来
    expect(closeDanglingInlineMarks('*斜体*')).toBe('*斜体*');
    expect(render(closeDanglingInlineMarks('*斜体*'))).toContain('<em>');
    expect(closeDanglingInlineMarks('前面 *斜体*')).toBe('前面 *斜体*');
    expect(closeDanglingInlineMarks('`代码`')).toBe('`代码`');
    expect(closeDanglingInlineMarks('~~删~~')).toBe('~~删~~');
    // 粗斜体：末尾三颗星是闭合的一部分，摘一颗再补两颗会少掉一颗
    expect(closeDanglingInlineMarks('***粗斜***')).toBe('***粗斜***');
  });

  it('打到一半的斜体补上单个星号', () => {
    expect(closeDanglingInlineMarks('这是 *斜的')).toBe('这是 *斜的*');
    expect(render(closeDanglingInlineMarks('这是 *斜的'))).toContain('<em>');
  });

  it('代码围栏里的星号是代码，不参与闭合判断', () => {
    const t = '```js\nconst a = b ** 2;\n```';
    expect(closeDanglingInlineMarks(t)).toBe(t);
  });
});

/**
 * 流式光标（STREAM_CURSOR）。
 *
 * 2026-08-25 用户指着截图里一个孤零零的蓝色小方块问「这个东西为什么会存在，这是故意设计吗」。
 * 光标是故意的，方块不是：光标当时被包进了 <ins>，于是套上了新增块的底色/圆角/内边距/进场动画，
 * 在刚换行、整行只剩光标的那几帧里就渲染成一块什么字都没有的蓝色小砖。
 *
 * 判据是「渲染出来的 <ins> 里有没有只装着光标的」，扫的是真实渲染结果不是源码字面量。
 */
describe('流式光标不许被当成新增内容', () => {
  const ORIGINAL = `# 标题

第一阶段建议至少形成以下成果：

1. 《真实工作能力基准标准》，定义任务来源、任务分级、验证方式；
2. 《真实任务制作模板》，统一问题说明、代码版本、环境；

结尾段落逐字保留。
`;
  const SELECTED = ORIGINAL.slice(ORIGINAL.indexOf('第一阶段'), ORIGINAL.indexOf('\n\n结尾'));
  const RANGE = { start: ORIGINAL.indexOf(SELECTED), end: ORIGINAL.indexOf(SELECTED) + SELECTED.length };
  const REWRITTEN = `第一阶段建议至少形成以下可落地成果：

1. **《真实工作能力基准标准》V0.1**
   - 明确任务来源分类及每类的可入库条件
2. **《真实任务制作模板》V0.1**
   - 必须字段：问题背景、目标、代码版本`;

  it('逐帧扫全程：没有任何一帧渲染出「只装着光标」的 ins', () => {
    const offenders: string[] = [];
    for (let n = 0; n <= REWRITTEN.length; n++) {
      const text = `${closeDanglingInlineMarks(REWRITTEN.slice(0, n))}${STREAM_CURSOR}`;
      const html = render(buildInlineDiffBody(ORIGINAL, RANGE, text).body);
      // 只装着光标（或光标 + 空白）的 ins —— 就是用户截图里那块蓝色小砖
      const m = html.match(new RegExp(`<ins>\\s*${STREAM_CURSOR}\\s*</ins>`, 'g'));
      if (m) offenders.push(`n=${n} ${m[0]}`);
    }
    expect(offenders, `这些帧把光标标成了新增块：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('光标始终留在 ins 外面：行里有真内容时也不进标记', () => {
    const one = { start: 0, end: '旧句子'.length };
    const out = buildInlineDiffBody('旧句子', one, `新句子${STREAM_CURSOR}`).body;
    expect(out).toContain(`<ins>新句子</ins>${STREAM_CURSOR}`);
    expect(out).not.toContain(`${STREAM_CURSOR}</ins>`);
    // 渲染后光标是 ins 的兄弟节点，不在它里面
    expect(render(out)).toContain(`<ins>新句子</ins>${STREAM_CURSOR}`);
  });

  it('列表项刚起头、一个字都没吐出来：整行原样，不标成新增', () => {
    const one = { start: 0, end: '旧'.length };
    const out = buildInlineDiffBody('旧', one, `1. ${STREAM_CURSOR}`).body;
    expect(out).toContain(`1. ${STREAM_CURSOR}`);
    expect(out).not.toContain('<ins>');
  });

  it('表格行例外：从中间切开会破坏单元格，光标留在单元格里', () => {
    const one = { start: 0, end: '旧'.length };
    const out = buildInlineDiffBody('旧', one, `| 甲 | 乙${STREAM_CURSOR} |`).body;
    expect(out).toContain(`| <ins>甲</ins> | <ins>乙${STREAM_CURSOR}</ins> |`);
  });
});
