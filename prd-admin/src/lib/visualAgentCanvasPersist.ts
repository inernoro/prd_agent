/**
 * VisualAgent Canvas 持久化工具
 *
 * 核心逻辑：
 * 1. canvasToPersistedV1: 将内存中的 canvas 状态转换为可持久化的 JSON
 * 2. persistedV1ToCanvas: 从持久化的 JSON 恢复 canvas 状态
 *
 * 关键点：
 * - running 状态的占位元素必须被保存，以便后端能够回填
 * - 使用 id 字段作为元素标识（与后端保持一致）
 */

// ============ 类型定义 ============

export type PersistedCanvasElementV1 =
  | {
      id: string;
      kind: 'image';
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      z?: number;
      name?: string;
      assetId?: string;
      src?: string;
      sha256?: string;
      naturalW?: number;
      naturalH?: number;
      locked?: boolean;
      hidden?: boolean;
      /** 占位状态：running 表示生成中，后端会回填 */
      status?: 'running' | 'error';
      /** 图片引用 ID，用于消息中的 @imgN 引用，持久化保存 */
      refId?: number;
      ext?: Record<string, unknown>;
    }
  | {
      id: string;
      kind: 'generator';
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      z?: number;
      name?: string;
      prompt?: string;
      requestedSize?: string | null;
      effectiveSize?: string | null;
      sizeAdjusted?: boolean;
      ratioAdjusted?: boolean;
      locked?: boolean;
      hidden?: boolean;
      ext?: Record<string, unknown>;
    }
  | {
      id: string;
      kind: 'shape';
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      z?: number;
      shapeType?: 'rect' | 'circle' | 'triangle' | 'star';
      fill?: string;
      stroke?: string;
      locked?: boolean;
      hidden?: boolean;
      ext?: Record<string, unknown>;
    }
  | {
      id: string;
      kind: 'text';
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      z?: number;
      text?: string;
      fontSize?: number;
      textColor?: string;
      fill?: string;
      stroke?: string;
      locked?: boolean;
      hidden?: boolean;
      ext?: Record<string, unknown>;
    };

export interface PersistedCanvasStateV1 {
  schemaVersion: 1;
  meta?: Record<string, unknown>;
  elements: PersistedCanvasElementV1[];
}

export interface CanvasImageItem {
  key: string;
  createdAt: number;
  prompt: string;
  src: string;
  status: 'done' | 'error' | 'running';
  kind?: 'image' | 'generator' | 'shape' | 'text';
  assetId?: string;
  sha256?: string;
  syncStatus?: 'pending' | 'synced' | 'failed';
  syncError?: string | null;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  naturalW?: number;
  naturalH?: number;
  userResized?: boolean;
  refId?: number;
  // generator 专用
  requestedSize?: string | null;
  effectiveSize?: string | null;
  sizeAdjusted?: boolean;
  ratioAdjusted?: boolean;
  errorMessage?: string | null;
  // shape 专用
  shapeType?: 'rect' | 'circle' | 'triangle' | 'star';
  fill?: string;
  stroke?: string;
  // text 专用
  text?: string;
  fontSize?: number;
  textColor?: string;
}

export interface ImageAsset {
  id: string;
  url?: string;
  sha256?: string;
  prompt?: string;
  width?: number;
  height?: number;
}

// ============ 常量 ============

export const PERSIST_SCHEMA_VERSION = 1 as const;
export const MAX_PERSIST_ELEMENTS = 200;

// ============ 辅助函数 ============

export function isRemoteImageSrc(src: string): boolean {
  const s = String(src ?? '').trim();
  if (!s) return false;
  if (s.startsWith('data:')) return false;
  if (s.startsWith('/api/')) return true;
  return /^https?:\/\//i.test(s);
}

// ============ 核心函数 ============

/**
 * 将内存中的 canvas 状态转换为可持久化的 JSON
 *
 * 关键逻辑：
 * - 对于 image 类型，如果有 assetId 或远程 src 或是占位状态（running/error），则保存
 * - 对于 data:/blob: 本地图片，跳过并计入 skippedLocalOnlyImages
 */
export function canvasToPersistedV1(items: CanvasImageItem[]): {
  state: PersistedCanvasStateV1;
  skippedLocalOnlyImages: number;
} {
  const els: PersistedCanvasElementV1[] = [];
  let skippedLocalOnlyImages = 0;
  const src = Array.isArray(items) ? items : [];

  for (let i = 0; i < src.length && els.length < MAX_PERSIST_ELEMENTS; i++) {
    const it = src[i]!;
    const kind = (it.kind ?? 'image') as PersistedCanvasElementV1['kind'];
    const base = {
      id: String(it.key ?? '').trim() || `el_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      kind,
      x: it.x,
      y: it.y,
      w: it.w,
      h: it.h,
      z: i,
      name: String(it.prompt ?? '').trim() || undefined,
    };

    if (kind === 'image') {
      const assetId = String(it.assetId ?? '').trim();
      const srcOk = isRemoteImageSrc(it.src);
      const isPlaceholder = it.status === 'running' || it.status === 'error';

      if (!assetId && !srcOk && !isPlaceholder) {
        // 仅把"真正的本地临时内容"计入 skipped：
        // - data: / blob: 属于本地内容，刷新后无法从服务器恢复 => 计数并提示
        // - 空 src（例如生图占位 running/error）不应被误判为"本地临时内容"
        const rawSrc = String(it.src ?? '').trim();
        if (rawSrc && (rawSrc.startsWith('data:') || rawSrc.startsWith('blob:'))) {
          skippedLocalOnlyImages += 1;
        }
        continue;
      }

      els.push({
        ...base,
        kind: 'image',
        assetId: assetId || undefined,
        src: srcOk ? it.src : undefined,
        sha256: String(it.sha256 ?? '').trim() || undefined,
        naturalW: it.naturalW,
        naturalH: it.naturalH,
        // 保存占位状态，以便后端回填时能找到目标元素
        status: isPlaceholder ? (it.status as 'running' | 'error') : undefined,
        // 持久化 refId，用于消息中的 @imgN 引用
        refId: typeof it.refId === 'number' && it.refId > 0 ? it.refId : undefined,
        ext: {},
      });
    } else if (kind === 'generator') {
      els.push({
        ...base,
        kind: 'generator',
        prompt: String(it.prompt ?? '').trim() || undefined,
        requestedSize: it.requestedSize ?? null,
        effectiveSize: it.effectiveSize ?? null,
        sizeAdjusted: Boolean(it.sizeAdjusted),
        ratioAdjusted: Boolean(it.ratioAdjusted),
        ext: {},
      });
    } else if (kind === 'shape') {
      els.push({
        ...base,
        kind: 'shape',
        shapeType: it.shapeType,
        fill: it.fill,
        stroke: it.stroke,
        ext: {},
      });
    } else if (kind === 'text') {
      els.push({
        ...base,
        kind: 'text',
        text: it.text,
        fontSize: it.fontSize,
        textColor: it.textColor,
        fill: it.fill,
        stroke: it.stroke,
        ext: {},
      });
    }
  }

  return {
    state: { schemaVersion: 1, meta: { skippedLocalOnlyImages }, elements: els },
    skippedLocalOnlyImages,
  };
}

/**
 * 从持久化的 JSON 恢复 canvas 状态
 *
 * 关键逻辑：
 * - 对于 image 类型，优先从 assets 中查找 URL
 * - 如果是占位状态（running/error），即使没有 src 也要恢复
 */
export function persistedV1ToCanvas(
  state: PersistedCanvasStateV1,
  assets: ImageAsset[]
): { canvas: CanvasImageItem[]; missingAssets: number; localOnlyImages: number } {
  const byId = new Map<string, ImageAsset>();
  for (const a of assets ?? []) {
    if (a?.id) byId.set(String(a.id), a);
  }

  const out: CanvasImageItem[] = [];
  let missingAssets = 0;
  let localOnlyImages = 0;
  const sorted = [...(state.elements ?? [])].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));

  for (const el of sorted) {
    const id = String(el.id ?? '').trim();
    if (!id) continue;

    if (el.kind === 'image') {
      const aid = String(el.assetId ?? '').trim();
      const a = aid ? byId.get(aid) : undefined;
      const src = a?.url || (isRemoteImageSrc(String(el.src ?? '')) ? String(el.src) : '');
      const isPlaceholder = el.status === 'running' || el.status === 'error';

      if (!src && !isPlaceholder) {
        if (!aid && !el.src) localOnlyImages += 1;
        else missingAssets += 1;
        continue;
      }

      const prompt = String(el.name ?? a?.prompt ?? '').trim();
      out.push({
        key: id,
        assetId: aid || a?.id,
        sha256: String(el.sha256 ?? a?.sha256 ?? '').trim() || undefined,
        createdAt: Date.now(),
        prompt,
        src,
        // 恢复占位状态：running 表示后端仍在生成中
        status: isPlaceholder ? el.status! : 'done',
        kind: 'image',
        syncStatus: src.startsWith('/api/visual-agent/image-master/assets/file/') || /^https?:\/\//i.test(src) ? 'synced' : 'pending',
        syncError: null,
        x: el.x,
        y: el.y,
        w: typeof el.w === 'number' && el.w > 0 ? el.w : a?.width || undefined,
        h: typeof el.h === 'number' && el.h > 0 ? el.h : a?.height || undefined,
        naturalW: typeof el.naturalW === 'number' && el.naturalW > 0 ? el.naturalW : a?.width || undefined,
        naturalH: typeof el.naturalH === 'number' && el.naturalH > 0 ? el.naturalH : a?.height || undefined,
        // 恢复持久化的 refId
        refId: typeof el.refId === 'number' && el.refId > 0 ? el.refId : undefined,
      });
    } else if (el.kind === 'generator') {
      out.push({
        key: id,
        createdAt: Date.now(),
        prompt: String(el.prompt ?? el.name ?? 'Image Generator'),
        src: '',
        status: 'done',
        kind: 'generator',
        x: el.x,
        y: el.y,
        w: el.w,
        h: el.h,
        requestedSize: el.requestedSize ?? null,
        effectiveSize: el.effectiveSize ?? null,
        sizeAdjusted: Boolean(el.sizeAdjusted),
        ratioAdjusted: Boolean(el.ratioAdjusted),
      });
    } else if (el.kind === 'shape') {
      out.push({
        key: id,
        createdAt: Date.now(),
        prompt: '',
        src: '',
        status: 'done',
        kind: 'shape',
        x: el.x,
        y: el.y,
        w: el.w,
        h: el.h,
        shapeType: el.shapeType,
        fill: el.fill,
        stroke: el.stroke,
      });
    } else if (el.kind === 'text') {
      out.push({
        key: id,
        createdAt: Date.now(),
        prompt: '',
        src: '',
        status: 'done',
        kind: 'text',
        x: el.x,
        y: el.y,
        w: el.w,
        h: el.h,
        text: el.text,
        fontSize: el.fontSize,
        textColor: el.textColor,
        fill: el.fill,
        stroke: el.stroke,
      });
    }
  }

  return { canvas: out, missingAssets, localOnlyImages };
}

// ============ refId 管理函数 ============

/**
 * 获取画布中已使用的最大 refId
 */
export function getMaxRefId(items: CanvasImageItem[]): number {
  let max = 0;
  for (const it of items) {
    if ((it.kind ?? 'image') === 'image' && typeof it.refId === 'number' && it.refId > max) {
      max = it.refId;
    }
  }
  return max;
}

/**
 * 为画布中没有 refId 的图片分配新的 refId
 * 返回是否有变更（用于判断是否需要保存）
 */
export function assignMissingRefIds(items: CanvasImageItem[]): boolean {
  let nextRefId = getMaxRefId(items) + 1;
  let changed = false;
  
  for (const it of items) {
    // 只为 image 类型（非 generator/shape/text）分配 refId
    if ((it.kind ?? 'image') === 'image' && (typeof it.refId !== 'number' || it.refId <= 0)) {
      it.refId = nextRefId++;
      changed = true;
    }
  }
  
  return changed;
}

/**
 * 为新添加的图片分配下一个可用的 refId
 */
export function allocateNextRefId(items: CanvasImageItem[]): number {
  return getMaxRefId(items) + 1;
}
