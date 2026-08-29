import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { describeQuickShare } from './quickShare';
import type { ShareLinkItem } from '@/services/real/webPages';

const page = readFileSync(new URL('../../pages/ShareViewPage.tsx', import.meta.url), 'utf8');

/**
 * 三条都属于同一族：**拿一个不成立的东西当证据**。
 * 前两条是把「另一档的说法」套到这一档，第三条是把 iframe 的 load 当成「画出来了」。
 */
describe('迟到原文的取舍判据', () => {
  it('不再拿 iframe 的 load 事件当「直链已经画出内容」的证据', () => {
    // 直链白屏时 load 照样触发，用它判就会把唯一能救场的原文丢掉
    expect(page).not.toContain('directLoadedRef');
    expect(page).not.toMatch(/onLoad=\{\(\) => \{\s*\n[^}]*directLoaded/);
  });

  it('改成按已过时间判——它才真的对应「用户攒了多少状态」', () => {
    expect(page).toContain('LATE_SWAP_GUARD_MS');
    expect(page).toMatch(/elapsed > LATE_SWAP_GUARD_MS/);
    expect(page).toContain('fetchStartedAtRef');
  });

  it('每次重新取原文都要重置起点，否则第二次进来一开始就算成迟到', () => {
    expect(page).toContain('fetchStartedAtRef.current = Date.now();');
  });
});

describe('可见性拒绝页要保住后端的区分', () => {
  it('两种策略压成同一个码时，显式保留后端原文', () => {
    // 「登录可见」只是没登录，「仅我和协作者」是团队外真进不去；
    // 注册表只能放一段话，只差登录的访客会被劝退
    expect(page).toContain("failure === 'unknown' || isVisibilityDenied ? error.message : null");
  });
});

describe('一步分享的一句话总结', () => {
  const base = {
    id: 'x', token: 't', siteId: 's', createdAt: new Date().toISOString(),
  } as unknown as ShareLinkItem;

  it('仅我和协作者 + 有密码：不许说「还需要输密码」', () => {
    const text = describeQuickShare(
      { ...base, visibility: 'owner-only', accessLevel: 'password' } as ShareLinkItem);
    // 能进来的人在后端一律免密，进不来的人在密码之前就被挡掉——没人会被密码拦一次
    expect(text).not.toContain('还需要输密码');
    expect(text).toMatch(/协作者/);
  });

  it('登录可见 / 公开 + 有密码：照常说密码', () => {
    for (const v of ['logged-in', 'public'] as const) {
      const text = describeQuickShare(
        { ...base, visibility: v, accessLevel: 'password' } as ShareLinkItem);
      expect(text).toContain('还需要输密码');
    }
  });

  it('没有密码时任何一档都不提密码', () => {
    for (const v of ['owner-only', 'logged-in', 'public'] as const) {
      const text = describeQuickShare(
        { ...base, visibility: v, accessLevel: 'none' } as ShareLinkItem);
      expect(text).not.toContain('密码');
    }
  });
});

describe('迟到的原文不许被丢掉', () => {
  it('超过时间窗只是「不自动换」，原文要留着并给出口', () => {
    // 「该不该换」需要两个都拿不到的答案：直链那一帧画出东西没有（跨源读不了），
    // 以及访客攒了多少状态（滚动发生在那一帧里）。上一版拿 iframe 的 load 当证据是形状 8；
    // 改成按已过时间同样证明不了白屏没白屏——它只是换了一个不成立的证据。
    //
    // 两个判据都不可知时，正确做法是把能救场的原文留在手里、给一个看得见的出口，
    // 而不是替用户猜。直接 return 会让「直链白屏 + 原文迟到」变成一片永远的白，
    // 那正是这条兜底本来要修的页面。
    expect(page).toContain('setLateHtml');
    // 迟到分支里必须是「存起来」而不是空手 return
    const branch = page.slice(
      page.indexOf('if (exposedDirectRef.current && elapsed > LATE_SWAP_GUARD_MS)'),
      page.indexOf('setEmbeddedHtml(ready)'),
    );
    expect(branch).toContain('setLateHtml(ready)');
    // 出口必须真的渲染出来，否则留着也没人点得到（形状 2：链路只建一半）
    expect(page).toMatch(/lateHtml && !iframeHtml/);
    expect(page).toContain('用原文重新加载');
    expect(page).toMatch(/onClick=\{\(\) => \{ setEmbeddedHtml\(lateHtml\); setLateHtml\(null\); \}\}/);
  });

  it('每次重新取原文都要清掉上一轮留下的迟到件', () => {
    // 不清的话，切到另一个站点时会拿着上一份原文的出口，点下去换成别人的内容
    const head = page.slice(page.indexOf('setEmbeddedHtmlError(null);'), page.indexOf('fetchStartedAtRef.current = Date.now();'));
    expect(head).toContain('setLateHtml(null);');
  });
});
