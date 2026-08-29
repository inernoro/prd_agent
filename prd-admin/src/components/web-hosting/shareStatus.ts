import type { ShareLinkItem } from '@/services/real/webPages';

/**
 * 一条分享链接此刻处于什么状态——**全站唯一判据**。
 *
 * 单独一个文件是为了避开循环依赖：分享档（shareLedger）要用它，站点结论句
 * （siteConclusion）也要用它，而前者本来就 import 后者的 daysUntil。判据放在
 * 任何一边都会让两个模块互指。
 */

/**
 * 一条链接**此刻**是否已过期。全站唯一判据。
 *
 * 不能只读服务端那个 `isExpired`：它是**上一次请求返回时**的结论，面板开着不动它不会
 * 自己翻。到期时刻一过，一条死链仍被算进「有效」——顶栏的分享数、结论句里的
 * 「N 条有效链接」、复制按钮、站点卡上的已分享标记会一起错，直到用户刷新为止。
 *
 * 判据与服务端逐字同口径（`ExpiresAt.HasValue && ExpiresAt < now`），只是把时钟换成
 * 传进来的这个：同一批数据在前后端不会给出两种答案。没有 expiresAt（永久链）或时间串
 * 解析不出来时，退回服务端那个快照兜底。
 *
 * 宽限期（inGracePeriod）是「过期了但还能续」，服务端也把它算作已过期，这里不另作处理。
 */
export function isLinkExpired(link: ShareLinkItem, now: number = Date.now()): boolean {
  if (link.expiresAt) {
    const t = new Date(link.expiresAt).getTime();
    if (!Number.isNaN(t)) return t < now;
  }
  return link.isExpired === true;
}

/**
 * 有效 = 未撤销且未过期。
 *
 * 这句判断此前散在六处（分享档三层、结论句、站点面板两处、首页顶栏计数、周报），
 * 每处都写成 `!l.isRevoked && !l.isExpired`。判据分裂就会漂移——事实上这次要改的
 * 「过期看时钟而不是看快照」，就得同时改六个地方才不会一半新一半旧
 * （predicate-and-wiring-discipline 形状 3）。所以收敛到这一个函数。
 */
export function isLinkActive(link: ShareLinkItem, now: number = Date.now()): boolean {
  return !link.isRevoked && !isLinkExpired(link, now);
}
