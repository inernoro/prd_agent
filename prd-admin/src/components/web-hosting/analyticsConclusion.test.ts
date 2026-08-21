import { describe, expect, it } from 'vitest';
import { buildAnalyticsConclusion, buildViewersConclusion } from './analyticsConclusion';
import type { ShareAnalyticsResult } from '@/services/real/webPages';

function data(over: Partial<ShareAnalyticsResult> = {}): ShareAnalyticsResult {
  return {
    totalShares: 3,
    activeShares: 2,
    expiredShares: 0,
    totalViews: 0,
    uniqueIpCount: 0,
    timeline: [],
    topLinks: [],
    ...over,
  };
}

const text = (d: ShareAnalyticsResult, days = 7) => buildAnalyticsConclusion(d, days).map((s) => s.text).join('');

describe('数据抽屉结论句', () => {
  it('没有生效链接时先说清「所以这里不会有数据」', () => {
    expect(text(data({ activeShares: 0 }))).toContain('没有生效中的链接');
  });

  it('有链接但零访问时给下一步，而不是摆一排 0', () => {
    const t = text(data({ activeShares: 2 }));
    expect(t).toContain('近 7 天没有人打开过');
    expect(t).toContain('2 条链接还生效着');
    expect(t).toContain('以访客身份预览');
  });

  it('把访问数与独立访客合成一句，并点破「同一批人反复看」', () => {
    const t = text(data({ totalViews: 132, uniqueIpCount: 3 }));
    expect(t).toContain('近 7 天 132 次访问来自 3 位独立访客');
    expect(t).toContain('平均每人看了 44 次');
  });

  it('人均不到三次就不说平均，免得把正常分布说成异常', () => {
    expect(text(data({ totalViews: 10, uniqueIpCount: 8 }))).not.toContain('平均每人');
  });

  it('单条链接占了一半以上流量时点名它', () => {
    const t = text(
      data({
        totalViews: 100,
        uniqueIpCount: 10,
        topLinks: [{ shareId: 'a', token: 't', title: '客户验收', viewCount: 78, uniqueIpCount: 4, createdAt: '', visibility: 'public' }],
      }),
    );
    expect(t).toContain('「客户验收」一条就占了 78%');
  });

  it('占比不到一半就不点名，避免把平均分布说成集中', () => {
    const t = text(
      data({
        totalViews: 100,
        uniqueIpCount: 10,
        topLinks: [{ shareId: 'a', token: 't', title: '客户验收', viewCount: 30, uniqueIpCount: 4, createdAt: '', visibility: 'public' }],
      }),
    );
    expect(t).not.toContain('一条就占了');
  });

  it('有过期链接时提示可续期复活', () => {
    const t = text(data({ totalViews: 12, uniqueIpCount: 2, expiredShares: 2 }));
    expect(t).toContain('另有 2 条已过期');
    expect(t).toContain('续期即可复活');
  });

  it('时间窗跟着用户选的档走，不写死 7 天', () => {
    expect(text(data({ totalViews: 5, uniqueIpCount: 1 }), 30)).toContain('近 30 天');
    expect(text(data({ totalViews: 5, uniqueIpCount: 1 }), 90)).toContain('近 90 天');
  });
});

const vtext = (a: Parameters<typeof buildViewersConclusion>[0]) =>
  buildViewersConclusion(a).map((s) => s.text).join('');

describe('访客抽屉结论句', () => {
  it('没人打开过时说清下一步，不写「暂无记录」', () => {
    const t = vtext({ totalViews: 0, uniqueViewers: 0, namedViewers: 0, siteTitle: 'X' });
    expect(t).toContain('还没有人打开过');
    expect(t).not.toContain('暂无');
  });

  it('全是匿名访客时告诉用户怎么才能拿到名单', () => {
    const t = vtext({ totalViews: 23, uniqueViewers: 5, namedViewers: 0, siteTitle: 'X' });
    expect(t).toContain('这些访客都是匿名的');
    expect(t).toContain('登录可见');
  });

  it('部分实名时说清有几位认得出', () => {
    const t = vtext({ totalViews: 42, uniqueViewers: 6, namedViewers: 2, siteTitle: 'X' });
    expect(t).toContain('其中 2 位能认出身份');
  });

  it('全部实名时直接给名单', () => {
    const t = vtext({ totalViews: 42, uniqueViewers: 3, namedViewers: 3, siteTitle: 'X' });
    expect(t).toContain('都是登录访客');
  });
});
