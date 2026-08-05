import { describe, it, expect } from 'vitest';
import { api } from '@/services/api';
import { buildWindowLabel, fmt, maskName } from '@/pages/executive/TeamInsightsPanel';

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
