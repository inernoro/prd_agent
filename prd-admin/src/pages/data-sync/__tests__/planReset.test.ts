import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * 换了一条 Run 就必须丢掉上一条的对照表。
 *
 * 这个组件在历史列表与详情之间来回切时是不卸载的，plan 会留在上一条 Run 上；
 * 而拉取那个 effect 的 `|| plan` 又会因此判定「已经有了，不用拉」——于是屏幕上显示的是
 * A 的源站、条数、集合清单，按下开始却是拿 B 去跑。操作者正是照着这一屏做决定的。
 *
 * 本仓库前端没有 jsdom，起不了组件；源码扫描是唯一能钉住它的手段，而这个不变量
 * 删掉之后所有既有测试仍然全绿。
 */
describe('切换 Run 时重置运行态', () => {
  const source = readFileSync(new URL('../DataSyncPage.tsx', import.meta.url), 'utf8');

  it('runId 变了就清掉上一条的对照表', () => {
    expect(source).toMatch(/useEffect\(\(\) => \{\s*setPlan\(null\);\s*\}, \[runId\]\);/);
  });

  it('拉取对照表的 effect 仍然靠 plan 去重（所以上面那条不能少）', () => {
    expect(source).toContain("run.status !== 'pending' || plan");
  });
});
