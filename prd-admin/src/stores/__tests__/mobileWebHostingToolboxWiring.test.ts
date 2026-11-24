import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOLS } from '../toolboxStore';

describe('移动端网页托管入口', () => {
  it('在百宝箱注册真实网页托管路由与权限', () => {
    const entry = BUILTIN_TOOLS.find((item) => item.id === 'builtin-web-pages');

    expect(entry).toMatchObject({
      name: '网页托管',
      kind: 'tool',
      routePath: '/web-pages',
      permission: 'web-pages.read',
    });
  });

  it('验收通过之前必须挂着 wip 标', () => {
    const entry = BUILTIN_TOOLS.find((item) => item.id === 'builtin-web-pages');

    // 百宝箱是全体用户共用的导航目录：没有这个标，未验收的功能在目录里
    // 与已转正的条目长得一模一样，等于替用户宣布它能用了。
    // 什么时候可以删掉这条守卫与那个字段：规则 #8 的真人验收通过，
    // 且 doc/plan.platform.open-design.md 的状态不再是「六步全部未验收」。
    expect(entry?.wip).toBe(true);
  });
});
