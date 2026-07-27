import { describe, it, expect } from 'vitest';
import {
  buildAnchorFromText,
  collapseWhitespace,
  MAX_SELECTED_TEXT,
  CONTEXT_LEN,
} from '../reportCommentAnchor';

describe('collapseWhitespace', () => {
  it('折叠换行与连续空格为单空格并去两端空白', () => {
    expect(collapseWhitespace('  本周\n完成了   周报  ')).toBe('本周 完成了 周报');
  });
});

describe('buildAnchorFromText', () => {
  const fullText = '本周完成了周报智能体的划词评论功能，被评论的内容显示黄色下划线状态，下周继续优化。';

  it('正常构造锚点：选中片段 + 前后上下文 + 偏移', () => {
    const start = fullText.indexOf('划词评论功能');
    const end = start + '划词评论功能'.length;
    const anchor = buildAnchorFromText(fullText, start, end);
    expect(anchor).not.toBeNull();
    expect(anchor!.selectedText).toBe('划词评论功能');
    expect(anchor!.contextBefore).toBe(fullText.slice(0, start));
    expect(anchor!.contextAfter).toBe(fullText.slice(end, end + CONTEXT_LEN));
    expect(anchor!.startOffset).toBe(start);
    expect(anchor!.endOffset).toBe(end);
  });

  it('文首选区：contextBefore 为空且不越界', () => {
    const anchor = buildAnchorFromText(fullText, 0, 4);
    expect(anchor).not.toBeNull();
    expect(anchor!.contextBefore).toBe('');
    expect(anchor!.selectedText).toBe('本周完成');
  });

  it('文末选区：contextAfter 为空且不越界', () => {
    const anchor = buildAnchorFromText(fullText, fullText.length - 5, fullText.length);
    expect(anchor).not.toBeNull();
    expect(anchor!.contextAfter).toBe('');
  });

  it('上下文最长 50 字符', () => {
    const long = 'a'.repeat(200) + '目标片段' + 'b'.repeat(200);
    const start = 200;
    const end = start + 4;
    const anchor = buildAnchorFromText(long, start, end);
    expect(anchor!.contextBefore).toBe('a'.repeat(CONTEXT_LEN));
    expect(anchor!.contextAfter).toBe('b'.repeat(CONTEXT_LEN));
  });

  it('选中文本内的换行/多空格被折叠为单空格', () => {
    const text = '第一行\n  第二行  结束';
    const anchor = buildAnchorFromText(text, 0, text.length);
    expect(anchor!.selectedText).toBe('第一行 第二行 结束');
  });

  it('去空白后不足 2 字符返回 null', () => {
    expect(buildAnchorFromText('a  b', 1, 3)).toBeNull();
    expect(buildAnchorFromText('x', 0, 1)).toBeNull();
  });

  it('非法偏移返回 null', () => {
    expect(buildAnchorFromText(fullText, -1, 5)).toBeNull();
    expect(buildAnchorFromText(fullText, 5, 5)).toBeNull();
    expect(buildAnchorFromText(fullText, 0, fullText.length + 1)).toBeNull();
  });

  it('超长选区截断到上限', () => {
    const long = '长'.repeat(MAX_SELECTED_TEXT + 100);
    const anchor = buildAnchorFromText(long, 0, long.length);
    expect(anchor!.selectedText.length).toBe(MAX_SELECTED_TEXT);
  });
});
