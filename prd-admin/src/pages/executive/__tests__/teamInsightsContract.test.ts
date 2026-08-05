import { describe, it, expect } from 'vitest';
import { api } from '@/services/api';
import { buildWindowLabel, fmt, maskName, relaxNodes } from '@/pages/executive/TeamInsightsPanel';
import type { PlotNode } from '@/pages/executive/TeamInsightsPanel';

/**
 * 团队洞察的两条硬约束守卫（predicate-and-wiring-discipline 形状 2）：
 * 1. 接线：面板消费的端点必须真的登记在 api.ts，删掉登记这条测试要变红。
 * 2. 判据：后端算不出来的指标必须显示「—」，不许被格式化成 0 —— 这正是旧版
 *    综合排行榜「无数据也给个分」的老毛病，必须锁死。
 */
describe('团队洞察 · 接线与空值判据', () => {
  it('team-insights 端点已登记在 api 注册表', () => {
    expect(api.executive.teamInsights()).toBe('/api/executive/team-insights');
  });

  it('null 指标渲染为占位符，绝不退化成 0', () => {
    expect(fmt(null, '件')).toBe('—');
    expect(fmt(NaN, '件')).toBe('—');
    // 真实的 0 仍然要如实显示 0，不能和「没数据」混为一谈
    expect(fmt(0, '件')).toBe('0');
  });

  it('数值格式：整数不带小数，小数保留一位，tokens 走万分位', () => {
    expect(fmt(216, '件')).toBe('216');
    expect(fmt(1.83, '小时')).toBe('1.8');
    expect(fmt(52000, 'tokens')).toBe('5.2w');
  });

  it('匿名档位只遮成员姓名', () => {
    expect(maskName('蒋云峰', false)).toBe('蒋云峰');
    expect(maskName('蒋云峰', true)).toBe('蒋**');
    expect(maskName('', true)).toBe('');
  });

  it('窗口标签：到今天为止才叫「近 N 天」，历史区间报区间', () => {
    const today = new Date();
    const iso = (d: Date) => d.toISOString();
    const sevenAgo = new Date(today.getTime() - 6 * 86400000);
    // 窗口右边界是今天 → 「近 N 天」成立
    expect(buildWindowLabel(7, iso(sevenAgo), iso(today))).toBe('近 7 天');
    // 历史区间仍写「近 7 天」会把读者带偏，必须报真实区间
    expect(buildWindowLabel(7, '2026-07-27T00:00:00Z', '2026-08-02T00:00:00Z')).toBe('7/27~8/2');
    // 无界窗口
    expect(buildWindowLabel(0, null, iso(today))).toBe('全量');
  });
});

/**
 * 散点避让的守卫。
 *
 * 避让是排版行为，一旦越界就变成改数据：把一个「质量低于中位」的人推到线上方，
 * 他在读者眼里就换了象限。所以这里锁死两件事——真的分开了、并且没跨线。
 * 删掉 relaxNodes 里的不跨线约束，第二条会红。
 */
describe('分型散点 · 重叠避让', () => {
  const node = (id: string, x: number, y: number, mx: number, my: number): PlotNode => ({
    m: { userId: id, displayName: id } as PlotNode['m'],
    trueX: x, trueY: y, x, y, r: 14, hw: 22, hh: 22,
    rightOfMedian: x >= mx, aboveMedian: y <= my,
  });

  it('完全重叠的两个点会被分开', () => {
    const nodes = [node('a', 100, 100, 50, 50), node('b', 100, 100, 50, 50)];
    relaxNodes(nodes, 400, 360, 50, 50);
    const dx = Math.abs(nodes[0].x - nodes[1].x);
    const dy = Math.abs(nodes[0].y - nodes[1].y);
    expect(dx > 40 || dy > 40).toBe(true);
  });

  it('避让不跨分型线：被同侧邻居挤向线的点会被拦在线内', () => {
    // 场景要真的会跨线才算测到东西：三个点全在竖线左侧且互相重叠，
    // 最右那个会被左边两个一路推向 200——不加约束它就跨到右象限去了。
    // （第一版这条测试用的是「线两侧各一个点」，那种排布天然不会跨线，
    //   把约束删掉照样绿 —— 测了个寂寞。）
    const mx = 200; const my = 320;
    const nodes = [node('a', 160, 100, mx, my), node('b', 178, 100, mx, my), node('c', 196, 100, mx, my)];
    relaxNodes(nodes, 400, 360, mx, my);
    for (const n of nodes) expect(n.x).toBeLessThan(mx);
  });

  it('避让不跨分型线：横线同理，同侧邻居不能把人挤到线另一边', () => {
    const mx = 30; const my = 200;
    const nodes = [node('a', 300, 160, mx, my), node('b', 300, 178, mx, my), node('c', 300, 196, mx, my)];
    relaxNodes(nodes, 400, 360, mx, my);
    for (const n of nodes) expect(n.y).toBeLessThan(my);
  });

  it('位移有上限，宁可留一点重叠也不搬家', () => {
    // 一堆点挤在同一处：不封顶的话会被推到画布边缘，位置就彻底失真了
    const nodes = Array.from({ length: 8 }, (_, i) => node(`n${i}`, 200, 200, 100, 100));
    relaxNodes(nodes, 400, 360, 100, 100);
    for (const n of nodes) {
      expect(Math.hypot(n.x - n.trueX, n.y - n.trueY)).toBeLessThanOrEqual(27);
    }
  });

  it('不重叠的点原地不动', () => {
    const nodes = [node('a', 60, 60, 30, 30), node('b', 300, 300, 30, 30)];
    relaxNodes(nodes, 400, 360, 30, 30);
    expect(nodes[0].x).toBe(60);
    expect(nodes[1].y).toBe(300);
  });
});
