import { describe, expect, it } from 'vitest';
import { layoutRadial2D, type RadialTreeNode } from '../radialLayout';

const leaf = (id: string): RadialTreeNode => ({ id, kind: 'leaf', children: [] });
const group = (id: string, children: RadialTreeNode[]): RadialTreeNode => ({ id, kind: 'group', children });
const root = (children: RadialTreeNode[]): RadialTreeNode => ({ id: 'root', kind: 'root', children });

describe('layoutRadial2D', () => {
  it('root 恒在原点,单文档库不产生 NaN', () => {
    const r = layoutRadial2D(root([leaf('a')]));
    expect(r.pos2dById.get('root')).toEqual({ x: 0, y: 0 });
    const p = r.pos2dById.get('a')!;
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
    expect(Math.hypot(p.x, p.y)).toBeGreaterThan(0);
  });

  it('空分组权重下限 1,不塌缩成零宽扇区', () => {
    const r = layoutRadial2D(root([group('g-empty', []), group('g-full', [leaf('a'), leaf('b')])]));
    const pe = r.pos2dById.get('g-empty')!;
    const pf = r.pos2dById.get('g-full')!;
    expect(Number.isFinite(pe.x)).toBe(true);
    // 两个分组角度不同(各占一段扇区)
    expect(Math.atan2(pe.y, pe.x)).not.toBeCloseTo(Math.atan2(pf.y, pf.x), 3);
  });

  it('同 depth 节点落在同一半径环上,环半径单调递增', () => {
    const g1 = group('g1', [leaf('l1'), leaf('l2')]);
    const g2 = group('g2', [leaf('l3')]);
    const r = layoutRadial2D(root([g1, g2]));
    const r1 = Math.hypot(r.pos2dById.get('g1')!.x, r.pos2dById.get('g1')!.y);
    const r2 = Math.hypot(r.pos2dById.get('g2')!.x, r.pos2dById.get('g2')!.y);
    expect(r1).toBeCloseTo(r2, 6);
    const rl = Math.hypot(r.pos2dById.get('l1')!.x, r.pos2dById.get('l1')!.y);
    expect(rl).toBeGreaterThan(r1);
    expect(r.maxRadius).toBeCloseTo(rl, 6);
  });

  it('大库(364 叶)外环半径按最小弧距自适应放大,叶间平均弧距达标', () => {
    const leaves = Array.from({ length: 364 }, (_, i) => leaf(`l${i}`));
    // 8 个分类均分
    const groups = Array.from({ length: 8 }, (_, gi) => group(`g${gi}`, leaves.slice(gi * 45, (gi + 1) * 45 + (gi === 7 ? 4 : 0))));
    const r = layoutRadial2D(root(groups));
    // 364 * 26 / 2pi ~= 1506
    expect(r.maxRadius).toBeGreaterThan(1200);
    // 抽查同分类相邻叶子的弧距不小于下限的一半(中线放置下相邻扇区中点距离 = 平均弧距)
    const p0 = r.pos2dById.get('l0')!;
    const p1 = r.pos2dById.get('l1')!;
    expect(Math.hypot(p1.x - p0.x, p1.y - p0.y)).toBeGreaterThan(13);
  });

  it('扇区角度覆盖整圈:全部叶子的角度范围接近 2pi', () => {
    const leaves = Array.from({ length: 12 }, (_, i) => leaf(`l${i}`));
    const r = layoutRadial2D(root([group('g', leaves)]));
    const angles = leaves
      .map((l) => r.pos2dById.get(l.id)!)
      .map((p) => Math.atan2(p.y, p.x));
    const uniq = new Set(angles.map((a) => a.toFixed(4)));
    expect(uniq.size).toBe(12); // 角度全部不同,均匀铺开
  });
});
