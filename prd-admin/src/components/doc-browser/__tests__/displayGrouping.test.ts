import { describe, it, expect } from 'vitest';
import { timeBucket, buildDisplayItems, type DocBrowserEntry } from '../DocBrowser';

// 固定"现在"为 2026-06-02 12:00（本地时区），便于断言时间桶边界
const NOW = new Date('2026-06-02T12:00:00').getTime();
const DAY = 24 * 60 * 60 * 1000;

function entry(id: string, createdAt: string, extra: Partial<DocBrowserEntry> = {}): DocBrowserEntry {
  return { id, title: id, isFolder: false, sourceType: 'doc', contentType: 'text/markdown', fileSize: 0, createdAt, ...extra };
}

describe('timeBucket', () => {
  it('今天 / 昨天 / 本周 / 本月 / 更早 边界正确', () => {
    expect(timeBucket(new Date(NOW).toISOString(), NOW).key).toBe('today');
    expect(timeBucket(new Date(NOW - DAY).toISOString(), NOW).key).toBe('yesterday');
    expect(timeBucket(new Date(NOW - 4 * DAY).toISOString(), NOW).key).toBe('week');
    expect(timeBucket(new Date(NOW - 20 * DAY).toISOString(), NOW).key).toBe('month');
    expect(timeBucket(new Date(NOW - 200 * DAY).toISOString(), NOW).key).toBe('earlier');
  });
  it('缺失/非法时间归为 none', () => {
    expect(timeBucket(undefined, NOW).key).toBe('none');
    expect(timeBucket('not-a-date', NOW).key).toBe('none');
  });
});

describe('buildDisplayItems', () => {
  it('groupByTime=false 时不插入任何分组头', () => {
    const roots = [entry('a', new Date(NOW).toISOString()), entry('b', new Date(NOW - 200 * DAY).toISOString())];
    const items = buildDisplayItems(roots, { groupByTime: false, timeField: 'createdAt', now: NOW });
    expect(items.every(i => i.kind === 'entry')).toBe(true);
    expect(items).toHaveLength(2);
  });

  it('groupByTime=true 时每个时间桶仅插入一个分组头，且 count 正确', () => {
    const roots = [
      entry('t1', new Date(NOW).toISOString()),
      entry('t2', new Date(NOW - 2 * 60 * 60 * 1000).toISOString()), // 今天
      entry('w1', new Date(NOW - 4 * DAY).toISOString()),            // 本周
      entry('o1', new Date(NOW - 100 * DAY).toISOString()),          // 更早
    ];
    const items = buildDisplayItems(roots, { groupByTime: true, timeField: 'createdAt', now: NOW });
    const headers = items.filter(i => i.kind === 'header');
    expect(headers.map(h => h.kind === 'header' && h.bucketKey)).toEqual(['today', 'week', 'earlier']);
    const todayHeader = headers.find(h => h.kind === 'header' && h.bucketKey === 'today');
    expect(todayHeader && todayHeader.kind === 'header' && todayHeader.count).toBe(2);
    // 顺序：今天头 → t1 → t2 → 本周头 → w1 → 更早头 → o1
    expect(items.map(i => i.kind === 'header' ? `#${i.bucketKey}` : i.entry.id))
      .toEqual(['#today', 't1', 't2', '#week', 'w1', '#earlier', 'o1']);
  });

  it('文件夹不参与时间分组，且会重置桶边界（文件夹后首个文件重新出头）', () => {
    const roots = [
      entry('f1', '', { isFolder: true }),
      entry('a', new Date(NOW).toISOString()),
      entry('f2', '', { isFolder: true }),
      entry('b', new Date(NOW).toISOString()), // 同为今天，但被文件夹打断 → 需重新出"今天"头
    ];
    const items = buildDisplayItems(roots, { groupByTime: true, timeField: 'createdAt', now: NOW });
    expect(items.map(i => i.kind === 'header' ? `#${i.bucketKey}` : i.entry.id))
      .toEqual(['f1', '#today', 'a', 'f2', '#today', 'b']);
    // 被文件夹拆成两段的"今天"头各自只数本段（各 1），不是全库总数（2）——防回归
    const todayCounts = items
      .filter(i => i.kind === 'header' && i.bucketKey === 'today')
      .map(i => (i.kind === 'header' ? i.count : -1));
    expect(todayCounts).toEqual([1, 1]);
  });
});
