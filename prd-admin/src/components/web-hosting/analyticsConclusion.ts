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
    segs.push({ text: String(data.uniqueIpCount), tone: 'strong' });
    segs.push({ text: ' 位独立访客' });
    // 人少而访问多 = 同一批人反复看；这是「谁在看」这一屏最该点破的事
    if (data.totalViews >= data.uniqueIpCount * 3) {
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
    segs.push({ text: '，内容还在，续期即可复活。' });
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
  uniqueViewers: number;
  /** 名单里有几条是能认出身份的登录访客 */
  namedViewers: number;
  siteTitle: string;
}): AnalyticsSegment[] {
  const { totalViews, uniqueViewers, namedViewers } = args;

  if (totalViews === 0) {
    return [{ text: '还没有人打开过这个站点。把链接发出去之后，谁在什么时候看了会记在这里。' }];
  }

  const segs: AnalyticsSegment[] = [
    { text: '这个站点被打开过 ' },
    { text: String(totalViews), tone: 'strong' },
    { text: ' 次' },
  ];

  if (uniqueViewers > 0) {
    segs.push({ text: '，来自 ' });
    segs.push({ text: `${uniqueViewers} 位访客`, tone: 'strong' });
  }

  if (namedViewers === 0) {
    segs.push({ text: '。这些访客都是匿名的——想拿到名单，把分享链接的可见性改成「登录可见」。' });
  } else if (namedViewers < uniqueViewers) {
    segs.push({ text: `。其中 ${namedViewers} 位能认出身份，其余是匿名访客（只留脱敏 IP）。` });
  } else {
    segs.push({ text: '，都是登录访客，名单如下。' });
  }

  return segs;
}
