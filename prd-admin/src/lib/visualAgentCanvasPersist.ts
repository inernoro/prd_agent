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
 *
 * 这两个函数是**生产路径唯一实现**。历史上 AdvancedVisualAgentTab 里另有一份拷贝，
 * 真正在跑的是页面里那份，而单测跑的是本文件这份——两份逐渐漂移，本文件这份缺了
 * 图层显隐/不透明度/次序等字段，于是「分层相关的持久化」实际上从来没有被测过。
 * 2026-08-10 合并为一份：页面改为 import 本文件，测试与生产从此是同一段代码。
 */

import type { LayerContentKind } from './layerContentAnalysis';

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
      /** 关联的生图任务 ID，用于刷新页面后同步状态 */
      runId?: string;
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
  /**
   * 裁剪前的满幅原件。画布显示裁剪版（好抓好拖），导出必须用满幅版——
   * 导出链路按原图尺寸对齐叠放，喂裁剪版会被拉伸铺满整张画布。
   * 这两个字段在画布页的同名类型上早就有，这里是持久化模块自己的一份结构定义，
   * 少声明就落不了盘（也正是本次 tsc 抓到的三处报错）。
   */
  originalSrc?: string;
  originalSha256?: string;
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
  /** 关联的生图任务 ID，用于刷新页面后同步状态 */
  runId?: string;
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
  /** AI 语义分层 Frame 元数据。图层本身仍是可独立编辑的普通图片。 */
  /** 通用编组标识（Cmd+G / Cmd+Shift+G）。 */
  frameId?: string;
  layerGroupId?: string;
  layerSourceKey?: string;
  layerIndex?: number;
  layerRole?: 'source' | 'layer';
  /** 图层面板里被关掉了眼睛：合成预览、合成 PNG、PSD 都跳过它。 */
  layerHidden?: boolean;
  /** 图层不透明度 0–1，缺省视为 1。 */
  layerOpacity?: number;
  /** 叠放次序（小的在下）。缺省回落到 layerIndex。 */
  layerZ?: number;
  /** 内容判定：普通图层 / 近乎空层 / 近乎纯色 / 整张原图。 */
  layerContentKind?: LayerContentKind;
  /** 不透明像素占比 0–1。 */
  layerCoverage?: number;
  /** 本次向模型请求的层数。层数是期望值，实到几层由模型决定。 */
  layerRequestedCount?: number;
  /** 这一块在可拆解副本里的原位（最小非透明外接矩形）；从平铺切回原位靠它。 */
  layerHomeX?: number;
  layerHomeY?: number;
  layerHomeW?: number;
  layerHomeH?: number;
  /** 本次分层实际落到的模型。 */
  layerModel?: string;
  /** 用户这次用自然语言说的拆法。 */
  layerIntent?: string;
  /** 裁剪前的满幅原件：画布用裁剪版，导出必须用这一版。 */
  layerOriginalSrc?: string;
  layerOriginalSha256?: string;
}

export interface ImageAsset {
  id: string;
  url?: string;
  sha256?: string;
  /** 后端契约里这个字段可能是 null，别收窄成 undefined——收窄会让调用方类型对不上。 */
  prompt?: string | null;
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
// 枚举扩展要逐层接线（.claude/rules/enum-ripple-audit.md）：漏了这里，
// 新增的归类会在刷新后被判成非法值静默丢掉，那一行的事实就消失了。
const LAYER_CONTENT_KINDS: readonly LayerContentKind[] = ['layer', 'empty', 'solid', 'flat', 'source-reference'];

/** 读回数字字段：非有限值一律当没存过，绝不把 NaN 当坐标用。 */
function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isLayerContentKind(value: unknown): value is LayerContentKind {
  return typeof value === 'string' && (LAYER_CONTENT_KINDS as readonly string[]).includes(value);
}

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
        // 持久化 runId，用于刷新页面后同步状态
        runId: isPlaceholder && it.runId ? String(it.runId).trim() || undefined : undefined,
        // 分层归属必须落盘：不存的话刷新后 Frame 散架、图层退化成一堆散图，
        // 「复用已有图层」判不出来，导出 PSD 会再调一次模型。
        ext: {
          frameId: it.frameId,
          // 迁移标记：说明这条记录是「知道 frameId 这个字段」的版本写出来的。
          // 有它，读回时 frameId 缺失就是**真的没有编组**（用户解过组）；
          // 没有它才说明是旧数据，需要拿 layerGroupId 补一次。
          // 不区分这两者的后果：解组后刷新，Frame 会原地复活（冒烟实测）。
          frameMigrated: true,
          layerGroupId: it.layerGroupId,
          layerSourceKey: it.layerSourceKey,
          layerIndex: it.layerIndex,
          layerRole: it.layerRole,
          layerHidden: it.layerHidden,
          layerOpacity: it.layerOpacity,
          layerZ: it.layerZ,
          layerContentKind: it.layerContentKind,
          layerCoverage: it.layerCoverage,
          layerRequestedCount: it.layerRequestedCount,
          layerHomeX: it.layerHomeX,
          layerHomeY: it.layerHomeY,
          layerHomeW: it.layerHomeW,
          layerHomeH: it.layerHomeH,
          layerModel: it.layerModel,
          layerIntent: it.layerIntent,
          // 裁剪前的满幅原件。画布显示裁剪版，导出必须用满幅版（按原图尺寸对齐叠放，
          // 喂裁剪版会被拉伸铺满整张画布）。不落盘的话，刷新之后导出就悄悄退回错的那版
          // ——正是 snapshot-fallback 那条规则说的「快照有、兜底没有」。
          layerOriginalSrc: it.originalSrc,
          layerOriginalSha256: it.originalSha256,
          // 尺寸是不是已由排版决定，必须落盘：不存的话刷新后 img.onLoad 会拿 natural 尺寸
          // 覆盖 w/h，同一个 Frame 里等大对齐的图层塌成大小不一的碎块（2026-08-10 实测截图）。
          userResized: it.userResized === true ? true : undefined,
        },
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
      const ext = el.ext && typeof el.ext === 'object' ? el.ext : {};
      const layerRole = ext.layerRole === 'source' || ext.layerRole === 'layer' ? ext.layerRole : undefined;
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
        // 恢复持久化的 runId，用于刷新页面后同步状态
        runId: isPlaceholder && el.runId ? String(el.runId).trim() || undefined : undefined,
        // 旧数据没有 frameId：用 layerGroupId 补一次，否则升级后既有分层组的 Frame 会整个消失。
        // 但**只对旧数据补**——新版本写出来的记录带 frameMigrated，此时 frameId 缺失
        // 意味着用户真的解过组，再补一次等于让 Frame 在刷新后复活（冒烟实测抓到）。
        frameId: typeof ext.frameId === 'string' && ext.frameId
          ? ext.frameId
          : (ext.frameMigrated === true
              ? undefined
              : (typeof ext.layerGroupId === 'string' ? ext.layerGroupId : undefined)),
        layerGroupId: typeof ext.layerGroupId === 'string' ? ext.layerGroupId : undefined,
        layerSourceKey: typeof ext.layerSourceKey === 'string' ? ext.layerSourceKey : undefined,
        layerIndex: typeof ext.layerIndex === 'number' && Number.isFinite(ext.layerIndex) ? ext.layerIndex : undefined,
        layerRole,
        layerHidden: ext.layerHidden === true,
        layerOpacity: typeof ext.layerOpacity === 'number' && Number.isFinite(ext.layerOpacity) ? ext.layerOpacity : undefined,
        layerZ: typeof ext.layerZ === 'number' && Number.isFinite(ext.layerZ) ? ext.layerZ : undefined,
        layerContentKind: isLayerContentKind(ext.layerContentKind) ? ext.layerContentKind : undefined,
        layerCoverage: typeof ext.layerCoverage === 'number' && Number.isFinite(ext.layerCoverage)
          ? ext.layerCoverage
          : undefined,
        layerRequestedCount: typeof ext.layerRequestedCount === 'number' && Number.isFinite(ext.layerRequestedCount)
          ? ext.layerRequestedCount
          : undefined,
        layerHomeX: finiteOrUndefined(ext.layerHomeX),
        layerHomeY: finiteOrUndefined(ext.layerHomeY),
        layerHomeW: finiteOrUndefined(ext.layerHomeW),
        layerHomeH: finiteOrUndefined(ext.layerHomeH),
        layerModel: typeof ext.layerModel === 'string' ? ext.layerModel : undefined,
        layerIntent: typeof ext.layerIntent === 'string' ? ext.layerIntent : undefined,
        originalSrc: typeof ext.layerOriginalSrc === 'string' ? ext.layerOriginalSrc : undefined,
        originalSha256: typeof ext.layerOriginalSha256 === 'string' ? ext.layerOriginalSha256 : undefined,
        // 分层 Frame 里的图层尺寸由排版决定，不能被 onLoad 的 natural 尺寸覆盖。
        // 存量数据没有这个字段，靠 layerRole 兜底；但必须真的存下过尺寸才敢锁，
        // 否则没尺寸又不让 onLoad 填，卡片会渲染成 0。
        userResized: ext.userResized === true
          || (!!layerRole && typeof el.w === 'number' && el.w > 0 && typeof el.h === 'number' && el.h > 0),
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

  // 还原时不应无故少一张；用与持久化一致的上限（MAX_PERSIST_ELEMENTS）
  return { canvas: out.slice(0, MAX_PERSIST_ELEMENTS), missingAssets, localOnlyImages };
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
