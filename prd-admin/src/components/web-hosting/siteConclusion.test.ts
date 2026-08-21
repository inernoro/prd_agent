import { describe, expect, it } from 'vitest';
import { buildSiteConclusion, daysUntil, linksOfSite } from './siteConclusion';
import type { ShareLinkItem } from '@/services/real/webPages';

const NOW = new Date('2026-08-21T00:00:00.000Z').getTime();

function link(over: Partial<ShareLinkItem> = {}): ShareLinkItem {
  return {
    id: 'l1',
    token: 't1',
    siteIds: [],
    siteId: 'site-1',
    shareType: 'single',
    accessLevel: 'public',
    viewCount: 0,
    createdBy: 'u1',
    createdAt: '2026-08-01T00:00:00.000Z',
    isRevoked: false,
    ...over,
  };
}

function text(links: ShareLinkItem[]): string {
  return buildSiteConclusion(links, NOW).segments.map((s) => s.text).join('');
}

describe('站点结论句', () => {
  it('没有任何链接时说清「只有你自己能看到」，而不是显示 0', () => {
    const c = buildSiteConclusion([], NOW);
    expect(c.empty).toBe(true);
    expect(text([])).toContain('还没分享出去过');
    expect(text([])).not.toContain('0 条');
  });

  it('链接全部过期或撤销时，结论是「现在没人能打开」而不是「有 N 条」', () => {
    const links = [link({ isExpired: true }), link({ id: 'l2', isRevoked: true })];
    const c = buildSiteConclusion(links, NOW);
    expect(c.empty).toBe(true);
    expect(text(links)).toContain('都已过期或撤销');
  });

  it('把条数与累计访问合成一句判断，数字可点进明细', () => {
    const links = [link({ viewCount: 98 }), link({ id: 'l2', viewCount: 34 })];
    expect(text(links)).toContain('有 2 条有效链接');
    expect(text(links)).toContain('累计带来 132 次访问');

    const drills = buildSiteConclusion(links, NOW).segments.filter((s) => s.drillTo);
    expect(drills.map((s) => s.drillTo)).toEqual(['shares', 'analytics']);
  });

  it('七天内到期的链接必须出现在结论里并标成警告色', () => {
    const links = [
      link({ viewCount: 10, expiresAt: '2026-09-30T00:00:00.000Z' }),
      link({ id: 'l2', viewCount: 1, expiresAt: '2026-08-24T00:00:00.000Z' }),
    ];
    expect(text(links)).toContain('其中最早的 3 天后过期');
    const warn = buildSiteConclusion(links, NOW).segments.find((s) => s.tone === 'warn');
    expect(warn?.text).toBe('3 天后过期');
  });

  it('还很久才到期就不提到期，免得每条链接都在喊「快过期了」', () => {
    const links = [link({ viewCount: 5, expiresAt: '2026-12-01T00:00:00.000Z' })];
    expect(text(links)).not.toContain('过期');
  });

  it('没人打开过要如实说，不能含糊成「最近一次刚打开过」', () => {
    expect(text([link({ viewCount: 0 })])).toContain('还没有人打开过');
    expect(text([link({ viewCount: 3, lastViewedAt: '2026-08-20T10:00:00.000Z' })])).toContain('最近一次刚打开过');
  });

  it('合集链接对它命中的每个站点都算一条对外入口', () => {
    const links = [
      link({ id: 'c1', siteId: undefined, shareType: 'collection', siteIds: ['site-1', 'site-2'] }),
      link({ id: 's1', siteId: 'site-2' }),
    ];
    expect(linksOfSite(links, 'site-1').map((l) => l.id)).toEqual(['c1']);
    expect(linksOfSite(links, 'site-2').map((l) => l.id)).toEqual(['c1', 's1']);
  });

  it('已经过期的时间不算「还剩几天」', () => {
    expect(daysUntil('2026-08-20T00:00:00.000Z', NOW)).toBeNull();
    expect(daysUntil(undefined, NOW)).toBeNull();
    expect(daysUntil('2026-08-23T00:00:00.000Z', NOW)).toBe(2);
  });
});
