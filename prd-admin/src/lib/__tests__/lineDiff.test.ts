import { describe, it, expect } from 'vitest';
import { computeLineDiff, diffStats, isIdentical } from '@/lib/lineDiff';

describe('computeLineDiff', () => {
  it('相同文本：全部 eq，零增删', () => {
    const lines = computeLineDiff('a\nb\nc', 'a\nb\nc');
    expect(lines.every((l) => l.type === 'eq')).toBe(true);
    expect(diffStats(lines)).toEqual({ added: 0, removed: 0 });
  });

  it('中间行被替换：识别为 1 删 1 增，首尾保持 eq', () => {
    const lines = computeLineDiff('a\nb\nc', 'a\nB\nc');
    expect(lines[0]).toEqual({ type: 'eq', text: 'a' });
    expect(lines).toContainEqual({ type: 'del', text: 'b' });
    expect(lines).toContainEqual({ type: 'add', text: 'B' });
    expect(lines[lines.length - 1]).toEqual({ type: 'eq', text: 'c' });
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1 });
  });

  it('纯追加：原文全部 eq，新增段为 add', () => {
    const lines = computeLineDiff('a\nb', 'a\nb\nc\nd');
    expect(diffStats(lines)).toEqual({ added: 2, removed: 0 });
    expect(lines.filter((l) => l.type === 'add').map((l) => l.text)).toEqual(['c', 'd']);
  });

  it('纯删除：被删行为 del', () => {
    const lines = computeLineDiff('a\nb\nc', 'a\nc');
    expect(diffStats(lines)).toEqual({ added: 0, removed: 1 });
    expect(lines).toContainEqual({ type: 'del', text: 'b' });
  });

  it('原文为空：全部为 add', () => {
    const lines = computeLineDiff('', 'x\ny');
    expect(lines).toEqual([
      { type: 'add', text: 'x' },
      { type: 'add', text: 'y' },
    ]);
  });

  it('改后为空：全部为 del', () => {
    const lines = computeLineDiff('x\ny', '');
    expect(lines).toEqual([
      { type: 'del', text: 'x' },
      { type: 'del', text: 'y' },
    ]);
  });

  it('退化保护：超大差异中段不抛错且保留增删计数', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `o${i}`).join('\n');
    const big2 = Array.from({ length: 2000 }, (_, i) => `n${i}`).join('\n');
    const lines = computeLineDiff(big, big2);
    const stats = diffStats(lines);
    expect(stats.removed).toBe(2000);
    expect(stats.added).toBe(2000);
  });
});

describe('isIdentical', () => {
  it('相等返回 true', () => {
    expect(isIdentical('a\nb', 'a\nb')).toBe(true);
  });
  it('不等返回 false', () => {
    expect(isIdentical('a\nb', 'a\nB')).toBe(false);
  });
});
