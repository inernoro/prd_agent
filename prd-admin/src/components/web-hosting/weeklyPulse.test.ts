import { describe, expect, it } from 'vitest';
import { buildWeeklyPulse } from './weeklyPulse';
import type { HostedSite, ShareLinkItem } from '@/services/real/webPages';

const NOW = new Date('2026-08-21T00:00:00.000Z').getTime();

function site(over: Partial<HostedSite> = {}): HostedSite {
  return {
    id: 's1',
    title: '站点',
    sourceType: 'upload',
    cosPrefix: 'p/',
    entryFile: 'index.html',
    siteUrl: 'https://x/',
    pdfAssetUrl: undefined,
    files: [],
    totalSize: 1024,
    tags: [],
    ownerUserId: 'u1',
    viewCount: 0,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...over,
  };
}

function link(over: Partial<ShareLinkItem> = {}): ShareLinkItem {
  return {
    id: 'l1',
    token: 't1',
    siteIds: [],
    siteId: 's1',
    shareType: 'single',
    accessLevel: 'public',
    viewCount: 0,
    createdBy: 'u1',
    createdAt: '2026-08-20T00:00:00.000Z',
    isRevoked: false,
    ...over,
  };
}

describe('本周分享动态', () => {
  it('三条动态各挂一个语义色，顺序固定：新增站点 → 新建链接 → 即将过期', () => {
    const items = buildWeeklyPulse(
      [site(), site({ id: 's2' })],
      [link(), link({ id: 'l2', expiresAt: '2026-08-24T00:00:00.000Z' })],
      NOW,
    );
    expect(items.map((i) => i.tone)).toEqual(['success', 'violet', 'warn']);
    expect(items.map((i) => i.text)).toEqual([
      '本周新增 2 个站点',
      '本周新建 2 条分享链接',
      '1 条链接 3 天后过期',
    ]);
  });

  it('窗口外的站点与链接不算「本周」', () => {
    const old = '2026-07-01T00:00:00.000Z';
    expect(buildWeeklyPulse([site({ createdAt: old })], [link({ createdAt: old })], NOW)).toEqual([]);
  });

  it('已撤销的链接既不算新建也不算即将过期', () => {
    const items = buildWeeklyPulse([], [link({ isRevoked: true, expiresAt: '2026-08-23T00:00:00.000Z' })], NOW);
    expect(items).toEqual([]);
  });

  it('过期时间已经过去的链接不会倒着报「还剩几天」', () => {
    const items = buildWeeklyPulse([], [link({ createdAt: '2026-07-01T00:00:00.000Z', expiresAt: '2026-08-19T00:00:00.000Z' })], NOW);
    expect(items).toEqual([]);
  });

  it('什么都没发生时返回空数组，让调用方决定要不要显示这一节（不摆一个全 0 的板）', () => {
    expect(buildWeeklyPulse([], [], NOW)).toEqual([]);
  });
});
