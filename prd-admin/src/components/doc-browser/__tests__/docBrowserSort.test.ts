import { describe, expect, it } from 'vitest';
import { computeReorderUpdates, sortDocBrowserEntries } from '../docBrowserSort';

const base = {
  isFolder: false,
  sourceType: 'document',
  contentType: 'text/markdown',
  fileSize: 0,
};

describe('docBrowserSort', () => {
  it('uses persisted SortOrder for book order across folders and chapters', () => {
    const entries = [
      { ...base, id: 'advanced', title: '高级篇', isFolder: true, sortOrder: 300 },
      { ...base, id: 'basic', title: '基础篇', isFolder: true, sortOrder: 100 },
      { ...base, id: 'intermediate', title: '中级篇', isFolder: true, sortOrder: 200 },
    ];

    expect(sortDocBrowserEntries(entries, { mode: 'default' }).map((entry) => entry.id)).toEqual([
      'basic',
      'intermediate',
      'advanced',
    ]);
  });

  it('uses natural chapter numbers when SortOrder is absent', () => {
    const entries = [
      { ...base, id: 'chapter-10', title: '第 10 章：密钥' },
      { ...base, id: 'chapter-2', title: '第 2 章：登录' },
      { ...base, id: 'chapter-1', title: '第 1 章：开始' },
    ];

    expect(sortDocBrowserEntries(entries, { mode: 'default' }).map((entry) => entry.id)).toEqual([
      'chapter-1',
      'chapter-2',
      'chapter-10',
    ]);
  });

  it('keeps explicit temporal sorting independent from book order', () => {
    const entries = [
      { ...base, id: 'older', title: '旧文章', sortOrder: 1, createdAt: '2026-07-01T00:00:00Z' },
      { ...base, id: 'newer', title: '新文章', sortOrder: 2, createdAt: '2026-07-16T00:00:00Z' },
    ];

    expect(sortDocBrowserEntries(entries, { mode: 'created-desc' }).map((entry) => entry.id)).toEqual([
      'newer',
      'older',
    ]);
  });
});

describe('computeReorderUpdates（拖拽自定义排序）', () => {
  const doc = (id: string, sortOrder?: number) => ({ id, title: id, isFolder: false, sortOrder });

  it('两侧邻居都有 sortOrder 时只写被拖条目一个中点值', () => {
    const siblings = [doc('a', 10), doc('b', 20), doc('c', 30)];
    expect(computeReorderUpdates(siblings, 'c', 'a', 'after')).toEqual([
      { entryId: 'c', sortOrder: 15 },
    ]);
  });

  it('拖到头部时给「首项 - 步长」', () => {
    const siblings = [doc('a', 10), doc('b', 20)];
    expect(computeReorderUpdates(siblings, 'b', 'a', 'before')).toEqual([
      { entryId: 'b', sortOrder: 0 },
    ]);
  });

  it('拖到尾部时给「末项 + 步长」', () => {
    const siblings = [doc('a', 10), doc('b', 20)];
    expect(computeReorderUpdates(siblings, 'a', 'b', 'after')).toEqual([
      { entryId: 'a', sortOrder: 30 },
    ]);
  });

  it('邻居缺 sortOrder 时整组重编号，只回传变化项', () => {
    const siblings = [doc('a'), doc('b'), doc('c')];
    const updates = computeReorderUpdates(siblings, 'c', 'a', 'before');
    expect(updates).toEqual([
      { entryId: 'c', sortOrder: 10 },
      { entryId: 'a', sortOrder: 20 },
      { entryId: 'b', sortOrder: 30 },
    ]);
  });

  it('重编号时已在位且值相同的条目不重复回传', () => {
    const siblings = [doc('a', 10), doc('b'), doc('c', 30)];
    const updates = computeReorderUpdates(siblings, 'b', 'a', 'after');
    // a 已经是 10 → 不回传；b 插到 20；c 已经是 30 → 不回传
    expect(updates).toEqual([{ entryId: 'b', sortOrder: 20 }]);
  });

  it('拖到自身 / 目标不存在时返回空', () => {
    const siblings = [doc('a', 10), doc('b', 20)];
    expect(computeReorderUpdates(siblings, 'a', 'a', 'before')).toEqual([]);
    expect(computeReorderUpdates(siblings, 'a', 'ghost', 'before')).toEqual([]);
  });

  it('被拖条目来自其他父级（跨文件夹拖入）也能插入编号', () => {
    const siblings = [doc('a', 10), doc('b', 20)];
    expect(computeReorderUpdates(siblings, 'outsider', 'a', 'after')).toEqual([
      { entryId: 'outsider', sortOrder: 15 },
    ]);
  });
});
