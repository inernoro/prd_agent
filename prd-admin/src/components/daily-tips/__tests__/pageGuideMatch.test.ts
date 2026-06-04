/**
 * filterPageTips / matchPageGuide 页面限定护栏。
 *
 * 根因(用户 2026-06-04 二次反馈「当前页面出现了其他页面的教程」):
 *   filterPageTips 旧实现里 `if (t.isTargeted) return true;` 把**被投递过**的 tip 无条件纳入,
 *   导致 /web-pages、/settings 等别页教程在每个页面的「本页教程」面板里冒出来。
 *   修复:被投递的 tip 若带 actionUrl,与普通教程一样按页面限定;仅无 actionUrl 的纯个人消息才不限页面。
 */
import { describe, expect, it } from 'vitest';
import type { DailyTip } from '@/services/real/dailyTips';
import { filterPageTips, matchPageGuide } from '../pageGuideMatch';

const NONE = new Set<string>();

function tip(partial: Partial<DailyTip> & { id: string; actionUrl: string }): DailyTip {
  return {
    kind: 'card',
    title: partial.id,
    ...partial,
  } as DailyTip;
}

describe('filterPageTips —— 被投递(isTargeted)的页面教程必须按页面限定', () => {
  // 复刻截图场景:两条被投递的别页教程
  const navOrder = tip({
    id: 'nav-order-customize',
    sourceId: 'nav-order-customize',
    actionUrl: '/settings?tab=nav-order',
    isTargeted: true,
    autoAction: { steps: [{ selector: '#a', title: 's' }] },
  });
  const webObservability = tip({
    id: 'web-observability',
    sourceId: 'web-observability-update-2026w22',
    actionUrl: '/web-pages',
    isTargeted: true,
    autoAction: { steps: [{ selector: '#b', title: 's' }] },
  });
  const all = [navOrder, webObservability];

  it('在不相干页面(/document-store)不出现任何别页教程', () => {
    const got = filterPageTips(all, NONE, '/document-store', '');
    expect(got.map((t) => t.id)).toEqual([]);
  });

  it('网页托管教程只在 /web-pages 出现', () => {
    expect(filterPageTips(all, NONE, '/web-pages', '').map((t) => t.id)).toEqual([
      'web-observability',
    ]);
  });

  it('导航排序教程只在 /settings?tab=nav-order 出现(query 必须匹配)', () => {
    expect(filterPageTips(all, NONE, '/settings', '?tab=nav-order').map((t) => t.id)).toEqual([
      'nav-order-customize',
    ]);
    // 同 /settings 但不同 tab → 不出现(否则 account/skin tab 也弹导航排序教程)
    expect(filterPageTips(all, NONE, '/settings', '?tab=account').map((t) => t.id)).toEqual([]);
  });

  it('无 actionUrl 的被投递个人消息(如「为你修复」通知)不限页面,任意页保留', () => {
    const personal = tip({ id: 'fix-notice', actionUrl: '', isTargeted: true });
    expect(filterPageTips([personal], NONE, '/anything', '').map((t) => t.id)).toEqual([
      'fix-notice',
    ]);
  });

  it('已 dismiss 的被投递 tip 不再出现', () => {
    expect(filterPageTips(all, new Set(['web-observability']), '/web-pages', '')).toEqual([]);
  });
});

describe('matchPageGuide —— 仅本页未走完的 *-page-guide 才算「有教程」', () => {
  const guide = tip({
    id: 'webpages-page-guide',
    sourceId: 'webpages-page-guide',
    actionUrl: '/web-pages',
    autoAction: { steps: [{ selector: '#a', title: 's' }] },
  });

  it('本页(/web-pages)命中', () => {
    expect(matchPageGuide([guide], NONE, '/web-pages', '')?.id).toBe('webpages-page-guide');
  });

  it('别页(/literary-agent)不命中', () => {
    expect(matchPageGuide([guide], NONE, '/literary-agent', '')).toBeNull();
  });

  it('已学会(learned)不再算未走完', () => {
    const learned = { ...guide, learned: true };
    expect(matchPageGuide([learned], NONE, '/web-pages', '')).toBeNull();
  });
});
