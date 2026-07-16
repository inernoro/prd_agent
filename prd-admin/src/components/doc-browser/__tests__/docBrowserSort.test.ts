import { describe, expect, it } from 'vitest';
import { sortDocBrowserEntries } from '../docBrowserSort';

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
