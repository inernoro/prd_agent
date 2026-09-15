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

export type VerticalClampInput = {
  stageTop: number;
  stageBottom: number;
  elementTop: number;
  elementBottom: number;
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
 * 返回浮层相对原始锚点应采用的绝对屏幕纵向偏移，避免图片贴近画布顶部时操作栏被裁掉。
 */
export function computeVerticalClampShift({
  stageTop,
  stageBottom,
  elementTop,
  elementBottom,
  currentShift = 0,
  padding = 12,
}: VerticalClampInput): number {
  const safeTop = stageTop + padding;
  const safeBottom = stageBottom - padding;
  const rawTop = elementTop - currentShift;
  const rawBottom = elementBottom - currentShift;
  const height = Math.max(0, elementBottom - elementTop);
  const available = Math.max(0, safeBottom - safeTop);

  if (height > available) return safeTop - rawTop;
  if (rawTop < safeTop) return safeTop - rawTop;
  if (rawBottom > safeBottom) return safeBottom - rawBottom;
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

  const hitAt = (x: number) => boxes.filter((box) => (
    x + w > box.x && box.x + box.w > x && y + h > box.y && box.y + box.h > y
  ));

  // 撞上了就**跨过挡路的那个**，而不是整整跳一个原图宽度。
  //
  // 旧写法是 `x += w + gap`：原图 2400 宽时，哪怕挡路的只是一张 1024 的小图，
  // 副本也要往右挪 2520px，中间留下一大片空。原图若是带透明边距的方图（可见内容
  // 只占中间一条），用户看到的就是「副本飞到了视野之外」——2026-09-02 反馈
  // 「隔得太远了吧，我记得应该就在附近啊，怎么算的这是」。
  //
  // 跨过挡路者的右边缘再加一个间距，既保住「副本在原图右侧、并排可比较」这条
  // 用户口述的规则，又不会凭空多留一整幅图的空白。
  let x = Math.round(sourceX + w + gap);
  for (let step = 0; step < 24; step += 1) {
    const hits = hitAt(x);
    if (hits.length === 0) break;
    const nextX = Math.round(Math.max(...hits.map((box) => box.x + box.w)) + gap);
    // 防呆：挡路者的右边缘若不比当前候选更靠右（异常尺寸），仍按老办法推进，避免原地死循环。
    x = nextX > x ? nextX : Math.round(x + w + gap);
  }
  return { x, y, w, h };
}

/**
 * 追踪一组图层「此刻」落在哪。
 *
 * {@link planLayeredCopyRect} 挑的空地只在开跑那一刻成立，但生成要几十秒，用户完全可能
 * 中途把这个 Frame 拖到别处。后续到达的图层若还按开跑时的坐标落位，就会跑回最初那块地上
 * 渲染（2026-08-11 用户实测：拆分途中把 Frame 移走，图层仍在原位置渲染）。
 *
 * 锚点取「还没被裁剪的占位卡」：它精确落在这一组的原点上，用户拖整组时它跟着走。
 * 全部裁完后锚点消失，此时保留最后一次读到的值——所以返回的是有记忆的读取器，
 * 而不是每次现算的纯查询，否则收尾的视角适配会跳回最初那块地。
 */
export type LiveGroupOriginCandidate = SemanticLayerMetadata & {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** 有值 = 这一层已按内容裁剪过，它的坐标是裁剪后的落点，不再代表组原点。 */
  layerHomeX?: number;
};

export function createLiveGroupOrigin(groupId: string, seed: SemanticLayerPlacement) {
  let current: SemanticLayerPlacement = { ...seed };
  return (items: ReadonlyArray<LiveGroupOriginCandidate>): SemanticLayerPlacement => {
    const anchor = items.find((candidate) => candidate.layerGroupId === groupId
      && candidate.layerRole === 'layer'
      && !Number.isFinite(candidate.layerHomeX as number));
    if (!anchor) return current;
    if (Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) {
      current = { ...current, x: Number(anchor.x), y: Number(anchor.y) };
    }
    // 尺寸同理。占位卡没有「生成中不许改大小」这道门（canResize 只看是不是单选），
    // 用户完全可以在等待期把它拽大一圈；后到的图层若还按开跑时的尺寸摊开，
    // 就会和用户眼前那个框对不上——和「拖走之后跑回原位」是同一个洞的另一半。
    if (Number.isFinite(anchor.w) && Number.isFinite(anchor.h)
      && Number(anchor.w) > 0 && Number(anchor.h) > 0) {
      current = { ...current, w: Number(anchor.w), h: Number(anchor.h) };
    }
    return current;
  };
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
