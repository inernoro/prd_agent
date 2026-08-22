import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fmtCount } from './analyticsFormat';

describe('分享数据的计数格式化', () => {
  it('缺字段不炸整屏 —— 拿不到就报 0', () => {
    expect(fmtCount(undefined)).toBe('0');
    expect(fmtCount(null)).toBe('0');
    expect(fmtCount(Number.NaN)).toBe('0');
  });

  it('有数就按千分位报', () => {
    expect(fmtCount(0)).toBe('0');
    expect(fmtCount(1842)).toBe('1,842');
  });
});

describe('数据抽屉不许再裸调 toLocaleString', () => {
  // 这一屏崩过一次：link.viewCount 缺字段 → 整个抽屉白屏。
  // 守卫扫源码，防止下一个人又写回 `x.toLocaleString()`。
  it('ShareAnalyticsDrawer 里的计数一律走 fmtCount', () => {
    const src = fs.readFileSync(path.join(__dirname, 'ShareAnalyticsDrawer.tsx'), 'utf-8');
    // 允许 Date 上的 toLocaleString（时间格式化本来就该走它），只拦数字字段
    const bare = src
      .split('\n')
      .filter((line) => /\.toLocaleString\(\)/.test(line));
    expect(bare).toEqual([]);
    expect(src).toContain('fmtCount(');
  });
});
