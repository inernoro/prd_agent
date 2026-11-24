import { describe, expect, it } from 'vitest';
import {
  ALIGNED_DIRECTIONS,
  PLACEMENT_PAD,
  FALLBACK_ITEM_SIZE,
  alignedSlot,
  anchorRectOf,
  findAlignedFreeTopLeft,
  itemRect,
  occupiedRects,
  occupiesSpace,
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

describe('itemRect / occupiedRects：尺寸未知的元素也必须占地方', () => {
  it('【关键】尺寸未知时绝不退成 1×1', () => {
    // 1×1 不是「小」，是「不存在」——落位搜索会把这块区域当空的，新图直接压上去。
    // 这正是「首页带图进画板，生成图叠在参考图上」的根因。
    const r = itemRect({ kind: 'image', src: 'x', x: 0, y: 0 });
    expect(r.w).toBe(FALLBACK_ITEM_SIZE);
    expect(r.h).toBe(FALLBACK_ITEM_SIZE);
    expect(r.w).toBeGreaterThan(1);
  });

  it('显式 w/h 优先，其次图片自身像素尺寸', () => {
    expect(itemRect({ src: 'x', w: 50, h: 60, naturalW: 900, naturalH: 900 })).toMatchObject({ w: 50, h: 60 });
    expect(itemRect({ src: 'x', naturalW: 900, naturalH: 700 })).toMatchObject({ w: 900, h: 700 });
  });

  it('空占位不占地方，运行中的占位占', () => {
    expect(occupiesSpace({ kind: 'image', src: '' })).toBe(false);
    expect(occupiesSpace({ kind: 'image', src: '', status: 'running' })).toBe(true);
    expect(occupiesSpace({ kind: 'text' })).toBe(true);
  });

  it('【关键】只有像素尺寸、没有显式 w/h 的参考图，必须挡住新图', () => {
    // 复现真实那一幕：首页带图进画板，参考图从资产列表重建 —— 后端没存 width/height，
    // 所以 w/h 是 undefined，只有图片加载后补上的 naturalW/H 是 2400×2400。
    //
    // 这条能区分两种实现：旧写法 `w: x.w ?? 1` 不看 naturalW，碰撞表里它是 1×1，
    // 1024 的新图会落在真实边框内部；新写法退到 naturalW，落位才真的躲开。
    // 断言比的是**它真正占的那块 2400 见方**，不随实现缩水，所以不会两边都绿。
    const ref = { kind: 'image', src: 'ref', x: 0, y: 0, naturalW: 2400, naturalH: 2400 };
    const trueBox = { x: 0, y: 0, w: 2400, h: 2400 };

    const pos = findAlignedFreeTopLeft(occupiedRects([ref]), 1024, 1024, itemRect(ref));
    expect(pos).not.toBeNull();

    const placed = { x: pos!.x, y: pos!.y, w: 1024, h: 1024 };
    const overlaps =
      placed.x < trueBox.x + trueBox.w && placed.x + placed.w > trueBox.x &&
      placed.y < trueBox.y + trueBox.h && placed.y + placed.h > trueBox.y;
    expect(overlaps, '新图不得压在参考图真实边框内').toBe(false);
  });
});

describe('anchorRectOf', () => {
  it('没落过位的元素当不了锚点（不能拿 0,0 硬凑）', () => {
    expect(anchorRectOf({ src: 'x', w: 100, h: 100 })).toBeNull();
    expect(anchorRectOf(null)).toBeNull();
  });

  it('有坐标就能当锚点，尺寸未知也算数（走兜底档，不是不算）', () => {
    expect(anchorRectOf({ src: 'x', x: 5, y: 6 })).toEqual({ x: 5, y: 6, w: FALLBACK_ITEM_SIZE, h: FALLBACK_ITEM_SIZE });
  });
});
