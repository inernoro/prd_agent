import { describe, expect, it } from 'vitest';
import { getWeekStart, groupGitHubLogsByWeek } from '../groupGitHubLogsByWeek';
import type { GitHubLogEntry } from '@/services/real/changelog';

function makeLog(sha: string, commitTimeUtc: string): GitHubLogEntry {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    message: `commit ${sha}`,
    authorName: 'tester',
    commitTimeUtc,
    htmlUrl: `https://github.com/x/y/commit/${sha}`,
  };
}

describe('getWeekStart', () => {
  it('周三归到本周一', () => {
    // 2026-06-10 是周三
    const d = getWeekStart(new Date(2026, 5, 10, 15, 30));
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5);
    expect(d.getDate()).toBe(8); // 2026-06-08 周一
  });

  it('周一归到自己，周日归到本周一', () => {
    expect(getWeekStart(new Date(2026, 5, 8)).getDate()).toBe(8);
    expect(getWeekStart(new Date(2026, 5, 14)).getDate()).toBe(8);
  });
});

describe('groupGitHubLogsByWeek', () => {
  const now = new Date(2026, 5, 10, 12, 0); // 2026-06-10 周三

  it('按自然周分组并按周倒序输出', () => {
    const logs = [
      makeLog('a1', new Date(2026, 5, 10, 9).toISOString()), // 本周
      makeLog('a2', new Date(2026, 5, 8, 9).toISOString()),  // 本周一
      makeLog('b1', new Date(2026, 5, 5, 9).toISOString()),  // 上周五
      makeLog('c1', new Date(2026, 4, 20, 9).toISOString()), // 更早
    ];
    const groups = groupGitHubLogsByWeek(logs, now);
    expect(groups).toHaveLength(3);
    expect(groups[0].weekStart).toBe('2026-06-08');
    expect(groups[0].logs.map((l) => l.sha)).toEqual(['a1', 'a2']);
    expect(groups[1].weekStart).toBe('2026-06-01');
    expect(groups[2].weekStart).toBe('2026-05-18');
  });

  it('本周/上周带语义化标签，更早的只给日期范围', () => {
    const logs = [
      makeLog('a', new Date(2026, 5, 9).toISOString()),
      makeLog('b', new Date(2026, 5, 3).toISOString()),
      makeLog('c', new Date(2026, 4, 20).toISOString()),
    ];
    const [thisWeek, lastWeek, older] = groupGitHubLogsByWeek(logs, now);
    expect(thisWeek.label.startsWith('本周')).toBe(true);
    expect(lastWeek.label.startsWith('上周')).toBe(true);
    expect(older.label).toBe('5.18 - 5.24');
  });

  it('跨年周范围带年份', () => {
    const logs = [makeLog('z', new Date(2025, 11, 30).toISOString())];
    const [group] = groupGitHubLogsByWeek(logs, now);
    expect(group.label).toContain('2025.12.29');
  });

  it('无效时间的记录被跳过', () => {
    const logs = [makeLog('bad', 'not-a-date'), makeLog('ok', new Date(2026, 5, 9).toISOString())];
    const groups = groupGitHubLogsByWeek(logs, now);
    expect(groups).toHaveLength(1);
    expect(groups[0].logs).toHaveLength(1);
  });
});
