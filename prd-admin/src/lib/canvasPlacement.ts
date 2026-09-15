/**
 * 画布落位：把新图摆在锚点旁边，而不是「离视口中心最近的那个空格」。
 *
 * 为什么不复用最近空位搜索：那个算法按 48px 网格从一个点向外找第一个不碰撞的位置，
 * 结果是「不重叠」但边缘全是碎的——两张图差 13px、下一张又偏 37px，画布很快乱成一片。
 * 用户要的是「贴着这张图的左边或右边、上面或下面，摆整齐」，所以落位必须**共边对齐**：
 * 左右放时上边缘齐平，上下放时左边缘齐平，间距恒定。
 */

export type PlacementRect = { x: number; y: number; w: number; h: number };

/**
 * 画布上任何「占了地方」的元素，落位时必须看得见它。
 *
 * 结构化最小类型：只声明落位需要的字段，不依赖画布组件里那个几十个字段的 CanvasImageItem。
 */
export type PlaceableItem = {
  kind?: string;
  src?: string;
  status?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  naturalW?: number;
  naturalH?: number;
};

/**
 * 尺寸未知时按多大算。
 *
 * **绝不能退到 1**。1×1 不是「小」，是「这个元素不存在」——落位搜索会把它所在的整片
 * 区域当成空的，新图直接压上去。这正是「首页带图进画板，生成图和参考图叠在一起」的根因：
 * 首页上传参考图没带 width/height，后端只在客户端给了才存，新画板从资产列表重建画布时
 * w/h 就是 undefined，于是一张 2400×2400 的图在碰撞表里是原点上的一个点。
 *
 * 320 不是新数字，是画布组件里已经在用的同一档兜底（选中框、边界框都用它）。
 */
export const FALLBACK_ITEM_SIZE = 320;

/** 单个元素占的矩形。尺寸优先取显式 w/h，其次图片本身的像素尺寸，最后才是兜底档。 */
export function itemRect(it: PlaceableItem): PlacementRect {
  return {
    x: it.x ?? 0,
    y: it.y ?? 0,
    w: Math.max(1, Math.round(it.w ?? it.naturalW ?? FALLBACK_ITEM_SIZE)),
    h: Math.max(1, Math.round(it.h ?? it.naturalH ?? FALLBACK_ITEM_SIZE)),
  };
}

/** 这个元素在画布上占地方吗（空的图片占位、已删除的元素不算）。 */
export function occupiesSpace(it: PlaceableItem): boolean {
  const kind = it.kind ?? 'image';
  return kind === 'generator' || kind === 'shape' || kind === 'text'
    || !!it.src || it.status === 'running' || it.status === 'error';
}

/** 落位用的碰撞表。三处落位（生成 / 上传 / 拖入）必须走这一个，否则改一处漏两处。 */
export function occupiedRects(items: readonly PlaceableItem[]): PlacementRect[] {
  return items.filter(occupiesSpace).map(itemRect);
}

/**
 * 把一个元素当作对齐锚点。没落过位（缺坐标）就不能当锚点——返回 null，
 * 让调用方退回最近空位搜索，而不是拿 (0,0) 硬凑一个假锚点。
 */
export function anchorRectOf(it: PlaceableItem | null | undefined): PlacementRect | null {
  if (!it) return null;
  if (typeof it.x !== 'number' || typeof it.y !== 'number') return null;
  return itemRect(it);
}

/** 落位方向的优先级：先左右（读起来是一排），放不下才上下。 */
export const ALIGNED_DIRECTIONS = ['right', 'left', 'down', 'up'] as const;
export type AlignedDirection = (typeof ALIGNED_DIRECTIONS)[number];

/** 与既有元素的最小空隙。与 findNearestFreeTopLeft 的碰撞 padding 同源，改一处即可。 */
export const PLACEMENT_PAD = 18;

/**
 * 间距按两张图里较小的那条边取 4%，并夹在 [24, 96]。
 *
 * 下限必须**大于** PLACEMENT_PAD：锚点自己就在 existing 里，若间距 ≤ padding，
 * 紧贴锚点的第一个候选会被锚点自己判成碰撞，四个方向全废，静默退回最近空位搜索——
 * 对齐逻辑接了等于没接。
 */
export function placementGap(a: PlacementRect, w: number, h: number): number {
  const base = Math.min(a.w, a.h, w, h) * 0.04;
  return Math.max(PLACEMENT_PAD + 6, Math.min(96, Math.round(base)));
}

function intersects(a: PlacementRect, b: PlacementRect, pad: number): boolean {
  return (
    a.x - pad < b.x + b.w &&
    a.x + a.w + pad > b.x &&
    a.y - pad < b.y + b.h &&
    a.y + a.h + pad > b.y
  );
}

/**
 * 第 k 条车道上、某个方向的对齐落位。k 从 1 起，同方向顺延成一排。
 * 顺延步长用**新图自己**的尺寸，所以连着放 n 张时排距恒定、不会越排越松。
 */
export function alignedSlot(
  a: PlacementRect,
  w: number,
  h: number,
  dir: AlignedDirection,
  k: number,
  gap: number
): { x: number; y: number } {
  const i = Math.max(1, Math.round(k)) - 1;
  switch (dir) {
    case 'right':
      return { x: Math.round(a.x + a.w + gap + i * (w + gap)), y: Math.round(a.y) };
    case 'left':
      return { x: Math.round(a.x - gap - w - i * (w + gap)), y: Math.round(a.y) };
    case 'down':
      return { x: Math.round(a.x), y: Math.round(a.y + a.h + gap + i * (h + gap)) };
    case 'up':
      return { x: Math.round(a.x), y: Math.round(a.y - gap - h - i * (h + gap)) };
  }
}

/**
 * 找一个贴着 anchor、且不与任何 existing 重叠的对齐落位。
 *
 * 按车道由近及远、每条车道内按 右→左→下→上 的顺序试。四个方向 lanes 条车道全占满时
 * 返回 null——调用方据此退回最近空位搜索，**不要**在这里硬塞一个重叠的位置。
 */
export function findAlignedFreeTopLeft(
  existing: PlacementRect[],
  w: number,
  h: number,
  anchor: PlacementRect,
  opts?: { gap?: number; pad?: number; lanes?: number }
): { x: number; y: number } | null {
  const width = Math.max(1, Math.round(w));
  const height = Math.max(1, Math.round(h));
  const pad = opts?.pad ?? PLACEMENT_PAD;
  const gap = Math.max(pad + 2, opts?.gap ?? placementGap(anchor, width, height));
  const lanes = Math.max(1, opts?.lanes ?? 4);

  for (let k = 1; k <= lanes; k++) {
    for (const dir of ALIGNED_DIRECTIONS) {
      const p = alignedSlot(anchor, width, height, dir, k, gap);
      const cand = { x: p.x, y: p.y, w: width, h: height };
      if (!existing.some((r) => intersects(cand, r, pad))) return p;
    }
  }
  return null;
}
