import { describe, expect, it } from 'vitest';
import { isLiveShareLink, pickScopeShareLinks, upsertShareLink } from '../shareScope';
import type { DocumentStoreShareLink } from '@/services/contracts/documentStore';

const NOW = new Date('2026-07-31T00:00:00Z').getTime();

function link(patch: Partial<DocumentStoreShareLink> & { id: string }): DocumentStoreShareLink {
  return {
    token: `tok-${patch.id}`,
    storeId: 'store-1',
    storeName: '知识库',
    viewCount: 0,
    createdBy: 'u1',
    createdAt: '2026-07-30T00:00:00Z',
    isRevoked: false,
    ...patch,
  };
}

describe('isLiveShareLink', () => {
  it('撤销的链接不再生效', () => {
    expect(isLiveShareLink(link({ id: 'a', isRevoked: true }), NOW)).toBe(false);
  });

  it('过期的链接不再生效，未到期的仍生效', () => {
    expect(isLiveShareLink(link({ id: 'a', expiresAt: '2026-07-30T00:00:00Z' }), NOW)).toBe(false);
    expect(isLiveShareLink(link({ id: 'b', expiresAt: '2026-08-30T00:00:00Z' }), NOW)).toBe(true);
  });

  it('没有过期时间 = 永不过期', () => {
    expect(isLiveShareLink(link({ id: 'a' }), NOW)).toBe(true);
  });
});

describe('pickScopeShareLinks — 分享范围不许串台', () => {
  const links = [
    link({ id: 'store-link' }),
    link({ id: 'entry-link', entryId: 'e1', entryTitle: '第一篇' }),
    link({ id: 'other-entry-link', entryId: 'e2', entryTitle: '第二篇' }),
    link({ id: 'revoked-store-link', isRevoked: true }),
  ];

  it('整库范围只拿整库链接，绝不混入单篇链接', () => {
    const picked = pickScopeShareLinks(links, undefined, NOW);
    expect(picked.map(l => l.id)).toEqual(['store-link']);
  });

  it('单篇范围只拿指向这一篇的链接，不把整库链接当成本篇的', () => {
    // 这正是「我分享单个，结果整个知识库都暴露了」的成因：范围判定必须带 entryId
    const picked = pickScopeShareLinks(links, 'e1', NOW);
    expect(picked.map(l => l.id)).toEqual(['entry-link']);
  });

  it('该范围没有生效链接时返回空，让弹窗落到「生成链接」态', () => {
    expect(pickScopeShareLinks([link({ id: 'x', isRevoked: true })], undefined, NOW)).toEqual([]);
  });
});

describe('upsertShareLink — 后端复用旧链接时不许多出一行', () => {
  it('同 id 视为同一条，替换而非追加', () => {
    const existing = [link({ id: 'a', viewCount: 1 }), link({ id: 'b' })];
    const reused = link({ id: 'a', viewCount: 9 });
    const next = upsertShareLink(existing, reused);
    expect(next).toHaveLength(2);
    expect(next.filter(l => l.id === 'a')).toHaveLength(1);
    expect(next[0].viewCount).toBe(9);
  });

  it('新 id 正常插到最前', () => {
    const next = upsertShareLink([link({ id: 'a' })], link({ id: 'c' }));
    expect(next.map(l => l.id)).toEqual(['c', 'a']);
  });
});
