/**
 * 「最近」时间线的分组判据（纯函数，单测覆盖）。
 *
 * 为什么要分组：一条平铺的时间线回答不了「刚刚那篇在不在里面」——
 * 用户扫的是「今天」那一段，看到「今天」里没有才会往下找。
 * 分组边界按**自然日**算，不按「距今 24 小时」：晚上 11 点存的东西，
 * 第二天早上 9 点应该出现在「昨天」，而不是还在「今天」。
 */
import type { RecentDocumentEntry } from '@/services/contracts/documentStore';

export type RecentGroupKey = 'today' | 'yesterday' | 'earlier';

export const RECENT_GROUP_LABELS: Record<RecentGroupKey, string> = {
  today: '今天',
  yesterday: '昨天',
  earlier: '更早',
};

export type RecentEntryGroup = {
  key: RecentGroupKey;
  label: string;
  items: RecentDocumentEntry[];
};

/** 本地时区的「同一个自然日」判定；跨时区/跨夏令时都由 Date 自己处理。 */
function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

export function recentGroupKeyOf(updatedAt: string, now: Date = new Date()): RecentGroupKey {
  const at = new Date(updatedAt);
  // 时间戳解析不出来时归到「更早」：宁可排在后面，也不要伪装成刚刚发生
  if (Number.isNaN(at.getTime())) return 'earlier';
  if (isSameLocalDay(at, now)) return 'today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameLocalDay(at, yesterday)) return 'yesterday';
  return 'earlier';
}

/**
 * 按自然日分组，保留后端给的时间倒序（后端已按 UpdatedAt 降序返回）。
 * 空组不产出——「昨天」下面挂零条比没有这一栏更让人以为漏了东西。
 */
export function groupRecentEntries(
  items: RecentDocumentEntry[],
  now: Date = new Date(),
): RecentEntryGroup[] {
  const buckets: Record<RecentGroupKey, RecentDocumentEntry[]> = {
    today: [], yesterday: [], earlier: [],
  };
  for (const item of items) buckets[recentGroupKeyOf(item.updatedAt, now)].push(item);
  return (['today', 'yesterday', 'earlier'] as const)
    .filter(key => buckets[key].length > 0)
    .map(key => ({ key, label: RECENT_GROUP_LABELS[key], items: buckets[key] }));
}
