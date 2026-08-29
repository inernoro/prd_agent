import type { ShareLinkItem } from '@/services/real/webPages';
import { isLinkActive } from './shareStatus';

/** 结论句的一段：纯文本，或一个挂着数字、可点进明细的片段 */
export interface ConclusionSegment {
  text: string;
  /** 有值 = 这段是个可点的数字，点了去哪儿 */
  drillTo?: 'shares' | 'analytics';
  /** 强调档：warn 用于「快过期了」这类要人现在就处理的事；info 是链接条数那一档 */
  tone?: 'plain' | 'strong' | 'warn' | 'info';
  /** true = 设计稿里那种放大一档的 display 数字（16px Space Grotesk），不是行内加粗 */
  numeric?: boolean;
}

export interface SiteConclusion {
  segments: ConclusionSegment[];
  /** 没有任何链接时的引导态：此时结论句退化成一句「还没分享出去」+ 主操作 */
  empty: boolean;
}

const DAY = 24 * 60 * 60 * 1000;

/** 还剩几天到期；已过期或没有过期时间返回 null */
export function daysUntil(iso: string | undefined, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t) || t <= now) return null;
  return Math.ceil((t - now) / DAY);
}

/**
 * 把一个站点的分享链接聚合成**一句挂着数字的判断**。
 *
 * 为什么不是直接摆四个数字：面板第一行的职责是让人三秒内知道「所以呢」。
 * 「2 条有效链接 · 132 次访问 · 3 位访客 · 剩 3 天」是四个要读者自己去比对的数，
 * 「有 2 条有效链接，其中 1 条 3 天后过期，先续这条」才是能直接行动的结论。
 *
 * 只用真实拿得到的数据：链接条数、累计访问、访客数、最近的到期时间。
 *
 * 与设计稿的一处刻意偏差：稿子写「近 7 天 132 次访问集中在 3 位访客」，而列表接口给的
 * 访问数与访客数都是**累计**口径（`visitors` 走的是 distinct viewer 聚合，没有时间窗），
 * 所以这里写「累计」。按 7 天窗口重写这句需要后端按天分桶，属于后续项——
 * 宁可换个准确的限定词，也不照抄一个我们算不出来的窗口（no-rootless-tree）。
 */
export function buildSiteConclusion(
  links: ShareLinkItem[],
  now: number = Date.now(),
  /** 该站点的去重访客数（页面从列表接口的 visitors 映射取）；拿不到就不写这半句 */
  visitorCount?: number,
): SiteConclusion {
  const active = links.filter((l) => isLinkActive(l, now));
  if (active.length === 0) {
    const hadLinks = links.length > 0;
    return {
      empty: true,
      segments: [
        {
          text: hadLinks
            ? '这个站点的链接都已过期或撤销，现在没有人能打开它。'
            : '这个站点还没分享出去过，只有你自己能看到。',
        },
      ],
    };
  }

  const views = active.reduce((sum, l) => sum + (l.viewCount ?? 0), 0);
  const soon = active
    .map((l) => ({ link: l, days: daysUntil(l.expiresAt, now) }))
    .filter((x): x is { link: ShareLinkItem; days: number } => x.days !== null && x.days <= 7)
    .sort((a, b) => a.days - b.days);
  const lastViewedAt = active
    .map((l) => l.lastViewedAt)
    .filter((v): v is string => Boolean(v))
    .sort()
    .pop();

  const segments: ConclusionSegment[] = [
    { text: '这个站点有 ' },
    { text: String(active.length), drillTo: 'shares', tone: 'info', numeric: true },
    { text: ' 条有效链接' },
  ];

  if (soon.length > 0) {
    segments.push({ text: `，其中 ${soon.length} 条 ` });
    segments.push({ text: `${soon[0].days} 天后过期`, drillTo: 'shares', tone: 'warn' });
  }

  if (views === 0) {
    segments.push({ text: '；还没有人打开过。' });
    return { segments, empty: false };
  }

  segments.push({ text: '；累计 ' });
  segments.push({ text: String(views), drillTo: 'analytics', tone: 'strong', numeric: true });
  segments.push({ text: ' 次访问' });
  if (typeof visitorCount === 'number' && visitorCount > 0) {
    segments.push({ text: ' 来自 ' });
    segments.push({ text: String(visitorCount), drillTo: 'analytics', tone: 'strong', numeric: true });
    segments.push({ text: ' 位访客。' });
  } else {
    segments.push({ text: lastViewedAt ? '，最近一次刚打开过。' : '。' });
  }

  return { segments, empty: false };
}

/** 取出这个站点名下的链接（含合集链接——合集对该站点同样是一条对外入口） */
export function linksOfSite(links: ShareLinkItem[], siteId: string): ShareLinkItem[] {
  return links.filter((l) => (l.siteId ? l.siteId === siteId : (l.siteIds ?? []).includes(siteId)));
}
