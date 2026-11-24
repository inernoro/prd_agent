import { describe, it, expect } from 'vitest';
import { groupRecentEntries, recentGroupKeyOf } from '../recentEntriesGroups';
import type { RecentDocumentEntry } from '@/services/contracts/documentStore';

function entry(updatedAt: string, title = 't'): RecentDocumentEntry {
  return {
    id: title, storeId: 's', storeName: '知识库', title,
    contentType: 'text/markdown', tags: [],
    createdAt: updatedAt, updatedAt, isNew: true,
  };
}

describe('recentGroupKeyOf', () => {
  const now = new Date('2026-08-25T09:00:00');

  it('同一个自然日算今天', () => {
    expect(recentGroupKeyOf('2026-08-25T00:05:00', now)).toBe('today');
    expect(recentGroupKeyOf('2026-08-25T08:59:00', now)).toBe('today');
  });

  it('昨天深夜不因为「不足 24 小时」被算成今天', () => {
    // 这条是本函数存在的理由：按 24 小时窗口算，23:30 距今才 9.5 小时会落进「今天」，
    // 而用户心里它就是昨天的事。
    expect(recentGroupKeyOf('2026-08-24T23:30:00', now)).toBe('yesterday');
  });

  it('前天及更早归更早', () => {
    expect(recentGroupKeyOf('2026-08-23T23:59:00', now)).toBe('earlier');
    expect(recentGroupKeyOf('2020-01-01T00:00:00', now)).toBe('earlier');
  });

  it('解析不出来的时间戳归更早，不冒充刚刚发生', () => {
    expect(recentGroupKeyOf('not-a-date', now)).toBe('earlier');
  });
});

describe('groupRecentEntries', () => {
  const now = new Date('2026-08-25T09:00:00');

  it('不产出空组', () => {
    const groups = groupRecentEntries([entry('2026-08-25T08:00:00', 'a')], now);
    expect(groups.map(g => g.key)).toEqual(['today']);
  });

  it('保持传入顺序，并按 今天 → 昨天 → 更早 排列', () => {
    const groups = groupRecentEntries([
      entry('2026-08-25T08:00:00', 'a'),
      entry('2026-08-23T08:00:00', 'c'),
      entry('2026-08-25T07:00:00', 'b'),
      entry('2026-08-24T08:00:00', 'd'),
    ], now);
    expect(groups.map(g => g.key)).toEqual(['today', 'yesterday', 'earlier']);
    expect(groups[0].items.map(i => i.title)).toEqual(['a', 'b']);
    expect(groups[1].items.map(i => i.title)).toEqual(['d']);
    expect(groups[2].items.map(i => i.title)).toEqual(['c']);
  });

  it('空输入产出空数组', () => {
    expect(groupRecentEntries([], now)).toEqual([]);
  });
});
