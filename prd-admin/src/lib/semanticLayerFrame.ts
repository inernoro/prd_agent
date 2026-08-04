export type SemanticLayerRole = 'source' | 'layer';

export type SemanticLayerMetadata = {
  layerGroupId?: string;
  layerSourceKey?: string;
  layerIndex?: number;
  layerRole?: SemanticLayerRole;
};

export type SemanticLayerCanvasItem = SemanticLayerMetadata & {
  key: string;
  prompt?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
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
  x: number;
  y: number;
  w: number;
  h: number;
};

const FRAME_PADDING = 28;
const FRAME_HEADER = 46;
const CARD_GAP = 24;
const SOURCE_GAP = 120;
const CARD_MAX_WIDTH = 360;

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
 * 将透明 RGBA 图层放在原图右侧的 Frame 中。
 * 每个卡片保持原图比例，图层内部坐标因此仍与原始构图一致。
 */
export function planSemanticLayerFrame(
  source: Pick<SemanticLayerCanvasItem, 'x' | 'y' | 'w' | 'h'>,
  layerCount: number,
): { frame: Omit<SemanticLayerFrame, 'id' | 'sourceKey' | 'name' | 'layerKeys'>; placements: SemanticLayerPlacement[] } {
  const count = Math.max(1, Math.min(10, Math.round(layerCount)));
  const sourceX = Number.isFinite(source.x) ? Number(source.x) : 0;
  const sourceY = Number.isFinite(source.y) ? Number(source.y) : 0;
  const sourceW = positive(source.w, 1024);
  const sourceH = positive(source.h, 1024);
  const scale = Math.min(1, CARD_MAX_WIDTH / sourceW);
  const cardW = Math.max(120, Math.round(sourceW * scale));
  const cardH = Math.max(120, Math.round(sourceH * scale));
  const columns = count === 1 ? 1 : Math.min(2, count);
  const rows = Math.ceil(count / columns);
  const frameX = Math.round(sourceX + sourceW + SOURCE_GAP);
  const frameY = Math.round(sourceY);
  const frameW = FRAME_PADDING * 2 + columns * cardW + (columns - 1) * CARD_GAP;
  const frameH = FRAME_HEADER + FRAME_PADDING + rows * cardH + (rows - 1) * CARD_GAP + FRAME_PADDING;

  const placements = Array.from({ length: count }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      x: frameX + FRAME_PADDING + column * (cardW + CARD_GAP),
      y: frameY + FRAME_HEADER + FRAME_PADDING + row * (cardH + CARD_GAP),
      w: cardW,
      h: cardH,
    };
  });

  return {
    frame: { x: frameX, y: frameY, w: frameW, h: frameH },
    placements,
  };
}

/** 根据可独立移动的图层重新计算 Frame 边界，刷新后也能恢复。 */
export function collectSemanticLayerFrames(items: SemanticLayerCanvasItem[]): SemanticLayerFrame[] {
  const sources = new Map<string, SemanticLayerCanvasItem>();
  const layers = new Map<string, SemanticLayerCanvasItem[]>();

  for (const item of items) {
    const groupId = String(item.layerGroupId ?? '').trim();
    if (!groupId) continue;
    if (item.layerRole === 'source') sources.set(groupId, item);
    if (item.layerRole === 'layer') {
      const bucket = layers.get(groupId) ?? [];
      bucket.push(item);
      layers.set(groupId, bucket);
    }
  }

  const frames: SemanticLayerFrame[] = [];
  for (const [groupId, groupLayers] of layers) {
    if (groupLayers.length === 0) continue;
    const sorted = [...groupLayers].sort((a, b) => (a.layerIndex ?? 0) - (b.layerIndex ?? 0));
    const minX = Math.min(...sorted.map((item) => Number.isFinite(item.x) ? Number(item.x) : 0));
    const minY = Math.min(...sorted.map((item) => Number.isFinite(item.y) ? Number(item.y) : 0));
    const maxX = Math.max(...sorted.map((item) => (Number.isFinite(item.x) ? Number(item.x) : 0) + positive(item.w, 320)));
    const maxY = Math.max(...sorted.map((item) => (Number.isFinite(item.y) ? Number(item.y) : 0) + positive(item.h, 320)));
    const source = sources.get(groupId);

    frames.push({
      id: groupId,
      sourceKey: source?.key || sorted[0]?.layerSourceKey || '',
      name: String(source?.prompt || 'AI 分层').trim() || 'AI 分层',
      layerKeys: sorted.map((item) => item.key),
      x: minX - FRAME_PADDING,
      y: minY - FRAME_HEADER - FRAME_PADDING,
      w: maxX - minX + FRAME_PADDING * 2,
      h: maxY - minY + FRAME_HEADER + FRAME_PADDING * 2,
    });
  }

  return frames;
}
