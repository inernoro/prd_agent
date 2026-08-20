import { describe, it, expect } from 'vitest';
import { resolveSelectionRange, isReplaceSafe, stripDuplicatedBlockPrefix } from '../selectionEdit';
import { buildPlainTextIndex, findRenderedTextRanges } from '../markdownTextIndex';

// 对抗式审计（2026-08-20）：划词拿到的是**渲染后**的纯文本，写回落在**源码**上。
// 这批用例就是当时把匹配链按对抗思路挨个捅一遍的现场，全部固化下来——
// 每一条都对应过一个真实缺陷或一次真实降级，不是补充说明性的样例。
//
// 判据统一是「替换之后的正文长什么样」，不是「某个中间函数返回了什么」
// （predicate-and-wiring-discipline.md 形状 4a：断言行为，不断言实现细节）。

/** 模拟真人划词：DOM 文本进去，替换后的正文出来；定位不了则返回 null（= 入口降级） */
function rewriteAsUser(
  body: string,
  domText: string,
  modelOutput: string,
  dom?: { index: number; total: number },
): string | null {
  const range = resolveSelectionRange(body, {
    selectedText: domText,
    startOffset: -1,
    endOffset: -1,
    domOccurrenceIndex: dom?.index ?? 0,
    domOccurrenceTotal: dom?.total ?? 1,
  });
  if (!range || !isReplaceSafe(body, range)) return null;
  const out = stripDuplicatedBlockPrefix(body, range, modelOutput);
  return body.slice(0, range.start) + out + body.slice(range.end);
}

describe('渲染文本 → 源码 的定位（页面上看不见的标记不能让匹配落空）', () => {
  it('句子里有行内加粗', () => {
    expect(rewriteAsUser('这是**非常重要**的一句话。\n', '这是非常重要的一句话。', '改写后的话。'))
      .toBe('改写后的话。\n');
  });

  it('句子里有行内代码', () => {
    expect(rewriteAsUser('调用 `apiRequest` 即可。\n', '调用 apiRequest 即可。', '直接调用即可。'))
      .toBe('直接调用即可。\n');
  });

  it('句子里有链接（整句选中）', () => {
    expect(rewriteAsUser('详见[开发文档](https://x.com)说明。\n', '详见开发文档说明。', '详见新文档说明。'))
      .toBe('详见新文档说明。\n');
  });

  it('句子里有双链（页面上只显示别名）', () => {
    expect(rewriteAsUser('详见[[知识库设计|设计文档]]说明。\n', '详见设计文档说明。', '详见新说明。'))
      .toBe('详见新说明。\n');
  });

  it('跨段落选择（DOM 里是换行，源码里是空行）', () => {
    expect(rewriteAsUser('第一段。\n\n第二段。\n', '第一段。\n第二段。', '合并成一段。'))
      .toBe('合并成一段。\n');
  });

  it('代码块内的行按原样匹配，不被当作行内标记剥离', () => {
    expect(rewriteAsUser('```ts\nconst a = **1**;\n```\n', 'const a = **1**;', 'const a = 2;'))
      .toBe('```ts\nconst a = 2;\n```\n');
  });

  it('词内下划线是真文字，不能当强调标记剥掉', () => {
    const idx = buildPlainTextIndex('字段 user_name 必填。');
    expect(idx.plain).toContain('user_name');
    expect(rewriteAsUser('字段 user_name 必填。\n', '字段 user_name 必填。', '字段 userName 必填。'))
      .toBe('字段 userName 必填。\n');
  });

  it('词边界的下划线是强调标记，页面上看不见', () => {
    expect(buildPlainTextIndex('这是_强调_文字').plain).toBe('这是强调文字');
  });

  it('图片在页面上没有文字，不参与匹配', () => {
    expect(buildPlainTextIndex('前![示意图](a.png)后').plain).toBe('前后');
  });
});

describe('块级前缀：页面上看不见的序号/井号，不能被模型补出第二份', () => {
  it('模型给有序列表项补了序号 → 不出现 1. 1.', () => {
    expect(rewriteAsUser('前言\n\n1. 旧条目；\n2. 另一条；\n', '旧条目；', '1. 新条目；'))
      .toBe('前言\n\n1. 新条目；\n2. 另一条；\n');
  });

  it('模型没补序号 → 原有序号保留，不被吃掉', () => {
    expect(rewriteAsUser('前言\n\n1. 旧条目；\n2. 另一条；\n', '旧条目；', '新条目；'))
      .toBe('前言\n\n1. 新条目；\n2. 另一条；\n');
  });

  it('标题：不出现 ## ##', () => {
    expect(rewriteAsUser('## 旧标题\n\n正文。\n', '旧标题', '## 新标题'))
      .toBe('## 新标题\n\n正文。\n');
  });

  it('无序列表：不出现 - -', () => {
    expect(rewriteAsUser('- 旧条目\n- 另一条\n', '旧条目', '- 新条目', { index: 0, total: 1 }))
      .toBe('- 新条目\n- 另一条\n');
  });

  it('引用：不出现 > >', () => {
    expect(rewriteAsUser('> 旧引用。\n', '旧引用。', '> 新引用。')).toBe('> 新引用。\n');
  });

  it('不同类的前缀不误剥：原文是列表项，模型输出以标题开头 → 保留标题标记', () => {
    expect(rewriteAsUser('- 旧条目\n', '旧条目', '## 提升为标题'))
      .toBe('- ## 提升为标题\n');
  });

  it('段落原文（行首没有块级标记）不做任何剥离', () => {
    expect(rewriteAsUser('一句原文。\n', '一句原文。', '1. 改成列表项'))
      .toBe('1. 改成列表项\n');
  });
});

describe('同文多处：只认 DOM 序号，指认不了就降级', () => {
  const body = '甲。目标句。乙。\n\n丙。目标句。丁。\n';

  it('DOM 序号指向第二处 → 改的就是第二处', () => {
    expect(rewriteAsUser(body, '目标句。', '新句。', { index: 1, total: 2 }))
      .toBe('甲。目标句。乙。\n\n丙。新句。丁。\n');
  });

  it('DOM 总数与正文对不上（页面上混入了同文副本）→ 拒绝定位，宁可降级', () => {
    expect(rewriteAsUser(body, '目标句。', '新句。', { index: 0, total: 3 })).toBeNull();
  });

  it('正文只有一处但页面上有多处副本 → 同样拒绝，不赌', () => {
    expect(rewriteAsUser('只有一处的句子。\n', '只有一处的句子。', '新句。', { index: 0, total: 2 }))
      .toBeNull();
  });
});

describe('链接结构：改显示文字可以，改地址/目标不行', () => {
  it('只选中链接文字 → 可改，地址原样保留', () => {
    expect(rewriteAsUser('详见[开发文档](https://x.com)说明。\n', '开发文档', '新文档'))
      .toBe('详见[新文档](https://x.com)说明。\n');
  });

  it('双链只显示别名，改别名不断链', () => {
    expect(rewriteAsUser('详见[[知识库设计|设计文档]]说明。\n', '设计文档', '新设计'))
      .toBe('详见[[知识库设计|新设计]]说明。\n');
  });
});

describe('位置映射本身', () => {
  it('映射回来的区间必须正好覆盖源码里对应的那段', () => {
    const body = '前言 **加粗的话** 后语';
    const [r] = findRenderedTextRanges(body, '加粗的话');
    expect(body.slice(r.start, r.end)).toBe('加粗的话');
  });

  it('匹配不到就是空，不产出可疑区间', () => {
    expect(findRenderedTextRanges('一些正文', '并不存在的句子')).toEqual([]);
  });
});
