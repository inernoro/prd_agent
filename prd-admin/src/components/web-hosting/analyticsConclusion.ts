import type { ShareAnalyticsResult } from '@/services/real/webPages';

export interface AnalyticsSegment {
  text: string;
  tone?: 'plain' | 'strong' | 'warn';
}

/**
 * 数据抽屉第一行的判断句（设计稿屏 7「先结论后数字」）。
 *
 * 旧版一进来是五张裸数字卡（活跃链接 / PV / 独立访客 / 评论 / 已过期），
 * 读者得自己把五个数比一遍才知道「所以呢」。这里先给一句能直接行动的结论，
 * 数字卡退到它下面当明细。
 *
 * 只用后端真实返回的字段：totalViews / uniqueIpCount / topLinks / expiredShares /
 * activeShares。任何算不出来的（比如「新访客占比」）就不写。
 */
export function buildAnalyticsConclusion(data: ShareAnalyticsResult, days: number): AnalyticsSegment[] {
  const window = `近 ${days} 天`;

  if (data.totalViews === 0) {
    if (data.activeShares === 0) {
      return [{ text: '你现在没有生效中的链接，所以这个窗口里不会有任何访问。先去建一条链接。' }];
    }
    return [
      { text: `${window}没有人打开过你的链接。` },
      { text: `${data.activeShares} 条链接还生效着`, tone: 'strong' },
      { text: '——把链接和密码发出去，或者用「以访客身份预览」先自己确认一遍它长什么样。' },
    ];
  }

  const segs: AnalyticsSegment[] = [
    { text: `${window} ` },
    { text: String(data.totalViews), tone: 'strong' },
    { text: ' 次访问' },
  ];

  if (data.uniqueIpCount > 0) {
    segs.push({ text: '来自 ' });
    // 样本被截断时这个数只是下界，说成确数就是把「至少 N」讲成「正好 N」
    segs.push({ text: `${data.visitorSampleCapped ? '至少 ' : ''}${data.uniqueIpCount}`, tone: 'strong' });
    segs.push({ text: ' 位独立访客' });
    // 人少而访问多 = 同一批人反复看；这是「谁在看」这一屏最该点破的事。
    // 但 totalViews 是无上限聚合、uniqueIpCount 只在取回的那批日志上去重，
    // 命中上限时两者人口不同，相除会显著高估人均——那种情况下宁可不出这句。
    if (!data.visitorSampleCapped && data.totalViews >= data.uniqueIpCount * 3) {
      segs.push({ text: '，平均每人看了 ' });
      segs.push({ text: `${Math.round(data.totalViews / data.uniqueIpCount)} 次`, tone: 'strong' });
    }
  }

  const top = data.topLinks?.[0];
  if (top && top.viewCount > 0 && data.totalViews > 0) {
    const share = Math.round((top.viewCount / data.totalViews) * 100);
    if (share >= 50) {
      segs.push({ text: `；其中「${top.title || '未命名链接'}」一条就占了 ` });
      segs.push({ text: `${share}%`, tone: 'strong' });
    }
  }

  if (data.expiredShares > 0) {
    segs.push({ text: '。另有 ' });
    segs.push({ text: `${data.expiredShares} 条已过期`, tone: 'warn' });
    // 「续期即可复活」只对未撤销且还在宽限窗内的那批成立——已撤销的和过期太久的，
    // 续期端点会当场拒绝。把救得回来的条数如实分开说，不对救不回来的部分许诺。
    const renewable = data.renewableExpiredShares;
    if (renewable >= data.expiredShares) {
      segs.push({ text: '，内容还在，续期即可复活。' });
    } else if (renewable > 0) {
      segs.push({ text: '，其中 ' });
      segs.push({ text: `${renewable} 条`, tone: 'strong' });
      segs.push({ text: '续期就能复活，其余的已撤销或过期太久，只能新建分享。' });
    } else {
      segs.push({ text: '，都已撤销或过期太久，续期救不回来了，只能新建分享。' });
    }
  } else {
    segs.push({ text: '。' });
  }

  return segs;
}

/**
 * 访客抽屉（屏 8）的判断句：这个站点被谁看过。
 *
 * 三种空态各自不同，不能都写「暂无记录」：
 * 一次都没被打开、只有匿名访客拿不到身份、以及压根还没分享出去。
 */
export function buildViewersConclusion(args: {
  totalViews: number;
  /** 后端在**整个集合**上去重出来的登录访客数（匿名访问 ViewerUserId 为空，不计入） */
  uniqueViewers: number;
  siteTitle: string;
}): AnalyticsSegment[] {
  const { totalViews, uniqueViewers } = args;

  if (totalViews === 0) {
    return [{ text: '还没有人打开过这个站点。把链接发出去之后，谁在什么时候看了会记在这里。' }];
  }

  const segs: AnalyticsSegment[] = [
    { text: '这个站点被打开过 ' },
    { text: String(totalViews), tone: 'strong' },
    { text: ' 次' },
  ];

  // uniqueViewers 是后端在整个集合上去重的**登录**访客数，所以它为 0 才真的等于
  // 「一个登录访客都没有」。曾经这里拿它当总访客数，再减去名单首页（最多 200 条）里
  // 认得出身份的条数，把差额说成「其余是匿名访客」——那个差额其实是分页截断，
  // 按构造他们全都是登录用户。匿名访问有几位后端根本没给，算不出来就不出这句。
  if (uniqueViewers === 0) {
    segs.push({ text: '，都是匿名访客（只留脱敏 IP）——想拿到名单，把分享链接的可见性改成「登录可见」。' });
  } else {
    segs.push({ text: '，其中 ' });
    segs.push({ text: `${uniqueViewers} 位登录访客`, tone: 'strong' });
    segs.push({ text: ' 能认出身份，名单如下。' });
  }

  return segs;
}
