/**
 * Codex 第十三轮的前端一条（PR #1532，reviewed commit ec13f34f2c）。
 *
 * 选中一个报告类型页签后切到没有该类型的作用域：kindTabs 只留 count > 0 的，
 * 页签消失；ledgerRows 仍按它过滤，于是台账空着、界面上没有任何选中的控件
 * 能解释或清掉它。判据抽成 resolveKindFilter，这里测判据 + 测接线。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { resolveKindFilter, ALL_KINDS } from '@/lib/reportKindFilter';

const PAGE = fs.readFileSync(path.resolve(process.cwd(), '../cds/web/src/pages/ReportsPage.tsx'), 'utf8');
const tabs = (...kinds: string[]) => kinds.map((kind) => ({ kind, count: 1 }));

describe('resolveKindFilter', () => {
  it('选中项还在可选集合里就原样保留', () => {
    expect(resolveKindFilter('功能验收', tabs('功能验收', '每日验收'))).toBe('功能验收');
  });

  it('选中项已经不在可选集合里就退回全部', () => {
    expect(resolveKindFilter('发布验收', tabs('功能验收', '每日验收'))).toBe(ALL_KINDS);
  });

  it('可选集合为空时也退回全部', () => {
    expect(resolveKindFilter('功能验收', [])).toBe(ALL_KINDS);
  });

  it('本来就是全部时不动', () => {
    expect(resolveKindFilter(ALL_KINDS, [])).toBe(ALL_KINDS);
  });
});

describe('台账接线', () => {
  it('ReportsPage 真的调用了这条判据，且依赖里带上了页签集合', () => {
    expect(PAGE, 'resolveKindFilter 没人调用，判据建了一半')
      .toContain('resolveKindFilter(kindFilter, kindTabs)');
    const effect = PAGE.slice(PAGE.indexOf('const next = resolveKindFilter('));
    expect(effect.slice(0, 400)).toMatch(/\}, \[kindTabs, kindFilter\]\);/);
  });

  it('判据只有一处定义，页面里没有第二份「页签里找不到就清掉」的手写实现', () => {
    const inline = PAGE.match(/kindTabs\.some\(/g) ?? [];
    expect(inline.length, '判据分裂成两份会各自漂移').toBe(0);
  });
});
