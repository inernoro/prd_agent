import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const page = readFileSync(
  new URL('../../pages/WebPagesPage.tsx', import.meta.url), 'utf8');

/**
 * 「已分享」标记必须从 shareLinks 算出来，不能是另一份并行 state。
 *
 * 两份并行时，分享工作台撤销链接只回吐 shareLinks，标记那一份不动——链接已经撤了、
 * 卡片还挂着「已分享」，拖拽目标还在给「取消分享」，要整页重拉才对得上。
 * 这类漏更新删掉不会有任何用例变红（两份各自都「对」，只是没同步），所以要守卫钉住。
 */
describe('sharedSiteIds 单一事实源', () => {
  it('是派生出来的，不是自己一份 state', () => {
    expect(page).toMatch(/const sharedSiteIds = useMemo\(\(\) => buildSharedSiteIds\(shareLinks\)/);
  });

  it('没有第二个写入口——有 setter 就意味着又能不同步了', () => {
    // 只断这一条就够：没有 setter，就不可能出现「更新了一份、忘了另一份」。
    // 别再去钉声明处的行形状——我最初写的那条正则把隔壁一个无关的 Set state 一起匹到了，
    // 在正确的代码上判红。守卫自己坏掉比没有守卫更糟。
    expect(page).not.toContain('setSharedSiteIds');
  });

  it('工作台的变更回吐到 shareLinks 这一份上', () => {
    expect(page).toContain('onLinksChange={setShareLinks}');
  });
});
