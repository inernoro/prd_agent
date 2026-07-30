/**
 * release-promotion-ancestor.test.ts —— 晋升候选必须是本环境版本的后代。
 *
 * `rev-list a..b --count` 只回答「b 有多少提交是 a 没有的」。分叉之后**两个方向
 * 都是正数**，于是「对方领先我 4 个提交」这句话对一条完全无关的分支同样成立。
 * 页面据此把「提升到生产」的按钮亮出来，点一下生产就被切到另一条线上
 * （Codex review P1，2026-07-29）。
 */

import { describe, expect, it } from 'vitest';

import { resolvePromotionCandidate } from '../../src/routes/releases.js';

const SHA = {
  base: '1111111111111111111111111111111111111111',
  ahead: '2222222222222222222222222222222222222222',
  forked: '3333333333333333333333333333333333333333',
};

function row(over: Record<string, unknown> = {}): never {
  return {
    target: { id: 'rt_prod', projectId: 'p1', name: '生产', environment: 'production', isEnabled: true },
    currentCommit: SHA.base,
    currentVersion: 'rel_prod',
    healthStatus: 'healthy',
    lastReleasedAt: '2026-07-20T00:00:00Z',
    ...over,
  } as never;
}

function staging(commit: string): never {
  return {
    target: { id: 'rt_stg', projectId: 'p1', name: '预发', environment: 'staging', isEnabled: true },
    currentCommit: commit,
    currentVersion: 'rel_stg',
    healthStatus: 'healthy',
    lastReleasedAt: '2026-07-28T00:00:00Z',
  } as never;
}

/**
 * 用一张「有向距离表」冒充 git：key 是 `from..to`，值是 rev-list --count。
 * 直线关系只有一个方向为正；分叉两个方向都为正——真实 git 就是这个行为。
 */
function railWith(distances: Record<string, number | null>): never {
  return {
    countCommitsBetween: (_project: string, from: string, to: string) => {
      if (from === to) return 0;
      const key = `${from}..${to}`;
      return key in distances ? distances[key] : null;
    },
  } as never;
}

describe('resolvePromotionCandidate', () => {
  it('直线领先：预发是生产的后代 → 可以晋升', () => {
    const rail = railWith({
      [`${SHA.base}..${SHA.ahead}`]: 4,
      [`${SHA.ahead}..${SHA.base}`]: 0, // 生产那一版是预发的祖先
    });
    const found = resolvePromotionCandidate(row(), [row(), staging(SHA.ahead)], rail);
    expect(found?.commitSha).toBe(SHA.ahead);
    expect(found?.aheadCount).toBe(4);
  });

  it('分叉：两个方向都为正 → 不是升级，不许出现晋升入口', () => {
    const rail = railWith({
      [`${SHA.base}..${SHA.forked}`]: 4, // 光看这个数会以为「领先 4 个提交」
      [`${SHA.forked}..${SHA.base}`]: 2, // 但我这边也有 2 个它没有的 —— 分叉
    });
    expect(resolvePromotionCandidate(row(), [row(), staging(SHA.forked)], rail)).toBeUndefined();
  });

  it('反向距离算不出来（仓库读不到）→ 保守不推荐', () => {
    const rail = railWith({ [`${SHA.base}..${SHA.ahead}`]: 4 }); // 反向缺失 = null
    expect(resolvePromotionCandidate(row(), [row(), staging(SHA.ahead)], rail)).toBeUndefined();
  });

  it('对方落后 → 本来就不该推荐', () => {
    const rail = railWith({
      [`${SHA.base}..${SHA.ahead}`]: 0,
      [`${SHA.ahead}..${SHA.base}`]: 3,
    });
    expect(resolvePromotionCandidate(row(), [row(), staging(SHA.ahead)], rail)).toBeUndefined();
  });

  it('本环境从未发布过：没有可比较的起点，照常推荐且 aheadCount 如实给 null', () => {
    // 这条路径不做祖先判定——「什么都没有」谈不上分叉。
    const rail = railWith({});
    const found = resolvePromotionCandidate(
      row({ currentCommit: '', currentVersion: '' }),
      [row({ currentCommit: '', currentVersion: '' }), staging(SHA.ahead)],
      rail,
    );
    expect(found?.commitSha).toBe(SHA.ahead);
    expect(found?.aheadCount).toBeNull();
  });

  it('健康是 failed 的来源环境不参与推荐（既有行为不许回退）', () => {
    const rail = railWith({
      [`${SHA.base}..${SHA.ahead}`]: 4,
      [`${SHA.ahead}..${SHA.base}`]: 0,
    });
    const sick = { ...(staging(SHA.ahead) as unknown as Record<string, unknown>), healthStatus: 'failed' } as never;
    expect(resolvePromotionCandidate(row(), [row(), sick], rail)).toBeUndefined();
  });
});

/**
 * 「现在点下去能不能真发出去」。
 *
 * startRelease 恒按分支**当前** commit 建 artifact，再用 expectedCommitSha 做
 * fail-closed 钳制。所以来源那一版一旦不再是分支 tip，提升必然被拒 —— 而按钮
 * 照常亮着（Codex review P1，2026-07-29）。钳制是对的，不能为了让按钮可用就拿掉；
 * 正确做法是提前告诉用户发不出去。
 */
describe('晋升可执行性', () => {
  const linear = () => railWith({
    [`${SHA.base}..${SHA.ahead}`]: 4,
    [`${SHA.ahead}..${SHA.base}`]: 0,
  });

  it('来源那一版仍是分支 tip → 可执行', () => {
    const found = resolvePromotionCandidate(
      row(), [row(), staging(SHA.ahead)], linear(),
      () => SHA.ahead,
    );
    expect(found?.executable).toBe(true);
    expect(found?.blockedReason).toBeUndefined();
  });

  it('分支已前进 → 不可执行，并给出人话原因', () => {
    const found = resolvePromotionCandidate(
      row(), [row(), staging(SHA.ahead)], linear(),
      () => SHA.forked,
    );
    // 候选仍然返回：要让用户看见「预发跑着更新的一版」这个事实，
    // 只是把按钮置灰 + 说明原因，而不是整块消失（消失了用户只会以为没这功能）。
    expect(found?.executable).toBe(false);
    expect(found?.blockedReason).toContain(SHA.forked.slice(0, 7));
    expect(found?.blockedReason).toContain(SHA.ahead.slice(0, 7));
  });

  it('解析不出 tip（分支已回收 / 未注入解析器）→ 不拦，真判定留给 startRelease', () => {
    expect(resolvePromotionCandidate(row(), [row(), staging(SHA.ahead)], linear(), () => undefined)?.executable)
      .toBe(true);
    expect(resolvePromotionCandidate(row(), [row(), staging(SHA.ahead)], linear())?.executable)
      .toBe(true);
  });
});

describe('前端真的按 executable 置灰（接线守卫）', () => {
  it('OverviewTab 的提升按钮读 executable 且展示 blockedReason', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const dir = path.dirname(url.fileURLToPath(import.meta.url));
    const source = fs.readFileSync(
      path.resolve(dir, '../../web/src/pages/release-center/OverviewTab.tsx'),
      'utf8',
    );
    // 只下发字段不消费 = 建了一半的链路：按钮照样可点，用户照样吃拒绝。
    expect(source).toContain("row.promotion.executable === false");
    expect(source).toContain('row.promotion.blockedReason');
    expect(source).toMatch(/disabled=\{promoting \|\| row\.promotion\.executable === false\}/);
  });
});
