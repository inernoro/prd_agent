import type { HostedSite, ShareLinkItem } from '@/services/real/webPages';
import { daysUntil } from './siteConclusion';

/**
 * 右栏底部的「本周分享动态」——三条一句话的近况，每条前面一个语义色圆点。
 *
 * 口径纪律：**每条都必须是当前列表数据能算出来的事实**。设计稿举的例子里有
 * 「客户方 3 人打开了验收报告」「评审 deck 收到 2 条访客提问」这类句子，需要
 * 按天分桶的访问日志与提问计数——列表接口两样都不给，所以这里换成同样是周窗口、
 * 但真算得出来的三件事，而不是把稿子上的句子照抄成一个编出来的数字
 * （`.claude/rules/no-rootless-tree.md`）。缺的那两个口径记在 debt 台账里。
 */
export type PulseTone = 'success' | 'violet' | 'warn';

export interface PulseItem {
  key: string;
  text: string;
  tone: PulseTone;
}

const DAY = 24 * 60 * 60 * 1000;

/** 落在最近 windowDays 天内（含今天）；时间戳解析不出来一律不算 */
function within(iso: string | undefined, now: number, windowDays: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return !Number.isNaN(t) && t <= now && now - t <= windowDays * DAY;
}

export function buildWeeklyPulse(
  sites: HostedSite[],
  links: ShareLinkItem[],
  now: number = Date.now(),
  windowDays = 7,
): PulseItem[] {
  const items: PulseItem[] = [];

  const newSites = sites.filter((s) => within(s.createdAt, now, windowDays)).length;
  if (newSites > 0) {
    items.push({ key: 'sites', tone: 'success', text: `本周新增 ${newSites} 个站点` });
  }

  const newLinks = links.filter((l) => !l.isRevoked && within(l.createdAt, now, windowDays)).length;
  if (newLinks > 0) {
    items.push({ key: 'links', tone: 'violet', text: `本周新建 ${newLinks} 条分享链接` });
  }

  const soon = links
    .filter((l) => !l.isRevoked && !l.isExpired)
    .map((l) => daysUntil(l.expiresAt, now))
    .filter((d): d is number => d !== null && d <= windowDays)
    .sort((a, b) => a - b);
  if (soon.length > 0) {
    items.push({ key: 'expiring', tone: 'warn', text: `${soon.length} 条链接 ${soon[0]} 天后过期` });
  }

  return items;
}
