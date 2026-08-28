import { describe, expect, it } from 'vitest';
import {
  normalizeVisibility,
  VISIBILITY_ACCESS_HINT,
  VISIBILITY_LABEL,
  visibilityLabelOf,
} from './shareVisibility';
import { VISIBILITY_HINT, VISIBILITY_LABEL as QUICK_LABEL, resolveVisibility } from './quickShare';

describe('可见性档位的文案不许比后端放行范围更严', () => {
  // 后端 EnforceShareVisibilityAsync 对 owner-only 放行的是「创建者 + 该站点已共享团队的
  // 成员」。文案写成「仅我可见」会让分享者以为同事打不开，照着这个理解发链接就会漏。
  // 这条守的是「说出去的话与真实放行范围一致」，不是某个具体措辞——所以只断言
  // 「不许出现把范围说成只有自己的写法」，换词不会误伤。
  const ONLY_ME_PHRASES = ['仅我可见', '只有我', '仅自己', '只有自己', '仅创建者'];

  it('两套语域的 owner-only 标签都没把范围说成只有自己', () => {
    for (const label of [VISIBILITY_LABEL['owner-only'], QUICK_LABEL['owner-only']]) {
      for (const phrase of ONLY_ME_PHRASES) {
        expect(label).not.toBe(phrase);
      }
    }
  });

  it('owner-only 的说明必须点出协作者也能打开', () => {
    expect(VISIBILITY_ACCESS_HINT['owner-only']).toMatch(/协作者|团队/);
    expect(VISIBILITY_HINT['owner-only']).toMatch(/协作者|团队/);
  });

  it('三档都有标签与说明，不许缺一档', () => {
    for (const tier of ['owner-only', 'logged-in', 'public'] as const) {
      expect(VISIBILITY_LABEL[tier]).toBeTruthy();
      expect(VISIBILITY_ACCESS_HINT[tier]).toBeTruthy();
    }
  });
});

describe('存量链接的兜底档', () => {
  // 往「更安全」的方向猜在这里是最危险的猜法：后端把没有 visibility 的旧链接按 public
  // 放行，界面兜底成 owner-only 就会告诉用户「只有你能打开」，而真相是谁都能打开。
  it('认不出的值一律按 public，不许兜底成 owner-only', () => {
    for (const v of [undefined, null, '', 'unknown', 'OWNER-ONLY']) {
      expect(normalizeVisibility(v)).toBe('public');
      expect(visibilityLabelOf(v)).toBe(VISIBILITY_LABEL.public);
    }
  });

  it('三个合法值原样返回', () => {
    for (const tier of ['owner-only', 'logged-in', 'public'] as const) {
      expect(normalizeVisibility(tier)).toBe(tier);
    }
  });

  it('quickShare 的 resolveVisibility 走的是同一个判据', () => {
    for (const v of [undefined, null, '', 'nope', 'owner-only', 'logged-in', 'public']) {
      expect(resolveVisibility({ visibility: v })).toBe(normalizeVisibility(v));
    }
  });
});
