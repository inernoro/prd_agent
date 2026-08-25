import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 卡片 hover 条与批量勾选框的**指针契约**守卫。
 *
 * 事故（2026-08-25 用真实指针序列测出来的）：hover 条写了 `group-hover:pointer-events-auto`，
 * 鼠标一悬停，这条 `inset-x-0` 的横条就以整条宽度接管指针，把它左下角盖住的勾选框整个吞掉——
 * 勾选框看得见、点不动，右栏因此永远进不了「选中」态。
 *
 * 为什么用源码扫描而不是行为测试：这条 bug 只在**真实命中测试**下成立。jsdom 没有 hit-testing，
 * `button.click()` 也照样能过（当时就是这样：程序化点击能选中、真人点不动）。
 * 能测红它的只有带真实指针序列的浏览器用例，那属于 e2e；在单测这一层，
 * 能守住的是「契约本身有没有被写回去」。
 */
const read = (f: string) => fs.readFileSync(path.join(__dirname, f), 'utf8');

/**
 * 取 hover 条那个元素的 className 字面量本身。
 *
 * 不能拿「data-hoverbar 后面若干字符」当范围：那段里包含解释事故的注释，
 * 注释里写着事故写法，守卫会把注释当成代码判红（判据读错了对象，形状 6 的小号版本）。
 */
function hoverBarClassName(src: string): string {
  const at = src.indexOf('data-hoverbar');
  expect(at, 'SiteCard 里找不到 data-hoverbar，守卫要同步').toBeGreaterThan(-1);
  const m = /className="([^"]+)"/.exec(src.slice(at));
  expect(m, 'hover 条的 className 写法变了（不再是字符串字面量），守卫要同步').not.toBeNull();
  return m![1];
}

describe('卡片 hover 条的指针契约', () => {
  it('hover 条容器恒为 pointer-events-none，不许在 hover 时整条接管指针', () => {
    const cls = hoverBarClassName(read('SiteCard.tsx'));
    expect(cls).toContain('pointer-events-none');
    // 这一条正是事故写法：整条在 hover 时变可点，等于盖死左下角的勾选框
    expect(cls).not.toContain('group-hover:pointer-events-auto');
    expect(cls).not.toContain('group-focus-within:pointer-events-auto');
  });

  it('hover 条里的按钮自己是可点的（否则整条都点不动）', () => {
    const actions = read('SiteCardActions.tsx');
    // CardIconAction 的共用 base 与 CardMoreButton 的触发按钮都要带上
    expect(actions.match(/pointer-events-auto/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('批量勾选框在 hover 条的留白区内（左内边距要给它让位）', () => {
    const src = read('SiteCard.tsx');
    // 勾选框 left 7px + 宽 20px = 右边缘 27px；hover 条左内边距必须大于它，
    // 否则第一个操作按钮会压在勾选框上（视觉重叠，即使指针能穿透也读不清）
    const at = src.indexOf('data-hoverbar');
    const pad = src.slice(at, at + 900).match(/padding:\s*'7px 7px 7px (\d+)px'/);
    expect(pad, 'hover 条的内边距写法变了，守卫要同步').not.toBeNull();
    expect(Number(pad![1])).toBeGreaterThan(27);
  });
});
