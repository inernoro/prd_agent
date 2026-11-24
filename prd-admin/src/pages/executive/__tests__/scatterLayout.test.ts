import { describe, it, expect } from 'vitest';
import { layoutScatter, SCATTER_H, type PlotNode } from '@/pages/executive/TeamInsightsPanel';
import type { TeamInsightMember } from '@/services/contracts/executive';
import fixture from './scatterFixture.json';

/**
 * 散点重叠的守卫 —— 用**线上真实的 32 人数据**跑布局，直接量碰撞盒有没有相交。
 *
 * 为什么必须是真实数据：造几个点的用例永远测不出「三十多人挤在对数刻度左半边」
 * 这种真实分布下的拥挤，而那正是用户看到重叠的地方。
 *
 * 为什么必须是纯函数：留在组件里就只能部署一轮、截图看一眼，而截图分不出
 * 「差 2px 没叠上」和「刚好叠上」。第一版就是这么栽的——把标签碰撞盒放宽后
 * 截图反而更糟，问题其实在盒子模型建错了（名字在气泡下方，盒子却按圆心对称建），
 * 眼睛看不出这个区别，尺子能。
 */

type Fixture = {
  members: { displayName: string; output: number; quality: number; outputDays: number }[];
  medians: { output: number; quality: number };
};
const fx = fixture as Fixture;

/** 复刻组件里的两个映射：X 走对数刻度，Y 按实际质量范围铺满 */
function makeMappers(members: Fixture['members'], medians: Fixture['medians']) {
  const maxOutput = Math.max(1, ...members.map(m => m.output));
  const logX = (v: number) => (Math.log10(Math.max(0, v) + 1) / Math.log10(maxOutput + 1)) * 88 + 6;
  const qs = members.map(m => m.quality).concat([medians.quality]);
  const qMin = Math.min(...qs, 100);
  const qMax = Math.max(...qs, 0);
  const pad = Math.max(4, (qMax - qMin) * 0.12);
  const qLo = Math.max(0, qMin - pad);
  const qHi = Math.min(100, qMax + pad);
  const span = Math.max(1, qHi - qLo);
  const posY = (q: number) => 100 - (((q - qLo) / span) * 84 + 8);
  return { logX, posY };
}

function asMembers(rows: Fixture['members']): TeamInsightMember[] {
  return rows.map((r, i) => ({ ...r, userId: `u${i}` })) as unknown as TeamInsightMember[];
}

/** 两个碰撞盒是否相交。盒心在 (x, y + oy)。 */
function overlaps(a: PlotNode, b: PlotNode): boolean {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs((a.y + a.oy) - (b.y + b.oy));
  return dx < a.hw + b.hw && dy < a.hh + b.hh;
}

function countOverlaps(nodes: PlotNode[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (overlaps(nodes[i], nodes[j])) {
        out.push(`${nodes[i].m.displayName} × ${nodes[j].m.displayName}`);
      }
    }
  }
  return out;
}

describe('分型散点 · 真实数据下无重叠', () => {
  const { logX, posY } = makeMappers(fx.members, fx.medians);
  const members = asMembers(fx.members);

  // 面板在宽屏与窄屏下画布宽度差很多，挤不挤得开完全不同，两档都要过
  for (const w of [1180, 860]) {
    it(`画布 ${w}px：32 人真实分布下没有任何两个碰撞盒相交`, () => {
      const nodes = layoutScatter(members, fx.medians, w, SCATTER_H, false, logX, posY);
      expect(nodes).toHaveLength(fx.members.length);
      const bad = countOverlaps(nodes);
      expect(bad, `以下 ${bad.length} 对叠在一起：\n${bad.join('\n')}`).toEqual([]);
    });
  }

  it('匿名档位（名字变短）同样不重叠', () => {
    const nodes = layoutScatter(members, fx.medians, 1180, SCATTER_H, true, logX, posY);
    expect(countOverlaps(nodes)).toEqual([]);
  });

  it('避让没有把任何人挪出画布', () => {
    const w = 1180;
    const nodes = layoutScatter(members, fx.medians, w, SCATTER_H, false, logX, posY);
    for (const n of nodes) {
      expect(n.x - n.hw).toBeGreaterThanOrEqual(-0.01);
      expect(n.x + n.hw).toBeLessThanOrEqual(w + 0.01);
    }
  });

  it('避让没有改变任何人的象限归属', () => {
    const w = 1180;
    const mx = (logX(fx.medians.output) / 100) * w;
    const my = (posY(fx.medians.quality) / 100) * SCATTER_H;
    const nodes = layoutScatter(members, fx.medians, w, SCATTER_H, false, logX, posY);
    for (const n of nodes) {
      expect(n.x >= mx, `${n.m.displayName} 横向跨线了`).toBe(n.rightOfMedian);
      expect(n.y <= my, `${n.m.displayName} 纵向跨线了`).toBe(n.aboveMedian);
    }
  });
});
