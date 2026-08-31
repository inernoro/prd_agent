import { describe, expect, it } from 'vitest';
import {
  ALIGNED_DIRECTIONS,
  PLACEMENT_PAD,
  alignedSlot,
  findAlignedFreeTopLeft,
  placementGap,
  type PlacementRect,
} from '../canvasPlacement';

const A: PlacementRect = { x: 1000, y: 1000, w: 400, h: 300 };

describe('placementGap', () => {
  it('下限必须大于碰撞 padding，否则锚点会把紧贴自己的落位判成碰撞', () => {
    // 这条不是凑数：gap ≤ pad 时四个方向全被锚点自己否掉，对齐落位静默失效。
    expect(placementGap({ x: 0, y: 0, w: 10, h: 10 }, 10, 10)).toBeGreaterThan(PLACEMENT_PAD);
  });

  it('按较小边的 4% 取值，并封顶 96', () => {
    expect(placementGap({ x: 0, y: 0, w: 1024, h: 1024 }, 1024, 1024)).toBe(41);
    expect(placementGap({ x: 0, y: 0, w: 8000, h: 8000 }, 8000, 8000)).toBe(96);
  });

  it('取的是四条边里最小的那条，不是锚点的', () => {
    // 大锚点 + 小新图：间距应当跟着小图走，否则小图会被推到很远。
    expect(placementGap({ x: 0, y: 0, w: 4000, h: 4000 }, 200, 200)).toBe(
      placementGap({ x: 0, y: 0, w: 200, h: 200 }, 200, 200)
    );
  });
});

describe('alignedSlot', () => {
  it('左右落位共上边缘，上下落位共左边缘', () => {
    expect(alignedSlot(A, 200, 500, 'right', 1, 40).y).toBe(A.y);
    expect(alignedSlot(A, 200, 500, 'left', 1, 40).y).toBe(A.y);
    expect(alignedSlot(A, 200, 500, 'down', 1, 40).x).toBe(A.x);
    expect(alignedSlot(A, 200, 500, 'up', 1, 40).x).toBe(A.x);
  });

  it('四个方向都恰好隔开一个 gap，不多不少', () => {
    const g = 40;
    expect(alignedSlot(A, 200, 500, 'right', 1, g).x).toBe(A.x + A.w + g);
    expect(alignedSlot(A, 200, 500, 'left', 1, g).x + 200).toBe(A.x - g);
    expect(alignedSlot(A, 200, 500, 'down', 1, g).y).toBe(A.y + A.h + g);
    expect(alignedSlot(A, 200, 500, 'up', 1, g).y + 500).toBe(A.y - g);
  });

  it('同方向顺延时步长是新图自己的尺寸，排距恒定', () => {
    const g = 40;
    const k1 = alignedSlot(A, 200, 500, 'right', 1, g).x;
    const k2 = alignedSlot(A, 200, 500, 'right', 2, g).x;
    const k3 = alignedSlot(A, 200, 500, 'right', 3, g).x;
    expect(k2 - k1).toBe(200 + g);
    expect(k3 - k2).toBe(k2 - k1);
  });
});

describe('findAlignedFreeTopLeft', () => {
  it('空画布：贴右边、上边缘齐平', () => {
    const p = findAlignedFreeTopLeft([A], 400, 300, A);
    const g = placementGap(A, 400, 300);
    expect(p).toEqual({ x: A.x + A.w + g, y: A.y });
  });

  it('锚点自己在 existing 里也不会挡住第一个落位', () => {
    // 形状 1 的老陷阱：判据把锚点算成障碍物，于是永远退回最近空位搜索。
    expect(findAlignedFreeTopLeft([A], 400, 300, A)).not.toBeNull();
  });

  it('右边被占 → 落左边，仍然上边缘齐平', () => {
    const g = placementGap(A, 400, 300);
    const blockRight: PlacementRect = { x: A.x + A.w + g, y: A.y, w: 400, h: 300 };
    const p = findAlignedFreeTopLeft([A, blockRight], 400, 300, A)!;
    expect(p).toEqual({ x: A.x - g - 400, y: A.y });
  });

  it('左右都被占 → 落下方，左边缘齐平', () => {
    const g = placementGap(A, 400, 300);
    const occupied: PlacementRect[] = [
      A,
      { x: A.x + A.w + g, y: A.y, w: 400, h: 300 },
      { x: A.x - g - 400, y: A.y, w: 400, h: 300 },
    ];
    const p = findAlignedFreeTopLeft(occupied, 400, 300, A)!;
    expect(p).toEqual({ x: A.x, y: A.y + A.h + g });
  });

  it('左右下都被占 → 落上方', () => {
    const g = placementGap(A, 400, 300);
    const occupied: PlacementRect[] = [
      A,
      { x: A.x + A.w + g, y: A.y, w: 400, h: 300 },
      { x: A.x - g - 400, y: A.y, w: 400, h: 300 },
      { x: A.x, y: A.y + A.h + g, w: 400, h: 300 },
    ];
    const p = findAlignedFreeTopLeft(occupied, 400, 300, A)!;
    expect(p).toEqual({ x: A.x, y: A.y - g - 300 });
  });

  it('车道由近及远：第一条车道四个方向都占满才去第二条', () => {
    const g = placementGap(A, 400, 300);
    const lane1: PlacementRect[] = [A, ...ALIGNED_DIRECTIONS.map((d) => {
      const p = alignedSlot(A, 400, 300, d, 1, g);
      return { x: p.x, y: p.y, w: 400, h: 300 };
    })];
    const p = findAlignedFreeTopLeft(lane1, 400, 300, A)!;
    expect(p).toEqual(alignedSlot(A, 400, 300, 'right', 2, g));
  });

  it('全占满时返回 null，让调用方退回最近空位搜索——不许硬塞一个重叠位置', () => {
    const g = placementGap(A, 400, 300);
    const all: PlacementRect[] = [A];
    for (let k = 1; k <= 4; k++) {
      for (const d of ALIGNED_DIRECTIONS) {
        const p = alignedSlot(A, 400, 300, d, k, g);
        all.push({ x: p.x, y: p.y, w: 400, h: 300 });
      }
    }
    expect(findAlignedFreeTopLeft(all, 400, 300, A, { lanes: 4 })).toBeNull();
  });

  it('连着放三张会排成一行：等距、上边缘全部齐平', () => {
    // 组件里是链式落位（下一张的锚点是上一张），这条锁的就是那个用法的结果。
    const existing: PlacementRect[] = [A];
    let anchor = A;
    const xs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const p = findAlignedFreeTopLeft(existing, 400, 300, anchor)!;
      expect(p.y).toBe(A.y);
      xs.push(p.x);
      anchor = { x: p.x, y: p.y, w: 400, h: 300 };
      existing.push(anchor);
    }
    expect(xs[1]! - xs[0]!).toBe(xs[2]! - xs[1]!);
  });

  it('高矮不同也共上边缘，而不是居中对齐', () => {
    const p = findAlignedFreeTopLeft([A], 200, 900, A)!;
    expect(p.y).toBe(A.y);
  });

  it('落位不与任何既有元素重叠（含 padding）', () => {
    const existing: PlacementRect[] = [
      A,
      { x: A.x + 500, y: A.y - 200, w: 300, h: 900 },
    ];
    const p = findAlignedFreeTopLeft(existing, 400, 300, A)!;
    const cand = { ...p, w: 400, h: 300 };
    for (const r of existing) {
      const hit =
        cand.x - PLACEMENT_PAD < r.x + r.w &&
        cand.x + cand.w + PLACEMENT_PAD > r.x &&
        cand.y - PLACEMENT_PAD < r.y + r.h &&
        cand.y + cand.h + PLACEMENT_PAD > r.y;
      expect(hit).toBe(false);
    }
  });
});
