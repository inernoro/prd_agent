import type { ShareLinkItem } from '@/services/real/webPages';
import { daysUntil } from './siteConclusion';
import { isLinkExpired } from './shareStatus';

/**
 * 分享档的三层账本 —— 有效 / 已过期 / 已撤销。
 *
 * 三层必须分明，因为三者能做的事完全不同：有效的可以续期、可以撤销；
 * 过期的内容还在、续期即复活；撤销的不可逆，只能重新分享。
 * 旧版把它们混在一个列表里按时间排，用户分不清哪条还活着。
 */
export type ShareTier = 'active' | 'expired' | 'revoked';

export interface ShareLedger {
  active: ShareLinkItem[];
  expired: ShareLinkItem[];
  revoked: ShareLinkItem[];
}

/** 撤销优先于过期：一条既撤销又过期的链接，用户能做的只有「重新分享」。 */
export function tierOf(link: ShareLinkItem, now: number = Date.now()): ShareTier {
  if (link.isRevoked) return 'revoked';
  if (isLinkExpired(link, now)) return 'expired';
  return 'active';
}

/** `now` 必须能被注入：排序与结论句读同一个时钟，否则两者会对同一批链接给出互相矛盾的
 *  「谁最急」——测试注入固定时刻、排序却偷偷读真实时钟，正是这种漂移
 *  （`.claude/rules/predicate-and-wiring-discipline.md` 形状 6：判据读的不是真正生效的那个值）。 */
export function buildShareLedger(links: ShareLinkItem[], now: number = Date.now()): ShareLedger {
  const ledger: ShareLedger = { active: [], expired: [], revoked: [] };
  for (const l of links) ledger[tierOf(l, now)].push(l);
  // 有效层按「快到期的排前面」——用户在这一屏最该先处理的就是快断的链接
  ledger.active.sort((a, b) => {
    const da = daysUntil(a.expiresAt, now);
    const db = daysUntil(b.expiresAt, now);
    if (da === null && db === null) return b.viewCount - a.viewCount;
    if (da === null) return 1; // 永久链排后面
    if (db === null) return -1;
    return da - db;
  });
  ledger.expired.sort((a, b) => (b.expiresAt ?? '').localeCompare(a.expiresAt ?? ''));
  // 撤销层按撤销时刻排（刚撤的在上面）；存量没有 revokedAt 的退回创建时间
  ledger.revoked.sort((a, b) =>
    (b.revokedAt ?? b.createdAt ?? '').localeCompare(a.revokedAt ?? a.createdAt ?? ''));
  return ledger;
}

export interface LedgerSegment {
  text: string;
  tone?: 'plain' | 'strong' | 'warn';
  /** 有值 = 这段数字可点，点了筛到哪一层 */
  drillTo?: ShareTier;
}

/**
 * 分享档顶部的结论句。
 *
 * 判据与顶栏「分享 N」那个数字必须同源：**有效 = 未过期且未撤销**。
 * 两处口径不一致时用户会以为界面在骗他。
 *
 * 只用链接自带的真实字段（条数、累计访问、到期时间、最后访问）。
 * 「近 7 天 / 多少位访客」需要访问日志聚合，这一屏拿不到，就不写。
 */
export function buildLedgerConclusion(links: ShareLinkItem[], now: number = Date.now()): LedgerSegment[] {
  const ledger = buildShareLedger(links, now);
  const active = ledger.active;

  if (active.length === 0) {
    return links.length === 0
      ? [{ text: '你还没有创建过任何分享链接。想让别人打开某个站点，从站点卡片上的「分享」开始。' }]
      : [
          { text: '你名下已经没有生效中的链接了——' },
          { text: `${ledger.expired.length} 条已过期`, drillTo: 'expired', tone: 'warn' },
          { text: `、${ledger.revoked.length} 条已撤销`, drillTo: 'revoked' },
          { text: '。过期的内容还在，续期即可复活。' },
        ];
  }

  const views = active.reduce((sum, l) => sum + (l.viewCount ?? 0), 0);
  const expiringSoon = active
    .map((l) => ({ link: l, days: daysUntil(l.expiresAt, now) }))
    .filter((x): x is { link: ShareLinkItem; days: number } => x.days !== null && x.days <= 7);
  const hottest = [...active].sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0))[0];

  // uniqueIpCount 是**每条链接各自**去重的 IP 数，跨链接不去重：同一个人打开两条
  // 链接，在两条里各算一次。所以这个和只有在「只有一条有效链接」时才等于人数。
  //
  // 原先这里照样渲染成「N 位访客」，并在注释里自我安慰「措辞是位访客不是个人」——
  // 对读者来说这两个词是一回事，链接一多这个数就明显虚高。数据撑不住的话不能说：
  // 一条链接时说人数，多条时改说「人次」，并点明同一人开多条会重复计。
  const visitors = active.reduce((sum, l) => sum + (l.uniqueIpCount ?? 0), 0);
  const visitorsAreDistinct = active.length === 1;

  const segs: LedgerSegment[] = [
    { text: String(active.length), drillTo: 'active', tone: 'strong' },
    // 设计稿这里写的是「近 7 天带来 N 次访问」，但这一屏只有 viewCount（累计值），
    // 近 7 天要访问日志聚合、分享档主屏拿不到。不把累计冒充成近 7 天，改说「累计」。
    { text: ' 条有效链接累计带来 ' },
    { text: String(views), tone: 'strong' },
    { text: ' 次访问' },
  ];

  if (visitors > 0) {
    segs.push({ text: '、' });
    segs.push({
      text: visitorsAreDistinct ? `${visitors} 位访客` : `${visitors} 人次访客`,
      tone: 'strong',
    });
    if (!visitorsAreDistinct) segs.push({ text: '（同一人开多条链接会重复计）' });
  }

  if (expiringSoon.length > 0) {
    const soonest = expiringSoon[0];
    segs.push({ text: '；其中 ' });
    segs.push({ text: `${expiringSoon.length} 条 ${soonest.days} 天内到期`, drillTo: 'active', tone: 'warn' });
    // 快到期而且还在被打开的那条，是最该先续的
    if ((soonest.link.viewCount ?? 0) > 0) {
      segs.push({ text: `，「${soonest.link.title || '未命名链接'}」还在被打开——先续这条。` });
    } else {
      segs.push({ text: '。' });
    }
  } else if (hottest && (hottest.viewCount ?? 0) > 0) {
    segs.push({ text: `，其中「${hottest.title || '未命名链接'}」占了 ` });
    segs.push({ text: String(hottest.viewCount), tone: 'strong' });
    segs.push({ text: ' 次。' });
  } else {
    segs.push({ text: '，但还没有人打开过。' });
  }

  return segs;
}

/**
 * 按关键词过滤，空关键词原样返回。
 *
 * 搜的必须是**用户看得见的那几个字**：行里「指向的站点」一列显示的是站点名，
 * 输入框也承诺「搜索链接或站点」，而这里原先只比 title / token / 短链号——
 * 于是照着屏幕上的站点名去搜，明明那一行就在眼前，结果却是空的。
 *
 * 所以站点名不自己另取一个值，而是把行里那个标签解析器传进来（siteTitles[0]，
 * 拿不到才回退本页 sites）：显示什么就搜什么，两边不会各自漂。
 * siteTitles 整份也一起纳入——合集行的标签是「合集 · N 个站点」，
 * 但用户很可能是照着其中某个成员站的名字来搜的。
 */
export function filterShareLinks(
  links: ShareLinkItem[],
  keyword: string,
  labelOf?: (l: ShareLinkItem) => string,
): ShareLinkItem[] {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return links;
  return links.filter((l) =>
    [
      l.title,
      l.token,
      l.shortSeq ? String(l.shortSeq) : '',
      labelOf ? labelOf(l) : '',
      ...(l.siteTitles ?? []),
    ]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(kw)),
  );
}
