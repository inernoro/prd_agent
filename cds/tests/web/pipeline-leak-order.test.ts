/**
 * 漏点严重度顺序在两处各写了一遍（后端 severity 表决定 leaks[] 的排序，
 * 前端 leakOrder 决定卡片的排列）。这正是 predicate-and-wiring-discipline
 * 形状 3「判据分裂成多份、各自漂移」的温床：加一种漏时很容易只改一边，
 * 页面上就会静默少一张卡，测试全绿。所以在这里把两份对齐钉死。
 *
 * 顺带守住 LeakKind 三处（后端类型 / 前端类型 / 文案表）的键集一致。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const read = (p: string): string => readFileSync(resolve(__dirname, '../..', p), 'utf8');

/** 从形如 `'a', 'b',` 的一段源码里按出现顺序抽出单引号字符串。 */
function quoted(segment: string): string[] {
  return [...segment.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
}

describe('漏点严重度顺序：后端与前端不许漂移', () => {
  const backend = read('src/services/acceptance-pipeline.ts');
  const panel = read('web/src/pages/reports/PipelinePanel.tsx');

  const severity = backend.match(/const severity: Record<LeakKind, number> = \{([\s\S]*?)\};/);
  const leakOrder = panel.match(/const leakOrder: LeakKind\[\] = \[([\s\S]*?)\];/);

  it('两份顺序表都还在（改了名字就得来更新这条守卫）', () => {
    expect(severity, '后端 severity 表没找到').not.toBeNull();
    expect(leakOrder, '前端 leakOrder 没找到').not.toBeNull();
  });

  it('顺序逐项相同', () => {
    expect(quoted(leakOrder![1])).toEqual(quoted(severity![1]));
  });

  it('文案表覆盖每一种漏，没有多余项', () => {
    const meta = panel.match(/const LEAK_META: Record<LeakKind, \{[^}]*\}> = \{([\s\S]*?)\n\};/);
    expect(meta, 'LEAK_META 没找到').not.toBeNull();
    const declared = [...meta![1].matchAll(/^\s*'([a-z-]+)':/gm)].map((m) => m[1]);
    expect([...declared].sort()).toEqual([...quoted(severity![1])].sort());
  });
});
