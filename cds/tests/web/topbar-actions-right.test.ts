/*
 * 守卫：主动操作按钮永远在右上角。
 *
 * 用户 2026-09-14 原话：「添加按钮要在右侧，主动操作按钮都在右上角哦，
 * 不要堆积在左上角，这是用户心智问题。」
 *
 * 左上是「我在哪」（品牌 + 面包屑），右上是「我要做什么」（刷新 / 添加 / 更多）。
 * 两者挤在一起，读者每次打开页面都得重新分辨哪个是标题、哪个是按钮。
 *
 * 这条容易悄悄坏：`right` 槽的按钮**已经传对了**，页面代码上看不出任何问题，
 * 坏的是布局——left 槽在桌面端不撑开、又没有 center 时，没有任何东西把动作推到
 * 右边，于是它们紧挨着面包屑。删掉 ml-auto 不会有任何测试变红，只会让全站的
 * 动作按钮悄悄挪回左上角（predicate-and-wiring-discipline 形状 2）。
 *
 * 判据只认「有没有把它推到右边」这件事，不锁具体类名的写法之外的东西。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(fileURLToPath(new URL('../../web/src/components/layout/AppShell.tsx', import.meta.url)), 'utf8');

/** 去注释：块注释必须独占行首，否则源码里的 '/api/*' 会把扫描带偏。 */
const code = SOURCE
  .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
  .replace(/^[ \t]*\{\/\*[\s\S]*?\*\/\}/gm, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('顶栏的主动操作靠右', () => {
  it('桌面端动作槽被推到右边', () => {
    const at = code.indexOf('cds-topbar-actions');
    expect(at, '找不到桌面端动作槽，守卫的取值范围要跟着改').toBeGreaterThanOrEqual(0);
    const cls = code.slice(at, code.indexOf('>', at));
    expect(cls, '动作槽缺少 ml-auto —— 没有 center 的页面它会紧挨着面包屑').toContain('ml-auto');
  });

  it('手机端的更多操作也靠右', () => {
    // 手机端把动作收进 ⋮，同样不能贴着标题。
    expect(code).toMatch(/ml-auto[^"]*md:hidden|md:hidden[^"]*ml-auto/);
  });

  it('左槽仍然不许抢占右边的空间', () => {
    // left 在桌面端是 flex-none：它一旦改成 flex-1，会把动作又挤回中间。
    const at = code.indexOf('cds-topbar-lead');
    const cls = code.slice(at, code.indexOf('>', at));
    expect(cls).toContain('md:flex-none');
  });
});
