import type { GitHubLogEntry } from '@/services/real/changelog';

export interface GitHubLogWeekGroup {
  /** 该周周一日期（本地时区）YYYY-MM-DD，分组 key */
  weekStart: string;
  /** 该周周日日期 YYYY-MM-DD */
  weekEnd: string;
  /** 展示标签：本周 / 上周 / 日期范围 */
  label: string;
  logs: GitHubLogEntry[];
}

function formatDateKey(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 给定任意时刻，返回其所在周的周一 0 点（本地时区，周一为一周起点） */
export function getWeekStart(date: Date): Date {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offset = (monday.getDay() + 6) % 7; // 周一=0 … 周日=6
  monday.setDate(monday.getDate() - offset);
  return monday;
}

function formatRangeLabel(start: Date, end: Date, now: Date): string {
  const withYear = start.getFullYear() !== now.getFullYear();
  const fmt = (d: Date) => (withYear
    ? `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`
    : `${d.getMonth() + 1}.${d.getDate()}`);
  return `${fmt(start)} - ${fmt(end)}`;
}

/**
 * 把 GitHub 提交按「自然周（周一起）」分组。
 * 输入应已按时间倒序；输出组按周起始日期倒序，组内保持输入顺序。
 * 本周 / 上周给语义化标签，其余给日期范围（跨年带年份）。
 */
export function groupGitHubLogsByWeek(
  logs: GitHubLogEntry[],
  now: Date = new Date(),
): GitHubLogWeekGroup[] {
  const byKey = new Map<string, GitHubLogWeekGroup>();
  const thisWeekStart = getWeekStart(now);
  const thisWeekKey = formatDateKey(thisWeekStart);
  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  const lastWeekKey = formatDateKey(lastWeekStart);

  for (const log of logs) {
    const t = new Date(log.commitTimeUtc);
    if (Number.isNaN(t.getTime())) continue;
    const start = getWeekStart(t);
    const key = formatDateKey(start);
    let group = byKey.get(key);
    if (!group) {
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      const range = formatRangeLabel(start, end, now);
      const label = key === thisWeekKey
        ? `本周 ${range}`
        : key === lastWeekKey
          ? `上周 ${range}`
          : range;
      group = { weekStart: key, weekEnd: formatDateKey(end), label, logs: [] };
      byKey.set(key, group);
    }
    group.logs.push(log);
  }

  return Array.from(byKey.values()).sort((a, b) => b.weekStart.localeCompare(a.weekStart));
}
