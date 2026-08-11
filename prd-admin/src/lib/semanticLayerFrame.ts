export type SemanticLayerRole = 'source' | 'layer';

export type SemanticLayerMetadata = {
  /**
   * 通用编组标识（Figma 心智的 Frame）。
   *
   * 和 layerGroupId 分开是有意的：layerGroupId 说「这是哪一次分层的产物」，
   * 是产物血缘，解组不该把它抹掉；frameId 说「这些东西现在被框在一起」，
   * 是用户的组织意图，随时可以 Cmd+G / Cmd+Shift+G 改。
   * AI 分层落地时两者初值相同，之后各走各的。
   */
  frameId?: string;
  layerGroupId?: string;
  layerSourceKey?: string;
  layerIndex?: number;
  layerRole?: SemanticLayerRole;
  /** 图层面板的显隐 / 不透明度 / 叠放次序；缺省分别是「可见 / 1 / 按 layerIndex」。 */
  layerHidden?: boolean;
  layerOpacity?: number;
  layerZ?: number;
};

export type SemanticLayerCanvasItem = SemanticLayerMetadata & {
  key: string;
  prompt?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
};

export type ExportableLayerCandidate = SemanticLayerMetadata & {
  key: string;
  src?: string;
  createdAt?: number;
};

export type SemanticLayerPlacement = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type SemanticLayerFrame = {
  id: string;
  sourceKey: string;
  name: string;
  layerKeys: string[];
  /**
   * ai-layers = 由一次 AI 分层产出（能开图层面板、能导出 PSD 图层组）；
   * group = 用户自己 Cmd+G 框起来的一堆元素。
   * 两者的 Frame 外观一致，但能做的事不同，所以必须区分——
   * 给一个普通编组显示「图层面板」按钮，点开是空的。
   */
  kind: 'ai-layers' | 'group';
  /** ai-layers 才有：这一组图层属于哪一次分层。 */
  layerGroupId?: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

const FRAME_PADDING = 28;
const FRAME_HEADER = 46;
const CARD_GAP = 64;
const SOURCE_GAP = 120;

export type HorizontalClampInput = {
  stageLeft: number;
  stageRight: number;
  elementLeft: number;
  elementRight: number;
  currentShift?: number;
  padding?: number;
};

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 返回浮层相对原始锚点应采用的绝对屏幕横向偏移，避免被画布外的聊天面板遮挡。
 */
export function computeHorizontalClampShift({
  stageLeft,
  stageRight,
  elementLeft,
  elementRight,
  currentShift = 0,
  padding = 12,
}: HorizontalClampInput): number {
  const safeLeft = stageLeft + padding;
  const safeRight = stageRight - padding;
  const rawLeft = elementLeft - currentShift;
  const rawRight = elementRight - currentShift;
  const width = Math.max(0, elementRight - elementLeft);
  const available = Math.max(0, safeRight - safeLeft);

  if (width > available) return safeLeft - rawLeft;
  if (rawLeft < safeLeft) return safeLeft - rawLeft;
  if (rawRight > safeRight) return safeRight - rawRight;
  return 0;
}

/**
 * 把透明 RGBA 图层排在原图右侧的 Frame 里。
 *
 * 两种摆法，默认「原位」：
 *
 * - **stacked（默认）**：所有部件按原图坐标叠回原位，画面看起来和原图一模一样，
 *   区别只是现在每一块都能单独选中、拖动。用户多数时候只是想「把 logo 挪一点」
 *   或者「人物靠左一点点」——摊开成一排的话，他还得自己拼回去，那是倒忙
 *   （2026-08-10 反馈：「分层之后不应该展开，而是还在原来的位置」）。
 * - **spread**：横向一排铺开，用来逐块检视。作为可切换的视图，不是默认。
 *
 * 一排摆法里图层一律按原图尺寸，不缩成小卡片墙——那样和原图不是同一个坐标系，
 * 既对不上位也看不清内容（2026-08-07 反馈）。
 */
export type SemanticLayerLayoutMode = 'stacked' | 'spread';

/**
 * 给这次分层挑一块**空地**：原图右侧、与原图等大、不压住画布上任何既有元素。
 *
 * 这是「可拆解副本」的落位规则，也是用户口述的第一步——「点击分层 → 在当前图片右侧
 * 创建一个同等大小的新图片 → 再开始生成」。两条都不能省：
 *
 * - **原图必须原封不动**。副本盖在原图上（哪怕像素一致）会让用户失去参照，
 *   也让「拆坏了重来」变成不可能。
 * - **同一张图拆多次要各占一块地**。第二次拆不是「覆盖第一次」，而是右边再多一个副本；
 *   两次结果并排，用户才能比较着挑（2026-08-11 反馈：「我重新生成新的图层时候，
 *   他居然将原来的清理掉了？」）。
 *
 * 找法很朴素：从原图右侧第一格起，一格一格往右挪，直到这一格不与任何既有元素相交。
 * 上限 24 格是防呆——真挪不动就落在最后一格上，宁可重叠也不能死循环。
 */
export function planLayeredCopyRect(input: {
  source: Pick<SemanticLayerCanvasItem, 'x' | 'y' | 'w' | 'h'>;
  /** 画布上所有已占位的元素（含原图自己，它天然会挡住第 0 格）。 */
  occupied: ReadonlyArray<Pick<SemanticLayerCanvasItem, 'x' | 'y' | 'w' | 'h'>>;
  gap?: number;
}): SemanticLayerPlacement {
  const sourceX = Number.isFinite(input.source.x) ? Number(input.source.x) : 0;
  const sourceY = Number.isFinite(input.source.y) ? Number(input.source.y) : 0;
  const w = Math.round(positive(input.source.w, 1024));
  const h = Math.round(positive(input.source.h, 1024));
  const gap = Number.isFinite(input.gap) && (input.gap as number) > 0 ? Math.round(input.gap as number) : SOURCE_GAP;
  const y = Math.round(sourceY);

  const boxes = input.occupied
    .map((item) => ({
      x: Number.isFinite(item.x) ? Number(item.x) : 0,
      y: Number.isFinite(item.y) ? Number(item.y) : 0,
      w: positive(item.w, 0),
      h: positive(item.h, 0),
    }))
    .filter((box) => box.w > 0 && box.h > 0);

  const intersects = (x: number) => boxes.some((box) => (
    x + w > box.x && box.x + box.w > x && y + h > box.y && box.y + box.h > y
  ));

  let x = Math.round(sourceX + w + gap);
  for (let step = 0; step < 24 && intersects(x); step += 1) x += w + gap;
  return { x, y, w, h };
}

export function planSemanticLayerFrame(
  source: Pick<SemanticLayerCanvasItem, 'x' | 'y' | 'w' | 'h'>,
  layerCount: number,
  mode: SemanticLayerLayoutMode = 'stacked',
  /**
   * 副本落在哪。不传就退回「原地」——只有旧数据的兼容路径会走到，
   * 新的分层一律由 {@link planLayeredCopyRect} 先挑好空地再传进来。
   */
  copy?: SemanticLayerPlacement,
): { frame: { x: number; y: number; w: number; h: number }; placements: SemanticLayerPlacement[] } {
  const count = Math.max(1, Math.min(10, Math.round(layerCount)));
  const sourceX = Number.isFinite(source.x) ? Number(source.x) : 0;
  const sourceY = Number.isFinite(source.y) ? Number(source.y) : 0;
  const sourceW = positive(source.w, 1024);
  const sourceH = positive(source.h, 1024);
  const baseX = copy ? Math.round(copy.x) : Math.round(sourceX);
  const baseY = copy ? Math.round(copy.y) : Math.round(sourceY);
  const cardW = Math.round(copy ? positive(copy.w, sourceW) : sourceW);
  const cardH = Math.round(copy ? positive(copy.h, sourceH) : sourceH);

  if (mode === 'stacked') {
    // 每一块都落在副本那块矩形上：叠起来就和原图一模一样。
    // Frame 框住的也正是副本那块，头部标签靠它给出「这是一组分层」的提示。
    return {
      frame: { x: baseX, y: baseY, w: cardW, h: cardH },
      placements: Array.from({ length: count }, () => ({ x: baseX, y: baseY, w: cardW, h: cardH })),
    };
  }

  const frameX = baseX;
  const frameY = baseY;
  const frameW = FRAME_PADDING * 2 + count * cardW + (count - 1) * CARD_GAP;
  const frameH = FRAME_HEADER + FRAME_PADDING * 2 + cardH;

  const placements = Array.from({ length: count }, (_, index) => ({
    x: frameX + FRAME_PADDING + index * (cardW + CARD_GAP),
    y: frameY + FRAME_HEADER + FRAME_PADDING,
    w: cardW,
    h: cardH,
  }));

  return {
    frame: { x: frameX, y: frameY, w: frameW, h: frameH },
    placements,
  };
}

/**
 * 选出某个分层组里应该进 PSD 的图层：同一个 layerIndex 只保留最新的一版。
 *
 * 对某个图层做快捷编辑会产出一个继承同一 layerIndex 的新图层，画布上两版并存。
 * 导出必须取最新那版，否则「编辑完了导出的还是编辑前那张」——编辑在画布上看得见、
 * 在 PSD 里却消失。反过来，编辑还在跑或者失败时产物 src 为空、会被这里滤掉，
 * 导出自动回落到原图层，不会导出一张空层。
 *
 * layerIndex 缺失时按 key 各成一桶，避免把两个无序号的图层误合并成一层。
 */
export function selectExportableLayers<T extends ExportableLayerCandidate>(
  items: readonly T[],
  groupId: string,
  options?: {
    /**
     * 图层面板要连「还没出图的占位层」一起列出来（用户要看见空位在生成中），
     * 而导出链路必须把它们滤掉。同一套分桶逻辑只此一份，靠这个开关分流，
     * 不允许再抄一份「几乎一样但不完全一样」的挑选函数。
     */
    includeEmpty?: boolean;
  },
): T[] {
  const normalizedGroupId = String(groupId ?? '').trim();
  if (!normalizedGroupId) return [];
  const includeEmpty = options?.includeEmpty === true;

  const latestPerIndex = new Map<string, T>();
  for (const item of items) {
    if (String(item.layerGroupId ?? '').trim() !== normalizedGroupId) continue;
    if (item.layerRole !== 'layer') continue;
    if (!item.src && !includeEmpty) continue;

    const bucket = typeof item.layerIndex === 'number' ? `#${item.layerIndex}` : `key:${item.key}`;
    const current = latestPerIndex.get(bucket);
    // 同一层的多个版本里，空 src 的那版永远不该盖掉已经出图的那版
    // （否则「编辑中」会把编辑前的成品从面板和导出里挤掉）。
    if (!current) {
      latestPerIndex.set(bucket, item);
      continue;
    }
    const currentHasSrc = !!current.src;
    const itemHasSrc = !!item.src;
    if (currentHasSrc && !itemHasSrc) continue;
    if ((!currentHasSrc && itemHasSrc) || (item.createdAt ?? 0) >= (current.createdAt ?? 0)) {
      latestPerIndex.set(bucket, item);
    }
  }

  return [...latestPerIndex.values()].sort(compareStackOrder);
}

/** 叠放次序：优先用面板调过的 layerZ，没调过就回落到分层序号。 */
function compareStackOrder(a: ExportableLayerCandidate, b: ExportableLayerCandidate): number {
  const az = typeof a.layerZ === 'number' && Number.isFinite(a.layerZ) ? a.layerZ : (a.layerIndex ?? 0);
  const bz = typeof b.layerZ === 'number' && Number.isFinite(b.layerZ) ? b.layerZ : (b.layerIndex ?? 0);
  if (az !== bz) return az - bz;
  return (a.layerIndex ?? 0) - (b.layerIndex ?? 0);
}

/** 根据可独立移动的图层重新计算 Frame 边界，刷新后也能恢复。 */
export function collectSemanticLayerFrames(items: SemanticLayerCanvasItem[]): SemanticLayerFrame[] {
  // 原图按 key 反查，**不**靠「原图身上打了哪个 groupId」——一张图可以被拆很多次，
  // 身上只能记住最后一个组，前面几组的原图指针就全指错了。
  const byKey = new Map<string, SemanticLayerCanvasItem>();
  for (const item of items) byKey.set(item.key, item);
  const layers = new Map<string, SemanticLayerCanvasItem[]>();

  // 只按 frameId 分组。解组就是把 frameId 抹掉，所以这里**不能**再拿 layerGroupId 兜底——
  // 兜底会让「解组」对 AI 分层组完全失效（框还在，用户以为快捷键坏了）。
  // 旧数据没有 frameId，在读回时已由持久化层补成 layerGroupId。
  for (const item of items) {
    const frameId = String(item.frameId ?? '').trim();
    if (!frameId) continue;
    const bucket = layers.get(frameId) ?? [];
    bucket.push(item);
    layers.set(frameId, bucket);
  }

  const frames: SemanticLayerFrame[] = [];
  for (const [groupId, groupLayers] of layers) {
    if (groupLayers.length === 0) continue;
    const sorted = [...groupLayers].sort((a, b) => (a.layerIndex ?? 0) - (b.layerIndex ?? 0));
    const minX = Math.min(...sorted.map((item) => Number.isFinite(item.x) ? Number(item.x) : 0));
    const minY = Math.min(...sorted.map((item) => Number.isFinite(item.y) ? Number(item.y) : 0));
    const maxX = Math.max(...sorted.map((item) => (Number.isFinite(item.x) ? Number(item.x) : 0) + positive(item.w, 320)));
    const maxY = Math.max(...sorted.map((item) => (Number.isFinite(item.y) ? Number(item.y) : 0) + positive(item.h, 320)));
    const aiLayers = sorted.filter((item) => item.layerRole === 'layer');
    const isAi = aiLayers.length > 0;
    const sourceKey = String(aiLayers[0]?.layerSourceKey ?? '').trim();
    const source = sourceKey ? byKey.get(sourceKey) : undefined;
    const layerGroupId = String(aiLayers[0]?.layerGroupId ?? '').trim();

    frames.push({
      id: groupId,
      kind: isAi ? 'ai-layers' : 'group',
      layerGroupId: isAi ? (layerGroupId || undefined) : undefined,
      sourceKey: source?.key || sourceKey,
      name: isAi
        ? (String(source?.prompt || 'AI 分层').trim() || 'AI 分层')
        : `${sorted.length} 个元素`,
      layerKeys: sorted.map((item) => item.key),
      x: minX - FRAME_PADDING,
      y: minY - FRAME_HEADER - FRAME_PADDING,
      w: maxX - minX + FRAME_PADDING * 2,
      h: maxY - minY + FRAME_HEADER + FRAME_PADDING * 2,
    });
  }

  return frames;
}
