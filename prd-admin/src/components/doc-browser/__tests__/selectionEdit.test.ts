import { describe, it, expect } from 'vitest';
import {
  resolveSelectionRange,
  replaceSelectionInBody,
  insertBlockAfterSelection,
  frontmatterPrefixOf,
  buildImageMarkdown,
} from '../selectionEdit';

describe('resolveSelectionRange', () => {
  const body = '第一段开头。这里是目标句子。第一段结尾。\n\n第二段也有目标句子。第二段结尾。';

  it('offset 提示精确命中时直接使用', () => {
    const start = body.indexOf('这里是目标句子。');
    const r = resolveSelectionRange(body, {
      selectedText: '这里是目标句子。',
      startOffset: start,
      endOffset: start + 8,
    });
    expect(r).toEqual({ start, end: start + 8 });
  });

  it('offset 失效（-1）但全文唯一出现时回退 indexOf', () => {
    const r = resolveSelectionRange(body, {
      selectedText: '第一段结尾。',
      startOffset: -1,
      endOffset: -1,
    });
    expect(r).not.toBeNull();
    expect(body.slice(r!.start, r!.end)).toBe('第一段结尾。');
  });

  it('offset 漂移（指向错误位置）时不盲信，回退重定位', () => {
    const real = body.indexOf('第一段结尾。');
    const r = resolveSelectionRange(body, {
      selectedText: '第一段结尾。',
      startOffset: 2, // 漂移的错误提示
      endOffset: 8,
    });
    expect(r).toEqual({ start: real, end: real + 6 });
  });

  it('多处出现 + contextBefore 可消歧 → 命中第二处', () => {
    const r = resolveSelectionRange(body, {
      selectedText: '目标句子。',
      startOffset: -1,
      endOffset: -1,
      contextBefore: '第二段也有',
    });
    expect(r).not.toBeNull();
    expect(r!.start).toBeGreaterThan(body.indexOf('第二段'));
  });

  it('多处出现且无法消歧 → 返回 null（禁用替换，宁缺毋错）', () => {
    const r = resolveSelectionRange(body, {
      selectedText: '目标句子。',
      startOffset: -1,
      endOffset: -1,
    });
    expect(r).toBeNull();
  });

  it('原文已变（选区文本不存在）→ null', () => {
    const r = resolveSelectionRange(body, {
      selectedText: '已被删除的句子',
      startOffset: 0,
      endOffset: 7,
    });
    expect(r).toBeNull();
  });
});

describe('replaceSelectionInBody', () => {
  it('只替换选区，前后文不动', () => {
    const body = 'AAA BBB CCC';
    const out = replaceSelectionInBody(body, { start: 4, end: 7 }, 'XYZ-XYZ');
    expect(out).toBe('AAA XYZ-XYZ CCC');
  });
});

describe('insertBlockAfterSelection', () => {
  it('插入到选区所在段落之后（下一个空行处），自成段落', () => {
    const body = '第一段内容。\n\n第二段内容。';
    const range = { start: 0, end: 3 };
    const out = insertBlockAfterSelection(body, range, '![配图](https://x/a.png)');
    expect(out).toBe('第一段内容。\n\n![配图](https://x/a.png)\n\n第二段内容。');
  });

  it('选区在最后一段时追加到文末', () => {
    const body = '第一段。\n\n最后一段。';
    const start = body.indexOf('最后一段。');
    const out = insertBlockAfterSelection(body, { start, end: start + 5 }, '![配图](u)');
    expect(out).toBe('第一段。\n\n最后一段。\n\n![配图](u)\n');
  });

  it('空 block 不改动正文', () => {
    const body = 'abc';
    expect(insertBlockAfterSelection(body, { start: 0, end: 1 }, '  ')).toBe('abc');
  });
});

describe('frontmatterPrefixOf', () => {
  it('有 frontmatter 时返回头部前缀，prefix + body === raw', () => {
    const raw = '---\ntitle: 测试\n---\n正文第一行。\n';
    const fmBody = '正文第一行。\n';
    const prefix = frontmatterPrefixOf(raw, fmBody);
    expect(prefix + fmBody).toBe(raw);
    expect(prefix).toBe('---\ntitle: 测试\n---\n');
  });

  it('无 frontmatter 时前缀为空', () => {
    expect(frontmatterPrefixOf('正文', '正文')).toBe('');
  });
});

describe('buildImageMarkdown', () => {
  it('生成标准图片 markdown，alt 兜底为「配图」', () => {
    expect(buildImageMarkdown('https://x/a.png')).toBe('![配图](https://x/a.png)');
  });

  it('alt 中的方括号/换行被清洗，防止破坏 markdown 结构', () => {
    expect(buildImageMarkdown('u', 'a[b]c\nd')).toBe('![a b c d](u)');
  });
});
