import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
import { glassPanel, glassTooltip, glassInputArea, glassPopoverCompact } from '@/lib/glassStyles';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { saveVisualAgentWorkspaceViewport } from '@/services';
import { Switch } from '@/components/design/Switch';
import { Dialog } from '@/components/ui/Dialog';
import { PrdPetalBreathingLoader } from '@/components/ui/PrdPetalBreathingLoader';
import { TwoPhaseRichComposer, type TwoPhaseRichComposerRef, type ImageOption } from '@/components/RichComposer';
import { WatermarkSettingsPanel, type WatermarkSettingsPanelHandle } from '@/components/watermark/WatermarkSettingsPanel';
import {
  ConfigManagementDialogBase,
  MarketplaceWatermarkCard,
  type ConfigManagementDialogHandle as ConfigDialogHandle,
  type ConfigColumn,
  type MarketplaceCardContext,
} from '@/components/config-management';
import type { MarketplaceWatermarkConfig } from '@/services/contracts/watermark';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import {
  deleteVisualAgentWorkspaceAsset,
  createWorkspaceImageGenRun,
  generateVisualAgentWorkspaceTitle,
  getVisualAgentWorkspaceDetail,
  listVisualAgentWorkspaceMessages,
  getImageGenRun,
  getUserPreferences,
  getVisualAgentAdapterInfo,
  getVisualAgentImageGenModels,
  getWatermarkByApp,
  listWatermarksMarketplace,
  forkWatermark,
  planImageGen,
  refreshVisualAgentWorkspaceCover,
  saveVisualAgentWorkspaceCanvas,
  updateVisualAgentPreferences,
  uploadVisualAgentWorkspaceAsset,
} from '@/services';
import type { ModelGroupForApp } from '@/types/modelGroup';
import type { QuickActionConfig } from '@/services/contracts/userPreferences';
import {
  ImageQuickActionBar,
  ImageQuickEditInput,
  QuickActionConfigPanel,
  MaskPaintCanvas,
  DrawingBoardDialog,
  BUILTIN_QUICK_ACTIONS,
  type QuickAction,
} from '@/components/visual-agent';
import { streamImageGenRunWithRetry } from '@/services';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import { ASPECT_OPTIONS, getSizeForTier } from '@/lib/imageAspectOptions';
import {
  computeRequestedSizeByRefRatio,
  extractSizeToken,
  parseInlinePrompt,
  readImageSizeFromFile,
  readImageSizeFromSrc,
  tryParseWxH,
} from '@/lib/visualAgentPromptUtils';
import { resolveImageRefs, buildRequestText } from '@/lib/imageRefResolver';
import type { CanvasImageItem as ContractCanvasItem, ChipRef } from '@/lib/imageRefContract';
import { moveUp, moveDown, bringToFront, sendToBack } from '@/lib/canvasLayerUtils';
import { assignMissingRefIds, getMaxRefId } from '@/lib/visualAgentCanvasPersist';
import type { ImageGenPlanResponse } from '@/services/contracts/imageGen';
import type { ImageAsset, VisualAgentCanvas, VisualAgentWorkspace } from '@/services/contracts/visualAgent';
import type { Model } from '@/types/admin';
import {
  ArrowUpToLine,
  ArrowDownToLine,
  Bug,
  Check,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Clipboard,
  Copy,
  Download,
  Eye,
  FileImage,
  Grid3X3,
  Hand,
  ImagePlus,
  MapPin,
  Maximize2,
  MessageSquare,
  MousePointer2,
  Plus,
  Send,
  Settings,
  Share,
  Sparkles,
  Square,
  Type,
  Trash,
  PenTool,
  Video,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { useLayoutStore } from '@/stores/layoutStore';
import { useGlobalDefectStore } from '@/stores/globalDefectStore';

import { MessageContentRenderer } from './components/MessageContentRenderer';
import { ChatMessageItem } from './components/ChatMessageItem';
import { LlmLogsPanel } from '@/pages/LlmLogsPage';
import { getVisualAgentLogsReal, getVisualAgentLogsMetaReal, getVisualAgentLogDetailReal } from '@/services/real/visualAgent';

type CanvasImageItem = {
  key: string;
  createdAt: number;
  prompt: string;
  src: string;
  status: 'done' | 'error' | 'running';
  kind?: 'image' | 'generator' | 'shape' | 'text';
  /** 关联的生图任务 ID，用于刷新页面后同步状态 */
  runId?: string;
  /** 用户手动调整过尺寸（避免 onLoad 用 natural 覆盖 w/h） */
  userResized?: boolean;
  errorMessage?: string | null;
  refId?: number;
  checked?: boolean;
  checkedAt?: number;
  assetId?: string;
  sha256?: string;
  /** 原图 URL（无水印）。用于作为参考图时避免水印叠加。 */
  originalSrc?: string;
  /** 原图 SHA256。用于参考图查询。 */
  originalSha256?: string;
  /** 生成时使用的参考图 key（用于重试时恢复参考图） */
  refImageKey?: string;
  /** 生成时使用的参考图 originalSha256（用于重试时恢复参考图） */
  refImageSha256?: string;
  /** 图片内容是否已持久化到后端资产（再由后端落本地或 COS）；避免刷新丢失 */
  syncStatus?: 'pending' | 'synced' | 'failed';
  syncError?: string | null;
  naturalW?: number;
  naturalH?: number;
  // image-gen meta（用于 UI 提示 requested -> effective）
  requestedSize?: string | null;
  effectiveSize?: string | null;
  sizeAdjusted?: boolean;
  ratioAdjusted?: boolean;
  // “开放世界”画布位置/尺寸（基础单位，渲染时乘以 zoom）
  x?: number;
  y?: number;
  w?: number;
  h?: number;

  // shape
  shapeType?: 'rect' | 'circle' | 'triangle' | 'star';
  fill?: string;
  stroke?: string;

  // text
  text?: string;
  fontSize?: number;
  textColor?: string;
};

function computeObjectFitContainRect(containerW: number, containerH: number, contentW: number, contentH: number) {
  const cw = Number.isFinite(containerW) ? Math.max(0, containerW) : 0;
  const ch = Number.isFinite(containerH) ? Math.max(0, containerH) : 0;
  const iw = Number.isFinite(contentW) ? Math.max(0, contentW) : 0;
  const ih = Number.isFinite(contentH) ? Math.max(0, contentH) : 0;
  if (!cw || !ch || !iw || !ih) return { x: 0, y: 0, w: cw, h: ch };
  const scale = Math.min(cw / iw, ch / ih);
  const w = Math.max(0, iw * scale);
  const h = Math.max(0, ih * scale);
  const x = (cw - w) / 2;
  const y = (ch - h) / 2;
  return { x, y, w, h };
}

function clampRadius(r: number, w: number, h: number) {
  const rr = Number.isFinite(r) ? Math.max(0, r) : 0;
  const ww = Number.isFinite(w) ? Math.max(0, w) : 0;
  const hh = Number.isFinite(h) ? Math.max(0, h) : 0;
  return Math.min(rr, ww / 2, hh / 2);
}

function normalize2(x: number, y: number) {
  const xx = Number.isFinite(x) ? x : 0;
  const yy = Number.isFinite(y) ? y : 0;
  const len = Math.hypot(xx, yy);
  if (len < 1e-6) return { x: 0, y: 0, len: 0 };
  return { x: xx / len, y: yy / len, len };
}

function shrinkDirForCorner(corner: 'nw' | 'ne' | 'sw' | 'se') {
  // “缩小”方向：从当前角点指向对角（对角线）
  if (corner === 'se') return { x: -1, y: -1 };
  if (corner === 'nw') return { x: 1, y: 1 };
  if (corner === 'ne') return { x: -1, y: 1 };
  return { x: 1, y: -1 }; // sw
}

type PersistedCanvasStateV1 = {
  schemaVersion: 1;
  meta?: Record<string, unknown>;
  elements: PersistedCanvasElementV1[];
};

type PersistedCanvasElementV1 =
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

const PERSIST_SCHEMA_VERSION = 1 as const;
const MAX_PERSIST_ELEMENTS = 200;

function safeJsonParse<T>(s: string): T | null {
  const raw = String(s ?? '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function isRemoteImageSrc(src: string): boolean {
  const s = String(src ?? '').trim();
  if (!s) return false;
  if (s.startsWith('data:')) return false;
  if (s.startsWith('/api/')) return true;
  return /^https?:\/\//i.test(s);
}

function canvasToPersistedV1(items: CanvasImageItem[]): { state: PersistedCanvasStateV1; skippedLocalOnlyImages: number } {
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
        // 持久化 refId
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
  return { state: { schemaVersion: 1, meta: { skippedLocalOnlyImages }, elements: els }, skippedLocalOnlyImages };
}

function persistedV1ToCanvas(
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
  // 还原时不应无故少一张；用与持久化一致的上限（MAX_PERSIST_ELEMENTS）
  return { canvas: out.slice(0, MAX_PERSIST_ELEMENTS), missingAssets, localOnlyImages };
}

type UiMsg = {
  id: string;
  role: 'User' | 'Assistant';
  content: string;
  ts: number;
};

// 图片生成结果/错误的富消息编码 —— 持久化在 content 字符串中
const GEN_ERROR_PREFIX = '[GEN_ERROR]';
const GEN_DONE_PREFIX = '[GEN_DONE]';
// genType: 生成类型 - text2img(纯文生图) | img2img(单图参考) | vision(多图)
// imageRefShas: 所有参考图的 sha256 数组（用于重试时恢复图片引用）
type GenErrorMeta = {
  msg: string;
  refSrc?: string;
  prompt?: string;
  runId?: string;
  modelPool?: string;
  genType?: 'text2img' | 'img2img' | 'vision';
  imageRefShas?: string[];
};
type GenDoneMeta = {
  src: string;
  refSrc?: string;
  prompt?: string;
  runId?: string;
  modelPool?: string;
  genType?: 'text2img' | 'img2img' | 'vision';
  imageRefShas?: string[];
};
function buildGenErrorContent(meta: GenErrorMeta): string {
  return `${GEN_ERROR_PREFIX}${JSON.stringify(meta)}`;
}
function buildGenDoneContent(meta: GenDoneMeta): string {
  return `${GEN_DONE_PREFIX}${JSON.stringify(meta)}`;
}
type CanvasTool = 'select' | 'hand' | 'mark';
type CanvasPlacing =
  | null
  | { kind: 'shape'; shapeType: NonNullable<CanvasImageItem['shapeType']> }
  | { kind: 'text' };

const clampZoom = (z: number) => Math.max(0.05, Math.min(3, z));
const clampZoomFactor = (f: number) => Math.max(0.93, Math.min(1.07, f));

const zoomFactorFromDeltaY = (deltaY: number) => {
  // 更细腻：factor = exp(-dy*k)，并限制单次变化幅度，避免"一滚就跳"
  // k=0.0024 适配 macOS 触控板手势（原 0.0016 提速 1.5 倍）
  const k = 0.003;
  return clampZoomFactor(Math.exp(-deltaY * k));
};


function guessRefName(ref: CanvasImageItem | null): string {
  const p = String(ref?.prompt ?? '').trim();
  if (p) return p.length > 80 ? p.slice(0, 80) : p;

  const src = String(ref?.src ?? '').trim();
  if (src) {
    try {
      const u = new URL(src);
      const base = (u.pathname.split('/').pop() ?? '').trim();
      const decoded = base ? decodeURIComponent(base) : '';
      if (decoded) return decoded.length > 80 ? decoded.slice(0, 80) : decoded;
    } catch {
      // ignore
    }
    const base = (src.split('?')[0]?.split('#')[0]?.split('/').pop() ?? '').trim();
    if (base) return base.length > 80 ? base.slice(0, 80) : base;
  }

  const sha = String(ref?.sha256 ?? '').trim().toLowerCase();
  if (sha && sha.length >= 8) return `参考图 ${sha.slice(0, 8)}`;
  return '参考图';
}

async function copyToClipboard(text: string) {
  const t = String(text ?? '');
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t);
    return;
  } catch {
    // fallback
  }
  const ta = document.createElement('textarea');
  ta.value = t;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
  } catch {
    // ignore
  } finally {
    document.body.removeChild(ta);
  }
}

async function downloadImage(src: string, filename: string) {
  const safe = String(filename || 'image')
    .trim()
    .replaceAll('/', '-')
    .replaceAll('\\', '-')
    .replaceAll(':', '-')
    .replaceAll('*', '-')
    .replaceAll('?', '-')
    .replaceAll('"', '-')
    .replaceAll('<', '-')
    .replaceAll('>', '-')
    .replaceAll('|', '-')
    .slice(0, 80);
  
  const finalName = safe ? `${safe}.png` : 'image.png';
  
  try {
    // 使用 fetch + blob 方式下载，解决跨域图片无法直接下载的问题
    const response = await fetch(src, { mode: 'cors' });
    if (!response.ok) throw new Error('Fetch failed');
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = finalName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    
    // 延迟释放 blob URL
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  } catch {
    // 如果 fetch 失败（如 CORS 问题），回退到直接下载方式
    const a = document.createElement('a');
    a.href = src;
    a.download = finalName;
    a.rel = 'noopener';
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}

async function copyImageToClipboard(src: string) {
  if (!src) return;
  try {
    const response = await fetch(src, { mode: 'cors' });
    if (!response.ok) throw new Error('Fetch failed');
    const blob = await response.blob();
    // ClipboardItem 要求 image/png 格式
    let pngBlob = blob;
    if (blob.type !== 'image/png') {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const loaded = await new Promise<HTMLImageElement>((resolve, reject) => {
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = URL.createObjectURL(blob);
      });
      const cvs = document.createElement('canvas');
      cvs.width = loaded.naturalWidth;
      cvs.height = loaded.naturalHeight;
      const ctx = cvs.getContext('2d')!;
      ctx.drawImage(loaded, 0, 0);
      URL.revokeObjectURL(img.src);
      pngBlob = await new Promise<Blob>((resolve, reject) =>
        cvs.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
      );
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
  } catch {
    // fallback：复制图片链接
    await copyToClipboard(src);
  }
}

async function exportImageAs(src: string, filename: string, format: 'jpg' | 'png' | 'svg') {
  if (!src) return;
  const safe = String(filename || 'image')
    .trim()
    .replaceAll('/', '-')
    .replaceAll('\\', '-')
    .replaceAll(':', '-')
    .replaceAll('*', '-')
    .replaceAll('?', '-')
    .replaceAll('"', '-')
    .replaceAll('<', '-')
    .replaceAll('>', '-')
    .replaceAll('|', '-')
    .slice(0, 80);

  if (format === 'svg') {
    // SVG 导出：将图片嵌入 SVG 内联
    try {
      const response = await fetch(src, { mode: 'cors' });
      if (!response.ok) throw new Error('Fetch failed');
      const blob = await response.blob();
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(blob);
      });
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = reject;
        img.src = dataUrl;
      });
      const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${img.naturalWidth}" height="${img.naturalHeight}"><image href="${dataUrl}" width="${img.naturalWidth}" height="${img.naturalHeight}"/></svg>`;
      const svgBlob = new Blob([svgContent], { type: 'image/svg+xml' });
      const blobUrl = URL.createObjectURL(svgBlob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${safe || 'image'}.svg`;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch {
      // fallback
      void downloadImage(src, safe);
    }
    return;
  }

  // PNG / JPG 导出
  try {
    const response = await fetch(src, { mode: 'cors' });
    if (!response.ok) throw new Error('Fetch failed');
    const blob = await response.blob();
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const loaded = await new Promise<HTMLImageElement>((resolve, reject) => {
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(blob);
    });
    const cvs = document.createElement('canvas');
    cvs.width = loaded.naturalWidth;
    cvs.height = loaded.naturalHeight;
    const ctx = cvs.getContext('2d')!;
    if (format === 'jpg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cvs.width, cvs.height);
    }
    ctx.drawImage(loaded, 0, 0);
    URL.revokeObjectURL(img.src);
    const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
    const ext = format === 'jpg' ? 'jpg' : 'png';
    const exported = await new Promise<Blob>((resolve, reject) =>
      cvs.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), mime, format === 'jpg' ? 0.92 : undefined)
    );
    const blobUrl = URL.createObjectURL(exported);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `${safe || 'image'}.${ext}`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  } catch {
    void downloadImage(src, safe);
  }
}


// 从尺寸字符串检测档位
function detectTierFromSize(size: string): '1k' | '2k' | '4k' {
  const s = (size || '').trim().toLowerCase();
  for (const opt of ASPECT_OPTIONS) {
    if (opt.size4k.toLowerCase() === s) return '4k';
    if (opt.size2k.toLowerCase() === s) return '2k';
    if (opt.size1k.toLowerCase() === s) return '1k';
  }
  return '1k';
}

// 从尺寸字符串检测比例（仅匹配标准比例，不使用 GCD 计算避免用户误解）
function detectAspectFromSize(size: string): string {
  const s = (size || '').trim().toLowerCase();
  // 从 ASPECT_OPTIONS 精确匹配
  for (const opt of ASPECT_OPTIONS) {
    if (opt.size1k.toLowerCase() === s || opt.size2k.toLowerCase() === s || opt.size4k.toLowerCase() === s) {
      return opt.id;
    }
  }
  // 不使用 GCD 计算，返回默认值（调用方应优先使用 sizeToAspectMap）
  return '1:1';
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => resolve('');
    reader.readAsDataURL(blob);
  });
}

type ImageGenRunStreamPayload = {
  type?: unknown;
  errorMessage?: unknown;
  asset?: { id?: unknown; sha256?: unknown; url?: unknown; originalUrl?: unknown; originalSha256?: unknown } | null;
  url?: unknown;
  originalUrl?: unknown;
  originalSha256?: unknown;
};

function buildTemplate(name: string) {
  if (name === 'wine') {
    return `为一家精品红酒商店设计一张海报：\n- 风格：高级、克制、现代\n- 主色：深酒红 + 金色点缀\n- 文案：Wine List / 2026 Spring Collection\n- 版式：留白，中心主视觉\n请输出：设计要点 + 生图提示词`;
  }
  if (name === 'coffee') {
    return `为咖啡店做品牌视觉：\n- 风格：手作感、温暖、轻复古\n- 元素：咖啡杯、豆子、纸张纹理\n- Logo：简洁字标\n请输出：设计方向 + 生图提示词`;
  }
  if (name === 'story') {
    return `为短片做分镜首帧图：\n- 画面：室内夜景，窗外雨，暖光\n- 情绪：克制、孤独\n- 镜头：中景，人物背影\n请输出：分镜描述 + 首帧生图提示词`;
  }
  return '';
}

export default function AdvancedVisualAgentTab(props: { workspaceId: string; initialPrompt?: string }) {
  // workspaceId：视觉创作 Agent 的稳定主键（用于替代易漂移的 sessionId）
  const workspaceId = String(props.workspaceId ?? '').trim();
  const initialPromptFromProps = String(props.initialPrompt ?? '').trim();
  const { isMobile } = useBreakpoint();
  const [mobileShowChat, setMobileShowChat] = useState(false);
  // 移动端默认使用 hand 工具，以便直接拖拽画布
  const [activeTool, setActiveTool] = useState<CanvasTool>(
    typeof window !== 'undefined' && window.innerWidth < 768 ? 'hand' : 'select'
  );
  // 固定默认参数：用户不需要选择
  // 输入区已移除“大小/比例”控制按钮：v1 固定用 1K 方形，避免过多配置干扰
  const imageGenSize = '1024x1024' as const;
  const DEFAULT_ZOOM = 0.5;

  const [modelsLoading, setModelsLoading] = useState(false);
  // 统一模型池列表（合并所有生成类型，去重）
  const [imageGenPools, setImageGenPools] = useState<ModelGroupForApp[]>([]);

  // 将模型池转换为 Model 兼容对象，用于选择器展示
  // 扩展 Model 类型以包含来源标记
  type ModelWithSource = Model & {
    resolutionType?: 'DedicatedPool' | 'DefaultPool' | 'DirectModel';
    isDedicated?: boolean;
    isDefault?: boolean;
    isLegacy?: boolean;
    /** 模型池中第一个模型的实际 modelId（用于查询适配器信息） */
    actualModelId?: string;
  };
  // 直接使用统一的模型池列表
  const filteredPools = useMemo(() => {
    return imageGenPools;
  }, [imageGenPools]);

  const poolModels = useMemo<ModelWithSource[]>(() => {
    if (filteredPools.length === 0) return [];
    return filteredPools
      .filter((g) => g.models && g.models.length > 0)
      .map((g) => {
        const first = g.models[0]!;
        return {
          id: `pool_${g.id}`,
          name: g.name,
          // 发送给后台的模型池 code（用于匹配模型池）
          modelName: g.code,
          // 用于查询适配器信息的实际模型 ID
          actualModelId: first.modelId,
          platformId: first.platformId,
          enabled: g.models.some((m) => m.healthStatus === 'Healthy' || m.healthStatus === 'Degraded'),
          isMain: false,
          isImageGen: true,
          enablePromptCache: false,
          priority: g.priority ?? 50,
          // 来源标记
          resolutionType: g.resolutionType,
          isDedicated: g.isDedicated,
          isDefault: g.isDefault,
          isLegacy: g.isLegacy,
        } as ModelWithSource;
      });
  }, [filteredPools]);

  // 模型列表：使用模型池（后端已包含 3 级回退：专属池 > 默认池 > 传统配置）
  const allImageGenModels = useMemo<ModelWithSource[]>(() => {
    return poolModels;
  }, [poolModels]);

  const serverDefaultModel = useMemo(() => {
    // 后端已按 priority + createdAt 排序，直接取第一个启用的模型
    return allImageGenModels.find((m) => m.enabled) ?? null;
  }, [allImageGenModels]);

  const userId = useAuthStore((s) => s.user?.userId ?? '');
  const setFullBleedMain = useLayoutStore((s) => s.setFullBleedMain);
  // 专注模式属于临时态：离开页面必须恢复，避免影响其他页面布局
  useEffect(() => {
    return () => setFullBleedMain(false);
  }, [setFullBleedMain]);
  const splitKey = userId ? `prdAdmin.visualAgent.splitWidth.${userId}` : '';
  const SPLIT_MIN = 240;
  const SPLIT_MAX = 360;

  // 模型偏好：按账号持久化到数据库
  const [modelPrefOpen, setModelPrefOpen] = useState(false);
  // 画布智能输入框的模型/尺寸选择面板
  const [quickModelOpen, setQuickModelOpen] = useState(false);
  const [quickSizeOpen, setQuickSizeOpen] = useState(false);
  const [modelPrefAuto, setModelPrefAuto] = useState(true);
  const [modelPrefModelId, setModelPrefModelId] = useState<string>('');
  const [modelPrefReady, setModelPrefReady] = useState(false);
  const modelPrefSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sizeSelectorOpen, setSizeSelectorOpen] = useState(false);
  const sizeSelectorRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭尺寸选择器
  useEffect(() => {
    if (!sizeSelectorOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (sizeSelectorRef.current && !sizeSelectorRef.current.contains(e.target as Node)) {
        setSizeSelectorOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [sizeSelectorOpen]);

  // 水印配置
  const [watermarkStatus, setWatermarkStatus] = useState<{ enabled: boolean; name?: string | null }>({ enabled: false });
  const handleWatermarkStatusChange = useCallback((status: { hasActiveConfig: boolean; activeId?: string; activeName?: string }) => {
    setWatermarkStatus({ enabled: status.hasActiveConfig, name: status.activeName ?? null });
  }, []);
  const watermarkPanelRef = useRef<WatermarkSettingsPanelHandle | null>(null);
  const configDialogRef = useRef<ConfigDialogHandle | null>(null);
  const enabledImageModels = useMemo(() => allImageGenModels.filter((m) => m.enabled), [allImageGenModels]);

  // ── 快捷操作 (Quick Actions) ──
  const [diyQuickActions, setDiyQuickActions] = useState<QuickActionConfig[]>([]);
  const diyQuickActionsReadyRef = useRef(false);
  /** 合并后的快捷操作列表：内置 + DIY */
  const mergedQuickActions = useMemo<QuickAction[]>(() => {
    const diyMapped: QuickAction[] = diyQuickActions
      .filter((a) => a.name.trim() && a.prompt.trim())
      .map((a) => ({ ...a, isDiy: true }));
    return [...BUILTIN_QUICK_ACTIONS, ...diyMapped];
  }, [diyQuickActions]);
  const [quickEditRunning, setQuickEditRunning] = useState(false);
  const [quickActionDialogOpen, setQuickActionDialogOpen] = useState(false);
  // 局部重绘（Inpainting）状态
  const [inpaintTarget, setInpaintTarget] = useState<CanvasImageItem | null>(null);
  // 提示词模式：按账号持久化（不写 DB）
  // - 关闭：先调用 planImageGen 解析/改写成候选提示词，再生图
  // - 开启：跳过解析，直接把输入原样作为 prompt 发给生图模型
  const directPromptKey = userId ? `prdAdmin.visualAgent.directPrompt.${userId}` : '';
  // 需求：直连作为默认值（首次进入默认开启）；若本地已有值则以本地为准
  const [directPrompt, setDirectPrompt] = useState(true);
  const [directPromptReady, setDirectPromptReady] = useState(false);
  const effectiveModel = useMemo(() => {
    const byId = modelPrefModelId ? enabledImageModels.find((m) => m.id === modelPrefModelId) ?? null : null;
    if (modelPrefAuto) return serverDefaultModel;
    return byId ?? serverDefaultModel;
  }, [enabledImageModels, modelPrefAuto, modelPrefModelId, serverDefaultModel]);

  // 尺寸选项（后端按分辨率分组返回，前端直接使用，无需转换）
  type SizeOption = { size: string; aspectRatio: string };
  type SizesByResolutionType = Record<'1k' | '2k' | '4k', SizeOption[]>;
  const [sizesByResolution, setSizesByResolution] = useState<SizesByResolutionType>({ '1k': [], '2k': [], '4k': [] });

  useEffect(() => {
    // 使用模型池 code（对于 visual-agent 就是 modelName）获取尺寸配置
    const modelCode = effectiveModel?.modelName;
    if (!modelCode) {
      setSizesByResolution({ '1k': [], '2k': [], '4k': [] });
      return;
    }

    getVisualAgentAdapterInfo(modelCode)
      .then((res) => {
        if (res.success && res.data?.matched && res.data.sizesByResolution) {
          const data = res.data.sizesByResolution;
          setSizesByResolution({
            '1k': Array.isArray(data['1k']) ? data['1k'] : [],
            '2k': Array.isArray(data['2k']) ? data['2k'] : [],
            '4k': Array.isArray(data['4k']) ? data['4k'] : [],
          });
        } else {
          setSizesByResolution({ '1k': [], '2k': [], '4k': [] });
        }
      })
      .catch(() => setSizesByResolution({ '1k': [], '2k': [], '4k': [] }));
  }, [effectiveModel]);

  // 按比例分组，每个比例只保留一个尺寸
  const ratiosByResolution = useMemo(() => {
    const result: Record<'1k' | '2k' | '4k', Map<string, SizeOption>> = {
      '1k': new Map(),
      '2k': new Map(),
      '4k': new Map(),
    };
    for (const tier of ['1k', '2k', '4k'] as const) {
      for (const opt of sizesByResolution[tier]) {
        const ratio = opt.aspectRatio || 'unknown';
        if (!result[tier].has(ratio)) result[tier].set(ratio, opt);
      }
    }
    return result;
  }, [sizesByResolution]);

  // 尺寸到比例的映射（使用后端返回的 aspectRatio，避免 GCD 计算偏差）
  const sizeToAspectMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const tier of ['1k', '2k', '4k'] as const) {
      for (const opt of sizesByResolution[tier]) {
        if (opt.size && opt.aspectRatio) {
          map.set(opt.size.toLowerCase(), opt.aspectRatio);
        }
      }
    }
    return map;
  }, [sizesByResolution]);

  // 所有尺寸的扁平列表（用于验证）
  const allSizeOptions = useMemo(() => {
    return [...sizesByResolution['1k'], ...sizesByResolution['2k'], ...sizesByResolution['4k']];
  }, [sizesByResolution]);

  // 初始化水印配置
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await getWatermarkByApp({ appKey: 'visual-agent' });
      if (cancelled) return;
      if (res?.success && res.data) {
        const config = res.data;
        setWatermarkStatus({
          enabled: true,
          name: config.name || config.text || null,
        });
      } else {
        setWatermarkStatus({ enabled: false, name: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const INITIAL_MSG_LIMIT = 50;
  const LOAD_MORE_LIMIT = 50;

  const [messages, setMessages] = useState<UiMsg[]>([
    {
      id: 'assistant-hello',
      role: 'Assistant',
      content:
        'Hi，我是你的 AI 设计师。描述你的需求，我会把它转成可执行的生图提示词并把结果放到左侧画板。若你想让输入直接作为提示词发送（不再二次解析/改写），可在"模型偏好"里开启"直连"。',
      ts: Date.now(),
    },
  ]);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const loadingMoreRef = useRef(false);

  const [uploadToast, setUploadToast] = useState<{ text: string } | null>(null);
  const uploadToastTimerRef = useRef<number | null>(null);
  const showUploadToast = useCallback((text: string) => {
    const t = String(text ?? '').trim();
    if (!t) return;
    setUploadToast({ text: t });
    if (uploadToastTimerRef.current != null) {
      window.clearTimeout(uploadToastTimerRef.current);
      uploadToastTimerRef.current = null;
    }
    uploadToastTimerRef.current = window.setTimeout(() => {
      setUploadToast(null);
      uploadToastTimerRef.current = null;
    }, 1600);
  }, []);
  useEffect(() => {
    return () => {
      if (uploadToastTimerRef.current != null) window.clearTimeout(uploadToastTimerRef.current);
      uploadToastTimerRef.current = null;
    };
  }, []);

  // 右侧对话输入（与画布快捷输入互不影响）
  const [input, setInput] = useState('');
  // 画布快捷输入（仅在选中生成器区域时出现）
  const [quickInput, setQuickInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const quickInputRef = useRef<HTMLTextAreaElement | null>(null);
  const quickPanelRef = useRef<HTMLDivElement | null>(null); // 快捷输入框容器，用于 GPU 加速更新
  const activeComposerRef = useRef<'right' | 'quick'>('right');
  
  // 两阶段选择富文本编辑器 ref
  const richComposerRef = useRef<TwoPhaseRichComposerRef | null>(null);
  const composingRef = useRef(false);
  const [composerSize, setComposerSize] = useState<string | null>(null);
  const composerSizeAutoRef = useRef(true);
  const inputPanelRef = useRef<HTMLDivElement | null>(null);
  const MIN_TA_HEIGHT = 132; // 默认高度较之前下降约 1/4（177 -> 132）
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionAtPos, setMentionAtPos] = useState<number | null>(null);
  const [asciiOpen, setAsciiOpen] = useState(false);
  const [asciiSource, setAsciiSource] = useState('');
  const [drawingBoardOpen, setDrawingBoardOpen] = useState(false);

  const [canvas, setCanvas] = useState<CanvasImageItem[]>([]);
  const canvasRef = useRef<CanvasImageItem[]>([]);
  
  // 图片选项（用于 @ 下拉菜单）
  const imageOptions = useMemo<ImageOption[]>(() => {
    return canvas
      .filter((it) => (it.kind ?? 'image') === 'image' && it.src)
      .map((it) => {
        const id = it.refId ?? 0;
        return {
          key: it.key,
          refId: id,
          src: it.src || '',
          label: guessRefName(it) || `img${id}`,
        };
      })
      .filter((opt) => opt.refId > 0);
  }, [canvas]);
  
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const selectedKeysRef = useRef<string[]>([]);
  useEffect(() => {
    selectedKeysRef.current = selectedKeys;
  }, [selectedKeys]);
  const primarySelectedKey = selectedKeys[0] ?? '';
  const selected = useMemo(() => canvas.find((x) => x.key === primarySelectedKey) ?? null, [canvas, primarySelectedKey]);
  const isSelectedKey = (k: string) => selectedKeys.includes(k);

  // 两阶段选择：跟踪当前有 pending chip 的图片 key（灰色，待确认）
  // 通过 TwoPhaseRichComposer 的 onPendingKeysChange 回调自动更新
  const [pendingChipKeys, setPendingChipKeys] = useState<Set<string>>(new Set());
  const isPendingKey = (k: string) => pendingChipKeys.has(k);
  const handlePendingKeysChange = useCallback((keys: Set<string>) => {
    setPendingChipKeys(keys);
  }, []);

  // [已废弃] clearPendingChips - 应使用 selectionManagerRef.current.clear() 代替

  /**
   * ============================================================
   * 选择状态管理器 - 所有修改 selectedKeys 的操作必须通过这里
   * ============================================================
   * 
   * 设计原则：
   * - 禁止直接调用 setSelectedKeys（除了这个管理器内部）
   * - 所有选择操作通过 selectionManager 进行
   * - 自动判断是否需要同步 chip（只有图片类型需要）
   */
  const selectionManagerRef = useRef<{
    /** 清空选中（四个球 + chip 一起清除） */
    clear: () => void;
    /** 设置选中（替换模式，自动同步 chip） */
    set: (keys: string[]) => void;
    /** 添加选中（追加模式，自动同步 chip） */
    add: (keys: string[]) => void;
    /** 移除选中（自动同步 chip） */
    remove: (keys: string[]) => void;
    /** 设置选中但不同步 chip（仅用于非图片类型如 generator/shape/text） */
    setWithoutChip: (keys: string[]) => void;
  } | null>(null);

  const selectedSingleImageForComposer = useMemo(() => {
    if (selectedKeys.length !== 1) return null;
    const it = selected;
    if (!it) return null;
    if ((it.kind ?? 'image') !== 'image') return null;
    const src = String(it.src ?? '').trim();
    if (!src) return null;
    return it;
  }, [selected, selectedKeys.length]);

  // 注：已删除 selectedImagesForComposer（老代码），现在使用 TwoPhaseRichComposer 管理 chip 显示

  const autoSizeForSelectedImage = useMemo(() => {
    const it = selectedSingleImageForComposer;
    if (!it) return null;
    const dim =
      it.naturalW && it.naturalH
        ? { w: Math.max(1, Math.round(it.naturalW)), h: Math.max(1, Math.round(it.naturalH)) }
        : null;
    return computeRequestedSizeByRefRatio(dim) ?? '1024x1024';
  }, [selectedSingleImageForComposer]);

  // 单选图片时：默认尺寸随选中图自动推断；用户手动更换后，仅对本次发送有效
  const composerRefKeyRef = useRef<string>('');
  useEffect(() => {
    const k = selectedSingleImageForComposer?.key ?? '';
    const autoSize = autoSizeForSelectedImage ?? '1024x1024';
    if (!k) {
      composerRefKeyRef.current = '';
      composerSizeAutoRef.current = true;
      setComposerSize(null);
      return;
    }
    if (composerRefKeyRef.current !== k) {
      composerRefKeyRef.current = k;
      composerSizeAutoRef.current = true;
      setComposerSize(autoSize);
      return;
    }
    // 同一张图：仅在“自动模式”下跟随像素尺寸变化（例如图片 onLoad 后 naturalW/H 刚补齐）
    if (composerSizeAutoRef.current) setComposerSize(autoSize);
  }, [autoSizeForSelectedImage, selectedSingleImageForComposer?.key]);

  // 当 sizesByResolution 变化时，如果当前尺寸不在支持列表中，自动选择一个有效尺寸
  useEffect(() => {
    if (allSizeOptions.length === 0) return;
    const currentSize = composerSize ?? '1024x1024';
    const isCurrentValid = allSizeOptions.some((opt) => opt.size?.toLowerCase() === currentSize.toLowerCase());
    if (!isCurrentValid) {
      // 先尝试保持当前比例，切换到支持的分辨率
      const currentAspect = sizeToAspectMap.get(currentSize.toLowerCase()) || detectAspectFromSize(currentSize);
      const priorities = ['2k', '1k', '4k'] as const;
      // 第一轮：找相同比例的
      for (const tier of priorities) {
        const sameAspectOpt = ratiosByResolution[tier].get(currentAspect);
        if (sameAspectOpt?.size) {
          composerSizeAutoRef.current = false;
          setComposerSize(sameAspectOpt.size);
          return;
        }
      }
      // 第二轮：退而求其次，选择任意可用尺寸
      for (const tier of priorities) {
        const firstOpt = ratiosByResolution[tier].values().next().value;
        if (firstOpt?.size) {
          composerSizeAutoRef.current = false;
          setComposerSize(firstOpt.size);
          return;
        }
      }
    }
  }, [allSizeOptions, ratiosByResolution, composerSize, sizeToAspectMap]);

  // 尺寸联动：当通过智能面板修改 composerSize 时，同步更新画布上选中的 Generator 的尺寸
  // 使用 ref 追踪上一次的 composerSize，避免在 canvas 变化时重复触发
  const prevComposerSizeRef = useRef<string | null>(null);
  useEffect(() => {
    if (!composerSize) return;
    // 仅在用户手动选择尺寸时（非自动模式）才联动
    if (composerSizeAutoRef.current) return;
    // 仅在 composerSize 实际变化时才执行
    if (prevComposerSizeRef.current === composerSize) return;
    prevComposerSizeRef.current = composerSize;

    const k = selectedKeys[0];
    if (!k) return;
    const it = canvas.find((x) => x.key === k);
    if (!it || (it.kind ?? 'image') !== 'generator') return;
    // 解析尺寸字符串（如 "768x1024"）
    const m = /^(\d+)\s*[xX×]\s*(\d+)$/i.exec(composerSize);
    if (!m) return;
    const newW = parseInt(m[1], 10);
    const newH = parseInt(m[2], 10);
    const oldW = it.w ?? 1024;
    const oldH = it.h ?? 1024;
    // 避免重复更新
    if (oldW === newW && oldH === newH) return;
    // 围绕中心点变化：调整 x, y 使中心点保持不变
    const oldCx = (it.x ?? 0) + oldW / 2;
    const oldCy = (it.y ?? 0) + oldH / 2;
    const newX = oldCx - newW / 2;
    const newY = oldCy - newH / 2;
    setCanvas((prev) =>
      prev.map((x) => (x.key === k ? { ...x, x: newX, y: newY, w: newW, h: newH } : x))
    );
  }, [composerSize, selectedKeys, canvas]);

  // 注：已删除老代码的 selectedImagesForComposer 显示区域
  // TwoPhaseRichComposer 内部自己管理 chip 显示，不需要外部 padding
  const composerMetaPadTop = 0;

  const HOVER_MENU_CLOSE_DELAY_MS = 320;

  // activeTool 已在上方通过 isMobile 初始化：移动端默认 'hand'，桌面端默认 'select'
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const toolMenuCloseTimerRef = useRef<number | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuCloseTimerRef = useRef<number | null>(null);
  const [shapeMenuOpen, setShapeMenuOpen] = useState(false);
  const shapeMenuCloseTimerRef = useRef<number | null>(null);

  const [placing, setPlacing] = useState<CanvasPlacing>(null);
  const [textEdit, setTextEdit] = useState<{ open: boolean; key: string; value: string }>({ open: false, key: '', value: '' });

  // 画布（无限平面）视口：camera + zoom
  // 性能关键：高频交互（wheel/pan/drag）不走 React setState，否则会触发整棵画布重渲染导致“不跟手”
  // 用 ref + rAF 直接更新 worldRef 的 transform；state 仅用于 UI 展示（低频同步）
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [camera, setCamera] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const zoomRef = useRef(DEFAULT_ZOOM);
  const cameraRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const rafTransformRef = useRef<number | null>(null);
  const lastUiSyncRef = useRef(0);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const worldUiRef = useRef<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const stageSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const canvasOpLockRef = useRef<Promise<void>>(Promise.resolve());

  // 用于精确计算“文件名/尺寸”标签的文本宽度（避免窗口缩放时裁剪不准）
  const labelMeasureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const labelFontRef = useRef<{ font: string; letterSpacingPx: number } | null>(null);
  useLayoutEffect(() => {
    try {
      const span = document.createElement('span');
      span.className = 'text-[11px] font-semibold';
      span.style.position = 'fixed';
      span.style.left = '-9999px';
      span.style.top = '-9999px';
      span.style.visibility = 'hidden';
      span.style.whiteSpace = 'nowrap';
      span.textContent = 'X';
      document.body.appendChild(span);
      const cs = window.getComputedStyle(span);
      const font = cs.font || `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const ls = cs.letterSpacing;
      let letterSpacingPx = 0;
      if (ls && ls !== 'normal') {
        const n = Number.parseFloat(ls);
        if (Number.isFinite(n)) letterSpacingPx = n;
      }
      labelFontRef.current = { font, letterSpacingPx };
      document.body.removeChild(span);
    } catch {
      // ignore：回退到粗略估算
      labelFontRef.current = { font: '600 11px system-ui', letterSpacingPx: 0 };
    }
  }, []);

  const measureLabelTextPx = useCallback((text: string): number => {
    const t = String(text ?? '');
    if (!t) return 0;
    const info = labelFontRef.current;
    const font = info?.font || '600 11px system-ui';
    const letterSpacingPx = info?.letterSpacingPx || 0;
    let canvas = labelMeasureCanvasRef.current;
    if (!canvas) {
      canvas = document.createElement('canvas');
      labelMeasureCanvasRef.current = canvas;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return Math.ceil(t.length * 7);
    ctx.font = font;
    const w = ctx.measureText(t).width;
    const w2 = w + Math.max(0, t.length - 1) * letterSpacingPx;
    return Math.ceil(w2);
  }, []);

  useEffect(() => {
    canvasRef.current = canvas;
  }, [canvas]);

  const applyWorldTransform = useCallback(() => {
    const el = worldRef.current;
    const ui = worldUiRef.current;
    if (!el) return;
    const z = zoomRef.current;
    const cam = cameraRef.current;
    const tf = `translate(${Math.round(cam.x)}px, ${Math.round(cam.y)}px) scale(${z})`;
    el.style.transform = tf;
    el.style.transformOrigin = '0 0';
    el.style.setProperty('--zoom', String(z));
    el.style.setProperty('--invZoom', String(1 / Math.max(0.0001, z)));
    if (ui) {
      ui.style.transform = tf;
      ui.style.transformOrigin = '0 0';
      ui.style.setProperty('--zoom', String(z));
      ui.style.setProperty('--invZoom', String(1 / Math.max(0.0001, z)));
    }
    // 同步更新快捷输入框位置（避免 React 状态延迟导致不跟手）
    const quickPanel = quickPanelRef.current;
    const gen = selectedGeneratorRef.current;
    if (quickPanel && gen) {
      const x = Math.round(((gen.x ?? 0) + (gen.w ?? 1024) / 2) * z + cam.x);
      const y = Math.round(((gen.y ?? 0) + (gen.h ?? 1024)) * z + cam.y + 26);
      quickPanel.style.transform = `translate(${x}px, ${y}px) translate(-50%, 0)`;
    }
  }, []);

  const scheduleWorldTransform = useCallback(
    (syncUi = false) => {
      if (rafTransformRef.current != null) return;
      rafTransformRef.current = window.requestAnimationFrame(() => {
        rafTransformRef.current = null;
        applyWorldTransform();
        const now = Date.now();
        // UI 展示低频同步：避免每帧 setState
        if (syncUi || now - lastUiSyncRef.current > 80) {
          lastUiSyncRef.current = now;
          setZoom(zoomRef.current);
          setCamera({ ...cameraRef.current });
        }
      });
    },
    [applyWorldTransform]
  );

  const setViewport = useCallback(
    (nextZoom: number, nextCamera: { x: number; y: number }, opts?: { syncUi?: boolean }) => {
      zoomRef.current = nextZoom;
      cameraRef.current = nextCamera;
      scheduleWorldTransform(Boolean(opts?.syncUi));
    },
    [scheduleWorldTransform]
  );

  // Space 平移 + 框选
  const [spacePressed, setSpacePressed] = useState(false);
  const [panning, setPanning] = useState(false);
  const effectiveTool: CanvasTool = spacePressed ? 'hand' : activeTool;
  const tempHand = spacePressed && activeTool !== 'hand';
  const panRef = useRef<{ active: boolean; pointerId: number; startX: number; startY: number; baseCamX: number; baseCamY: number }>({
    active: false,
    pointerId: -1,
    startX: 0,
    startY: 0,
    baseCamX: 0,
    baseCamY: 0,
  });
  const dragItemsRef = useRef<{
    active: boolean;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    keys: string[];
    base: Record<string, { x: number; y: number }>;
  }>({ active: false, pointerId: -1, startClientX: 0, startClientY: 0, keys: [], base: {} });

  type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';
  const [resizing, setResizing] = useState(false);
  const resizeRef = useRef<{
    active: boolean;
    pointerId: number;
    key: string;
    corner: ResizeCorner;
    lockAspect?: boolean;
    aspectRatio?: number;
    startClientX: number;
    startClientY: number;
    baseX: number;
    baseY: number;
    baseW: number;
    baseH: number;
  }>({
    active: false,
    pointerId: -1,
    key: '',
    corner: 'se',
    lockAspect: false,
    aspectRatio: undefined,
    startClientX: 0,
    startClientY: 0,
    baseX: 0,
    baseY: 0,
    baseW: 0,
    baseH: 0,
  });

  const applyResizeFromClient = useCallback((clientX: number, clientY: number) => {
    const rz = resizeRef.current;
    if (!rz.active) return;
    const dx = (clientX - rz.startClientX) / zoomRef.current;
    const dy = (clientY - rz.startClientY) / zoomRef.current;
    const minSize = 40;
    const baseLeft = rz.baseX;
    const baseTop = rz.baseY;
    const baseRight = rz.baseX + rz.baseW;
    const baseBottom = rz.baseY + rz.baseH;

    let left = baseLeft;
    let top = baseTop;
    let right = baseRight;
    let bottom = baseBottom;

    if (rz.corner === 'se') {
      right = baseRight + dx;
      bottom = baseBottom + dy;
      right = Math.max(baseLeft + minSize, right);
      bottom = Math.max(baseTop + minSize, bottom);
    } else if (rz.corner === 'nw') {
      left = baseLeft + dx;
      top = baseTop + dy;
      left = Math.min(baseRight - minSize, left);
      top = Math.min(baseBottom - minSize, top);
    } else if (rz.corner === 'ne') {
      right = baseRight + dx;
      top = baseTop + dy;
      right = Math.max(baseLeft + minSize, right);
      top = Math.min(baseBottom - minSize, top);
    } else if (rz.corner === 'sw') {
      left = baseLeft + dx;
      bottom = baseBottom + dy;
      left = Math.min(baseRight - minSize, left);
      bottom = Math.max(baseTop + minSize, bottom);
    }

    const nextW = Math.max(minSize, right - left);
    const nextH = Math.max(minSize, bottom - top);

    let outLeft = left;
    let outTop = top;
    let outW = nextW;
    let outH = nextH;

    // 对图片/生成器默认锁定比例（避免 object-fit: contain 产生“留白幽灵框”）
    if (rz.lockAspect && typeof rz.aspectRatio === 'number' && Number.isFinite(rz.aspectRatio) && rz.aspectRatio > 0) {
      const ratio = rz.aspectRatio;
      // 选择更“贴手”的维度作为主导：变化更大的那个
      const dw = Math.abs(nextW - rz.baseW);
      const dh = Math.abs(nextH - rz.baseH);

      let w2: number;
      let h2: number;
      if (dw >= dh) {
        w2 = nextW;
        h2 = w2 / ratio;
      } else {
        h2 = nextH;
        w2 = h2 * ratio;
      }

      // 双边最小尺寸约束
      const scaleUp = Math.max(minSize / Math.max(0.0001, w2), minSize / Math.max(0.0001, h2), 1);
      w2 *= scaleUp;
      h2 *= scaleUp;

      // 以“对角固定点”为 anchor 重算 left/top（角点拖拽）
      if (rz.corner === 'se') {
        outLeft = baseLeft;
        outTop = baseTop;
      } else if (rz.corner === 'nw') {
        outLeft = baseRight - w2;
        outTop = baseBottom - h2;
      } else if (rz.corner === 'ne') {
        outLeft = baseLeft;
        outTop = baseBottom - h2;
      } else if (rz.corner === 'sw') {
        outLeft = baseRight - w2;
        outTop = baseTop;
      }
      outW = w2;
      outH = h2;
    }

    // 角点缩放的“对角线锥形约束”（cone constraint）：只在接近对角线方向时允许缩小，避免手抖导致跳变
    // - 仅对“锁比例”的图片/生成器启用
    // - enlarge 不限制（用户手不直也能放大），shrink 需要接近对角线
    if (rz.lockAspect) {
      const eps = 0.5;
      const isShrinking = outW < (rz.baseW - eps) || outH < (rz.baseH - eps);
      if (isShrinking) {
        const v = normalize2(dx, dy);
        const d0 = shrinkDirForCorner(rz.corner);
        const d = normalize2(d0.x, d0.y);
        // 角度阈值：越小越“只允许对角线”，常见体验是 20-30 度
        const COS_TH = Math.cos((25 * Math.PI) / 180);
        const cos = v.len > 0 && d.len > 0 ? v.x * d.x + v.y * d.y : -1;
        if (!(cos >= COS_TH)) {
          outLeft = baseLeft;
          outTop = baseTop;
          outW = rz.baseW;
          outH = rz.baseH;
        }
      }
    }

    setCanvas((prev) =>
      prev.map((it) =>
        it.key === rz.key
          ? {
              ...it,
              x: outLeft,
              y: outTop,
              w: outW,
              h: outH,
              userResized: true,
            }
          : it
      )
    );
  }, []);

  useEffect(() => {
    if (!resizing) return;

    const onMove = (e: PointerEvent) => {
      const rz = resizeRef.current;
      if (!rz.active) return;
      if (rz.pointerId !== e.pointerId) return;
      applyResizeFromClient(e.clientX, e.clientY);
      // 避免拖拽时触发选中文本/滚动等
      try {
        e.preventDefault();
      } catch {
        // ignore
      }
    };

    const end = (e: PointerEvent) => {
      const rz = resizeRef.current;
      if (!rz.active) return;
      if (rz.pointerId !== e.pointerId) return;
      resizeRef.current.active = false;
      setResizing(false);
      document.body.style.cursor = '';
    };

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', end, { passive: true });
    window.addEventListener('pointercancel', end, { passive: true });

    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [applyResizeFromClient, resizing]);
  const [marquee, setMarquee] = useState<{
    active: boolean;
    startX: number;
    startY: number;
    x: number;
    y: number;
    w: number;
    h: number;
    shift: boolean;
  }>({ active: false, startX: 0, startY: 0, x: 0, y: 0, w: 0, h: 0, shift: false });

  // @imgN 占位符
  const [showLogs, setShowLogs] = useState(false);
  const [nextRefId, setNextRefId] = useState(1);
  const canvasDirtyRef = useRef(false);

  const ensureRefIdForKey = useCallback(
    (key: string) => {
      const it = canvas.find((x) => x.key === key) ?? null;
      if (!it) return null;
      if (typeof it.refId === 'number' && Number.isFinite(it.refId) && it.refId > 0) return it.refId;

      const maxExisting = canvas.reduce((acc, x) => (typeof x.refId === 'number' && x.refId > acc ? x.refId : acc), 0);
      const id = Math.max(nextRefId, maxExisting + 1);
      setNextRefId(id + 1);
      setCanvas((prev) => prev.map((x) => (x.key === key ? { ...x, refId: id } : x)));
      return id;
    },
    [canvas, nextRefId]
  );

  /**
   * ============================================================
   * 选择管理器实现 - 同步 selectedKeys（四个球）和 chip（对勾）
   * ============================================================
   */
  
  // 内部方法：同步 chip 到当前选中的图片
  const syncChipsToSelection = useCallback((newKeys: string[]) => {
    richComposerRef.current?.clearPending();
    
    for (const key of newKeys) {
      // 优先从 canvasRef 获取（避免闭包问题）
      const item = canvasRef.current.find(x => x.key === key);
      if (item && (item.kind ?? 'image') === 'image' && item.src) {
        const refId = item.refId ?? ensureRefIdForKey(key);
        if (refId) {
          richComposerRef.current?.insertImageChip(
            { key, refId, src: item.src, label: item.prompt || `img${refId}` },
            { preserveFocus: true }
          );
        }
      }
    }
  }, [ensureRefIdForKey]);

  // 清空选中（四个球 + chip 一起清除）
  const clearSelection = useCallback(() => {
    setSelectedKeys([]);
    richComposerRef.current?.clearPending();
  }, []);

  // 设置选中（替换模式，自动同步 chip）
  const setSelection = useCallback((keys: string[]) => {
    setSelectedKeys(keys);
    syncChipsToSelection(keys);
  }, [syncChipsToSelection]);

  // 添加选中（追加模式，自动同步 chip）
  const addSelection = useCallback((keys: string[]) => {
    const currentKeys = selectedKeysRef.current;
    const newKeys = [...new Set([...currentKeys, ...keys])];
    setSelectedKeys(newKeys);
    syncChipsToSelection(newKeys);
  }, [syncChipsToSelection]);

  // 移除选中（自动同步 chip）
  const removeSelection = useCallback((keys: string[]) => {
    const currentKeys = selectedKeysRef.current;
    const removeSet = new Set(keys);
    const newKeys = currentKeys.filter(k => !removeSet.has(k));
    setSelectedKeys(newKeys);
    syncChipsToSelection(newKeys);
  }, [syncChipsToSelection]);

  // 设置选中但不同步 chip（仅用于非图片类型）
  const setSelectionWithoutChip = useCallback((keys: string[]) => {
    setSelectedKeys(keys);
    // 不同步 chip - 用于 generator/shape/text 等非图片类型
  }, []);

  // 更新 ref 以便在回调中使用最新方法
  selectionManagerRef.current = {
    clear: clearSelection,
    set: setSelection,
    add: addSelection,
    remove: removeSelection,
    setWithoutChip: setSelectionWithoutChip,
  };

  // 兼容旧代码的别名
  const clearSelectionWithChips = clearSelection;
  const updateSelectionWithChips = useCallback((
    keys: string[],
    mode: 'replace' | 'add' | 'remove' = 'replace'
  ) => {
    if (mode === 'replace') setSelection(keys);
    else if (mode === 'add') addSelection(keys);
    else removeSelection(keys);
    // chip 插入会触发 Lexical 编辑器抢焦点，延迟恢复画布焦点
    requestAnimationFrame(() => {
      try { stageRef.current?.focus({ preventScroll: true }); } catch { /* ignore */ }
    });
  }, [setSelection, addSelection, removeSelection]);

  const focusComposer = useCallback(() => {
    try {
      inputPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    } catch {
      // ignore
    }
    requestAnimationFrame(() => {
      // 优先使用富文本编辑器
      if (richComposerRef.current) {
        richComposerRef.current.focus();
      } else {
        inputRef.current?.focus();
      }
    });
  }, []);

  const focusStage = useCallback(() => {
    try {
      stageRef.current?.focus({ preventScroll: true });
    } catch {
      stageRef.current?.focus();
    }
  }, []);

  const startResize = useCallback(
    (e: ReactPointerEvent, it: CanvasImageItem, corner: ResizeCorner) => {
      if (effectiveTool === 'hand') return;
      // 仅在单选时允许 resize（避免多选整体 resize 的复杂交互）
      if (selectedKeysRef.current.length !== 1 || selectedKeysRef.current[0] !== it.key) return;

      const x = it.x ?? 0;
      const y = it.y ?? 0;
      const w = Math.max(1, it.w ?? 1);
      const h = Math.max(1, it.h ?? 1);
      const kind = it.kind ?? 'image';
      const nw = typeof it.naturalW === 'number' ? it.naturalW : 0;
      const nh = typeof it.naturalH === 'number' ? it.naturalH : 0;
      const ratio =
        nw > 0 && nh > 0 ? nw / nh : w > 0 && h > 0 ? w / h : 0;
      // 简化交互：图片/生成器默认锁比例；按住 Shift 临时解锁（便于特殊需求）
      const lockAspect = (kind === 'image' || kind === 'generator') && ratio > 0 && !e.shiftKey;

      resizeRef.current = {
        active: true,
        pointerId: e.pointerId,
        key: it.key,
        corner,
        lockAspect,
        aspectRatio: ratio > 0 ? ratio : undefined,
        startClientX: e.clientX,
        startClientY: e.clientY,
        baseX: x,
        baseY: y,
        baseW: w,
        baseH: h,
      };

      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }

      setResizing(true);
      document.body.style.cursor = corner === 'se' || corner === 'nw' ? 'nwse-resize' : 'nesw-resize';

      e.stopPropagation();
      e.preventDefault();
    },
    [effectiveTool]
  );


  // splitter：右侧宽度（px）
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [rightWidth, setRightWidth] = useState(0);
  const dragRef = useRef<{ dragging: boolean; startX: number; startRight: number } | null>(null);

  const [_busy, setBusy] = useState(false);
  const [error, setError] = useState<string>('');
  const [defectFlash, setDefectFlash] = useState(false);
  const [workspace, setWorkspace] = useState<VisualAgentWorkspace | null>(null);
  const [, setBooting] = useState(false);
  const initWorkspaceRef = useRef<{ workspaceId: string; started: boolean }>({ workspaceId: '', started: false });

  // 触发缺陷提交按钮闪烁（生图失败时调用，持续闪烁直到用户点击）
  const triggerDefectFlash = useCallback(() => {
    setDefectFlash(true);
  }, []);
  // debug logs removed

  // 重要：pushMsg 需要稳定引用（供多个 useEffect 依赖），并且不能直接依赖 workspace state（否则每次 render 变更都触发 effect）
  const workspaceRef = useRef<VisualAgentWorkspace | null>(null);
  const titleGenTriggeredRef = useRef(false);
  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  // pushMsg：仅更新本地 UI 状态（消息持久化由后端 CreateRun / Worker 自动完成）
  const pushMsg = useCallback((role: UiMsg['role'], content: string) => {
    const msg: UiMsg = { id: `${role}-${Date.now()}`, role, content, ts: Date.now() };
    setMessages((prev) => prev.concat(msg));
  }, []);

  const MAX_GEN_CONCURRENCY = 3;
  type GenJob = {
    id: string;
    displayText: string;
    requestText: string;
    /** 所有引用的图片（按顺序），第一个为主图 */
    imageRefs: CanvasImageItem[];
    seedSelectedKey: string;
    sizeOverride?: string | null;
  };
  const pendingJobsRef = useRef<GenJob[]>([]);
  const sendGuardRef = useRef<{ text: string; at: number } | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const runningCountRef = useRef(0);
  const [runningCount, setRunningCount] = useState(0);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const openImageFilePicker = useCallback(() => {
    const input = fileRef.current;
    if (!input) return;

    // Chrome/Edge 在 overflow 容器内打开 file picker 后，可能会把最近一次触发的元素滚动到可视区，
    // 在专注模式（full-bleed）下表现为“整页上移”。这里在文件选择器关闭后恢复 main 的 scrollTop。
    const mainEl = document.querySelector('main') as HTMLElement | null;
    const prevTop = mainEl?.scrollTop ?? 0;
    const restore = () => {
      if (!mainEl) return;
      mainEl.scrollTop = prevTop;
    };

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      window.removeEventListener('focus', onWindowFocus, true);
      input.removeEventListener('change', onInputChange);
    };

    const onWindowFocus = () => {
      // 文件选择器关闭后 window 会重新获得焦点
      requestAnimationFrame(restore);
      window.setTimeout(restore, 0);
      cleanup();
    };

    const onInputChange = () => {
      // 选择文件后 change 触发（有些浏览器先触发 change 再 focus）
      requestAnimationFrame(restore);
      window.setTimeout(restore, 0);
      cleanup();
    };

    window.addEventListener('focus', onWindowFocus, true);
    input.addEventListener('change', onInputChange);
    input.click();
  }, []);

  const [preview, setPreview] = useState<{ open: boolean; src: string; prompt: string; runId?: string }>({ open: false, src: '', prompt: '' });

  // ── Stable callbacks for memoized ChatMessageItem ──────────────────
  const handleMsgPreview = useCallback((src: string, prompt: string, runId?: string) => {
    setPreview({ open: true, src, prompt, runId });
  }, []);

  // Retry: uses a ref so the callback identity never changes even when sendText/canvas update
  const retryRef = useRef<(prompt: string, imageRefShas: string[], canvasSnapshot: { key: string; sha256?: string; originalSha256?: string; src: string; refId?: number }[]) => void>(() => {});

  const handleMsgRetry = useCallback(
    (prompt: string, imageRefShas: string[], canvasSnapshot: { key: string; sha256?: string; originalSha256?: string; src: string; refId?: number }[]) => {
      retryRef.current(prompt, imageRefShas, canvasSnapshot);
    },
    [],
  );

  // 图片右键菜单状态
  const [imgContextMenu, setImgContextMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    src: string;
    prompt: string;
    key: string; // 右键点击的元素 key，用于图层操作
  }>({ open: false, x: 0, y: 0, src: '', prompt: '', key: '' });

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const msgContentRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const canvasBootedRef = useRef(false);
  const canvasSaveTimerRef = useRef<number | null>(null);
  const lastSavedJsonRef = useRef<string>('');
  const lastSaveAtRef = useRef<number>(0);
  const pendingLocalOnlyWarnRef = useRef<number>(0);
  // 视口（zoom/camera）持久化走服务器：避免“未回放前就用默认值写回服务器”导致覆盖
  const viewportHydratedRef = useRef(false);
  const lastViewportSavedRef = useRef<{ z: number; x: number; y: number } | null>(null);

  const reloadWorkspace = useCallback(async () => {
    if (!workspaceId) return;
    const detail = await getVisualAgentWorkspaceDetail({ id: workspaceId, messageLimit: INITIAL_MSG_LIMIT, assetLimit: 200 });
    if (!detail.success) return;
    setWorkspace(detail.data.workspace);
    setHasMoreMessages(!!detail.data.hasMoreMessages);

    // 服务器下发视口（缩放/相机）：优先回放（避免每次回到默认 50%）
    const vp = detail.data.viewport;
    if (vp && typeof vp.z === 'number' && typeof vp.x === 'number' && typeof vp.y === 'number') {
      lastViewportSavedRef.current = { z: vp.z, x: vp.x, y: vp.y };
      setViewport(clampZoom(vp.z), { x: vp.x, y: vp.y }, { syncUi: true });
    }
    viewportHydratedRef.current = true;

    const ms = Array.isArray(detail.data.messages) ? detail.data.messages : [];
    if (ms.length > 0) {
      setMessages(
        ms.map((m) => ({
          id: m.id,
          role: m.role === 'Assistant' ? 'Assistant' : 'User',
          content: String(m.content ?? ''),
          ts: Number.isFinite(Date.parse(m.createdAt)) ? Date.parse(m.createdAt) : Date.now(),
        }))
      );
    }

    const assets = Array.isArray(detail.data.assets) ? detail.data.assets : [];
    const assetsList = assets as ImageAsset[];
    const canvasObj = detail.data.canvas;
    if (canvasObj?.payloadJson) {
      const parsed = safeJsonParse<PersistedCanvasStateV1>(canvasObj.payloadJson);
      if (parsed && parsed.schemaVersion === 1 && Array.isArray(parsed.elements)) {
        const restored = persistedV1ToCanvas(parsed, assetsList);
        // 为没有 refId 的图片分配新的 refId（老数据迁移）
        const refIdChanged = assignMissingRefIds(restored.canvas);
        setCanvas(restored.canvas);
        // 更新 nextRefId 为当前最大值 + 1
        const maxRef = getMaxRefId(restored.canvas);
        if (maxRef > 0) {
          setNextRefId(maxRef + 1);
        }
        // 如果有 refId 变更，标记需要保存
        if (refIdChanged) {
          canvasDirtyRef.current = true;
        }
        clearSelectionWithChips();
        return;
      }
    }
    setCanvas([]);
    clearSelectionWithChips();
  }, [setViewport, workspaceId, clearSelectionWithChips]);

  const confirmAndDeleteSelectedKeys = useCallback(
    async (keysArg?: string[]) => {
      const keys = Array.from(new Set((keysArg ?? selectedKeysRef.current ?? []).filter(Boolean)));
      if (keys.length === 0) return;

      const ok = await systemDialog.confirm({
        title: '确认删除',
        message: `确认删除选中的 ${keys.length} 项？`,
        tone: 'danger',
        confirmText: '删除',
        cancelText: '取消',
      });
      if (!ok) return;

      const set = new Set(keys);
      const snapshot = (canvasRef.current ?? []).filter((it) => set.has(it.key));
      const assetIds = Array.from(
        new Set(
          snapshot
            .filter((it) => (it.kind ?? 'image') === 'image')
            .map((it) => (it.assetId ?? '').trim())
            .filter((x) => !!x)
        )
      );

      // 先乐观删除 UI
      setCanvas((prev) => prev.filter((it) => !set.has(it.key)));
      clearSelectionWithChips();

      if (assetIds.length === 0) return;
      const results = await Promise.all(assetIds.map((id) => deleteVisualAgentWorkspaceAsset({ id: workspaceId, assetId: id })));
      // 只关注真正的失败，忽略"资产不存在"（ASSET_NOT_FOUND）因为目标已达成
      const realFailed = results.find((r) => !r.success && r.error?.code !== 'ASSET_NOT_FOUND') ?? null;
      if (realFailed) {
        toast.error(realFailed.error?.message || '删除失败');
        await reloadWorkspace();
      }
    },
    [reloadWorkspace, workspaceId, clearSelectionWithChips]
  );

  useEffect(() => {
    setModelsLoading(true);
    // 通过视觉创作专属端点获取模型池（后端已合并去重所有生成类型，含 3 级回退）
    getVisualAgentImageGenModels()
      .then((poolsRes) => {
        if (poolsRes.success) setImageGenPools(poolsRes.data ?? []);
      })
      .finally(() => setModelsLoading(false));
  }, []);

  // 读取模型偏好（从后端）
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await getUserPreferences();
        if (cancelled) return;
        if (res.success && res.data.visualAgentPreferences) {
          const prefs = res.data.visualAgentPreferences;
          setModelPrefAuto(prefs.modelAuto ?? true);
          setModelPrefModelId(prefs.modelId ?? '');
          // 加载 DIY 快捷指令
          if (Array.isArray(prefs.quickActions)) {
            setDiyQuickActions(prefs.quickActions);
          }
          diyQuickActionsReadyRef.current = true;
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) {
          setModelPrefReady(true);
          diyQuickActionsReadyRef.current = true;
        }
      }
    })();
    return () => { cancelled = true; };
  }, [userId]);

  // 写入模型偏好（防抖保存到后端）
  useEffect(() => {
    if (!userId) return;
    // 必须等加载完成后才保存，避免初始值覆盖
    if (!modelPrefReady) return;
    // 防抖：避免快速切换导致频繁请求
    if (modelPrefSaveRef.current) {
      clearTimeout(modelPrefSaveRef.current);
    }
    modelPrefSaveRef.current = setTimeout(() => {
      void updateVisualAgentPreferences({
        modelAuto: modelPrefAuto,
        modelId: modelPrefModelId || undefined,
        quickActions: diyQuickActions,
      }).catch(() => {
        // 静默失败，不影响用户操作
      });
    }, 500);
    return () => {
      if (modelPrefSaveRef.current) {
        clearTimeout(modelPrefSaveRef.current);
      }
    };
  }, [modelPrefAuto, modelPrefModelId, modelPrefReady, userId, diyQuickActions]);

  // 读取直连模式（仅在有 userId 时）
  useEffect(() => {
    if (!directPromptKey) return;
    try {
      setDirectPromptReady(false);
      // 需求变更：直连应始终开启（避免解析接口不稳定/误关导致体验抖动）。
      // 历史上用户可能关闭过（localStorage 存了 0），这里统一纠正为开启，并写回。
      setDirectPrompt(true);
      setDirectPromptReady(true);
      try {
        localStorage.setItem(directPromptKey, '1');
      } catch {
        // ignore
      }
    } catch {
      // ignore
      setDirectPrompt(true);
      setDirectPromptReady(true);
    }
  }, [directPromptKey]);

  // 写入直连模式
  useEffect(() => {
    if (!directPromptKey) return;
    // 重要：必须先读完本地偏好，避免初始值覆盖用户历史配置
    if (!directPromptReady) return;
    try {
      localStorage.setItem(directPromptKey, directPrompt ? '1' : '0');
    } catch {
      // ignore
    }
  }, [directPrompt, directPromptKey, directPromptReady]);

  // 如果手动选中的模型被禁用/不存在，自动回退到“自动”
  useEffect(() => {
    if (modelPrefAuto) return;
    if (!modelPrefModelId) return;
    const ok = enabledImageModels.some((m) => m.id === modelPrefModelId);
    if (!ok) {
      setModelPrefAuto(true);
      setModelPrefModelId('');
    }
  }, [enabledImageModels, modelPrefAuto, modelPrefModelId]);

  // 启动时：加载 workspace 并回放历史消息+画布（workspaceId 为稳定主键）
  useEffect(() => {
    if (!workspaceId) return;
    if (initWorkspaceRef.current.workspaceId === workspaceId && initWorkspaceRef.current.started) return;
    initWorkspaceRef.current = { workspaceId, started: true };

    // 重置视口 hydration：避免进入页面时用默认值覆写服务器保存的 viewport
    viewportHydratedRef.current = false;
    lastViewportSavedRef.current = null;

    let cancelled = false;
    setBooting(true);
    (async () => {
      const detail = await getVisualAgentWorkspaceDetail({ id: workspaceId, messageLimit: INITIAL_MSG_LIMIT, assetLimit: 200 });
      if (!detail.success) {
        if (!cancelled) setError(detail.error?.message || '加载 Workspace 失败');
        return;
      }
      if (cancelled) return;
      setWorkspace(detail.data.workspace);
      setHasMoreMessages(!!detail.data.hasMoreMessages);

      // 服务器下发视口（缩放/相机）：首次进入也要回放，否则会永远停在 DEFAULT_ZOOM=0.5
      const vp = detail.data.viewport;
      if (vp && typeof vp.z === 'number' && typeof vp.x === 'number' && typeof vp.y === 'number') {
        lastViewportSavedRef.current = { z: vp.z, x: vp.x, y: vp.y };
        setViewport(clampZoom(vp.z), { x: vp.x, y: vp.y }, { syncUi: true });
      }
      viewportHydratedRef.current = true;

      const ms = Array.isArray(detail.data.messages) ? detail.data.messages : [];
      if (ms.length > 0) {
        setMessages(
          ms.map((m) => ({
            id: m.id,
            role: m.role === 'Assistant' ? 'Assistant' : 'User',
            content: String(m.content ?? ''),
            ts: Number.isFinite(Date.parse(m.createdAt)) ? Date.parse(m.createdAt) : Date.now(),
          }))
        );
      }

      const assets = Array.isArray(detail.data.assets) ? detail.data.assets : [];
      const assetsList = assets as ImageAsset[];

      const applyCanvasFocus = (items: CanvasImageItem[]) => {
        setCanvas(items);
        // 更新 nextRefId 为当前最大值 + 1
        const maxRef = getMaxRefId(items);
        if (maxRef > 0) {
          setNextRefId(maxRef + 1);
        }
        canvasBootedRef.current = true;
        // 修复：初始化时不自动选中第一张图片，而是清空选中
        clearSelectionWithChips();

        if (items.length > 0) {
          requestAnimationFrame(() => {
            const ae = document.activeElement as HTMLElement | null;
            const tag = (ae?.tagName ?? '').toLowerCase();
            const isEditable =
              tag === 'textarea' ||
              tag === 'input' ||
              Boolean(ae?.isContentEditable) ||
              Boolean(ae?.getAttribute?.('contenteditable'));
            if (isEditable) return;
            focusStage();
          });
        }
      };

      const canvasObj: VisualAgentCanvas | null = detail.data.canvas ?? null;
      if (canvasObj && String(canvasObj.payloadJson ?? '').trim()) {
        const parsed = safeJsonParse<PersistedCanvasStateV1>(String(canvasObj.payloadJson ?? ''));
        if (parsed && parsed.schemaVersion === 1 && Array.isArray(parsed.elements)) {
          const restored = persistedV1ToCanvas(parsed, assetsList);
          // 为没有 refId 的图片分配新的 refId（老数据迁移）
          const refIdChanged = assignMissingRefIds(restored.canvas);
          applyCanvasFocus(restored.canvas);

          // 同步 running 状态的元素：查询后端实际状态
          const runningElements = restored.canvas.filter((el) => el.status === 'running' && el.runId);
          if (runningElements.length > 0) {
            void (async () => {
              for (const el of runningElements) {
                try {
                  const res = await getImageGenRun({ runId: el.runId!, includeItems: true });
                  if (!res.success || !res.data?.run) continue;
                  const run = res.data.run;
                  if (run.status === 'Failed' || run.status === 'Cancelled') {
                    // 后端已失败，更新前端状态
                    setCanvas((prev) =>
                      prev.map((x) =>
                        x.key === el.key
                          ? { ...x, status: 'error', errorMessage: run.status === 'Failed' ? '生成失败（后端）' : '已取消' }
                          : x
                      )
                    );
                  } else if (run.status === 'Completed') {
                    // 后端已完成，尝试获取图片 URL
                    const item = res.data.items?.find((it) => it.url);
                    if (item?.url) {
                      setCanvas((prev) =>
                        prev.map((x) =>
                          x.key === el.key
                            ? { ...x, status: 'done', src: item.url!, kind: 'image' }
                            : x
                        )
                      );
                    } else {
                      // 完成但没有 URL，标记为错误
                      setCanvas((prev) =>
                        prev.map((x) =>
                          x.key === el.key
                            ? { ...x, status: 'error', errorMessage: '生成完成但无图片 URL' }
                            : x
                        )
                      );
                    }
                  }
                  // 如果是 Queued/Running，保持 running 状态，用户可以等待或重试
                } catch {
                  // 查询失败，保持原状态
                }
              }
            })();
          }

          if (restored.missingAssets > 0 || restored.localOnlyImages > 0) {
            pushMsg(
              'Assistant',
              `画布已恢复。${restored.missingAssets > 0 ? `有 ${restored.missingAssets} 个图片资产缺失已跳过。` : ''}${restored.localOnlyImages > 0 ? `有 ${restored.localOnlyImages} 张本地未持久化图片无法恢复。` : ''}`
            );
          }
          lastSavedJsonRef.current = canvasObj.payloadJson;
          pendingLocalOnlyWarnRef.current = Number((parsed.meta as { skippedLocalOnlyImages?: unknown } | undefined)?.skippedLocalOnlyImages ?? 0) || 0;
          // 如果有 refId 变更（老数据迁移），标记需要保存
          if (refIdChanged) {
            canvasDirtyRef.current = true;
          }
          return;
        }
        pushMsg('Assistant', '检测到画布数据格式异常，已回退到资产列表并重新建立画布。');
      }

      const fallbackItems: CanvasImageItem[] = (assetsList ?? [])
        .map((a) => ({
          key: a.id,
          assetId: a.id,
          sha256: a.sha256,
          createdAt: Number.isFinite(Date.parse(a.createdAt)) ? Date.parse(a.createdAt) : Date.now(),
          prompt: a.prompt ?? '',
          src: a.url || '',
          status: 'done' as const,
          kind: 'image' as const,
          syncStatus: 'synced' as const,
          syncError: null,
          w: typeof a.width === 'number' && a.width > 0 ? a.width : undefined,
          h: typeof a.height === 'number' && a.height > 0 ? a.height : undefined,
          naturalW: typeof a.width === 'number' && a.width > 0 ? a.width : undefined,
          naturalH: typeof a.height === 'number' && a.height > 0 ? a.height : undefined,
        }))
        .filter((x) => !!x.src)
        .slice(0, 60);

      applyCanvasFocus(fallbackItems);
      const built = canvasToPersistedV1(fallbackItems);
      const json = JSON.stringify(built.state);
      lastSavedJsonRef.current = json;
      void saveVisualAgentWorkspaceCanvas({ id: workspaceId, schemaVersion: PERSIST_SCHEMA_VERSION, payloadJson: json, idempotencyKey: `boot_${Date.now()}` });
    })()
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : '加载 Workspace 失败');
      })
      .finally(() => {
        if (!cancelled) setBooting(false);
      });

    return () => {
      cancelled = true;
      // React 18 StrictMode(dev) 会在 mount 后立刻执行一次 cleanup 再执行 effect 第二次。
      // 这里如果不重置 started，第二次 effect 会被守卫跳过，导致 workspace 永远不落地（表现为空白页）。
      if (initWorkspaceRef.current.workspaceId === workspaceId) {
        initWorkspaceRef.current.started = false;
      }
    };
  }, [focusStage, pushMsg, setViewport, workspaceId]);

  // 自动保存画布（debounce）
  useEffect(() => {
    if (!workspaceId) return;
    if (!canvasBootedRef.current) return;

    if (canvasSaveTimerRef.current != null) {
      window.clearTimeout(canvasSaveTimerRef.current);
      canvasSaveTimerRef.current = null;
    }

    canvasSaveTimerRef.current = window.setTimeout(() => {
      canvasSaveTimerRef.current = null;
      const built = canvasToPersistedV1(canvasRef.current ?? []);
      const json = JSON.stringify(built.state);
      if (json === lastSavedJsonRef.current) return;

      const now = Date.now();
      if (now - lastSaveAtRef.current < 800) return;
      lastSaveAtRef.current = now;
      lastSavedJsonRef.current = json;

      // 本地图片（data: / 非远程且无 assetId）在持久化前会被跳过，以避免把大内容写进画布 payload。
      // 体验修复：上传完成后要明确提示“已同步完成”，并重置计数，避免用户以为仍未持久化。
      if (built.skippedLocalOnlyImages === 0 && pendingLocalOnlyWarnRef.current > 0) {
        pendingLocalOnlyWarnRef.current = 0;
        pushMsg('Assistant', '同步完成：本地图片已持久化并纳入保存。');
      } else if (built.skippedLocalOnlyImages > 0 && pendingLocalOnlyWarnRef.current !== built.skippedLocalOnlyImages) {
        pendingLocalOnlyWarnRef.current = built.skippedLocalOnlyImages;
        pushMsg(
          'Assistant',
          `提示：有 ${built.skippedLocalOnlyImages} 张图片仍是本地临时内容（未持久化），不会被保存到画布。等待“同步中”完成后会自动纳入保存。`
        );
      }

      void saveVisualAgentWorkspaceCanvas({
        id: workspaceId,
        schemaVersion: PERSIST_SCHEMA_VERSION,
        payloadJson: json,
        idempotencyKey: `autosave_${Math.floor(now / 1000)}`,
      });
    }, 1200);

    return () => {
      if (canvasSaveTimerRef.current != null) {
        window.clearTimeout(canvasSaveTimerRef.current);
        canvasSaveTimerRef.current = null;
      }
    };
  }, [canvas, pushMsg, workspaceId]);

  // 初始化右侧宽度：localStorage 优先，否则默认 20%
  useEffect(() => {
    const el = containerRef.current;
    const cw = el?.clientWidth ?? 0;
    const fallback = Math.round((cw || 1200) * 0.2);
    const def = Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, fallback));
    let next = def;
    if (splitKey) {
      const raw = localStorage.getItem(splitKey);
      const n = raw ? Number(raw) : NaN;
      if (Number.isFinite(n) && n > 0) next = Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, Math.round(n)));
    }
    setRightWidth(next);
  }, [splitKey]);

  // 视口持久化改为走服务器：getWorkspaceDetail 返回 viewport；交互时 debounce PUT /viewport
  const viewportSaveTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!workspaceId) return;
    // 尚未从服务器回放 viewport 前，不允许写回（否则会把默认 0.5 写回覆盖用户保存值）
    if (!viewportHydratedRef.current) return;

    const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;
    const same = (a: { z: number; x: number; y: number }, b: { z: number; x: number; y: number }) =>
      near(a.z, b.z, 1e-6) && near(a.x, b.x, 0.02) && near(a.y, b.y, 0.02);
    const cur = { z: clampZoom(zoomRef.current), x: cameraRef.current.x, y: cameraRef.current.y };
    const def = { z: DEFAULT_ZOOM, x: 0, y: 0 };
    const last = lastViewportSavedRef.current;
    // 1) 未保存过且仍是默认值：不写（避免“进入页面就 PUT 一次”）
    if (!last && same(cur, def)) return;
    // 2) 与服务器已知值一致：不写
    if (last && same(cur, last)) return;

    if (viewportSaveTimerRef.current != null) {
      window.clearTimeout(viewportSaveTimerRef.current);
      viewportSaveTimerRef.current = null;
    }
    viewportSaveTimerRef.current = window.setTimeout(() => {
      viewportSaveTimerRef.current = null;
      const next = { z: clampZoom(zoomRef.current), x: cameraRef.current.x, y: cameraRef.current.y };
      const last2 = lastViewportSavedRef.current;
      if (!last2 && same(next, def)) return;
      if (last2 && same(next, last2)) return;
      void (async () => {
        const res = await saveVisualAgentWorkspaceViewport({
          id: workspaceId,
          z: next.z,
          x: next.x,
          y: next.y,
          idempotencyKey: `viewport_${Date.now()}`,
        });
        if (!res.success) return;
        const vp = res.data?.viewport;
        if (vp && typeof vp.z === 'number' && typeof vp.x === 'number' && typeof vp.y === 'number') {
          lastViewportSavedRef.current = { z: vp.z, x: vp.x, y: vp.y };
        }
      })();
    }, 600);
    return () => {
      if (viewportSaveTimerRef.current != null) window.clearTimeout(viewportSaveTimerRef.current);
      viewportSaveTimerRef.current = null;
    };
    // 依赖 zoom/camera state（低频同步后的值），避免每帧触发
  }, [camera, workspaceId, zoom]);

  // 拖拽 splitter
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const st = dragRef.current;
      if (!st?.dragging) return;
      const dx = e.clientX - st.startX;
      const next = st.startRight - dx;
      setRightWidth(Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, Math.round(next))));
      e.preventDefault();
    };
    const onUp = () => {
      const st = dragRef.current;
      if (!st?.dragging) return;
      dragRef.current = { dragging: false, startX: 0, startRight: 0 };
      if (splitKey) {
        try {
          localStorage.setItem(splitKey, String(rightWidth));
        } catch {
          // ignore
        }
      }
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [rightWidth, splitKey]);

  // 滚动到消息列表底部
  // ResizeObserver 监听消息内容高度变化（图片加载 / 新消息追加），自动滚动到底部
  const shouldAutoScrollRef = useRef(true);
  const programmaticScrollRef = useRef(false); // 标记是否为程序触发的滚动

  // 稳定 effect：只在 mount 时创建一次 ResizeObserver + scroll listener
  useEffect(() => {
    const scrollEl = scrollRef.current;
    const contentEl = msgContentRef.current;
    if (!scrollEl || !contentEl) return;

    const checkAutoScroll = () => {
      if (programmaticScrollRef.current) return;
      const threshold = 100;
      shouldAutoScrollRef.current = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < threshold;
    };

    const scrollToBottom = () => {
      if (!shouldAutoScrollRef.current) return;
      programmaticScrollRef.current = true;
      scrollEl.scrollTop = scrollEl.scrollHeight;
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
    };

    scrollEl.addEventListener('scroll', checkAutoScroll);

    // ResizeObserver 自动捕捉新消息 DOM 插入和图片加载导致的高度变化
    const ro = new ResizeObserver(() => {
      scrollToBottom();
    });
    ro.observe(contentEl);

    // 初始滚动
    shouldAutoScrollRef.current = true;
    scrollToBottom();

    return () => {
      scrollEl.removeEventListener('scroll', checkAutoScroll);
      ro.disconnect();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- mount-only, ResizeObserver handles dynamic content

  // ── 向上滚动加载更早消息 ──────────────────────────────────────────
  const loadOlderMessages = useCallback(async () => {
    if (loadingMoreRef.current || !hasMoreMessages || !workspaceId) return;
    loadingMoreRef.current = true;

    try {
      // 取最早消息的时间戳作为游标
      const oldest = messages[0];
      if (!oldest) return;
      const beforeTs = new Date(oldest.ts).toISOString();

      const res = await listVisualAgentWorkspaceMessages({
        id: workspaceId,
        before: beforeTs,
        limit: LOAD_MORE_LIMIT,
      });

      if (!res.success || !Array.isArray(res.data?.messages)) return;

      const olderMsgs: UiMsg[] = res.data.messages.map((m) => ({
        id: m.id,
        role: m.role === 'Assistant' ? ('Assistant' as const) : ('User' as const),
        content: String(m.content ?? ''),
        ts: Number.isFinite(Date.parse(m.createdAt)) ? Date.parse(m.createdAt) : Date.now(),
      }));

      if (olderMsgs.length === 0) {
        setHasMoreMessages(false);
        return;
      }

      setHasMoreMessages(res.data.hasMore);

      // 保留滚动位置：记住 prepend 前的 scrollHeight
      const scrollEl = scrollRef.current;
      const prevScrollHeight = scrollEl?.scrollHeight ?? 0;

      setMessages((prev) => [...olderMsgs, ...prev]);

      // Prepend 后恢复滚动位置（保持用户看到的内容不跳动）
      requestAnimationFrame(() => {
        if (scrollEl) {
          const newScrollHeight = scrollEl.scrollHeight;
          scrollEl.scrollTop += newScrollHeight - prevScrollHeight;
        }
      });
    } finally {
      loadingMoreRef.current = false;
    }
  }, [hasMoreMessages, messages, workspaceId]);

  // 滚动到顶部时触发加载
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    const onScroll = () => {
      // 距离顶部 80px 以内时触发加载
      if (scrollEl.scrollTop < 80 && hasMoreMessages && !loadingMoreRef.current) {
        void loadOlderMessages();
      }
    };

    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    return () => scrollEl.removeEventListener('scroll', onScroll);
  }, [hasMoreMessages, loadOlderMessages]);

  // 监听画布尺寸变化（用于居中/适配）
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const next = { w: el.clientWidth || 0, h: el.clientHeight || 0 };
      stageSizeRef.current = next;
      setStageSize(next);
    });
    ro.observe(el);
    const next = { w: el.clientWidth || 0, h: el.clientHeight || 0 };
    stageSizeRef.current = next;
    setStageSize(next);
    return () => ro.disconnect();
  }, []);

  // Space 键：按住拖拽平移（像 Figma）
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.key === ' ' || e.code === 'Space') {
        // 输入控件内不拦截 Space，避免无法输入空格
        const ae = document.activeElement as HTMLElement | null;
        const tag = (ae?.tagName ?? '').toLowerCase();
        const isEditable =
          tag === 'textarea' ||
          tag === 'input' ||
          Boolean(ae?.isContentEditable) ||
          Boolean(ae?.getAttribute?.('contenteditable'));
        if (isEditable) return;

        // 避免 Space 滚动页面
        e.preventDefault();
        setSpacePressed(true);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === ' ' || e.code === 'Space') {
        // 输入控件内不拦截 Space，避免无法输入空格
        const ae = document.activeElement as HTMLElement | null;
        const tag = (ae?.tagName ?? '').toLowerCase();
        const isEditable =
          tag === 'textarea' ||
          tag === 'input' ||
          Boolean(ae?.isContentEditable) ||
          Boolean(ae?.getAttribute?.('contenteditable'));
        if (isEditable) return;

        e.preventDefault();
        setSpacePressed(false);
      }
    };
    const opts: AddEventListenerOptions = { passive: false };
    window.addEventListener('keydown', onDown, opts);
    window.addEventListener('keyup', onUp, opts);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, []);

  // 画布快捷键兜底（当焦点不在画布上，但存在选中项时也应可操作）
  useEffect(() => {
    const deletingRef = { current: false };
    const onDown = (e: KeyboardEvent) => {
      // 若焦点已经在画布上，则交由画布自身 onKeyDown 处理，避免重复
      const stageEl = stageRef.current;
      const ae = document.activeElement as HTMLElement | null;
      if (stageEl && ae && stageEl.contains(ae)) return;

      // 输入控件内不处理，避免 Delete/Backspace 误删元素
      const tag = (ae?.tagName ?? '').toLowerCase();
      const isEditable =
        tag === 'textarea' ||
        tag === 'input' ||
        Boolean(ae?.isContentEditable) ||
        Boolean(ae?.getAttribute?.('contenteditable'));
      if (isEditable) return;

      const keys = selectedKeysRef.current;
      if (!keys || keys.length === 0) return;

      // Delete / Backspace：删除选中
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (deletingRef.current) return;
        deletingRef.current = true;
        e.preventDefault();
        void (async () => {
          try {
            await confirmAndDeleteSelectedKeys([...keys]);
          } finally {
            deletingRef.current = false;
          }
        })();
        return;
      }

      // Escape：取消选中，同时清除 pending chips
      if (e.key === 'Escape') {
        e.preventDefault();
        clearSelectionWithChips();
        return;
      }

      // 方向键：微调（Figma-ish）
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        const set = new Set(keys);
        setCanvas((prev) => prev.map((it) => (set.has(it.key) ? { ...it, x: (it.x ?? 0) + dx, y: (it.y ?? 0) + dy } : it)));
      }
    };
    // capture：尽量早于其它元素拿到事件，但仍遵守“输入控件不处理”的规则
    const opts = { capture: true } as const;
    window.addEventListener('keydown', onDown, opts);
    return () => window.removeEventListener('keydown', onDown, opts);
  }, [confirmAndDeleteSelectedKeys, focusStage, clearSelectionWithChips]);

  const zoomAt = useCallback((clientX: number, clientY: number, nextZoom: number) => {
    const el = stageRef.current;
    if (!el) {
      setViewport(nextZoom, cameraRef.current, { syncUi: true });
      return;
    }
    const rect = el.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const curZ = zoomRef.current;
    const curCam = cameraRef.current;
    const wx = (sx - curCam.x) / curZ;
    const wy = (sy - curCam.y) / curZ;
    // 保持鼠标所在世界点不动：sx = wx*next + camX'
    const nextCamX = sx - wx * nextZoom;
    const nextCamY = sy - wy * nextZoom;
    setViewport(nextZoom, { x: nextCamX, y: nextCamY });
  }, [setViewport]);

  const stageCenterClient = useCallback(() => {
    const el = stageRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, []);

  const stageCenterWorld = useCallback(() => {
    const z = zoomRef.current;
    const cam = cameraRef.current;
    // 关键：stageSize 初始可能为 0（ResizeObserver 尚未触发），这会导致 nearWorld 落在 (0,0) 造成“覆盖/堆叠”假象
    const sw = stageSizeRef.current.w || stageRef.current?.clientWidth || 900;
    const sh = stageSizeRef.current.h || stageRef.current?.clientHeight || 700;
    const cx = (sw / 2 - cam.x) / Math.max(0.0001, z);
    const cy = (sh / 2 - cam.y) / Math.max(0.0001, z);
    return { x: cx, y: cy };
  }, []);

  const findNearestFreeTopLeft = useCallback(
    (
      existing: Array<{ x: number; y: number; w: number; h: number }>,
      desiredW: number,
      desiredH: number,
      nearWorld: { x: number; y: number }
    ) => {
      const intersects = (
        a: { x: number; y: number; w: number; h: number },
        b: { x: number; y: number; w: number; h: number },
        pad = 16
      ) => {
        const ax0 = a.x - pad;
        const ay0 = a.y - pad;
        const ax1 = a.x + a.w + pad;
        const ay1 = a.y + a.h + pad;
        const bx0 = b.x;
        const by0 = b.y;
        const bx1 = b.x + b.w;
        const by1 = b.y + b.h;
        return ax0 < bx1 && ax1 > bx0 && ay0 < by1 && ay1 > by0;
      };

      const w = Math.max(1, Math.round(desiredW));
      const h = Math.max(1, Math.round(desiredH));
      const step = 48;
      // 自适应搜索半径
      const viewSpan = Math.max(stageSizeRef.current.w || 900, stageSizeRef.current.h || 700);
      const existingMax = existing.length ? Math.max(...existing.map((r) => Math.max(r.w, r.h))) : 0;
      const maxDim = Math.max(viewSpan * 2, existingMax * 2, w * 2, h * 2);
      const maxSteps = Math.max(26, Math.ceil((maxDim + 240) / step));

      // 使用欧氏距离优先的搜索：生成候选位置并按欧氏距离排序
      // 这样可以确保选择真正几何距离最近的空闲位置
      type Candidate = { gx: number; gy: number; dist: number };
      const candidates: Candidate[] = [];
      const seen = new Set<string>();

      // 生成网格候选位置（从中心向外扩展）
      for (let r = 0; r <= maxSteps; r++) {
        for (let gx = -r; gx <= r; gx++) {
          for (let gy = -r; gy <= r; gy++) {
            // 只取当前环上的点（曼哈顿距离 == r 或 首次出现）
            const key = `${gx},${gy}`;
            if (seen.has(key)) continue;
            seen.add(key);
            // 欧氏距离
            const dist = Math.sqrt(gx * gx + gy * gy);
            candidates.push({ gx, gy, dist });
          }
        }
      }

      // 按欧氏距离排序（最近的在前）
      candidates.sort((a, b) => a.dist - b.dist);

      // 依次检查候选位置，返回第一个不重叠的
      for (const c of candidates) {
        const worldCx = nearWorld.x + c.gx * step;
        const worldCy = nearWorld.y + c.gy * step;
        const x = Math.round(worldCx - w / 2);
        const y = Math.round(worldCy - h / 2);
        const cand = { x, y, w, h };
        const hit = existing.some((r) => intersects(r, cand, 18));
        if (!hit) return { x, y };
      }

      // fallback：直接放在中心
      return { x: Math.round(nearWorld.x - w / 2), y: Math.round(nearWorld.y - h / 2) };
    },
    []
  );

  const placeAtPointer = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!placing) return false;
      stageRef.current?.focus();
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const wx = (sx - cameraRef.current.x) / zoomRef.current;
      const wy = (sy - cameraRef.current.y) / zoomRef.current;
      const key = `${placing.kind}_${Date.now()}`;

      if (placing.kind === 'shape') {
        const st = placing.shapeType;
        const w = st === 'circle' ? 180 : 240;
        const h = st === 'circle' ? 180 : 160;
        const next: CanvasImageItem = {
          key,
          kind: 'shape',
          shapeType: st,
          createdAt: Date.now(),
          prompt: `Shape:${st}`,
          src: '',
          status: 'done',
          x: Math.round(wx - w / 2),
          y: Math.round(wy - h / 2),
          w,
          h,
          fill: 'rgba(255,255,255,0.86)',
          stroke: 'rgba(0,0,0,0.14)',
        };
        setCanvas((prev) => [next, ...prev].slice(0, 120));
        setSelectionWithoutChip([key]); // 形状不需要 chip
        setPlacing(null);
        return true;
      }

      const w = 320;
      const h = 88;
      const next: CanvasImageItem = {
        key,
        kind: 'text',
        createdAt: Date.now(),
        prompt: 'Text',
        src: '',
        status: 'done',
        x: Math.round(wx - w / 2),
        y: Math.round(wy - h / 2),
        w,
        h,
        text: 'Text',
        fontSize: 26,
        textColor: 'rgba(11,11,15,0.92)',
        fill: 'rgba(255,255,255,0.90)',
        stroke: 'rgba(0,0,0,0.10)',
      };
      setCanvas((prev) => [next, ...prev].slice(0, 120));
      setSelectionWithoutChip([key]); // 文字不需要 chip
      setPlacing(null);
      setTextEdit({ open: true, key, value: next.text || 'Text' });
      return true;
    },
    [placing]
  );

  const cameraAnimRef = useRef<number | null>(null);
  const animateCameraToWorldCenter = useCallback(
    (worldCx: number, worldCy: number) => {
      if (!stageSize.w || !stageSize.h) return;
      const z = zoomRef.current;
      const from = { ...cameraRef.current };
      const to = {
        x: stageSize.w / 2 - worldCx * z,
        y: stageSize.h / 2 - worldCy * z,
      };
      if (cameraAnimRef.current != null) cancelAnimationFrame(cameraAnimRef.current);
      const start = performance.now();
      const dur = 260;
      const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / dur);
        const k = easeOutCubic(t);
        const next = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
        setViewport(zoomRef.current, next, { syncUi: t >= 1 });
        if (t < 1) cameraAnimRef.current = requestAnimationFrame(tick);
        else cameraAnimRef.current = null;
      };
      cameraAnimRef.current = requestAnimationFrame(tick);
    },
    [setViewport, stageSize.h, stageSize.w]
  );

  /** 动画移动视角并适配尺寸，使指定矩形区域完整显示在视口中 */
  const animateCameraToFitRect = useCallback(
    (rect: { x: number; y: number; w: number; h: number }, opts?: { maxZoom?: number }) => {
      if (!stageSize.w || !stageSize.h) return;
      const pad = 60; // 留边距
      const viewW = Math.max(1, stageSize.w - pad * 2);
      const viewH = Math.max(1, stageSize.h - pad * 2);
      const rectW = Math.max(1, rect.w);
      const rectH = Math.max(1, rect.h);
      const maxZ = opts?.maxZoom ?? 1;
      // 计算合适的缩放比例，使矩形能够完整显示
      const targetZoom = clampZoom(Math.min(viewW / rectW, viewH / rectH, maxZ));
      const worldCx = rect.x + rectW / 2;
      const worldCy = rect.y + rectH / 2;
      const fromZoom = zoomRef.current;
      const fromCam = { ...cameraRef.current };
      const toZoom = targetZoom;
      const toCam = {
        x: stageSize.w / 2 - worldCx * toZoom,
        y: stageSize.h / 2 - worldCy * toZoom,
      };
      if (cameraAnimRef.current != null) cancelAnimationFrame(cameraAnimRef.current);
      const start = performance.now();
      const dur = 320; // 稍长一点的动画时间
      const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / dur);
        const k = easeOutCubic(t);
        const nextZoom = fromZoom + (toZoom - fromZoom) * k;
        const nextCam = { x: fromCam.x + (toCam.x - fromCam.x) * k, y: fromCam.y + (toCam.y - fromCam.y) * k };
        setViewport(nextZoom, nextCam, { syncUi: t >= 1 });
        if (t < 1) cameraAnimRef.current = requestAnimationFrame(tick);
        else cameraAnimRef.current = null;
      };
      cameraAnimRef.current = requestAnimationFrame(tick);
    },
    [setViewport, stageSize.h, stageSize.w]
  );

  const pickNearestGeneratorKey = useCallback(
    (items: CanvasImageItem[], nearWorld: { x: number; y: number }) => {
      const gens = items.filter((x) => (x.kind ?? 'image') === 'generator');
      if (gens.length === 0) return null;
      let best: { k: string; d: number } | null = null;
      for (const g of gens) {
        const cx = (g.x ?? 0) + (g.w ?? 1024) / 2;
        const cy = (g.y ?? 0) + (g.h ?? 1024) / 2;
        const d = Math.hypot(cx - nearWorld.x, cy - nearWorld.y);
        if (!best || d < best.d) best = { k: g.key, d };
      }
      return best?.k ?? null;
    },
    []
  );

  // Mac 触控板捏合缩放（Chrome/Edge 通常体现为 ctrlKey + wheel）
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;

    const onWheel = (ev: WheelEvent) => {
      // 空态不缩放
      if (canvas.length === 0) return;
      // pinch / ctrl+wheel：缩放
      if (ev.ctrlKey || ev.metaKey) {
        ev.preventDefault();
        const next = clampZoom(zoomRef.current * zoomFactorFromDeltaY(ev.deltaY));
        zoomAt(ev.clientX, ev.clientY, next);
        return;
      }
      // 双指滑动：平移（trackpad pan）
      ev.preventDefault();
      const cam = cameraRef.current;
      setViewport(zoomRef.current, { x: cam.x - ev.deltaX, y: cam.y - ev.deltaY });
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel as EventListener);
  }, [canvas.length, setViewport, zoomAt]);

  // 初始化/刷新时：确保 DOM transform 与 state/ref 一致
  useEffect(() => {
    zoomRef.current = zoom;
    cameraRef.current = camera;
    scheduleWorldTransform(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  const setActiveValue = (next: string) => {
    if (activeComposerRef.current === 'quick') setQuickInput(next);
    else setInput(next);
  };

  const getActiveTa = () => {
    if (activeComposerRef.current === 'quick') return quickInputRef.current;
    return inputRef.current;
  };

  const focusQuickComposer = () => {
    const ta = quickInputRef.current;
    if (!ta) return;
    requestAnimationFrame(() => {
      ta.focus();
    });
  };

  const replaceMentionAtCursor = (replacement: string) => {
    const ta = getActiveTa();
    if (!ta) return;
    const value = ta.value ?? '';
    const start = mentionAtPos ?? (ta.selectionStart ?? value.length);
    const end = ta.selectionStart ?? value.length;
    const next = value.slice(0, start) + replacement + value.slice(end);
    setActiveValue(next);
    setMentionOpen(false);
    setMentionQuery('');
    setMentionAtPos(null);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + replacement.length;
      ta.setSelectionRange(pos, pos);
    });
  };

  const findAtomicTagRangeAt = (s: string, caret: number) => {
    const patterns = [
      /@model\([^)]+\)\s?/g,
      /@vision\([^)]+\)\s?/g,
      /@img\d+\s?/g,
      /\(\s*@size\s*:\s*\d{2,5}\s*[xX×＊*]\s*\d{2,5}\s*\)\s?/g,
    ];
    for (const rx of patterns) {
      let m: RegExpExecArray | null;
      while ((m = rx.exec(s))) {
        const start = m.index;
        const end = start + m[0].length;
        if (caret > start && caret < end) return { start, end };
        if (caret === end) return { start, end };
      }
    }
    return null;
  };

  const applyAtomicDelete = (taArg?: HTMLTextAreaElement | null) => {
    const ta = taArg ?? getActiveTa();
    if (!ta) return false;
    const value = ta.value ?? '';
    const start = ta.selectionStart ?? value.length;
    const end = ta.selectionEnd ?? start;
    if (start !== end) return false;
    const caret = start;
    const range = findAtomicTagRangeAt(value, caret);
    if (!range) return false;
    // backspace 删除时：caret 可能在 token 中或 token 末尾；delete 也同理
    const next = value.slice(0, range.start) + value.slice(range.end);
    setActiveValue(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(range.start, range.start);
    });
    return true;
  };

  const makeAsciiArt = (text: string) => {
    const lines = String(text ?? '')
      .replaceAll('\r\n', '\n')
      .split('\n')
      .map((x) => x.replaceAll('\t', '    '));
    const width = Math.min(72, Math.max(12, Math.max(...lines.map((l) => l.length), 0)));
    const padLine = (l: string) => (l.length >= width ? l.slice(0, width) : l + ' '.repeat(width - l.length));
    const top = `┌${'─'.repeat(width)}┐`;
    const bottom = `└${'─'.repeat(width)}┘`;
    const body = lines.map((l) => `│${padLine(l)}│`).join('\n');
    return `${top}\n${body}\n${bottom}`;
  };

  const extractForcedImageModel = (text: string): { forced: Model | null; clean: string } => {
    const s = String(text ?? '');
    const re = /@model\(([^)]+)\)/gi;
    let m: RegExpExecArray | null = null;
    let last: string | null = null;
    while ((m = re.exec(s))) {
      last = String(m[1] ?? '').trim();
    }
    // 同类多次 @model(...)：取最后一个生效；其余从文本中剔除
    const all = Array.from(s.matchAll(re));
    const lastFull = all.length > 0 ? String(all[all.length - 1]?.[0] ?? '') : '';
    const keepLast = lastFull ? s.replace(lastFull, '__KEEP_LAST_MODEL__') : s;
    const clean = keepLast
      .replace(re, '')
      .replace('__KEEP_LAST_MODEL__', lastFull)
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!last) return { forced: null, clean };
    const key = last.toLowerCase();
    const forced =
      enabledImageModels.find((x) => String(x.name || '').trim().toLowerCase() === key) ??
      enabledImageModels.find((x) => String(x.modelName || '').trim().toLowerCase() === key) ??
      enabledImageModels.find((x) => String(x.name || x.modelName || '').toLowerCase().includes(key)) ??
      null;
    return { forced, clean };
  };

  // RichComposer 自动处理高度，已移除 recomputeTextareaHeight 相关逻辑

  const runFromText = async (
    displayText: string,
    requestText: string,
    imageRefs: CanvasImageItem[],
    seedSelectedKey?: string,
    sizeOverride?: string | null
  ) => {
    const display = String(displayText ?? '').trim();
    // 直连模式：解析 @model(...) 只用于"强制选模型"，不应当把标记本身发给生图 prompt
    const stripModelMention = (s: string) => String(s ?? '').replace(/@model\([^)]*\)/gi, '').replace(/\s{2,}/g, ' ').trim();

    const forcedPick = extractForcedImageModel(directPrompt ? displayText : requestText);
    const reqText = String(forcedPick.clean ?? '').trim();
    if (!reqText) return;
    const pickedModel = forcedPick.forced ?? effectiveModel;
    if (!pickedModel) {
      const msg = modelsLoading ? '模型加载中' : '暂无可用生图模型（请配置 image-gen 模型池或启用 isImageGen 模型）';
      setError(msg);
      pushMsg('Assistant', '暂无可用生图模型（请配置 image-gen 模型池或启用 isImageGen 模型）');
      return;
    }

    setError('');
    const seedKey = String(seedSelectedKey ?? '').trim();
    const selectedAtSend = seedKey ? (canvasRef.current.find((x) => x.key === seedKey) ?? null) : null;
    // 主引用图（第一张）用于尺寸推算等
    const primaryRef = imageRefs[0] ?? null;
    const refForUi = (primaryRef ?? selectedAtSend) as CanvasImageItem | null;
    const refSrc = String(refForUi?.src ?? '').trim();
    // 注意：不再使用 [IMAGE src=... name=...] 标记
    // 因为用户输入的 @imgN 引用已由 MessageContentRenderer 渲染为 Chip
    const forcedSize = (() => {
      const s = String(sizeOverride ?? '').trim();
      if (!s) return null;
      const parsed = tryParseWxH(s);
      return parsed ? `${parsed.w}x${parsed.h}` : s;
    })();
    const uiSizeToken = forcedSize ? `(@size:${forcedSize}) ` : '';
    const modelPoolName = pickedModel?.name || pickedModel?.modelName || '';
    const uiModelToken = modelPoolName ? `(@model:${modelPoolName}) ` : '';
    const userMsgForBackend = `${uiSizeToken}${uiModelToken}${display || reqText}`;
    pushMsg('User', userMsgForBackend);

    // ========== 统一图片引用：如果有选中图片但没有 @imgN，也加入 imageRefs ==========
    // 这样后端只需处理 imageRefs，无需区分 initImageAssetSha256
    let unifiedImageRefs = [...imageRefs];
    if (unifiedImageRefs.length === 0 && selectedAtSend) {
      const selSha = selectedAtSend.originalSha256 || selectedAtSend.sha256 || '';
      if (selSha.length === 64) {
        // 将选中的图片作为隐式的 @img1 加入引用列表
        unifiedImageRefs = [{ ...selectedAtSend, refId: 1 } as CanvasImageItem];
      }
    }

    // 收集所有参考图的 sha256（用于重试时恢复）
    const imageRefShas = unifiedImageRefs
      .map((img) => img.originalSha256 || img.sha256 || '')
      .filter((sha) => sha.length === 64);

    let items: Array<{ prompt: string }> = [];
    let firstPrompt = '';
    if (directPrompt) {
      firstPrompt = stripModelMention(reqText) || stripModelMention(display) || '';
      if (!firstPrompt) {
        const msg = '内容为空';
        pushMsg('Assistant', buildGenErrorContent({ msg, refSrc: refSrc || undefined, prompt: display || reqText || undefined, imageRefShas }));
        return;
      }
    } else {
      let plan: ImageGenPlanResponse | null = null;
      try {
        const pres = await planImageGen({ text: reqText, maxItems: 8 });
        if (!pres.success) {
          const msg = pres.error?.message || '解析失败';
          pushMsg('Assistant', buildGenErrorContent({ msg, refSrc: refSrc || undefined, prompt: reqText || undefined, imageRefShas }));
          return;
        }
        plan = pres.data ?? null;
      } catch (e) {
        const msg = e instanceof Error ? e.message : '网络错误';
        pushMsg('Assistant', buildGenErrorContent({ msg, refSrc: refSrc || undefined, prompt: reqText || undefined, imageRefShas }));
        return;
      }

      items = Array.isArray(plan?.items) ? (plan!.items as Array<{ prompt: string }>) : [];
      const fallbackPrompt = stripModelMention(reqText) || reqText;
      firstPrompt = String(items[0]?.prompt ?? '').trim() || fallbackPrompt;
    }

    const refDim =
      (primaryRef?.naturalW && primaryRef?.naturalH ? { w: primaryRef.naturalW, h: primaryRef.naturalH } : null) ??
      (selectedAtSend?.naturalW && selectedAtSend?.naturalH ? { w: selectedAtSend.naturalW, h: selectedAtSend.naturalH } : null);
    const resolvedSizeForGen = forcedSize ?? computeRequestedSizeByRefRatio(refDim) ?? imageGenSize;

    // 用户要求移除右侧“本次使用模型/直连模式/参考图...”类提示，不再 push 该类 Assistant 消息

    // 画板占位
    const near = stageCenterWorld();
    const selectedFirstKey = seedKey;
    const selectedIsGenerator = selectedFirstKey
      ? (canvasRef.current.find((x) => x.key === selectedFirstKey)?.kind ?? 'image') === 'generator'
      : false;
    const generatorExistingKey = selectedIsGenerator
      ? selectedFirstKey
      : pickNearestGeneratorKey(canvasRef.current, near);
    const key = generatorExistingKey ?? `gen_${Date.now()}`;
    // 获取参考图（选中图）的位置信息，用于联合适配
    const refItem = primaryRef ?? selectedAtSend;
    const refRect = refItem && typeof refItem.x === 'number' && typeof refItem.y === 'number'
      ? { x: refItem.x, y: refItem.y, w: refItem.w ?? 320, h: refItem.h ?? 220 }
      : undefined;
    // 保存参考图信息，用于重试时恢复
    const refImageKey = refItem?.key;
    const refImageSha256 = refItem?.originalSha256 ?? refItem?.sha256;

    setCanvas((prev) => {
      const existingRects = prev
        .filter(
          (x) =>
            ((x.kind ?? 'image') === 'generator' ||
              (x.kind ?? 'image') === 'shape' ||
              (x.kind ?? 'image') === 'text' ||
              !!x.src ||
              x.status === 'running' ||
              x.status === 'error')
        )
        .map((x) => ({ x: x.x ?? 0, y: x.y ?? 0, w: x.w ?? 1, h: x.h ?? 1 }));
      // 占位尺寸随 requested size（保持比例），避免"永远 1K 方形"的观感
      const parsedSize = tryParseWxH(resolvedSizeForGen);
      const genW = parsedSize?.w ?? 1024;
      const genH = parsedSize?.h ?? 1024;
      // 如果命中生成器区域：把生成结果写回同一个 key（不再新建一张图）
      if (generatorExistingKey) {
        const found = prev.find((x) => x.key === generatorExistingKey) ?? null;
        const gx = found?.x ?? near.x - genW / 2;
        const gy = found?.y ?? near.y - genH / 2;
        const gw = found?.w ?? genW;
        const gh = found?.h ?? genH;
        focusKeyRef.current = { key, cx: gx + gw / 2, cy: gy + gh / 2, w: gw, h: gh, refRect };
        return prev.map((x) =>
          x.key === generatorExistingKey
            ? {
                ...x,
                // 需求：一旦开始生成，生成器立即转换为"普通图片"（running）
                // 这样底部白色快捷输入框会消失，同时仍保持加载动画与可选中行为
                kind: 'image',
                createdAt: Date.now(),
                prompt: firstPrompt,
                status: 'running',
                errorMessage: null,
                // 保持面板位置与尺寸
                w: gw,
                h: gh,
                // 清空旧图，进入加载态（running）
                src: '',
                // 保存参考图信息，用于重试时恢复
                refImageKey,
                refImageSha256,
              }
            : x
        );
      }

      // 否则：新建一张图（放在视口附近的最近空位）
      const pos = findNearestFreeTopLeft(existingRects, genW, genH, near);
      const placeholder: CanvasImageItem = {
        key,
        kind: 'image',
        createdAt: Date.now(),
        prompt: firstPrompt,
        src: '',
        status: 'running',
        w: genW,
        h: genH,
        x: pos.x,
        y: pos.y,
        // 保存参考图信息，用于重试时恢复
        refImageKey,
        refImageSha256,
      };
      focusKeyRef.current = { key, cx: pos.x + genW / 2, cy: pos.y + genH / 2, w: genW, h: genH, refRect };
      // 重要：新元素要在最上层 => 放到数组末尾（后渲染覆盖先渲染）
      return [...prev, placeholder].slice(-60);
    });
    // 体验：像"上传图片"一样，开始生成就把视角移动到占位图位置（避免用户找不到新图）
    setSelectionWithoutChip([key]); // generator 不需要 chip
    requestAnimationFrame(() => {
      const f = focusKeyRef.current;
      if (!f || f.key !== key) return;
      // 新图可能很大，移动视角前先适配尺寸（选中图 + 目标图联合适配）
      if (f.w && f.h) {
        const targetRect = { x: f.cx - f.w / 2, y: f.cy - f.h / 2, w: f.w, h: f.h };
        if (f.refRect) {
          // 计算联合边界框
          const minX = Math.min(targetRect.x, f.refRect.x);
          const minY = Math.min(targetRect.y, f.refRect.y);
          const maxX = Math.max(targetRect.x + targetRect.w, f.refRect.x + f.refRect.w);
          const maxY = Math.max(targetRect.y + targetRect.h, f.refRect.y + f.refRect.h);
          animateCameraToFitRect({ x: minX, y: minY, w: maxX - minX, h: maxY - minY });
        } else {
          animateCameraToFitRect(targetRect);
        }
      } else {
        animateCameraToWorldCenter(f.cx, f.cy);
      }
    });

    try {
      const refForInit = (primaryRef ?? selected) as CanvasImageItem | null;
      const initSrc = (refForInit?.src ?? '').trim();
      const initSha = (refForInit?.sha256 ?? '').trim();
      let initImageBase64: string | undefined;
      let initImageUrl: string | undefined;
      let initImageAssetSha256: string | undefined;

      if (initSrc && initSrc.startsWith('data:')) {
        // 本地粘贴/未持久化：直接传 dataURL
        initImageBase64 = initSrc;
      } else if (initSha && initSha.length === 64) {
        // 已持久化资产：优先传原图 sha256，让服务端直接读文件（避免浏览器 CORS / 省流量 / 水印叠加）
        initImageAssetSha256 = initSha;
      } else if (initSrc) {
        // 若是自托管 file URL：解析 sha 后走 sha 逻辑（仍由服务端读取）
        const m = /\/api\/v1\/admin\/image-master\/assets\/file\/([^/?#]+)/.exec(initSrc);
        const name = (m?.[1] ?? '').trim();
        const sha = (name.split('.')[0] ?? '').trim().toLowerCase();
        if (sha.length === 64) {
          initImageAssetSha256 = sha;
        } else if (/^https?:\/\//i.test(initSrc)) {
          // 外链：直接传 url，让服务端下载转 base64（不会受浏览器 CORS 限制）
          initImageUrl = initSrc;
        }
      }

      // 新策略：将“生图 + 落盘”交给服务端后台任务 runId
      // - 服务端会：生图 -> 落 COS -> 写入 workspace 资产 -> 回填画布元素（key）
      // - 前端关闭页面不影响后台继续；下次打开 workspace 会直接看到结果

      // 若选择了首帧但还未持久化到资产（dataUrl/外链），先上传一次拿到 sha256（服务端 run 只接受 sha）
      // 关键修复：当引用图“看似有 sha”但其实还没落到本 workspace（或仍处于 pending/failed）时，也必须先确保落盘，
      // 否则后端会报“参考图不存在/不可用”，并且封面/保存都会缺失。
      if (refForInit) {
        const needEnsure =
          !initImageAssetSha256 ||
          refForInit.syncStatus !== 'synced' ||
          !refForInit.assetId ||
          !refForInit.sha256;

        if (needEnsure) {
          let data: string | undefined = initImageBase64;
          let sourceUrl: string | undefined = initImageUrl;

          // 若引用的是自托管 file URL（可能来自别的画板/别的 workspace），则从浏览器 fetch 出 blob 再上传进当前 workspace
          if (!data && initSrc.startsWith('/api/visual-agent/image-master/assets/file/')) {
            try {
              const r = await fetch(initSrc);
              if (r.ok) {
                const b = await r.blob();
                const d = await blobToDataUrl(b);
                if (d && d.startsWith('data:')) data = d;
              }
            } catch {
              // ignore
            }
          }

          // 若是 http(s) 但不允许服务端直下（或你希望统一走服务端存储），浏览器也可抓取后走 data
          if (!data && !sourceUrl && /^https?:\/\//i.test(initSrc)) {
            // 先尝试浏览器抓取（同源/可访问时更稳），失败再退回 sourceUrl 让服务端尝试下载
            try {
              const r = await fetch(initSrc);
              if (r.ok) {
                const b = await r.blob();
                const d = await blobToDataUrl(b);
                if (d && d.startsWith('data:')) data = d;
              }
            } catch {
              sourceUrl = initSrc;
            }
          }

          if (data || sourceUrl) {
            const up = await uploadVisualAgentWorkspaceAsset({
              id: workspaceId,
              data,
              sourceUrl,
              prompt: (refForInit?.prompt ?? '').trim() || 'reference',
              width: refForInit?.naturalW,
              height: refForInit?.naturalH,
            });
            if (up.success) {
              initImageAssetSha256 = up.data.asset.sha256;
              const a = up.data.asset;
              const refKey = refForInit?.key;
              if (refKey) {
                setCanvas((prev) =>
                  prev.map((x) =>
                    x.key === refKey
                      ? { ...x, assetId: a.id, sha256: a.sha256, src: a.url || x.src, syncStatus: 'synced', syncError: null }
                      : x
                  )
                );
              }
              // best-effort：刷新封面（尤其当这是该 workspace 第一张图时）
              void (async () => {
                const r2 = await refreshVisualAgentWorkspaceCover({ id: workspaceId, idempotencyKey: `cover_${Date.now()}` });
                if (r2.success) setWorkspace(r2.data.workspace);
              })();
            } else {
              const msg2 = up.error?.message || '参考图持久化失败';
              // 避免继续传入“看似有 sha 但不可用”的引用，导致后端直接报错
              initImageAssetSha256 = undefined;
              const refKey = refForInit?.key;
              if (refKey) {
                setCanvas((prev) =>
                  prev.map((x) => (x.key === refKey ? { ...x, syncStatus: 'failed', syncError: msg2 } : x))
                );
              }
              pushMsg('Assistant', `参考图未能持久化到后端资产：${msg2}`);
            }
          }
        }
      }

      const cur = canvasRef.current.find((x) => x.key === key) ?? null;

      // 关键：在调用后端生成任务前，强制立即保存 canvas（确保占位元素已持久化）
      // 避免用户关闭页面后，后端回填时找不到目标元素
      {
        const built = canvasToPersistedV1(canvasRef.current ?? []);
        const json = JSON.stringify(built.state);
        if (json !== lastSavedJsonRef.current) {
          lastSavedJsonRef.current = json;
          lastSaveAtRef.current = Date.now();
          await saveVisualAgentWorkspaceCanvas({
            id: workspaceId,
            schemaVersion: PERSIST_SCHEMA_VERSION,
            payloadJson: json,
            idempotencyKey: `preGenSave_${key}`,
          });
        }
      }

      // ========== 统一构建 imageRefs（使用 unifiedImageRefs）==========
      // 如果通过选中图片触发且刚上传成功，需要更新 unifiedImageRefs 中的 sha256
      if (initImageAssetSha256 && unifiedImageRefs.length > 0 && !unifiedImageRefs[0].sha256) {
        unifiedImageRefs = unifiedImageRefs.map((img, idx) =>
          idx === 0 ? { ...img, sha256: initImageAssetSha256, originalSha256: initImageAssetSha256 } : img
        );
      }

      // 构建发送给后端的 imageRefs
      // label 使用顺序号（第1张图、第2张图），避免 VLM 描述与用户称呼不一致导致语义混乱
      const imageRefsForBackend = unifiedImageRefs
        .filter((img) => img.sha256 || img.originalSha256) // 只传有 sha256 的图片
        .map((img, idx) => ({
          refId: img.refId ?? (idx + 1),
          assetSha256: img.originalSha256 || img.sha256 || '',
          url: img.originalSrc || img.src || '',
          label: `第${idx + 1}张图`,
        }));

      const runRes = await createWorkspaceImageGenRun({
        id: workspaceId,
        input: {
          prompt: firstPrompt,
          targetKey: key,
          x: typeof cur?.x === 'number' ? cur!.x : undefined,
          y: typeof cur?.y === 'number' ? cur!.y : undefined,
          w: typeof cur?.w === 'number' ? cur!.w : undefined,
          h: typeof cur?.h === 'number' ? cur!.h : undefined,
          ...(pickedModel!.id.startsWith('pool_')
            ? { platformId: pickedModel!.platformId, modelId: pickedModel!.modelName }
            : { configModelId: pickedModel!.id }),
          size: resolvedSizeForGen,
          responseFormat: 'url',
          // 统一使用 imageRefs（后端兼容层会处理 initImageAssetSha256）
          imageRefs: imageRefsForBackend.length > 0 ? imageRefsForBackend : undefined,
          userMessageContent: userMsgForBackend,
        },
        idempotencyKey: `imRun_${workspaceId}_${key}`,
      });
      if (!runRes.success) {
        const msg = runRes.error?.message || '生成失败';
        setCanvas((prev) => prev.map((x) => (x.key === key ? { ...x, status: 'error', errorMessage: msg } : x)));
        pushMsg('Assistant', buildGenErrorContent({ msg, refSrc: refSrc || undefined, prompt: firstPrompt || undefined, imageRefShas }));
        triggerDefectFlash();
        return;
      }

      const runId = String(runRes.data?.runId ?? '').trim();
      if (!runId) {
        const msg = '未返回 runId';
        setCanvas((prev) => prev.map((x) => (x.key === key ? { ...x, status: 'error', errorMessage: msg } : x)));
        pushMsg('Assistant', buildGenErrorContent({ msg, refSrc: refSrc || undefined, prompt: firstPrompt || undefined, imageRefShas }));
        triggerDefectFlash();
        return;
      }

      // 保存 runId 到画布元素，用于刷新页面后同步状态
      setCanvas((prev) => prev.map((x) => (x.key === key ? { ...x, runId } : x)));

      // 可选：订阅进度并实时替换（关闭页面也没关系，服务端会最终回填）
      const ac = new AbortController();
      streamImageGenRunWithRetry({
        runId,
        signal: ac.signal,
        onEvent: (evt) => {
          const data = String(evt.data ?? '').trim();
          if (!data) return;
          let obj: unknown = null;
          try {
            obj = JSON.parse(data) as unknown;
          } catch {
            return;
          }
          const o = obj as ImageGenRunStreamPayload;
          const t = String(o.type ?? '');
          if (t === 'imageDone') {
            const assetRaw = o.asset ?? null;
            const asset = assetRaw
              ? {
                  id: String(assetRaw.id ?? ''),
                  sha256: String(assetRaw.sha256 ?? ''),
                  url: String(assetRaw.url ?? ''),
                  originalUrl: String(assetRaw.originalUrl ?? ''),
                  originalSha256: String(assetRaw.originalSha256 ?? ''),
                }
              : null;
            const u = String(asset?.url ?? o.url ?? '');
            // 原图信息：优先用 asset（后端持久化的），否则用 SSE 顶层字段
            const originalU = String(asset?.originalUrl || o.originalUrl || u || '');
            const originalSha = String(asset?.originalSha256 || o.originalSha256 || asset?.sha256 || '');
            if (!u) return;
            setCanvas((prev) =>
              prev.map((x) =>
                x.key === key
                  ? {
                      ...x,
                      kind: 'image',
                      status: 'done',
                      src: u,
                      originalSrc: originalU,
                      assetId: (asset?.id || '').trim() || x.assetId,
                      sha256: (asset?.sha256 || '').trim() || x.sha256,
                      originalSha256: originalSha.trim() || x.originalSha256,
                      syncStatus: 'synced',
                      syncError: null,
                    }
                  : x
              )
            );
            const modelPoolName = pickedModel?.name || pickedModel?.modelName || '';
            pushMsg('Assistant', buildGenDoneContent({ src: u, refSrc: refSrc || undefined, prompt: firstPrompt || undefined, runId, modelPool: modelPoolName, imageRefShas }));
          } else if (t === 'imageError' || t === 'error') {
            const msg = String(o.errorMessage ?? '生成失败');
            setCanvas((prev) => prev.map((x) => (x.key === key ? { ...x, status: 'error', errorMessage: msg } : x)));
            const modelPoolName = pickedModel?.name || pickedModel?.modelName || '';
            pushMsg('Assistant', buildGenErrorContent({ msg, refSrc: refSrc || undefined, prompt: firstPrompt || undefined, runId, modelPool: modelPoolName, imageRefShas }));
            triggerDefectFlash();
          }
        },
      }).then(() => {
        // SSE 流结束后，检查该图片是否还在 running 状态
        // 如果是，说明服务端没有返回最终状态，需要标记为 error
        setCanvas((prev) => {
          const item = prev.find((x) => x.key === key);
          if (item && item.status === 'running') {
            pushMsg('Assistant', buildGenErrorContent({ msg: '生成超时或连接中断，请重试', refSrc: refSrc || undefined, prompt: firstPrompt || undefined, runId, modelPool: pickedModel?.name || pickedModel?.modelName || '', imageRefShas }));
            triggerDefectFlash();
          }
          return prev.map((x) =>
            x.key === key && x.status === 'running'
              ? { ...x, status: 'error', errorMessage: '生成超时或连接中断，请重试' }
              : x
          );
        });
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : '生成失败';
      setCanvas((prev) => prev.map((x) => (x.key === key ? { ...x, status: 'error', errorMessage: msg } : x)));
      pushMsg('Assistant', buildGenErrorContent({ msg, refSrc: refSrc || undefined, prompt: firstPrompt || undefined, imageRefShas }));
      triggerDefectFlash();
    }
  };

  // ── 快捷操作执行（写入消息列表以便追溯） ──
  const executeQuickAction = useCallback(
    async (prompt: string, sourceItem: CanvasImageItem, sizeOverride?: string, maskBase64?: string, actionLabel?: string) => {
      if (!prompt.trim()) return;
      const pickedModel = effectiveModel;
      if (!pickedModel) {
        toast.error('暂无可用生图模型');
        return;
      }
      // 记录用户操作到消息面板（包含参考图引用，便于追溯）
      const label = actionLabel || '快捷编辑';
      const refSrc = sourceItem.originalSrc || sourceItem.src || '';
      const refTag = sourceItem.refId ? ` @img${sourceItem.refId}` : '';
      const qaUserMsg = `[${label}]${refTag} ${prompt}`;
      pushMsg('User', qaUserMsg);
      // 标记：后端消息会在上传后用 COS URL 重新构建（qaMsgForBackend）
      let qaMsgForBackend = qaUserMsg;
      // 尺寸自适应：基于源图原始尺寸（支持外部覆盖，如 HD 放大需要升档）
      const refDim =
        sourceItem.naturalW && sourceItem.naturalH
          ? { w: sourceItem.naturalW, h: sourceItem.naturalH }
          : null;
      const resolvedSize = sizeOverride ?? computeRequestedSizeByRefRatio(refDim) ?? imageGenSize;
      const parsedSize = tryParseWxH(resolvedSize);
      const genW = parsedSize?.w ?? 1024;
      const genH = parsedSize?.h ?? 1024;

      // 确保源图有 sha256（若未持久化，先上传）
      let assetSha256 = sourceItem.originalSha256 || sourceItem.sha256 || '';
      if (!assetSha256 || assetSha256.length !== 64) {
        const srcUrl = sourceItem.src || '';
        let data: string | undefined;
        if (srcUrl.startsWith('data:')) {
          data = srcUrl;
        } else if (srcUrl) {
          try {
            const r = await fetch(srcUrl);
            if (r.ok) {
              const b = await r.blob();
              const d = await blobToDataUrl(b);
              if (d?.startsWith('data:')) data = d;
            }
          } catch { /* ignore */ }
        }
        if (data) {
          const up = await uploadVisualAgentWorkspaceAsset({
            id: workspaceId,
            data,
            prompt: sourceItem.prompt || 'reference',
            width: sourceItem.naturalW,
            height: sourceItem.naturalH,
          });
          if (up.success) {
            assetSha256 = up.data.asset.sha256;
            // 用 COS URL 重建后端消息（刷新后不再依赖 canvas refId）
            const cosUrl = up.data.asset.url || '';
            if (cosUrl) {
              const imgTag = maskBase64 ? `[IMG:${cosUrl}|参考图] [蒙版已应用]` : `[IMG:${cosUrl}|参考图]`;
              qaMsgForBackend = `[${label}] ${imgTag} ${prompt}`;
            }
            // 更新源图的 syncStatus
            setCanvas((prev) =>
              prev.map((x) =>
                x.key === sourceItem.key
                  ? { ...x, assetId: up.data.asset.id, sha256: up.data.asset.sha256, syncStatus: 'synced' as const, syncError: null }
                  : x
              )
            );
          } else {
            toast.error('参考图上传失败：' + (up.error?.message || '未知错误'));
            return;
          }
        } else {
          toast.error('无法获取参考图数据');
          return;
        }
      }

      // 画布占位：固定放在源图右侧（间距 24px），与源图顶部对齐
      const key = `qa_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const sourceX = sourceItem.x ?? 0;
      const sourceY = sourceItem.y ?? 0;
      const sourceW = sourceItem.w ?? 320;
      const newX = sourceX + sourceW + 24;
      const newY = sourceY;

      setCanvas((prev) => {
        const placeholder: CanvasImageItem = {
          key,
          kind: 'image',
          createdAt: Date.now(),
          prompt: prompt,
          src: '',
          status: 'running',
          w: genW,
          h: genH,
          x: newX,
          y: newY,
        };
        return [...prev, placeholder].slice(-60);
      });
      setSelectionWithoutChip([key]);

      // 强制保存 canvas（确保占位元素已持久化）
      {
        const built = canvasToPersistedV1(canvasRef.current ?? []);
        const json = JSON.stringify(built.state);
        if (json !== lastSavedJsonRef.current) {
          lastSavedJsonRef.current = json;
          lastSaveAtRef.current = Date.now();
          await saveVisualAgentWorkspaceCanvas({
            id: workspaceId,
            schemaVersion: PERSIST_SCHEMA_VERSION,
            payloadJson: json,
            idempotencyKey: `qaPreSave_${key}`,
          });
        }
      }

      // 调用后端生成
      try {
        const runRes = await createWorkspaceImageGenRun({
          id: workspaceId,
          input: {
            prompt,
            targetKey: key,
            ...(pickedModel.id.startsWith('pool_')
              ? { platformId: pickedModel.platformId, modelId: pickedModel.modelName }
              : { configModelId: pickedModel.id }),
            size: resolvedSize,
            responseFormat: 'url',
            imageRefs: [
              {
                refId: 1,
                assetSha256,
                url: sourceItem.originalSrc || sourceItem.src || '',
                label: '原图',
              },
            ],
            maskBase64: maskBase64 || undefined,
            userMessageContent: qaMsgForBackend,
          },
          idempotencyKey: `qaRun_${workspaceId}_${key}`,
        });
        if (!runRes.success) {
          const msg = runRes.error?.message || '快捷操作失败';
          setCanvas((prev) => prev.map((x) => (x.key === key ? { ...x, status: 'error', errorMessage: msg } : x)));
          pushMsg('Assistant', buildGenErrorContent({ msg, refSrc: refSrc || undefined, prompt }));
          return;
        }
        const runId = String(runRes.data?.runId ?? '').trim();
        if (!runId) {
          setCanvas((prev) => prev.map((x) => (x.key === key ? { ...x, status: 'error', errorMessage: '未返回 runId' } : x)));
          pushMsg('Assistant', buildGenErrorContent({ msg: '未返回 runId', refSrc: refSrc || undefined, prompt }));
          return;
        }
        const modelPoolName = pickedModel?.name || pickedModel?.modelName || '';
        setCanvas((prev) => prev.map((x) => (x.key === key ? { ...x, runId } : x)));

        // 订阅 SSE 流
        const ac = new AbortController();
        void streamImageGenRunWithRetry({
          runId,
          signal: ac.signal,
          onEvent: (evt) => {
            const data = String(evt.data ?? '').trim();
            if (!data) return;
            let obj: unknown = null;
            try { obj = JSON.parse(data); } catch { return; }
            const o = obj as ImageGenRunStreamPayload;
            const t = String(o.type ?? '');
            if (t === 'imageDone') {
              const assetRaw = o.asset ?? null;
              const asset = assetRaw
                ? { id: String(assetRaw.id ?? ''), sha256: String(assetRaw.sha256 ?? ''), url: String(assetRaw.url ?? ''), originalUrl: String(assetRaw.originalUrl ?? ''), originalSha256: String(assetRaw.originalSha256 ?? '') }
                : null;
              const u = String(asset?.url ?? o.url ?? '');
              const originalU = String(asset?.originalUrl || o.originalUrl || u || '');
              const originalSha = String(asset?.originalSha256 || o.originalSha256 || asset?.sha256 || '');
              if (!u) return;
              setCanvas((prev) =>
                prev.map((x) =>
                  x.key === key
                    ? { ...x, kind: 'image', status: 'done', src: u, originalSrc: originalU, assetId: (asset?.id || '').trim() || x.assetId, sha256: (asset?.sha256 || '').trim() || x.sha256, originalSha256: originalSha.trim() || x.originalSha256, syncStatus: 'synced', syncError: null }
                    : x
                )
              );
              pushMsg('Assistant', buildGenDoneContent({ src: u, refSrc: refSrc || undefined, prompt, runId, modelPool: modelPoolName }));
            } else if (t === 'imageError' || t === 'error') {
              const msg = String(o.errorMessage ?? '快捷操作失败');
              setCanvas((prev) => prev.map((x) => (x.key === key ? { ...x, status: 'error', errorMessage: msg } : x)));
              pushMsg('Assistant', buildGenErrorContent({ msg, refSrc: refSrc || undefined, prompt, runId, modelPool: modelPoolName }));
            }
          },
        }).then(() => {
          setCanvas((prev) => {
            const item = prev.find((x) => x.key === key);
            if (item && item.status === 'running') {
              pushMsg('Assistant', buildGenErrorContent({ msg: '生成超时或连接中断，请重试', refSrc: refSrc || undefined, prompt, modelPool: modelPoolName }));
            }
            return prev.map((x) =>
              x.key === key && x.status === 'running'
                ? { ...x, status: 'error', errorMessage: '生成超时或连接中断，请重试' }
                : x
            );
          });
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : '快捷操作失败';
        setCanvas((prev) => prev.map((x) => (x.key === key ? { ...x, status: 'error', errorMessage: msg } : x)));
        pushMsg('Assistant', buildGenErrorContent({ msg, refSrc: refSrc || undefined, prompt }));
      }
    },
    [effectiveModel, imageGenSize, workspaceId, setSelectionWithoutChip, pushMsg],
  );

  /** 快捷操作栏：点击内置/DIY 操作 */
  const handleQuickAction = useCallback(
    (action: QuickAction) => {
      if (!selected || selected.status !== 'done' || !selected.src) {
        toast.error('请先选中一张已完成的图片');
        return;
      }
      // HD 放大：自动升级尺寸档位（1K→2K, 2K→4K）
      let sizeOverride: string | undefined;
      if (action.id === 'hd-upscale') {
        const refDim =
          selected.naturalW && selected.naturalH
            ? { w: selected.naturalW, h: selected.naturalH }
            : null;
        const currentSize = computeRequestedSizeByRefRatio(refDim) ?? imageGenSize;
        const currentTier = detectTierFromSize(currentSize);
        if (currentTier) {
          // 找到当前比例
          const matchedAspect = ASPECT_OPTIONS.find((opt) => {
            const s = currentTier === '1k' ? opt.size1k : currentTier === '2k' ? opt.size2k : opt.size4k;
            return s.toLowerCase() === currentSize.toLowerCase();
          });
          if (matchedAspect) {
            const nextTier = currentTier === '1k' ? '2k' : currentTier === '2k' ? '4k' : '4k';
            sizeOverride = getSizeForTier(matchedAspect.id, nextTier);
          }
        }
      }
      void executeQuickAction(action.prompt, selected, sizeOverride, undefined, action.name);
    },
    [selected, executeQuickAction, imageGenSize],
  );

  /** 快捷编辑：用户在输入框描述编辑内容 */
  const handleQuickEditSubmit = useCallback(
    (text: string) => {
      if (!selected || selected.status !== 'done' || !selected.src) {
        toast.error('请先选中一张已完成的图片');
        return;
      }
      setQuickEditRunning(true);
      void executeQuickAction(text, selected, undefined, undefined, '快捷编辑').finally(() => setQuickEditRunning(false));
    },
    [selected, executeQuickAction],
  );

  // 处理初始 prompt（从首页快捷输入跳转过来，或从 sessionStorage 读取）
  const initialPromptHandledRef = useRef(false);
  const [initialPrompt, setInitialPrompt] = useState<{
    text: string;
    size: string | null;
    inlineImage?: { src: string; name?: string };
  } | null>(initialPromptFromProps ? parseInlinePrompt(initialPromptFromProps) : null);

  // 从 sessionStorage 读取初始消息（如果 props 中没有提供）
  useEffect(() => {
    if (initialPromptFromProps) {
      setInitialPrompt(parseInlinePrompt(initialPromptFromProps));
      return;
    }
    if (!workspaceId) return;
    const sessionKey = `visual_agent_init_${workspaceId}`;
    try {
      const stored = sessionStorage.getItem(sessionKey);
      if (!stored) return;
      const data = JSON.parse(stored);
      // 读取后立即删除，避免重复执行
      sessionStorage.removeItem(sessionKey);
      const messageText = String(data.messageText || '').trim();
      if (messageText) {
        setInitialPrompt(parseInlinePrompt(messageText));
      }
    } catch {
      // ignore
    }
  }, [workspaceId, initialPromptFromProps]);

  // 首页带入处理（入口3）
  useEffect(() => {
    if (!initialPrompt?.text) return;
    if (initialPromptHandledRef.current) return;
    if (!workspace) return;
    if (modelsLoading) return;
    if (!canvasBootedRef.current) return;

    // 标记已处理，避免重复执行
    initialPromptHandledRef.current = true;

    // 延迟执行，确保 UI 已渲染完成
    const timer = window.setTimeout(() => {
      const inline = initialPrompt.inlineImage;

      // 如果有内联图片，先添加到 canvas
      if (inline?.src) {
        const inlineKey = `inline_${Date.now()}`;
        // 为新图片分配 refId
        const maxExisting = canvasRef.current.reduce((acc, x) => (typeof x.refId === 'number' && x.refId > acc ? x.refId : acc), 0);
        const newRefId = Math.max(nextRefId, maxExisting + 1);
        setNextRefId(newRefId + 1);
        
        const inlineCanvasItem: CanvasImageItem = {
          key: inlineKey,
          createdAt: Date.now(),
          prompt: inline.name || '参考图',
          src: inline.src,
          status: 'done',
          kind: 'image',
          refId: newRefId,
        };
        setCanvas((prev) => [...prev, inlineCanvasItem]);
        // 手动同步选中和 chip（因为 setCanvas 是异步的）
        setSelectedKeys([inlineKey]);
        richComposerRef.current?.clearPending();
        richComposerRef.current?.insertImageChip(
          { key: inlineKey, refId: newRefId, src: inline.src, label: inline.name || `img${newRefId}` },
          { preserveFocus: true }
        );
      }

      // 通过统一守门员发送（inlineImage 现在已在 canvas 中，会被 selectedKeys 引用）
      void sendText(initialPrompt.text, {
        inlineImage: inline,
      });
    }, 500);

    return () => window.clearTimeout(timer);
  }, [initialPrompt, workspace, modelsLoading]);

  const insertAtCursor = (text: string) => {
    const ta = inputRef.current;
    if (!ta) return;
    const value = ta.value ?? '';
    const start = ta.selectionStart ?? value.length;
    const end = ta.selectionEnd ?? value.length;
    const next = value.slice(0, start) + text + value.slice(end);
    setInput(next);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + text.length;
      ta.setSelectionRange(pos, pos);
    });
  };

  const drainGenQueue = () => {
    while (runningCountRef.current < MAX_GEN_CONCURRENCY && pendingJobsRef.current.length > 0) {
      const job = pendingJobsRef.current.shift()!;
      setPendingCount(pendingJobsRef.current.length);
      runningCountRef.current += 1;
      setRunningCount(runningCountRef.current);
      setBusy(runningCountRef.current > 0);

      void (async () => {
        try {
          await runFromText(job.displayText, job.requestText, job.imageRefs, job.seedSelectedKey, job.sizeOverride);
        } finally {
          runningCountRef.current = Math.max(0, runningCountRef.current - 1);
          setRunningCount(runningCountRef.current);
          setBusy(runningCountRef.current > 0);
          setPendingCount(pendingJobsRef.current.length);
          drainGenQueue();
        }
      })();
    }
  };

  /**
   * 统一发送函数（三入口守门员）
   * @param rawText 原始文本
   * @param opts.chipRefs 来自 RichComposer 的 chip 引用
   * @param opts.inlineImage 首页带入的内联图片
   */
  const sendText = async (rawText: string, opts?: {
    chipRefs?: ChipRef[];
    inlineImage?: { src: string; name?: string };
  }) => {
    const raw = String(rawText ?? '').trim();
    if (!raw) return;
    const now = Date.now();
    const last = sendGuardRef.current;
    if (last && last.text === raw && now - last.at < 500) return;
    sendGuardRef.current = { text: raw, at: now };
    const sized = extractSizeToken(raw);
    const cleanDisplay = String(sized.cleanText ?? '').trim();
    if (!cleanDisplay) return;

    // 使用统一解析器
    const contractCanvas: ContractCanvasItem[] = canvas
      .filter((it) => (it.kind ?? 'image') === 'image' && it.src)
      .map((it) => ({
        key: it.key,
        refId: it.refId ?? 0,
        src: it.src!,
        label: it.prompt || '',
      }));

    const resolveResult = resolveImageRefs({
      rawText: cleanDisplay,
      chipRefs: opts?.chipRefs ?? [],
      selectedKeys,
      inlineImage: opts?.inlineImage,
      canvas: contractCanvas,
    });

    // 使用新的 buildRequestText
    const { requestText } = buildRequestText(
      resolveResult.cleanText,
      resolveResult.refs
    );

    // 转换所有 refs 为 CanvasImageItem（用于 UI 显示和生成）
    const imageRefs: CanvasImageItem[] = resolveResult.refs
      .map((ref) => canvas.find((c) => c.key === ref.canvasKey))
      .filter((c): c is CanvasImageItem => !!c);

    const seedSelectedKey = String(selectedKeysRef.current?.[0] ?? '').trim();
    const sizeOverride = sized.size ?? composerSize ?? autoSizeForSelectedImage ?? null;
    const job: GenJob = {
      id: `job_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      displayText: cleanDisplay,
      requestText,
      imageRefs,
      seedSelectedKey,
      sizeOverride,
    };
    pendingJobsRef.current.push(job);
    setPendingCount(pendingJobsRef.current.length);
    drainGenQueue();

    // 首次发送时，自动生成工作区标题
    if (!titleGenTriggeredRef.current && workspaceId) {
      const ws = workspaceRef.current;
      if (!ws || ws.title === '未命名' || !ws.title) {
        titleGenTriggeredRef.current = true;
        generateVisualAgentWorkspaceTitle(workspaceId, cleanDisplay).then((res) => {
          if (res.success && res.data?.title) {
            setWorkspace((prev) => prev ? { ...prev, title: res.data.title } : prev);
          }
        }).catch(() => { /* ignore */ });
      }
    }
  };

  // ── Keep retryRef in sync with latest sendText + canvas ──────────
  retryRef.current = (prompt, imageRefShas, canvasSnapshot) => {
    if (!prompt) return;
    const shas = imageRefShas || [];
    if (shas.length === 0) {
      void sendText(prompt);
      return;
    }
    const refIdMatches = [...prompt.matchAll(/@img(\d+)/gi)];
    const originalRefIds = refIdMatches.map((m) => parseInt(m[1], 10));
    const foundItems = shas
      .map((sha) => canvasSnapshot.find((c) => c.sha256 === sha || c.originalSha256 === sha))
      .filter((c): c is NonNullable<typeof c> => !!c && !!c.src);
    if (foundItems.length > 0) {
      const chipRefs = foundItems.map((c, idx) => ({
        refId: originalRefIds[idx] ?? c.refId ?? (idx + 1),
        canvasKey: c.key,
      }));
      void sendText(prompt, { chipRefs });
    } else {
      void sendText(prompt);
    }
  };

  // ====== 两阶段选择：画布点击 → 预选（灰色 chip） → 点击输入框确认（蓝色） ======
  // 逻辑已封装在 TwoPhaseRichComposer 组件中

  /**
   * 画布图片预选（两阶段第一步）
   * 点击画布图片 → 使用统一方法同时更新 selectedKeys 和 pending chips
   */
  const handleCanvasImagePreselect = useCallback((it: CanvasImageItem) => {
    const kind = it.kind ?? 'image';
    if (kind !== 'image' || !it.src) {
      return;
    }

    // 确保有 refId
    ensureRefIdForKey(it.key);
    
    // 使用统一方法同时更新四个球和 chip
    updateSelectionWithChips([it.key], 'replace');
  }, [ensureRefIdForKey, updateSelectionWithChips]);

  // 富文本编辑器发送（入口1）
  // 注意：TwoPhaseRichComposer 的 onSubmit 回调会自动确认 pending chips
  const onSendRich = async () => {
    const composer = richComposerRef.current;
    if (!composer) return;

    // 获取结构化内容（包含 imageRefs）
    // TwoPhaseRichComposer 已在 onSubmit 中自动调用 confirmPending()
    const { text, imageRefs } = composer.getStructuredContent();
    if (!text.trim()) return;

    // 只有 (@size:...) 而没有实际内容时，不应发送
    const clean = String(extractSizeToken(text).cleanText ?? '').trim();
    if (!clean) return;

    composer.clear();
    setInput('');
    composerSizeAutoRef.current = true;
    if (selectedSingleImageForComposer) setComposerSize(autoSizeForSelectedImage ?? '1024x1024');

    // 传递 chipRefs 给统一守门员
    await sendText(text, { chipRefs: imageRefs });
  };

  const onSendQuick = async () => {
    const raw = quickInput.trim();
    if (!raw) return;
    const clean = String(extractSizeToken(raw).cleanText ?? '').trim();
    if (!clean) return;
    setQuickInput('');
    composerSizeAutoRef.current = true;
    if (selectedSingleImageForComposer) setComposerSize(autoSizeForSelectedImage ?? '1024x1024');
    await sendText(raw);
  };

  const onUploadImages = async (files: File[], opts?: { mode?: 'auto' | 'add' }) => {
    const list = (files ?? []).filter((f) => f && f.type && f.type.startsWith('image/'));
    if (list.length === 0) return;

    // 关键：上传/放置必须串行化，否则两次快速上传会并发读文件，导致“空位算法看不到对方”=> 100% 覆盖
    const run = async () => {
    // 选中单张“图片”时：上传单图默认“替换”而非叠加（保留 x/y/w/h）
    const mode = opts?.mode ?? 'auto';
    if (mode === 'auto' && list.length === 1 && selectedKeys.length === 1) {
      const targetKey = selectedKeys[0]!;
      const target = canvas.find((x) => x.key === targetKey);
      if (!target || (target.kind ?? 'image') !== 'image') {
        // 如果当前选中的是“生成器区域”等非图片对象，则走新增逻辑
      } else {
      const file = list[0]!;
      const now = Date.now();
      const dimFile = await readImageSizeFromFile(file);
      const src = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => resolve('');
        reader.readAsDataURL(file);
      });
      if (!src) return;
      const dim = dimFile ?? (await readImageSizeFromSrc(src));
      const nextW = dim?.w ?? target.w ?? 1;
      const nextH = dim?.h ?? target.h ?? 1;

      setCanvas((prev) =>
        prev.map((it) => {
          if (it.key !== targetKey) return it;
          // 替换后如果尺寸变化导致碰撞：用“最近空位”微移，避免遮挡
          const cx = (it.x ?? 0) + (nextW / 2);
          const cy = (it.y ?? 0) + (nextH / 2);
          const others = prev
            .filter((x) => x.key !== targetKey)
            .filter(
              (x) =>
                ((x.kind ?? 'image') === 'generator' ||
                  (x.kind ?? 'image') === 'shape' ||
                  (x.kind ?? 'image') === 'text' ||
                  !!x.src ||
                  x.status === 'running' ||
                  x.status === 'error')
            )
            .map((x) => ({ x: x.x ?? 0, y: x.y ?? 0, w: x.w ?? 1, h: x.h ?? 1 }));
          const hit = others.some((r) => {
            const ax0 = (it.x ?? 0) - 18;
            const ay0 = (it.y ?? 0) - 18;
            const ax1 = (it.x ?? 0) + nextW + 18;
            const ay1 = (it.y ?? 0) + nextH + 18;
            const bx0 = r.x;
            const by0 = r.y;
            const bx1 = r.x + r.w;
            const by1 = r.y + r.h;
            return ax0 < bx1 && ax1 > bx0 && ay0 < by1 && ay1 > by0;
          });
          const pos = hit ? findNearestFreeTopLeft(others, nextW, nextH, { x: cx, y: cy }) : { x: it.x ?? 0, y: it.y ?? 0 };
          focusKeyRef.current = { key: targetKey, cx: pos.x + nextW / 2, cy: pos.y + nextH / 2, w: nextW, h: nextH };
          requestAnimationFrame(() => {
            const f = focusKeyRef.current;
            if (!f || f.key !== targetKey) return;
            // 新图可能很大，移动视角前先适配尺寸
            if (f.w && f.h) {
              animateCameraToFitRect({ x: f.cx - f.w / 2, y: f.cy - f.h / 2, w: f.w, h: f.h });
            } else {
              animateCameraToWorldCenter(f.cx, f.cy);
            }
          });
          return {
            ...it,
            createdAt: now,
            prompt: file.name || it.prompt,
            src,
            status: 'done',
            errorMessage: null,
            assetId: undefined,
            sha256: undefined,
            syncStatus: 'pending',
            syncError: null,
            w: nextW,
            h: nextH,
            naturalW: dim?.w ?? it.naturalW,
            naturalH: dim?.h ?? it.naturalH,
            x: pos.x,
            y: pos.y,
          };
        })
      );
      pushMsg('Assistant', '已替换当前选中图片。');

      // 持久化替换后的图片
      const up = await uploadVisualAgentWorkspaceAsset({ id: workspaceId, data: src, prompt: file.name || 'uploaded' });
      if (up.success) {
        const a = up.data.asset;
        setCanvas((prev) =>
          prev.map((x) =>
            x.key === targetKey
              ? {
                  ...x,
                  assetId: a.id,
                  sha256: a.sha256,
                  src: a.url || x.src,
                  syncStatus: 'synced',
                  syncError: null,
                }
              : x
          )
        );
        showUploadToast(`上传成功：${file.name || '图片'}`);
      } else {
        const msg = up.error?.message || '图片持久化失败';
        setCanvas((prev) =>
          prev.map((x) =>
            x.key === targetKey
              ? {
                  ...x,
                  syncStatus: 'failed',
                  syncError: msg,
                }
              : x
          )
        );
        pushMsg('Assistant', `图片未能持久化到后端资产（刷新可能丢失）：${msg}`);
      }
      return;
      }
    }

    const added: CanvasImageItem[] = [];
    const now = Date.now();

    await Promise.all(
      list.slice(0, 20).map(
        (file, idx) =>
          new Promise<void>((resolve) => {
            const reader = new FileReader();
            const key = `upload_${now}_${idx}`;
            reader.onload = async () => {
              const src = String(reader.result || '');
              if (src) {
                const dim = (await readImageSizeFromFile(file)) ?? (await readImageSizeFromSrc(src));
                added.push({
                  key,
                  createdAt: Date.now(),
                  prompt: file.name || 'uploaded',
                  src,
                  status: 'done',
                  syncStatus: 'pending',
                  syncError: null,
                  w: dim?.w,
                  h: dim?.h,
                  naturalW: dim?.w,
                  naturalH: dim?.h,
                });
              }
              resolve();
            };
            reader.onerror = () => resolve();
            reader.readAsDataURL(file);
          })
      )
    );

    if (added.length === 0) return;
    // 保持顺序：用户选中的文件顺序
    added.sort((a, b) => a.createdAt - b.createdAt);
    {
      const prev = canvasRef.current;
      // “最近路径”算法：从当前视口中心向外找最近空位，避免与现有元素堆叠
      const near = stageCenterWorld();
      const existingRects = prev
        .filter(
          (x) =>
            ((x.kind ?? 'image') === 'generator' ||
              (x.kind ?? 'image') === 'shape' ||
              (x.kind ?? 'image') === 'text' ||
              !!x.src ||
              x.status === 'running' ||
              x.status === 'error')
        )
        .map((x) => ({ x: x.x ?? 0, y: x.y ?? 0, w: x.w ?? 1, h: x.h ?? 1 }));
      const placed: CanvasImageItem[] = [];
      let focus: { key: string; cx: number; cy: number; w?: number; h?: number } | null = null;
      for (const it of added) {
        const w = it.w ?? 1;
        const h = it.h ?? 1;
        const pos = findNearestFreeTopLeft(existingRects, w, h, near);
        const nextIt: CanvasImageItem = { ...it, w, h, x: pos.x, y: pos.y };
        placed.push(nextIt);
        existingRects.push({ x: pos.x, y: pos.y, w, h });
        focus = { key: it.key, cx: pos.x + w / 2, cy: pos.y + h / 2, w, h };
      }
      // 重要：新元素要在最上层 => 放到数组末尾（后渲染覆盖先渲染）
      const merged = [...prev, ...placed].slice(-60);
      if (focus) focusKeyRef.current = focus;
      canvasRef.current = merged;
      setCanvas(merged);
    }
    // 默认选中最新一张（放在最上层的那张）并同步 chip
    // 注意：setCanvas 是异步的，所以我们直接从 added 数组获取图片信息
    const lastAdded = added[added.length - 1]!;
    const lastAddedKey = lastAdded.key;
    // 为新图片分配 refId（这会更新 canvas，但我们直接使用返回值）
    const maxExisting = canvasRef.current.reduce((acc, x) => (typeof x.refId === 'number' && x.refId > acc ? x.refId : acc), 0);
    const newRefId = Math.max(nextRefId, maxExisting + 1);
    setNextRefId(newRefId + 1);
    // 更新 canvas 中的 refId（使用 canvasRef 避免闭包问题）
    setCanvas((prev) => prev.map((x) => (x.key === lastAddedKey ? { ...x, refId: newRefId } : x)));
    // 同步选中和 chip
    setSelectedKeys([lastAddedKey]);
    richComposerRef.current?.clearPending();
    if ((lastAdded.kind ?? 'image') === 'image' && lastAdded.src) {
      richComposerRef.current?.insertImageChip(
        { key: lastAddedKey, refId: newRefId, src: lastAdded.src, label: lastAdded.prompt || `img${newRefId}` },
        { preserveFocus: true }
      );
    }
    requestAnimationFrame(() => {
      const f = focusKeyRef.current;
      if (!f) return;
      // 新图可能很大，移动视角前先适配尺寸
      if (f.w && f.h) {
        animateCameraToFitRect({ x: f.cx - f.w / 2, y: f.cy - f.h / 2, w: f.w, h: f.h });
      } else {
        animateCameraToWorldCenter(f.cx, f.cy);
      }
    });
    pushMsg('Assistant', `已把 ${added.length} 张图片加入画板。你可以选中其中一张作为首帧，或用 @imgN 引用多张图。`);

    // 持久化：上传到后端并替换为自托管 URL（避免 dataURL 过大、也方便跨设备恢复）
    void (async () => {
      let okCount = 0;
      let failedCount = 0;
      for (const it of added) {
        if (!it.src || !it.src.startsWith('data:')) continue;
        const up = await uploadVisualAgentWorkspaceAsset({ id: workspaceId, data: it.src, prompt: it.prompt });
        if (!up.success) {
          failedCount += 1;
          const msg = up.error?.message || '图片持久化失败';
          setCanvas((prev) =>
            prev.map((x) =>
              x.key === it.key
                ? {
                    ...x,
                    syncStatus: 'failed',
                    syncError: msg,
                  }
                : x
            )
          );
          continue;
        }
        okCount += 1;
        const a = up.data.asset;
        setCanvas((prev) =>
          prev.map((x) =>
            x.key === it.key
              ? {
                  ...x,
                  assetId: a.id,
                  sha256: a.sha256,
                  src: a.url || x.src,
                  syncStatus: 'synced',
                  syncError: null,
                }
              : x
          )
        );
      }
      if (okCount > 0) {
        showUploadToast(`上传成功：${okCount} 张`);
      }
      if (failedCount > 0) {
        pushMsg('Assistant', `有 ${failedCount} 张图片未能持久化到后端资产（刷新可能丢失）。请检查网络/权限/后端存储配置后重试上传。`);
      }
    })();
    };

    canvasOpLockRef.current = canvasOpLockRef.current.then(run, run);
    await canvasOpLockRef.current;
  };

  const stageHoverRef = useRef(false);
  const onUploadImagesRef = useRef(onUploadImages);
  useEffect(() => {
    onUploadImagesRef.current = onUploadImages;
  });

  // 画板支持 Ctrl/Cmd+V 粘贴图片（作为“新增一项”，不走替换逻辑）
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const cd = e.clipboardData;
      if (!cd) return;

      // 正在编辑输入框时，不劫持粘贴（允许用户在文本框内粘贴文本/图片）
      const ae = document.activeElement as HTMLElement | null;
      const tag = (ae?.tagName ?? '').toLowerCase();
      const isEditable =
        tag === 'textarea' ||
        tag === 'input' ||
        Boolean(ae?.isContentEditable) ||
        Boolean(ae?.getAttribute?.('contenteditable'));
      if (isEditable) return;

      // 只有“在画板上操作”时才接管粘贴：画板 hover 或画板获得焦点
      const stageEl = stageRef.current;
      const isInStage =
        (stageEl && ae && stageEl.contains(ae)) ||
        stageHoverRef.current;
      if (!isInStage) return;

      const items = Array.from(cd.items ?? []);
      const clipboardFiles = items
        .filter((it) => it.kind === 'file' && (it.type || '').startsWith('image/'))
        .map((it) => it.getAsFile())
        .filter((x): x is File => Boolean(x));
      if (clipboardFiles.length === 0) return;

      e.preventDefault();

      const now = Date.now();
      const files = clipboardFiles.map((f, idx) => {
        const type = (f.type || 'image/png').toLowerCase();
        const ext = type.includes('png') ? 'png' : type.includes('jpeg') || type.includes('jpg') ? 'jpg' : type.includes('webp') ? 'webp' : 'png';
        const name = (f.name && f.name.trim()) ? f.name : `clipboard_${now}_${idx}.${ext}`;
        return new File([f], name, { type });
      });

      void onUploadImagesRef.current(files, { mode: 'add' });
    };

    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  const templates = [
    { id: 'wine', title: 'Wine List', desc: '生成一张高级红酒海报（克制、留白、金色点缀）' },
    { id: 'coffee', title: 'Coffee Shop Branding', desc: '为咖啡店生成品牌视觉方向与主视觉' },
    { id: 'story', title: 'Story Board', desc: '生成短片分镜首帧图（情绪与镜头）' },
  ] as const;

  /** 适配指定内容到视口（Figma 风格）*/
  const fitItemsToViewport = useCallback(
    (items: CanvasImageItem[]) => {
      if (items.length === 0) {
        // 回到原点附近
        setViewport(DEFAULT_ZOOM, { x: Math.round(stageSize.w / 2), y: Math.round(stageSize.h / 2) }, { syncUi: true });
        return;
      }
      const minX = Math.min(...items.map((it) => it.x ?? 0));
      const minY = Math.min(...items.map((it) => it.y ?? 0));
      const maxX = Math.max(...items.map((it) => (it.x ?? 0) + (it.w ?? 320)));
      const maxY = Math.max(...items.map((it) => (it.y ?? 0) + (it.h ?? 220)));
      const bboxW = Math.max(1, maxX - minX);
      const bboxH = Math.max(1, maxY - minY);
      const pad = 80;
      const viewW = Math.max(1, stageSize.w - pad * 2);
      const viewH = Math.max(1, stageSize.h - pad * 2);
      const nextZoom = clampZoom(Math.min(viewW / bboxW, viewH / bboxH));
      const cx = minX + bboxW / 2;
      const cy = minY + bboxH / 2;
      const camX = stageSize.w / 2 - cx * nextZoom;
      const camY = stageSize.h / 2 - cy * nextZoom;
      setViewport(nextZoom, { x: camX, y: camY }, { syncUi: true });
    },
    [setViewport, stageSize.h, stageSize.w]
  );

  /** 获取所有可见画布元素 */
  const getVisibleCanvasItems = useCallback(() => {
    return canvas.filter(
      (x) =>
        ((x.kind ?? 'image') === 'generator' ||
          (x.kind ?? 'image') === 'shape' ||
          (x.kind ?? 'image') === 'text' ||
          !!x.src ||
          x.status === 'running' ||
          x.status === 'error')
    );
  }, [canvas]);

  /** Shift+1: 适配选中内容（无选中时适配全部） */
  const fitToSelection = useCallback(() => {
    const itemsAll = getVisibleCanvasItems();
    const items = selectedKeys.length > 0 ? itemsAll.filter((x) => selectedKeys.includes(x.key)) : itemsAll;
    fitItemsToViewport(items);
  }, [fitItemsToViewport, getVisibleCanvasItems, selectedKeys]);

  /** Cmd/Ctrl+0: 适配全部内容 */
  const fitToAll = useCallback(() => {
    const items = getVisibleCanvasItems();
    fitItemsToViewport(items);
  }, [fitItemsToViewport, getVisibleCanvasItems]);

  /** Cmd/Ctrl+1: 缩放到 100%（保持当前视口中心不变） */
  const zoomTo100 = useCallback(() => {
    // 计算当前视口中心对应的世界坐标
    const currentZoom = zoomRef.current;
    const currentCam = cameraRef.current;
    const viewCenterX = stageSize.w / 2;
    const viewCenterY = stageSize.h / 2;
    // 视口中心对应的世界坐标
    const worldCx = (viewCenterX - currentCam.x) / currentZoom;
    const worldCy = (viewCenterY - currentCam.y) / currentZoom;
    // 设置新的 camera 使得相同的世界坐标仍然在视口中心（但 zoom = 1）
    const newCamX = viewCenterX - worldCx * 1;
    const newCamY = viewCenterY - worldCy * 1;
    setViewport(1, { x: newCamX, y: newCamY }, { syncUi: true });
  }, [setViewport, stageSize.h, stageSize.w]);

  /** 自动排列：紧凑网格布局（最大化利用空间） */
  const arrangeGrid = useCallback(() => {
    const items = canvasRef.current.filter(
      (it) =>
        (it.kind ?? 'image') === 'image' ||
        (it.kind ?? 'image') === 'generator' ||
        (it.kind ?? 'image') === 'shape' ||
        (it.kind ?? 'image') === 'text'
    );
    if (items.length === 0) return;

    // 按创建时间排序（旧→新，左上→右下）
    const sorted = [...items].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

    const gap = 20; // 间距

    // 使用接近正方形的网格：列数 = ceil(sqrt(n))
    // 例如：4张→2列, 6张→3列, 9张→3列, 12张→4列
    const n = sorted.length;
    const cols = Math.max(1, Math.ceil(Math.sqrt(n)));

    // 计算图片的最大宽度
    const maxW = Math.max(...sorted.map((it) => it.w ?? 320));

    // 可用宽度 = 列数 × (最大宽度 + 间距)，确保每行能放下指定列数的图片
    const availableW = cols * (maxW + gap);

    // 桌面图标式紧凑布局算法：
    // 1. 按行堆叠，每行高度取该行最高元素
    // 2. 从左到右放置，超出宽度则换行
    // 3. 一次性计算所有位置
    type RowItem = { item: typeof sorted[0]; x: number };
    const rows: { items: RowItem[]; maxH: number }[] = [];
    let currentRow: RowItem[] = [];
    let currentRowX = 0;
    let currentRowMaxH = 0;

    for (const it of sorted) {
      const w = it.w ?? 320;
      const h = it.h ?? 220;

      // 检查是否需要换行
      if (currentRow.length > 0 && currentRowX + w > availableW) {
        // 保存当前行
        rows.push({ items: [...currentRow], maxH: currentRowMaxH });
        currentRow = [];
        currentRowX = 0;
        currentRowMaxH = 0;
      }

      // 添加到当前行
      currentRow.push({ item: it, x: currentRowX });
      currentRowX += w + gap;
      currentRowMaxH = Math.max(currentRowMaxH, h);
    }

    // 保存最后一行
    if (currentRow.length > 0) {
      rows.push({ items: currentRow, maxH: currentRowMaxH });
    }

    // 计算总高度和总宽度
    let totalH = 0;
    let maxRowW = 0;
    for (const row of rows) {
      totalH += row.maxH + gap;
      const rowW = row.items.length > 0
        ? row.items[row.items.length - 1].x + (row.items[row.items.length - 1].item.w ?? 320)
        : 0;
      maxRowW = Math.max(maxRowW, rowW);
    }
    totalH -= gap; // 去掉最后一个gap

    // 固定起点：以世界坐标原点为中心，确保每次布局结果一致
    const startX = -maxRowW / 2;
    const startY = -totalH / 2;

    // 分配所有位置（一次性计算）
    const updates: Record<string, { x: number; y: number }> = {};
    let currentY = startY;

    for (const row of rows) {
      for (const { item, x } of row.items) {
        updates[item.key] = { x: startX + x, y: currentY };
      }
      currentY += row.maxH + gap;
    }

    // 更新画布
    setCanvas((prev) => {
      const next = prev.map((it) =>
        updates[it.key] ? { ...it, x: updates[it.key].x, y: updates[it.key].y } : it
      );
      canvasRef.current = next;
      return next;
    });

    // 适配视口 - 直接使用计算好的新位置，避免异步状态问题
    const updatedItems = sorted.map((it) => ({
      ...it,
      x: updates[it.key]?.x ?? it.x,
      y: updates[it.key]?.y ?? it.y,
    }));
    requestAnimationFrame(() => {
      fitItemsToViewport(updatedItems);
    });
  }, [fitItemsToViewport, stageSize.w, stageSize.h]);

  // 图层操作回调
  const layerMoveUp = useCallback(() => {
    if (selectedKeys.length === 0) return;
    setCanvas((prev) => {
      const next = moveUp(prev, selectedKeys);
      canvasRef.current = next;
      return next;
    });
  }, [selectedKeys]);

  const layerMoveDown = useCallback(() => {
    if (selectedKeys.length === 0) return;
    setCanvas((prev) => {
      const next = moveDown(prev, selectedKeys);
      canvasRef.current = next;
      return next;
    });
  }, [selectedKeys]);

  const layerBringToFront = useCallback(() => {
    if (selectedKeys.length === 0) return;
    setCanvas((prev) => {
      const next = bringToFront(prev, selectedKeys);
      canvasRef.current = next;
      return next;
    });
  }, [selectedKeys]);

  const layerSendToBack = useCallback(() => {
    if (selectedKeys.length === 0) return;
    setCanvas((prev) => {
      const next = sendToBack(prev, selectedKeys);
      canvasRef.current = next;
      return next;
    });
  }, [selectedKeys]);

  // Figma 风格快捷键（仅在画布区域操作时生效）
  // - Shift+1: 适配全部内容 (Zoom to Fit)
  // - Shift+2: 适配选中内容 (Zoom to Selection)，无选中时等同于 Shift+1
  // - Shift+0: 缩放到 100% (Zoom to 100%)
  // - Cmd/Ctrl+]: 上移一层
  // - Cmd/Ctrl+[: 下移一层
  // - Cmd/Ctrl+Shift+]: 置于顶层
  // - Cmd/Ctrl+Shift+[: 置于底层
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      // 输入控件内不处理，避免抢占用户输入
      const ae = document.activeElement as HTMLElement | null;
      const tag = (ae?.tagName ?? '').toLowerCase();
      const isEditable =
        tag === 'textarea' ||
        tag === 'input' ||
        Boolean(ae?.isContentEditable) ||
        Boolean(ae?.getAttribute?.('contenteditable'));
      if (isEditable) return;

      // 仅当"在画板上操作"时才响应：画板 hover 或画板获得焦点
      const stageEl = stageRef.current;
      const isInStage = (stageEl && ae && stageEl.contains(ae)) || stageHoverRef.current;
      if (!isInStage) return;

      const isMod = e.metaKey || e.ctrlKey;
      const is0 = e.key === '0' || e.code === 'Digit0';
      const is1 = e.key === '1' || e.code === 'Digit1';
      const is2 = e.key === '2' || e.code === 'Digit2';
      const isBracketRight = e.key === ']' || e.code === 'BracketRight';
      const isBracketLeft = e.key === '[' || e.code === 'BracketLeft';

      // Cmd/Ctrl+Shift+]: 置于顶层
      if (isMod && e.shiftKey && !e.altKey && isBracketRight) {
        e.preventDefault();
        layerBringToFront();
        return;
      }

      // Cmd/Ctrl+Shift+[: 置于底层
      if (isMod && e.shiftKey && !e.altKey && isBracketLeft) {
        e.preventDefault();
        layerSendToBack();
        return;
      }

      // Cmd/Ctrl+]: 上移一层
      if (isMod && !e.shiftKey && !e.altKey && isBracketRight) {
        e.preventDefault();
        layerMoveUp();
        return;
      }

      // Cmd/Ctrl+[: 下移一层
      if (isMod && !e.shiftKey && !e.altKey && isBracketLeft) {
        e.preventDefault();
        layerMoveDown();
        return;
      }

      // Shift+0: 缩放到 100%
      if (e.shiftKey && !isMod && !e.altKey && is0) {
        e.preventDefault();
        zoomTo100();
        return;
      }

      // Shift+1: 适配全部内容
      if (e.shiftKey && !isMod && !e.altKey && is1) {
        e.preventDefault();
        fitToAll();
        return;
      }

      // Shift+2: 适配选中内容（无选中时适配全部）
      if (e.shiftKey && !isMod && !e.altKey && is2) {
        e.preventDefault();
        fitToSelection();
        return;
      }
    };
    const opts = { capture: true } as const;
    window.addEventListener('keydown', onDown, opts);
    return () => window.removeEventListener('keydown', onDown, opts);
  }, [fitToAll, fitToSelection, zoomTo100, layerMoveUp, layerMoveDown, layerBringToFront, layerSendToBack]);

  const focusKeyRef = useRef<{
    key: string;
    cx: number;
    cy: number;
    w?: number;
    h?: number;
    /** 参考图/选中图的位置，用于联合适配 */
    refRect?: { x: number; y: number; w: number; h: number };
  } | null>(null);

  const selectedGenerator = useMemo(() => {
    const k = selectedKeys[0];
    if (!k) return null;
    const it = canvas.find((x) => x.key === k) ?? null;
    if (!it) return null;
    if ((it.kind ?? 'image') !== 'generator') return null;
    return it;
  }, [canvas, selectedKeys]);

  // 同步 selectedGenerator 到 ref，供 applyWorldTransform 使用（避免 React 状态延迟）
  const selectedGeneratorRef = useRef<typeof selectedGenerator>(null);
  useEffect(() => {
    selectedGeneratorRef.current = selectedGenerator;
  }, [selectedGenerator]);

  return (
    <div ref={containerRef} className="h-full min-h-0">
      {uploadToast ? (
        <div
          className="fixed left-1/2 z-9999"
          style={{
            top: 18,
            transform: 'translateX(-50%)',
            pointerEvents: 'none',
          }}
          aria-live="polite"
          aria-atomic="true"
        >
          <div
            className="inline-flex items-center gap-2 rounded-full px-4 h-10 text-[13px] font-semibold"
            style={{
              ...glassTooltip,
              background: 'rgba(0,0,0,0.50)',
              border: '1px solid rgba(255,255,255,0.18)',
              color: 'rgba(255,255,255,0.92)',
              boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
            }}
          >
            <Check size={16} />
            <span className="truncate max-w-[520px]">{uploadToast.text}</span>
          </div>
        </div>
      ) : null}
      {/* 单一框架：左右无缝拼接 */}
      <GlassCard glow className="h-full min-h-0 overflow-hidden p-0!">
        <div className="h-full min-h-0 flex">
          {/* 左侧：画板 */}
          <div className="flex-1 min-w-0 min-h-0">
        <div className="h-full min-h-0 relative">
          {/* 主画布（无限视口） */}
          <div
            ref={stageRef}
            className="absolute inset-0 overflow-hidden outline-none focus:outline-none focus-visible:outline-none! focus-visible:shadow-none!"
            style={{
              background: 'rgba(0,0,0,0.10)',
              cursor: panning ? 'grabbing' : effectiveTool === 'hand' ? 'grab' : 'default',
              userSelect: 'none',
              WebkitUserSelect: 'none',
            }}
            onContextMenu={(e) => e.preventDefault()}
            tabIndex={0}
            onPointerEnter={() => {
              stageHoverRef.current = true;
            }}
            onPointerDownCapture={(e) => {
              // placing 优先
              if (placing) {
                const placed = placeAtPointer(e);
                if (!placed) return;
                e.preventDefault();
                e.stopPropagation();
                return;
              }

              // Space/Hand：在捕获阶段接管拖拽，避免子元素（图片）stopPropagation 导致无法平移
              if (effectiveTool === 'hand') {
                stageRef.current?.focus();
                panRef.current = {
                  active: true,
                  pointerId: e.pointerId,
                  startX: e.clientX,
                  startY: e.clientY,
                  baseCamX: cameraRef.current.x,
                  baseCamY: cameraRef.current.y,
                };
                setPanning(true);
                (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
                e.preventDefault();
                e.stopPropagation();
              }
            }}
            onMouseDown={() => stageRef.current?.focus()}
            onBlur={() => {
              // 失焦时清掉框选残留
              setMarquee((prev) => (prev.active ? { ...prev, active: false, w: 0, h: 0 } : prev));
              panRef.current.active = false;
              setPanning(false);
              dragItemsRef.current.active = false;
            }}
            onPointerDown={(e) => {
              stageRef.current?.focus();

              // Hand tool / Space + 拖拽：平移（Hand 模式允许在任意元素上拖动）
              if (effectiveTool === 'hand') {
                panRef.current = {
                  active: true,
                  pointerId: e.pointerId,
                  startX: e.clientX,
                  startY: e.clientY,
                  baseCamX: cameraRef.current.x,
                  baseCamY: cameraRef.current.y,
                };
                setPanning(true);
                (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
                e.preventDefault();
                return;
              }

              // 只处理“空白区域”的 pointerdown；点击图片会 stopPropagation
              const isBlank = e.target === e.currentTarget || e.target === worldRef.current;
              if (!isBlank) return;

              // 空白拖拽：框选（Marquee）
              const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
              const sx = e.clientX - rect.left;
              const sy = e.clientY - rect.top;
              setMarquee({ active: true, startX: sx, startY: sy, x: sx, y: sy, w: 0, h: 0, shift: e.shiftKey });
              (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
              e.preventDefault();
            }}
            onPointerCancel={(e) => {
              // pointer 被系统取消时（例如手势/滚动打断），清理所有交互态，避免“长方形框选”残留
              dragItemsRef.current.active = false;
              panRef.current.active = false;
              setPanning(false);
              setMarquee((prev) => (prev.active ? { ...prev, active: false, w: 0, h: 0 } : prev));
              try {
                (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
              } catch {
                // ignore
              }
            }}
            onPointerLeave={(e) => {
              stageHoverRef.current = false;
              // 离开画布也清理 marquee（极端情况下 pointerup 没触发）
              if (!marquee.active) return;
              setMarquee((prev) => ({ ...prev, active: false, w: 0, h: 0 }));
              try {
                (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
              } catch {
                // ignore
              }
            }}
            onPointerMove={(e) => {
              // dragging selected items
              const drag = dragItemsRef.current;
              if (drag.active && drag.pointerId === e.pointerId) {
                const dx = (e.clientX - drag.startClientX) / zoomRef.current;
                const dy = (e.clientY - drag.startClientY) / zoomRef.current;
                const set = new Set(drag.keys);
                setCanvas((prev) =>
                  prev.map((it) => {
                    if (!set.has(it.key)) return it;
                    const b = drag.base[it.key] ?? { x: it.x ?? 0, y: it.y ?? 0 };
                    return { ...it, x: b.x + dx, y: b.y + dy };
                  })
                );
                e.preventDefault();
                return;
              }
              // pan
              const pan = panRef.current;
              if (pan.active && pan.pointerId === e.pointerId) {
                const dx = e.clientX - pan.startX;
                const dy = e.clientY - pan.startY;
                setViewport(zoomRef.current, { x: pan.baseCamX + dx, y: pan.baseCamY + dy });
                e.preventDefault();
                return;
              }
              // marquee
              if (marquee.active) {
                const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                const sx = e.clientX - rect.left;
                const sy = e.clientY - rect.top;
                const x = Math.min(marquee.startX, sx);
                const y = Math.min(marquee.startY, sy);
                const w = Math.abs(sx - marquee.startX);
                const h = Math.abs(sy - marquee.startY);
                setMarquee((prev) => ({ ...prev, x, y, w, h }));
                e.preventDefault();
              }
            }}
            onPointerUp={(e) => {
              // end dragging items
              const drag = dragItemsRef.current;
              if (drag.active && drag.pointerId === e.pointerId) {
                dragItemsRef.current.active = false;
                try {
                  (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
                } catch {
                  // ignore
                }
                e.preventDefault();
                return;
              }
              // end pan
              const pan = panRef.current;
              if (pan.active && pan.pointerId === e.pointerId) {
                panRef.current.active = false;
                setPanning(false);
                try {
                  (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
                } catch {
                  // ignore
                }
                e.preventDefault();
                return;
              }
              // end marquee
              if (!marquee.active) return;
              const box = marquee;
              setMarquee((prev) => ({ ...prev, active: false, w: 0, h: 0 }));

              const isClick = box.w < 6 && box.h < 6;
              if (isClick) {
                // 点击空白：取消选中，同时清除 pending chips
                if (!box.shift) {
                  clearSelectionWithChips();
                }
                return;
              }

              // 框选：转世界坐标并命中图片 bbox
              const x0 = (box.x - cameraRef.current.x) / zoomRef.current;
              const y0 = (box.y - cameraRef.current.y) / zoomRef.current;
              const x1 = (box.x + box.w - cameraRef.current.x) / zoomRef.current;
              const y1 = (box.y + box.h - cameraRef.current.y) / zoomRef.current;
              const minX = Math.min(x0, x1);
              const minY = Math.min(y0, y1);
              const maxX = Math.max(x0, x1);
              const maxY = Math.max(y0, y1);
              const hits = canvas
                .filter(
                  (it) =>
                    ((it.kind ?? 'image') === 'generator' ||
                      (it.kind ?? 'image') === 'shape' ||
                      (it.kind ?? 'image') === 'text' ||
                      !!it.src ||
                      it.status === 'running' ||
                      it.status === 'error')
                )
                .filter((it) => {
                  const ix0 = it.x ?? 0;
                  const iy0 = it.y ?? 0;
                  const ix1 = ix0 + (it.w ?? 320);
                  const iy1 = iy0 + (it.h ?? 220);
                  const inter = ix0 <= maxX && ix1 >= minX && iy0 <= maxY && iy1 >= minY;
                  return inter;
                })
                .map((it) => it.key);

              // 确保所有框选的图片都有 refId
              for (const key of hits) {
                ensureRefIdForKey(key);
              }
              
              if (!box.shift) {
                // 非 Shift：使用统一方法替换选中
                updateSelectionWithChips(hits, 'replace');
              } else {
                // Shift：使用统一方法追加选中
                updateSelectionWithChips(hits, 'add');
              }

              try {
                (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
              } catch {
                // ignore
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              const fs = Array.from(e.dataTransfer.files ?? []);
              void onUploadImages(fs);
            }}
            onKeyDown={(e) => {
              // 重要：当焦点在输入控件时，不处理画布快捷键（否则 Backspace/Delete 会误触发删图确认）
              const t = e.target as HTMLElement | null;
              const tag = t?.tagName?.toLowerCase();
              if (tag === 'textarea' || tag === 'input' || (t as HTMLElement | null)?.isContentEditable) return;

              // Delete / Backspace：删除选中
              if ((e.key === 'Delete' || e.key === 'Backspace') && selectedKeys.length > 0) {
                // 避免在输入框中删除字符：这里只在画布获得焦点时触发
                e.preventDefault();
                void confirmAndDeleteSelectedKeys([...selectedKeys]);
                return;
              }

              // 方向键微调（Figma-ish）
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                if (selectedKeys.length === 0) return;
                e.preventDefault();
                const step = e.shiftKey ? 10 : 1;
                const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
                const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
                const set = new Set(selectedKeys);
                setCanvas((prev) =>
                  prev.map((it) => (set.has(it.key) ? { ...it, x: (it.x ?? 0) + dx, y: (it.y ?? 0) + dy } : it))
                );
                return;
              }

              const isMod = e.metaKey || e.ctrlKey;
              if (!isMod) return;

              // Ctrl/Cmd + C：复制选中图片到剪贴板
              if (e.key === 'c' || e.key === 'C') {
                if (selectedKeys.length === 1) {
                  const it = canvas.find((x) => x.key === selectedKeys[0]);
                  if (it && (it.kind ?? 'image') === 'image' && it.src) {
                    e.preventDefault();
                    void copyImageToClipboard(it.src);
                  }
                }
                return;
              }

              if (e.key === '+' || e.key === '=') {
                e.preventDefault();
                const c = stageCenterClient();
                zoomAt(c.x, c.y, clampZoom(zoomRef.current * 1.07));
              } else if (e.key === '-') {
                e.preventDefault();
                const c = stageCenterClient();
                zoomAt(c.x, c.y, clampZoom(zoomRef.current / 1.07));
              } else if (e.key === '0') {
                e.preventDefault();
                const c = stageCenterClient();
                zoomAt(c.x, c.y, 1);
              }
            }}
          >
            <div
              ref={worldRef}
              className="absolute inset-0"
              style={{ transformOrigin: '0 0' }}
            >
              {canvas.map((it) => {
                const kind = it.kind ?? 'image';
                // 错误态：仍需要渲染占位框（否则用户不知道尺寸，也无法直接选中/删除）
                if (kind === 'image' && !it.src && it.status !== 'running' && it.status !== 'error') return null;
                const x = it.x ?? 0;
                const y = it.y ?? 0;
                const w = it.w ?? 320;
                const h = it.h ?? 220;
                const active = isSelectedKey(it.key);
                const isPending = isPendingKey(it.key); // 两阶段选择：pending 状态
                const showSelectOverlay = effectiveTool !== 'hand' && active && (kind === 'image' || kind === 'generator');
                // 单选时显示可交互的四角控制点；多选时也显示但仅作为视觉标识（不可 resize）
                const isSingleSelect = selectedKeys.length === 1;
                const showHandles = showSelectOverlay; // 多选时也显示四角圆点
                const canResize = showSelectOverlay && isSingleSelect; // 仅单选可交互
                const boxW = Math.max(40, Math.round(w));
                const boxH = Math.max(40, Math.round(h));
                const nw = typeof it.naturalW === 'number' ? it.naturalW : 0;
                const nh = typeof it.naturalH === 'number' ? it.naturalH : 0;
                const hasNatural = nw > 0 && nh > 0;
                // 仅在“实际有图且可显示”的情况下，把选中框贴合 object-fit: contain 的图片本体（排除留白区域）
                const fitToImage =
                  (kind === 'image' || kind === 'generator') && it.status === 'done' && Boolean(it.src) && hasNatural;
                const inner = fitToImage ? computeObjectFitContainRect(boxW, boxH, nw, nh) : { x: 0, y: 0, w: boxW, h: boxH };
                const selX = inner.x;
                const selY = inner.y;
                const selW = Math.max(1, inner.w);
                const selH = Math.max(1, inner.h);
                const selRadius = clampRadius(fitToImage ? 14 : 16, selW, selH);
                const handleBase: React.CSSProperties = {
                  width: 12,
                  height: 12,
                  borderRadius: 999,
                  background: 'rgba(255,255,255,0.92)',
                  border: '2px solid rgba(96,165,250,0.95)',
                  boxShadow: '0 10px 22px rgba(0,0,0,0.28)',
                };
                // 动态计算边框宽度：确保屏幕像素永远 >= 2px（参考四角控制点的缩放策略）
                const invZoom = 1 / Math.max(0.0001, zoom);
                // 基准宽度 * invZoom，确保最小 2px 屏幕像素
                const strokeOuter = Math.max(2, 4 * invZoom);
                const strokeInner = Math.max(2, 2.5 * invZoom);
                return (
                  <div
                    key={it.key}
                    className="absolute rounded-[16px] group/citem"
                    style={{
                      left: Math.round(x),
                      top: Math.round(y),
                      width: boxW,
                      height: boxH,
                      // 外层容器仅负责布局/拖拽命中；边框应贴合图片本体，因此容器不画边框
                      border: '1px solid transparent',
                      // 根因：这里的 background/boxShadow 会永远渲染一个"长方形卡片"
                      // 需求：元素本体就是图片本身，不应出现任何额外长方形框 => 直接去掉
                      background: 'transparent',
                      boxShadow: 'none',
                      overflow: 'visible',
                      cursor: panning || effectiveTool === 'hand' ? 'inherit' : 'pointer',
                    }}
                    onContextMenu={(e) => {
                      // 阻止默认右键菜单，避免选中整个页面
                      e.preventDefault();
                      e.stopPropagation();
                      // 显示右键菜单（图层操作对所有类型都可用）
                      setImgContextMenu({
                        open: true,
                        x: e.clientX,
                        y: e.clientY,
                        src: it.src || '',
                        prompt: it.prompt || 'image',
                        key: it.key,
                      });
                      // 如果当前元素未被选中，则单选它（便于后续图层操作）
                      if (!selectedKeys.includes(it.key)) {
                        // 根据类型决定是否同步 chip
                        if (kind === 'image' && it.src) {
                          setSelection([it.key]);
                        } else {
                          setSelectionWithoutChip([it.key]);
                        }
                      }
                    }}
                    onMouseDown={(e) => {
                      if (effectiveTool !== 'hand') e.stopPropagation();
                    }}
                    onPointerDown={(e) => {
                      if (effectiveTool === 'hand') return;
                      // 右键点击不启动拖拽，让 contextmenu 事件正常触发
                      if (e.button === 2) return;
                      focusStage();
                      e.stopPropagation();

                      // Cmd/Ctrl + 点击：直接插入就绪的 @imgN 引用（跳过两阶段，不同步 pending chip）
                      // 2026-01-31: 先暂时这样，以后单击+选中，则是选中画面的元素，而非选中
                      /*
                      if (kind === 'image' && (e.metaKey || e.ctrlKey)) {
                        // 只更新四个球，不影响 pending chip（因为这是直接插入确认的引用）
                        const currentKeys = selectedKeysRef.current;
                        if (!currentKeys.includes(it.key)) {
                          setSelectionWithoutChip([...currentKeys, it.key]);
                        }
                        const id = ensureRefIdForKey(it.key);
                        if (id) insertAtCursor(`@img${id} `);
                        focusComposer();
                        // 不启动拖拽
                        return;
                      }
                      */

                      // 确定本次拖拽涉及的选中集合（按 Figma：未选中则先选中）
                      // 将 Ctrl/Cmd 映射为 Shift 功能（多选）
                      const shift = e.shiftKey || e.metaKey || e.ctrlKey;
                      const wasSelected = selectedKeys.includes(it.key);
                      let nextKeys: string[];
                      
                      if (shift) {
                        // Shift+点击：追加选中（不取消已选中的）
                        nextKeys = wasSelected ? selectedKeys : [...selectedKeys, it.key];
                        if (!wasSelected) {
                          // 确保有 refId
                          ensureRefIdForKey(it.key);
                          // 使用统一方法：追加选中并同步 chip
                          updateSelectionWithChips([it.key], 'add');
                        }
                      } else {
                        // 普通点击：替换选中
                        nextKeys = wasSelected ? selectedKeys : [it.key];
                        if (kind === 'image' && it.src) {
                          // 确保有 refId
                          ensureRefIdForKey(it.key);
                          // 使用统一方法：替换选中并同步 chip
                          updateSelectionWithChips([it.key], 'replace');
                        } else {
                          // 非图片：只更新 selectedKeys，不同步 chip
                          setSelectionWithoutChip([it.key]);
                        }
                      }
                      // 开始拖拽（多选整体移动）
                      const base: Record<string, { x: number; y: number }> = {};
                      for (const k of nextKeys) {
                        const found = canvas.find((x) => x.key === k);
                        base[k] = { x: found?.x ?? 0, y: found?.y ?? 0 };
                      }
                      dragItemsRef.current = {
                        active: true,
                        pointerId: e.pointerId,
                        startClientX: e.clientX,
                        startClientY: e.clientY,
                        keys: nextKeys,
                        base,
                      };
                      (stageRef.current as HTMLDivElement | null)?.setPointerCapture(e.pointerId);
                      e.preventDefault();
                    }}
                    onClick={(e) => {
                      focusStage();
                      e.stopPropagation();
                      if (effectiveTool === 'hand') {
                        return;
                      }
                      // 注意：由于 onPointerDown 中的 e.preventDefault()，onClick 实际上不会触发
                      // 但为了代码一致性，仍保留这些处理

                      // 生成器区域：仅做选中，不做 @img 引用插入
                      if (kind === 'generator') {
                        if (e.shiftKey) {
                          const currentKeys = selectedKeysRef.current;
                          const set = new Set(currentKeys);
                          if (set.has(it.key)) set.delete(it.key);
                          else set.add(it.key);
                          setSelectionWithoutChip(Array.from(set));
                        } else {
                          setSelectionWithoutChip([it.key]);
                        }
                        focusComposer();
                        return;
                      }
                      // Cmd/Ctrl + 点击：直接插入就绪的 @imgN 引用（跳过两阶段）
                      // 2026-01-31: 先暂时这样，以后单击+选中，则是选中画面的元素，而非选中
                      /*
                      if (kind === 'image' && (e.metaKey || e.ctrlKey)) {
                        const currentKeys = selectedKeysRef.current;
                        if (!currentKeys.includes(it.key)) {
                          setSelectionWithoutChip([...currentKeys, it.key]);
                        }
                        const id = ensureRefIdForKey(it.key);
                        if (id) insertAtCursor(`@img${id} `);
                        focusComposer();
                        return;
                      }
                      */
                      // Shift (或 Ctrl/Cmd) 点击：多选
                      if (e.shiftKey || e.metaKey || e.ctrlKey) {
                        const alreadySelected = selectedKeys.includes(it.key);
                        if (alreadySelected) {
                          removeSelection([it.key]);
                        } else {
                          addSelection([it.key]);
                        }
                        return;
                      }
                      // 普通点击图片：两阶段预选
                      if (kind === 'image' && it.src) {
                        handleCanvasImagePreselect(it);
                        return;
                      }
                      // 其他类型（shape/text 等）：仅选中
                      setSelectionWithoutChip([it.key]);
                    }}
                    title={it.prompt}
                  >
                    {/* 多选 checkbox（开放世界也保留） */}
                    {/* 已移除：左上角“+选择引用”按钮（用户反馈不需要） */}

                    {kind === 'generator' ? (
                      <div
                        className="w-full h-full rounded-[16px] relative"
                        style={{
                          background: 'rgba(96,165,250,0.16)',
                          border: '1px solid rgba(96,165,250,0.25)',
                          boxShadow: 'none',
                        }}
                      >
                        {it.status === 'done' && it.sizeAdjusted ? (
                          <div
                            className="absolute left-3 top-3 text-[11px] font-extrabold rounded-full px-2.5 h-6 inline-flex items-center"
                            style={{
                              background: 'rgba(168, 85, 247, 0.16)',
                              border: '1px solid rgba(168, 85, 247, 0.30)',
                              color: 'rgba(255,255,255,0.92)',
                            }}
                            title={
                              it.ratioAdjusted
                                ? `比例已微调：${String(it.requestedSize || '')} → ${String(it.effectiveSize || '')}`
                                : `尺寸已替换：${String(it.requestedSize || '')} → ${String(it.effectiveSize || '')}`
                            }
                          >
                            {it.ratioAdjusted ? '比例已微调' : '尺寸已替换'}
                          </div>
                        ) : null}
                        {it.status === 'running' ? (
                          <div className="absolute inset-0">
                            <PrdPetalBreathingLoader fill className="absolute inset-0" />
                          </div>
                        ) : it.status === 'error' ? (
                          <div className="absolute inset-0">
                            {/* 灰色静止花瓣背景 */}
                            <PrdPetalBreathingLoader fill paused grayscale className="absolute inset-0" />
                            {/* 错误提示 */}
                            <div
                              className="absolute inset-0 flex items-end justify-center pb-[8%]"
                              style={{ zIndex: 200 }}
                            >
                              <div className="max-w-[90%] text-center truncate" style={{ color: 'rgba(255,255,255,0.5)', fontSize: '3.5cqw' }} title={it.errorMessage || '生成失败'}>
                                {it.errorMessage || '生成失败'}
                              </div>
                            </div>
                          </div>
                        ) : it.src ? (
                          <div className="absolute inset-0 flex items-center justify-center">
                            <img
                              src={it.src}
                              alt={it.prompt}
                              className="w-full h-full block"
                              style={{ objectFit: 'contain', borderRadius: 14 }}
                              onLoad={(e) => {
                                const img = e.currentTarget;
                                const nw = img.naturalWidth || 0;
                                const nh = img.naturalHeight || 0;
                                if (!nw || !nh) return;
                                setCanvas((prev) =>
                                  prev.map((x) => (x.key === it.key ? { ...x, naturalW: nw, naturalH: nh } : x))
                                );
                              }}
                            />
                          </div>
                        ) : (
                          <div className="absolute inset-0 flex items-center justify-center" style={{ color: 'rgba(96,165,250,0.35)' }}>
                            <ImagePlus size={54} />
                          </div>
                        )}
                      </div>
                    ) : it.status === 'running' ? (
                      <div
                        className="w-full h-full rounded-[16px] relative"
                        // 需求：加载中要有“占位框”，告诉用户会在这里生成一张这么大的图
                        // - 非选中：也要有细边框（避免 loader 像“漂浮出来的”）
                        // - 选中：强化描边/光晕（不改变尺寸/比例）
                        style={{
                          background: 'rgba(255,255,255,0.01)',
                          border: '1px solid rgba(255,255,255,0.12)',
                          boxShadow: 'none',
                        }}
                      >
                        <div
                          className="absolute right-3 top-3 text-[12px] font-extrabold rounded-full px-2.5 h-6 inline-flex items-center pointer-events-none"
                          style={{
                            background: 'rgba(0,0,0,0.28)',
                            border: '1px solid rgba(255,255,255,0.10)',
                            color: 'rgba(255,255,255,0.78)',
                            // 关键：文字大小不随画布 zoom 缩放（保持清晰可读）
                            transform: 'scale(var(--invZoom))',
                            transformOrigin: 'right top',
                          }}
                          title="预计生成尺寸（画布占位）"
                        >
                          预计 {Math.round(w)} × {Math.round(h)}
                        </div>
                        <div className="absolute inset-0">
                          <PrdPetalBreathingLoader fill className="absolute inset-0" />
                        </div>
                      </div>
                    ) : kind === 'shape' ? (
                      <div className="w-full h-full flex items-center justify-center">
                        <div
                          className="w-full h-full"
                          style={{
                            background: it.fill ?? 'rgba(255,255,255,0.86)',
                            border:
                              active
                                ? '2px solid rgba(96,165,250,0.85)'
                                : `1px solid ${it.stroke ?? 'rgba(0,0,0,0.14)'}`,
                            borderRadius: it.shapeType === 'circle' ? 999 : 14,
                            clipPath:
                              it.shapeType === 'triangle'
                                ? 'polygon(50% 12%, 8% 88%, 92% 88%)'
                                : it.shapeType === 'star'
                                  ? 'polygon(50% 8%, 61% 36%, 92% 36%, 67% 55%, 78% 90%, 50% 70%, 22% 90%, 33% 55%, 8% 36%, 39% 36%)'
                                  : undefined,
                            filter: active
                              ? 'drop-shadow(0 0 2px rgba(96,165,250,0.95)) drop-shadow(0 0 14px rgba(96,165,250,0.35))'
                              : 'none',
                          }}
                        />
                      </div>
                    ) : kind === 'text' ? (
                      <div className="w-full h-full flex items-center justify-center">
                        <div
                          className="w-full h-full rounded-[14px] px-3 inline-flex items-center justify-center text-center"
                          style={{
                            background: it.fill ?? 'rgba(255,255,255,0.90)',
                            border:
                              active
                                ? '2px solid rgba(96,165,250,0.85)'
                                : `1px solid ${it.stroke ?? 'rgba(0,0,0,0.10)'}`,
                            color: it.textColor ?? 'rgba(11,11,15,0.92)',
                            fontSize: it.fontSize ?? 26,
                            fontWeight: 800,
                            lineHeight: 1.1,
                            filter: active
                              ? 'drop-shadow(0 0 2px rgba(96,165,250,0.95)) drop-shadow(0 0 14px rgba(96,165,250,0.35))'
                              : 'none',
                          }}
                        >
                          {String(it.text ?? 'Text')}
                        </div>
                      </div>
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        {it.status === 'error' ? (
                          <div
                            className="w-full h-full rounded-[16px] relative"
                            style={{
                              background: 'rgba(0,0,0,0.18)',
                              border: active ? '2px solid rgba(250,204,21,0.75)' : '1px solid rgba(255,255,255,0.12)',
                              boxShadow: active ? '0 0 0 1px rgba(0,0,0,0.22) inset, 0 0 18px rgba(250,204,21,0.30)' : 'none',
                              overflow: 'hidden',
                            }}
                          >
                            {/* 灰色静止花瓣背景 */}
                            <PrdPetalBreathingLoader fill paused grayscale className="absolute inset-0" />
                            {/* 错误提示 */}
                            <div
                              className="absolute inset-0 flex items-end justify-center pb-[8%]"
                              style={{ zIndex: 200 }}
                            >
                              <div className="max-w-[90%] text-center truncate" style={{ color: 'rgba(255,255,255,0.5)', fontSize: '3.5cqw' }} title={it.errorMessage || '图片加载失败'}>
                                {it.errorMessage || '图片加载失败'}
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className={`w-full h-full relative ${it.syncStatus === 'pending' ? 'prd-upload-wave' : ''}`}>
                            {it.syncStatus && it.syncStatus !== 'synced' ? (
                              <div
                                className="absolute right-3 top-3 text-[12px] font-extrabold rounded-full px-2.5 h-6 inline-flex items-center pointer-events-none"
                                style={{
                                  background: it.syncStatus === 'failed' ? 'rgba(239,68,68,0.22)' : 'rgba(0,0,0,0.28)',
                                  border: it.syncStatus === 'failed' ? '1px solid rgba(239,68,68,0.35)' : '1px solid rgba(255,255,255,0.10)',
                                  color: it.syncStatus === 'failed' ? 'rgba(255,255,255,0.90)' : 'rgba(255,255,255,0.78)',
                                  transform: 'scale(var(--invZoom))',
                                  transformOrigin: 'right top',
                                }}
                                title={
                                  it.syncStatus === 'failed'
                                    ? `图片未能持久化到后端资产，刷新可能丢失：${String(it.syncError || '未知原因')}`
                                    : '图片正在持久化到后端资产（完成后可跨刷新/跨设备稳定访问）'
                                }
                              >
                                {it.syncStatus === 'failed' ? '未持久化' : '同步中'}
                              </div>
                            ) : null}
                            <img
                              src={it.src}
                              alt={it.prompt}
                              className="w-full h-full block"
                              style={{
                                objectFit: 'contain',
                                borderRadius: 14,
                                // 选中态由“蓝色描边+角点”统一表达（避免光晕不明显）
                                filter: 'none',
                              }}
                              onLoad={(e) => {
                                const img = e.currentTarget;
                                const nw = img.naturalWidth || 0;
                                const nh = img.naturalHeight || 0;
                                if (!nw || !nh) return;
                                setCanvas((prev) =>
                                  prev.map((x) => {
                                    if (x.key !== it.key) return x;
                                    // 规则：图片的显示尺寸 = natural 像素尺寸（比例关系只由画布 zoom 改变）
                                    if (x.userResized) return { ...x, naturalW: nw, naturalH: nh, status: x.status === 'error' ? 'done' : x.status };
                                    return { ...x, naturalW: nw, naturalH: nh, w: nw, h: nh, status: x.status === 'error' ? 'done' : x.status };
                                  })
                                );
                              }}
                              onError={() => {
                                setCanvas((prev) =>
                                  prev.map((x) =>
                                    x.key === it.key
                                      ? { ...x, status: 'error', errorMessage: x.errorMessage || '图片不可用（可能已删除或地址失效）' }
                                      : x
                                  )
                                );
                              }}
                            />
                          </div>
                        )}
                      </div>
                    )}

                    {/* 鼠标悬停边框效果（仅未选中 + 非 pending 时显示） */}
                    {!active && !isPending && (kind === 'image' || kind === 'generator') && it.src ? (
                      <div
                        className="absolute rounded-[14px] opacity-0 group-hover/citem:opacity-100 transition-all duration-200 pointer-events-none"
                        style={{
                          left: selX,
                          top: selY,
                          width: selW,
                          height: selH,
                          border: '2px solid rgba(147,197,253,0.55)',
                          boxShadow: '0 0 16px rgba(96,165,250,0.18), inset 0 0 8px rgba(96,165,250,0.06)',
                          zIndex: 30,
                        }}
                      />
                    ) : null}

                    {/* 两阶段选择：pending 状态遮罩（灰色边框 + 对勾标记） */}
                    {isPending && kind === 'image' ? (
                      <div
                        className="absolute rounded-[14px]"
                        style={{
                          left: selX,
                          top: selY,
                          width: selW,
                          height: selH,
                          background: 'rgba(156, 163, 175, 0.25)',
                          border: '2px solid rgba(156, 163, 175, 0.6)',
                          pointerEvents: 'none',
                          zIndex: 35,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <span
                          style={{
                            color: 'white',
                            fontSize: Math.max(20, Math.min(selW, selH) * 0.15),
                            fontWeight: 700,
                            textShadow: '0 2px 8px rgba(0,0,0,0.5)',
                          }}
                        >
                          ✓
                        </span>
                      </div>
                    ) : null}

                    {/* 选中覆盖层：蓝色描边 + 四角圆点（单选可 resize） */}
                    {showSelectOverlay ? (
                      <div
                        className="absolute"
                        style={{ left: selX, top: selY, width: selW, height: selH, pointerEvents: 'none', zIndex: 40 }}
                      >
                        <svg
                          width="100%"
                          height="100%"
                          viewBox={`0 0 ${selW} ${selH}`}
                          preserveAspectRatio="none"
                          overflow="visible"
                          style={{ position: 'absolute', inset: 0 }}
                        >
                          {/* 外描边：深色更粗，提升在大图/复杂背景下的可见性（动态宽度确保 >= 2px 屏幕像素） */}
                          <rect
                            x="0"
                            y="0"
                            width={selW}
                            height={selH}
                            rx={selRadius}
                            ry={selRadius}
                            fill="none"
                            stroke="rgba(0,0,0,0.45)"
                            strokeWidth={strokeOuter}
                          />
                          <rect
                            x="0"
                            y="0"
                            width={selW}
                            height={selH}
                            rx={selRadius}
                            ry={selRadius}
                            fill="none"
                            stroke="rgba(96,165,250,0.95)"
                            strokeWidth={strokeInner}
                          />
                        </svg>

                        {showHandles ? (
                          <>
                            {/* 四角控制点：单选时可交互 resize，多选时仅作为视觉标识 */}
                            <div
                              role={canResize ? 'button' : undefined}
                              aria-label={canResize ? 'resize-nw' : undefined}
                              style={{
                                position: 'absolute',
                                left: 0,
                                top: 0,
                                pointerEvents: canResize ? 'auto' : 'none',
                                cursor: canResize ? 'nwse-resize' : 'default',
                                transform: 'translate(-50%, -50%) scale(var(--invZoom))',
                                transformOrigin: 'center',
                                ...handleBase,
                                // 多选时半透明以区分不可交互
                                opacity: canResize ? 1 : 0.7,
                              }}
                              onPointerDown={canResize ? (e) => startResize(e, it, 'nw') : undefined}
                            />
                            <div
                              role={canResize ? 'button' : undefined}
                              aria-label={canResize ? 'resize-ne' : undefined}
                              style={{
                                position: 'absolute',
                                left: '100%',
                                top: 0,
                                pointerEvents: canResize ? 'auto' : 'none',
                                cursor: canResize ? 'nesw-resize' : 'default',
                                transform: 'translate(-50%, -50%) scale(var(--invZoom))',
                                transformOrigin: 'center',
                                ...handleBase,
                                opacity: canResize ? 1 : 0.7,
                              }}
                              onPointerDown={canResize ? (e) => startResize(e, it, 'ne') : undefined}
                            />
                            <div
                              role={canResize ? 'button' : undefined}
                              aria-label={canResize ? 'resize-sw' : undefined}
                              style={{
                                position: 'absolute',
                                left: 0,
                                top: '100%',
                                pointerEvents: canResize ? 'auto' : 'none',
                                cursor: canResize ? 'nesw-resize' : 'default',
                                transform: 'translate(-50%, -50%) scale(var(--invZoom))',
                                transformOrigin: 'center',
                                ...handleBase,
                                opacity: canResize ? 1 : 0.7,
                              }}
                              onPointerDown={canResize ? (e) => startResize(e, it, 'sw') : undefined}
                            />
                            <div
                              role={canResize ? 'button' : undefined}
                              aria-label={canResize ? 'resize-se' : undefined}
                              style={{
                                position: 'absolute',
                                left: '100%',
                                top: '100%',
                                pointerEvents: canResize ? 'auto' : 'none',
                                cursor: canResize ? 'nwse-resize' : 'default',
                                transform: 'translate(-50%, -50%) scale(var(--invZoom))',
                                transformOrigin: 'center',
                                ...handleBase,
                                opacity: canResize ? 1 : 0.7,
                              }}
                              onPointerDown={canResize ? (e) => startResize(e, it, 'se') : undefined}
                            />

                            {/* 多选时显示选中顺序角标 */}
                            {selectedKeys.length > 1 && (() => {
                              const selectionOrder = selectedKeys.indexOf(it.key) + 1;
                              if (selectionOrder <= 0) return null;
                              return (
                                <div
                                  style={{
                                    position: 'absolute',
                                    right: 0,
                                    top: 0,
                                    transform: 'translate(50%, -50%) scale(var(--invZoom))',
                                    transformOrigin: 'center',
                                    minWidth: 20,
                                    height: 20,
                                    padding: '0 6px',
                                    borderRadius: 999,
                                    background: 'rgba(96, 165, 250, 0.95)',
                                    color: '#fff',
                                    fontSize: 11,
                                    fontWeight: 600,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
                                    pointerEvents: 'none',
                                    userSelect: 'none',
                                  }}
                                  title={`选中顺序: ${selectionOrder}`}
                                >
                                  {selectionOrder}
                                </div>
                              );
                            })()}
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>

            {/* 画布 UI 覆盖层：随 camera/zoom 移动；分为“展示层（不吃事件）”与“交互层（可输入）” */}
            <div ref={worldUiRef} className="absolute inset-0 z-30 pointer-events-none" style={{ transformOrigin: '0 0' }}>
              {/* 展示层：永远可读且压在图片上方 */}
              <div className="absolute inset-0 pointer-events-none">
                {canvas
                  .filter((x) => (x.kind ?? 'image') === 'generator')
                  .map((g) => {
                    const x = g.x ?? 0;
                    const y = g.y ?? 0;
                    const w = g.w ?? 1024;
                    const h = g.h ?? 1024;
                    return (
                      <div key={`ui_${g.key}`} className="absolute" style={{ left: Math.round(x), top: Math.round(y), width: Math.round(w), height: Math.round(h) }}>
                        <div
                          className="absolute text-[11px] font-semibold"
                          style={{
                            left: 0,
                            top: 0,
                            transform: 'translateY(calc(-100% - 10px)) scale(var(--invZoom))',
                            transformOrigin: 'left bottom',
                            color: 'rgba(255,255,255,0.86)',
                            textShadow: '0 2px 10px rgba(0,0,0,0.55)',
                          }}
                        >
                          Image Generator
                        </div>
                        <div
                          className="absolute text-[11px] font-semibold"
                          style={{
                            right: 0,
                            top: 0,
                            transform: 'translateY(calc(-100% - 10px)) scale(var(--invZoom))',
                            transformOrigin: 'right bottom',
                            color: 'rgba(255,255,255,0.78)',
                            textShadow: '0 2px 10px rgba(0,0,0,0.55)',
                          }}
                        >
                          {Math.round(w)} × {Math.round(h)}
                        </div>
                      </div>
                    );
                  })}

                {/* 普通图片：选中时也显示“名字 + 尺寸”（智能图片已有固定 UI） */}
                {selectedKeys.length === 1
                  ? canvas
                      .filter((it) => (it.kind ?? 'image') === 'image' && isSelectedKey(it.key))
                      .map((it) => {
                        const x = it.x ?? 0;
                        const y = it.y ?? 0;
                        const w = it.w ?? 320;
                        const h = it.h ?? 220;
                        const nameRaw = String(it.prompt ?? '').trim();
                        const name = nameRaw || '图片';
                        const pxW = typeof it.naturalW === 'number' ? it.naturalW : 0;
                        const pxH = typeof it.naturalH === 'number' ? it.naturalH : 0;
                        const hasPixel = pxW > 0 && pxH > 0;
                        const sizeText = hasPixel ? `${Math.round(pxW)} × ${Math.round(pxH)}` : `${Math.round(w)} × ${Math.round(h)}`;
                        const boxW = Math.max(40, Math.round(w));
                        const boxH = Math.max(40, Math.round(h));
                        const inner = hasPixel ? computeObjectFitContainRect(boxW, boxH, pxW, pxH) : { x: 0, y: 0, w: boxW, h: boxH };
                        const selX = Math.round(inner.x);
                        const selY = Math.round(inner.y);
                        const selW = Math.max(1, Math.round(inner.w));
                        const selH = Math.max(1, Math.round(inner.h));
                        // 顶部标签宽度计算
                        const gap = 8;
                        const pad = 16; // label 左右 padding 合计（8+8）
                        const sizeTextPx = measureLabelTextPx(sizeText);
                        const nameTextPx = measureLabelTextPx(name);
                        const sizeLabelW0 = Math.min(220, Math.max(60, sizeTextPx + pad + 14));
                        const screenLeft = Math.round((Math.round(x) + selX) * zoom + camera.x);
                        const stageW = stageSize.w || stageRef.current?.clientWidth || 0;
                        const maxByViewport = stageW > 0 ? Math.max(80, Math.floor(stageW - 12 - screenLeft)) : 9999;
                        const labelHardMax = 920;
                        const screenSelW = Math.max(40, Math.floor(selW * zoom));
                        const labelBoxW = Math.max(80, Math.min(labelHardMax, maxByViewport, screenSelW));
                        const sizeLabelW = Math.min(sizeLabelW0, Math.max(52, labelBoxW - gap - 48));
                        const nameNeedW = Math.min(labelBoxW - sizeLabelW - gap, nameTextPx + pad + 14);
                        const nameBoxW = Math.max(48, Math.floor(Math.min(labelBoxW - sizeLabelW - gap, Math.max(48, nameNeedW))));
                        // 如果名字中包含 @imgN 引用，则尝试使用 MessageContentRenderer 渲染为 Chip
                        const isChipLabel = name.match(/@img\d+/);
                        
                        return (
                          <div
                            key={`ui_sel_${it.key}`}
                            className="absolute"
                            style={{
                              left: Math.round(x) + selX,
                              top: Math.round(y) + selY,
                              width: selW,
                              height: selH,
                            }}
                          >
                            <div
                              className="absolute text-[11px] font-semibold"
                              style={{
                                left: 0,
                                top: 0,
                                transform: 'translateY(calc(-100% - 10px)) scale(var(--invZoom))',
                                transformOrigin: 'left bottom',
                                width: nameBoxW,
                                maxWidth: nameBoxW,
                                boxSizing: 'border-box',
                                padding: '4px 8px',
                                height: 22,
                                display: 'flex',
                                alignItems: 'center',
                                borderRadius: 10,
                                background: 'transparent',
                                border: 'none',
                                color: 'rgba(255,255,255,0.86)',
                                textShadow: 'none',
                                pointerEvents: 'auto', // 允许点击 Chip
                                minWidth: 0,
                              }}
                              title={name}
                            >
                              <span
                                style={{
                                  display: 'block',
                                  minWidth: 0,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {isChipLabel ? (
                                  <MessageContentRenderer
                                    content={name}
                                    canvasItems={canvas}
                                    onPreview={(src, prompt) => setPreview({ open: true, src, prompt })}
                                  />
                                ) : (
                                  name
                                )}
                              </span>
                            </div>

                            <div
                              className="absolute text-[11px] font-semibold"
                              style={{
                                right: 0,
                                top: 0,
                                transform: 'translateY(calc(-100% - 10px)) scale(var(--invZoom))',
                                transformOrigin: 'right bottom',
                                width: sizeLabelW,
                                maxWidth: sizeLabelW,
                                boxSizing: 'border-box',
                                padding: '4px 8px',
                                height: 22,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'flex-end',
                                borderRadius: 10,
                                background: 'transparent',
                                border: 'none',
                                color: 'rgba(255,255,255,0.78)',
                                textShadow: 'none',
                                pointerEvents: 'none',
                                whiteSpace: 'nowrap',
                              }}
                              title={hasPixel ? '图片像素尺寸（natural）' : '图片尺寸（未解析到像素，暂用画布占位）'}
                            >
                              {sizeText}
                            </div>
                          </div>
                        );
                      })
                  : null}

                {/* ── 快捷操作栏 + 快捷编辑输入框（世界坐标，跟随画布 transform） ── */}
                {selectedKeys.length === 1 &&
                  !imgContextMenu.open &&
                  effectiveTool !== 'hand' &&
                  !panning
                  ? canvas
                      .filter(
                        (it) =>
                          (it.kind ?? 'image') === 'image' &&
                          isSelectedKey(it.key) &&
                          it.status === 'done' &&
                          Boolean(it.src),
                      )
                      .map((it) => {
                        const ix = it.x ?? 0;
                        const iy = it.y ?? 0;
                        const iw = it.w ?? 320;
                        const ih = it.h ?? 220;
                        const bW = Math.max(40, Math.round(iw));
                        const bH = Math.max(40, Math.round(ih));
                        const nw = typeof it.naturalW === 'number' ? it.naturalW : 0;
                        const nh = typeof it.naturalH === 'number' ? it.naturalH : 0;
                        const hasN = nw > 0 && nh > 0;
                        const fitImg = it.status === 'done' && Boolean(it.src) && hasN;
                        const inn = fitImg ? computeObjectFitContainRect(bW, bH, nw, nh) : { x: 0, y: 0, w: bW, h: bH };
                        const sX = inn.x;
                        const sY = inn.y;
                        const sW = Math.max(1, inn.w);
                        const sH = Math.max(1, inn.h);
                        return (
                          <div
                            key={`quickbar_${it.key}`}
                            className="absolute"
                            style={{
                              left: Math.round(ix) + sX,
                              top: Math.round(iy) + sY,
                              width: sW,
                              height: sH,
                              pointerEvents: 'none',
                            }}
                          >
                            {/* 快捷操作栏：选区上方居中 */}
                            <div
                              style={{
                                position: 'absolute',
                                left: '50%',
                                top: 0,
                                transform: 'translate(-50%, calc(-100% - 104px)) scale(var(--invZoom))',
                                transformOrigin: 'center bottom',
                                pointerEvents: 'auto',
                              }}
                              onPointerDown={(e) => e.stopPropagation()}
                            >
                              <ImageQuickActionBar
                                actions={mergedQuickActions}
                                onAction={handleQuickAction}
                                onDownload={() => void downloadImage(it.src, it.prompt || 'image')}
                                onOpenConfig={() => setQuickActionDialogOpen(true)}
                                onInpaint={() => {
                                  if (it.status !== 'done' || !it.src) {
                                    toast.error('请先选中一张已完成的图片');
                                    return;
                                  }
                                  setInpaintTarget(it);
                                }}
                              />
                            </div>

                            {/* 快捷编辑输入框：选区下方居中 */}
                            <div
                              style={{
                                position: 'absolute',
                                left: '50%',
                                bottom: 0,
                                transform: 'translate(-50%, calc(100% + 26px)) scale(var(--invZoom))',
                                transformOrigin: 'center top',
                                pointerEvents: 'auto',
                              }}
                              onPointerDown={(e) => e.stopPropagation()}
                            >
                              <ImageQuickEditInput
                                onSubmit={handleQuickEditSubmit}
                                running={quickEditRunning}
                              />
                            </div>
                          </div>
                        );
                      })
                  : null}
              </div>
            </div>

            {/* 交互层：选中生成器时显示快捷输入（可输入/可删除/可发送）
                注意：不能用“全屏覆盖层”接收事件，否则会挡住画布工具栏/缩放条。
                这里用屏幕坐标定位一个“仅自身大小”的浮层。 */}
            {selectedGenerator ? (
              <div
                ref={quickPanelRef}
                className="absolute z-40"
                style={{
                  left: 0,
                  top: 0,
                  // 初始位置通过 React 设置，后续拖动时由 applyWorldTransform 直接更新 DOM 避免延迟
                  transform: `translate(${Math.round(((selectedGenerator.x ?? 0) + (selectedGenerator.w ?? 1024) / 2) * zoom + camera.x)}px, ${Math.round(((selectedGenerator.y ?? 0) + (selectedGenerator.h ?? 1024)) * zoom + camera.y + 26)}px) translate(-50%, 0)`,
                  willChange: 'transform',
                  pointerEvents: 'auto',
                }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  activeComposerRef.current = 'quick';
                  focusQuickComposer();
                }}
              >
                <div
                  className="w-[560px] max-w-[82vw] rounded-[12px] p-3"
                  style={{
                    ...glassInputArea,
                    background: 'rgba(0,0,0,0.14)',
                    border: '1px solid var(--border-subtle, rgba(255,255,255,0.12))',
                    boxShadow: '0 24px 90px rgba(0,0,0,0.45)',
                    minHeight: 148,
                  }}
                >
                  <textarea
                    ref={quickInputRef}
                    value={quickInput}
                    onFocus={() => {
                      activeComposerRef.current = 'quick';
                    }}
                    onCompositionStart={() => {
                      composingRef.current = true;
                    }}
                    onCompositionEnd={() => {
                      composingRef.current = false;
                    }}
                    onChange={(e) => {
                      setQuickInput(e.target.value);
                    }}
                    onKeyDown={(e) => {
                      // 防止按键冒泡到画布层触发删图/移动等快捷键
                      e.stopPropagation();
                      if (e.key === 'Backspace') {
                        if (applyAtomicDelete(e.currentTarget)) {
                          e.preventDefault();
                          return;
                        }
                      }
                      if (e.key === 'Delete') {
                        if (applyAtomicDelete(e.currentTarget)) {
                          e.preventDefault();
                          return;
                        }
                      }
                      if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
                        e.preventDefault();
                        e.currentTarget.select();
                        return;
                      }
                      if (e.key === 'Enter' && !e.shiftKey) {
                        // IME 合成输入时：Enter 代表“确认候选”，不应触发发送/生成
                        const ne = e.nativeEvent as unknown as { isComposing?: boolean; keyCode?: number };
                        if (composingRef.current || ne.isComposing || ne.keyCode === 229) return;
                        e.preventDefault();
                        void onSendQuick();
                      }
                    }}
                    placeholder="请输入你的设计需求（Enter 发送，Shift+Enter 换行）"
                    className="w-full resize-none outline-none focus:outline-none focus-visible:outline-none"
                    style={{
                      height: 88,
                      background: 'transparent',
                      border: 'none',
                      outline: 'none',
                      boxShadow: 'none',
                      color: 'var(--text-primary, rgba(255,255,255,0.92))',
                      fontSize: 14,
                      fontWeight: 500,
                      lineHeight: '20px',
                    }}
                  />

                  <div className="mt-2 flex items-center justify-between gap-2">
                    {/* 尺寸选择器 */}
                    <Popover.Root open={quickSizeOpen} onOpenChange={(open) => {
                      setQuickSizeOpen(open);
                      // 打开时检查并自动修正不支持的尺寸
                      if (open && allSizeOptions.length > 0) {
                        const currentSize = composerSize ?? '1024x1024';
                        const isCurrentValid = allSizeOptions.some((opt) => opt.size?.toLowerCase() === currentSize.toLowerCase());
                        if (!isCurrentValid) {
                          const currentAspect = sizeToAspectMap.get(currentSize.toLowerCase()) || detectAspectFromSize(currentSize);
                          const priorities = ['2k', '1k', '4k'] as const;
                          for (const tier of priorities) {
                            const sameAspectOpt = ratiosByResolution[tier].get(currentAspect);
                            if (sameAspectOpt?.size) {
                              composerSizeAutoRef.current = false;
                              setComposerSize(sameAspectOpt.size);
                              return;
                            }
                          }
                          for (const tier of priorities) {
                            const firstOpt = ratiosByResolution[tier].values().next().value;
                            if (firstOpt?.size) {
                              composerSizeAutoRef.current = false;
                              setComposerSize(firstOpt.size);
                              return;
                            }
                          }
                        }
                      }
                    }}>
                      <Popover.Trigger asChild>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded-full px-2.5 h-6 text-[11px] font-medium cursor-pointer hover:opacity-80 transition-opacity"
                          style={{
                            background: 'rgba(34, 197, 94, 0.12)',
                            border: '1px solid rgba(34, 197, 94, 0.35)',
                            color: 'rgba(74, 222, 128, 0.95)',
                          }}
                          title="选择尺寸"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {(() => {
                            const size = composerSize ?? autoSizeForSelectedImage ?? '1024x1024';
                            const tier = detectTierFromSize(size);
                            const aspect = sizeToAspectMap.get(size.toLowerCase()) || detectAspectFromSize(size);
                            // 如果当前分辨率不可用，显示实际会使用的分辨率
                            const availableTiers = (['1k', '2k', '4k'] as const).filter((t) => ratiosByResolution[t].size > 0);
                            const effectiveTier = availableTiers.length > 0 && !availableTiers.includes(tier) ? availableTiers[0] : tier;
                            const tierLabel = effectiveTier === '4k' ? '4K' : effectiveTier === '2k' ? '2K' : '1K';
                            return <span style={{ whiteSpace: 'nowrap' }}>{tierLabel} · {aspect || '1:1'}</span>;
                          })()}
                          <span className="text-[8px] ml-0.5" style={{ opacity: 0.6 }}>▾</span>
                        </button>
                      </Popover.Trigger>
                      <Popover.Portal>
                        <Popover.Content
                          side="top"
                          align="start"
                          sideOffset={10}
                          className="z-50 rounded-[16px] p-3"
                          style={{
                            width: 280,
                            ...glassPanel,
                          }}
                          onPointerDownOutside={(e) => e.preventDefault()}
                          onInteractOutside={(e) => e.preventDefault()}
                          onFocusOutside={(e) => e.preventDefault()}
                        >
                          {/* 分辨率 */}
                          <div className="text-[11px] font-semibold mb-1.5" style={{ color: 'rgba(255,255,255,0.55)' }}>分辨率</div>
                          <div className="flex gap-1.5 mb-3">
                            {(() => {
                              const currentSize = composerSize ?? autoSizeForSelectedImage ?? '1024x1024';
                              const currentTier = detectTierFromSize(currentSize);
                              const availableTiers = (['1k', '2k', '4k'] as const).filter((t) => ratiosByResolution[t].size > 0);
                              // 如果当前分辨率不可用，计算实际应该选中的分辨率
                              const effectiveTier = availableTiers.includes(currentTier) ? currentTier : availableTiers[0];
                              return availableTiers.map((tier) => {
                                const isSelected = effectiveTier === tier;
                                const label = tier === '4k' ? '4K' : tier === '2k' ? '2K' : '1K';
                                return (
                                  <button
                                    key={tier}
                                    type="button"
                                    className="flex-1 h-7 rounded-[8px] text-[12px] font-semibold transition-colors"
                                    style={{
                                      background: isSelected ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.04)',
                                      border: isSelected ? '1px solid rgba(99, 102, 241, 0.6)' : '1px solid rgba(255,255,255,0.14)',
                                      color: isSelected ? 'rgba(129, 140, 248, 1)' : 'rgba(255,255,255,0.88)',
                                    }}
                                    onClick={() => {
                                      const currentAspect = sizeToAspectMap.get(currentSize.toLowerCase()) || detectAspectFromSize(currentSize);
                                      const targetOpt = ratiosByResolution[tier].get(currentAspect);
                                      if (targetOpt) {
                                        composerSizeAutoRef.current = false;
                                        setComposerSize(targetOpt.size);
                                      } else {
                                        const first = ratiosByResolution[tier].values().next().value;
                                        if (first) {
                                          composerSizeAutoRef.current = false;
                                          setComposerSize(first.size);
                                        }
                                      }
                                    }}
                                  >
                                    {label}
                                  </button>
                                );
                              });
                            })()}
                          </div>
                          {/* 比例 */}
                          <div className="text-[11px] font-semibold mb-1.5" style={{ color: 'rgba(255,255,255,0.55)' }}>Size</div>
                          <div className="grid grid-cols-4 gap-1.5">
                            {(() => {
                              const currentSize = composerSize ?? autoSizeForSelectedImage ?? '1024x1024';
                              const currentTier = detectTierFromSize(currentSize);
                              const currentAspect = sizeToAspectMap.get(currentSize.toLowerCase()) || detectAspectFromSize(currentSize);
                              // 如果当前分辨率不可用，回退到第一个可用的分辨率
                              let ratios = ratiosByResolution[currentTier];
                              if (ratios.size === 0) {
                                for (const tier of ['2k', '1k', '4k'] as const) {
                                  if (ratiosByResolution[tier].size > 0) {
                                    ratios = ratiosByResolution[tier];
                                    break;
                                  }
                                }
                              }
                              return Array.from(ratios.entries()).map(([ratio, opt]) => {
                                const isSelected = ratio === currentAspect;
                                const [rw, rh] = ratio.includes(':') ? ratio.split(':').map(Number) : [1, 1];
                                const aspectVal = rw && rh ? rw / rh : 1;
                                const iconW = aspectVal >= 1 ? 20 : Math.round(20 * aspectVal);
                                const iconH = aspectVal <= 1 ? 20 : Math.round(20 / aspectVal);
                                return (
                                  <button
                                    key={ratio}
                                    type="button"
                                    className="flex flex-col items-center justify-center gap-1 py-2 rounded-[8px] transition-colors"
                                    style={{
                                      background: isSelected ? 'rgba(99, 102, 241, 0.22)' : 'rgba(255,255,255,0.08)',
                                      border: isSelected ? '1px solid rgba(99, 102, 241, 0.6)' : '1px solid rgba(255,255,255,0.14)',
                                      color: isSelected ? 'rgba(129, 140, 248, 1)' : 'rgba(255,255,255,0.88)',
                                    }}
                                    onClick={() => {
                                      composerSizeAutoRef.current = false;
                                      setComposerSize(opt.size);
                                      setQuickSizeOpen(false);
                                    }}
                                  >
                                    <div style={{ width: iconW, height: iconH, border: '1.5px solid currentColor', borderRadius: 3, opacity: 0.7 }} />
                                    <span className="text-[10px] font-medium">{ratio}</span>
                                  </button>
                                );
                              });
                            })()}
                          </div>
                        </Popover.Content>
                      </Popover.Portal>
                    </Popover.Root>

                    {/* 模型选择器 */}
                    <DropdownMenu.Root open={quickModelOpen} onOpenChange={setQuickModelOpen}>
                      <DropdownMenu.Trigger asChild>
                        <button
                          type="button"
                          className="text-[11px] font-medium inline-flex items-center gap-1 rounded-full px-2.5 h-6 hover:bg-white/5 transition-colors"
                          style={{
                            background: 'rgba(99, 102, 241, 0.12)',
                            border: '1px solid rgba(99, 102, 241, 0.35)',
                            color: 'rgba(129, 140, 248, 0.95)',
                          }}
                          title="切换绘图模型"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Sparkles size={10} className="shrink-0" />
                          <span className="truncate max-w-[140px]">
                            {effectiveModel?.name || effectiveModel?.modelName || '自动模型'}
                          </span>
                          <span className="text-[8px] ml-0.5" style={{ opacity: 0.6 }}>▾</span>
                        </button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content
                          side="top"
                          align="start"
                          sideOffset={10}
                          className="z-50 rounded-[18px] p-3"
                          style={{
                            minWidth: 320,
                            ...glassPanel,
                          }}
                        >
                          <div className="px-2 py-1 text-[11px] font-semibold" style={{ color: 'var(--text-muted, rgba(255,255,255,0.45))' }}>
                            {(() => {
                              const first = allImageGenModels[0];
                              if (first?.isDedicated) return '绘图模型（专属模型池）';
                              if (first?.isDefault) return '绘图模型（默认模型池）';
                              if (first?.isLegacy) return '绘图模型（默认生图）';
                              return '绘图模型';
                            })()}
                          </div>
                          <div className="max-h-[320px] overflow-auto p-1">
                            {allImageGenModels
                              .slice()
                              .sort(
                                (a, b) =>
                                  Number(Boolean(b.enabled)) - Number(Boolean(a.enabled)) ||
                                  Number(a.priority ?? 1e9) - Number(b.priority ?? 1e9) ||
                                  String(a.name || a.modelName || '').localeCompare(String(b.name || b.modelName || ''), undefined, { numeric: true })
                              )
                              .map((m) => {
                                const disabled = !m.enabled;
                                const using = modelPrefAuto ? effectiveModel?.id === m.id : modelPrefModelId === m.id;
                                const isPool = m.id.startsWith('pool_');
                                // 根据来源类型生成标签
                                const getSourceLabel = () => {
                                  if (m.isDedicated) return '专属池';
                                  if (m.isDefault) return '默认池';
                                  if (m.isLegacy) return '默认生图';
                                  if (isPool) return '模型池';
                                  return disabled ? '已禁用' : '已启用';
                                };
                                const sourceLabel = getSourceLabel();
                                return (
                                  <button
                                    key={m.id}
                                    type="button"
                                    className="w-full text-left rounded-[12px] px-3 py-2 hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                    style={{
                                      border: using ? '1px solid rgba(250,204,21,0.35)' : '1px solid transparent',
                                      background: using ? 'rgba(250,204,21,0.08)' : 'transparent',
                                    }}
                                    disabled={disabled}
                                    onClick={() => {
                                      setModelPrefAuto(false);
                                      setModelPrefModelId(m.id);
                                      setQuickModelOpen(false);
                                    }}
                                  >
                                    <div className="flex items-center gap-2 min-w-0">
                                      <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-1.5">
                                          <div className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary, rgba(255,255,255,0.92))' }}>
                                            {m.name || m.modelName}
                                          </div>
                                          {m.isDedicated && (
                                            <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded-[4px]" style={{ background: 'rgba(147,51,234,0.20)', color: 'rgb(192,132,252)' }}>
                                              专属
                                            </span>
                                          )}
                                          {m.isDefault && !m.isDedicated && (
                                            <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded-[4px]" style={{ background: 'rgba(34,197,94,0.18)', color: 'rgb(74,222,128)' }}>
                                              默认
                                            </span>
                                          )}
                                          {m.isLegacy && (
                                            <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded-[4px]" style={{ background: 'rgba(234,179,8,0.18)', color: 'rgb(250,204,21)' }}>
                                              传统
                                            </span>
                                          )}
                                        </div>
                                        <div className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--text-muted, rgba(255,255,255,0.40))' }}>
                                          {isPool ? m.modelName : (disabled ? '已禁用（模型管理可启用）' : sourceLabel)}
                                        </div>
                                      </div>
                                      <div className="ml-auto shrink-0">
                                        {using ? <Check size={16} style={{ color: 'rgba(250,204,21,0.95)' }} /> : null}
                                      </div>
                                    </div>
                                  </button>
                                );
                              })}
                          </div>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>

                    <div className="flex-1" />
                    <div className="text-[10px]" style={{ color: 'var(--text-muted, rgba(255,255,255,0.40))' }}>
                      Enter 发送
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {/* 框选矩形（屏幕坐标） */}
            {marquee.active && marquee.w > 0 && marquee.h > 0 ? (
              <div
                className="absolute"
                style={{
                  left: Math.round(marquee.x),
                  top: Math.round(marquee.y),
                  width: Math.round(marquee.w),
                  height: Math.round(marquee.h),
                  border: '1px solid rgba(96,165,250,0.75)',
                  background: 'rgba(96,165,250,0.10)',
                  boxShadow: '0 0 0 1px rgba(0,0,0,0.35) inset',
                  pointerEvents: 'none',
                }}
              />
            ) : null}
          </div>

          {/* 右上：专注模式按钮（已隐藏 - 功能暂时不需要） */}

          {/* 顶部居中：缩放浮层 */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20">
            <div
              className="h-9 rounded-[999px] px-1.5 inline-flex items-center gap-1 whitespace-nowrap"
              style={{
                ...glassTooltip,
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(0,0,0,0.25)',
                boxShadow: '0 18px 60px rgba(0,0,0,0.50)',
                color: 'var(--text-secondary)',
              }}
            >
              <button
                type="button"
                className="h-8 w-8 rounded-[999px] inline-flex items-center justify-center hover:bg-white/5 shrink-0"
                onClick={() => {
                  const c = stageCenterClient();
                  zoomAt(c.x, c.y, clampZoom(zoomRef.current / 1.07));
                }}
                title="缩小"
                aria-label="缩小"
                disabled={canvas.length === 0}
              >
                <ZoomOut size={16} />
              </button>
              <div className="px-1 text-[10px] font-semibold tabular-nums shrink-0" title="缩放比例">
                {Math.round(zoom * 100)}%
              </div>
              <button
                type="button"
                className="h-8 w-8 rounded-[999px] inline-flex items-center justify-center hover:bg-white/5 shrink-0"
                onClick={() => {
                  const c = stageCenterClient();
                  zoomAt(c.x, c.y, clampZoom(zoomRef.current * 1.07));
                }}
                title="放大"
                aria-label="放大"
                disabled={canvas.length === 0}
              >
                <ZoomIn size={16} />
              </button>
              {/* 移动端精简：只保留 适配 按钮，隐藏 100% 和排列 */}
              <button
                type="button"
                className="h-8 px-2 rounded-[999px] text-[10px] font-semibold hover:bg-white/5 whitespace-nowrap shrink-0"
                onClick={fitToSelection}
                disabled={canvas.length === 0}
                title="适配选中/全部 (Shift+2) | 适配全部 (Shift+1) | 100% (Shift+0)"
              >
                适配
              </button>
              {!isMobile && (
                <>
                  <button
                    type="button"
                    className="h-8 px-2 rounded-[999px] text-[10px] font-semibold hover:bg-white/5 whitespace-nowrap shrink-0"
                    onClick={() => {
                      const c = stageCenterClient();
                      zoomAt(c.x, c.y, 1);
                    }}
                    disabled={canvas.length === 0}
                    title="回到 100%"
                  >
                    100%
                  </button>
                  <div className="w-px h-4 mx-0.5 shrink-0" style={{ background: 'rgba(255,255,255,0.15)' }} />
                  <button
                    type="button"
                    className="h-8 w-8 rounded-[999px] inline-flex items-center justify-center hover:bg-white/5 shrink-0"
                    onClick={arrangeGrid}
                    disabled={canvas.length === 0}
                    title="自动排列（网格布局）"
                    aria-label="自动排列"
                  >
                    <Grid3X3 size={14} />
                  </button>
                </>
              )}
            </div>
          </div>

          {/* 左侧工具栏（液态大玻璃风格，上下半圆圆角）— 移动端隐藏 */}
          <div className={`absolute left-3 top-1/2 -translate-y-1/2 z-20 ${isMobile ? 'hidden' : ''}`}>
            <div
              className="rounded-full p-1.5 flex flex-col gap-1.5 bg-transparent"
              style={{
                ...glassPanel,
                boxShadow: '0 18px 60px rgba(0,0,0,0.45), 0 0 0 1px rgba(255, 255, 255, 0.06) inset',
              }}
            >
              {/* 工具（hover 弹出：Select / Hand / Mark[禁用]） */}
              <div
                onPointerEnter={() => {
                  if (toolMenuCloseTimerRef.current != null) {
                    window.clearTimeout(toolMenuCloseTimerRef.current);
                    toolMenuCloseTimerRef.current = null;
                  }
                  setToolMenuOpen(true);
                }}
                onPointerLeave={() => {
                  if (toolMenuCloseTimerRef.current != null) window.clearTimeout(toolMenuCloseTimerRef.current);
                  toolMenuCloseTimerRef.current = window.setTimeout(() => {
                    setToolMenuOpen(false);
                    toolMenuCloseTimerRef.current = null;
                  }, HOVER_MENU_CLOSE_DELAY_MS);
                }}
              >
                <DropdownMenu.Root
                  modal={false}
                  open={toolMenuOpen}
                  onOpenChange={(open) => {
                    // hover 模式：仅允许外部关闭，不要让 Radix 的 open=true 干扰 hover 状态
                    if (!open) setToolMenuOpen(false);
                  }}
                >
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      className={`h-11 w-11 rounded-[14px] inline-flex items-center justify-center bg-transparent transition-colors hover:bg-white/12 ${
                        tempHand ? 'bg-white/12' : ''
                      }`}
                      style={{ color: 'rgba(255,255,255,0.86)' }}
                      title={
                        effectiveTool === 'hand'
                          ? tempHand
                            ? 'Hand tool (Space)'
                            : 'Hand tool'
                          : effectiveTool === 'mark'
                            ? 'Mark'
                            : 'Select'
                      }
                      aria-label="工具"
                      onClick={() => stageRef.current?.focus()}
                    >
                      {effectiveTool === 'hand' ? <Hand size={18} /> : effectiveTool === 'mark' ? <MapPin size={18} /> : <MousePointer2 size={18} />}
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      side="right"
                      align="start"
                      sideOffset={8}
                      className="z-50 rounded-[18px] p-2"
                      style={{
                        ...glassPanel,
                        minWidth: 220,
                        background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.96) 0%, rgba(255, 255, 255, 0.90) 100%)',
                        border: '1px solid rgba(0, 0, 0, 0.08)',
                        boxShadow: '0 18px 60px rgba(0,0,0,0.18), 0 0 0 1px rgba(255, 255, 255, 0.8) inset',
                        color: '#0b0b0f',
                      }}
                      onPointerEnter={() => {
                        if (toolMenuCloseTimerRef.current != null) {
                          window.clearTimeout(toolMenuCloseTimerRef.current);
                          toolMenuCloseTimerRef.current = null;
                        }
                      }}
                      onPointerLeave={() => {
                        if (toolMenuCloseTimerRef.current != null) window.clearTimeout(toolMenuCloseTimerRef.current);
                        toolMenuCloseTimerRef.current = window.setTimeout(() => {
                          setToolMenuOpen(false);
                          toolMenuCloseTimerRef.current = null;
                        }, HOVER_MENU_CLOSE_DELAY_MS);
                      }}
                    >
                      <div className="px-2 pb-2">
                        <div className="text-[12px] font-semibold" style={{ color: 'rgba(0,0,0,0.45)' }}>
                          悬浮 - 展开菜单
                        </div>
                        <div className="mt-0.5 text-[12px] font-semibold" style={{ color: 'rgba(0,0,0,0.45)' }}>
                          点按 - 选择工具
                        </div>
                        <div className="mt-2 h-px" style={{ background: 'rgba(0,0,0,0.10)' }} />
                      </div>
                      <button
                        type="button"
                        className="w-full flex items-center gap-3 rounded-[14px] px-3 py-2 hover:bg-black/5"
                        onClick={() => {
                          setActiveTool('select');
                          setToolMenuOpen(false);
                          stageRef.current?.focus();
                        }}
                      >
                        <MousePointer2 size={18} color="#0b0b0f" />
                        <span className="text-[16px] font-semibold" style={{ color: '#0b0b0f' }}>
                          Select
                        </span>
                        <span className="ml-auto inline-flex items-center gap-2 text-[14px] font-semibold">
                          <span style={{ color: 'rgba(0,0,0,0.22)' }}>-</span>
                          <span style={{ color: 'rgba(0,0,0,0.35)' }}>V</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="w-full flex items-center gap-3 rounded-[14px] px-3 py-2 hover:bg-black/5"
                        onClick={() => {
                          setActiveTool('hand');
                          setToolMenuOpen(false);
                          stageRef.current?.focus();
                        }}
                      >
                        <Hand size={18} color="#0b0b0f" />
                        <span className="text-[16px] font-semibold" style={{ color: '#0b0b0f' }}>
                          Hand tool
                        </span>
                        <span className="ml-auto inline-flex items-center gap-2 text-[14px] font-semibold">
                          <span style={{ color: 'rgba(0,0,0,0.22)' }}>-</span>
                          <span style={{ color: 'rgba(0,0,0,0.35)' }}>H</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="w-full flex items-center gap-3 rounded-[14px] px-3 py-2 opacity-60 cursor-not-allowed"
                        disabled
                      >
                        <MapPin size={18} color="#0b0b0f" />
                        <span className="text-[16px] font-semibold" style={{ color: 'rgba(11,11,15,0.65)' }}>
                          Mark
                        </span>
                        <span className="ml-auto inline-flex items-center gap-2 text-[14px] font-semibold">
                          <span style={{ color: 'rgba(0,0,0,0.22)' }}>-</span>
                          <span style={{ color: 'rgba(0,0,0,0.35)' }}>M</span>
                        </span>
                      </button>
                                          </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>

              {/* +新增 */}
              <div
                onPointerEnter={() => {
                  if (addMenuCloseTimerRef.current != null) {
                    window.clearTimeout(addMenuCloseTimerRef.current);
                    addMenuCloseTimerRef.current = null;
                  }
                  setAddMenuOpen(true);
                }}
                onPointerLeave={() => {
                  if (addMenuCloseTimerRef.current != null) window.clearTimeout(addMenuCloseTimerRef.current);
                  addMenuCloseTimerRef.current = window.setTimeout(() => {
                    setAddMenuOpen(false);
                    addMenuCloseTimerRef.current = null;
                  }, HOVER_MENU_CLOSE_DELAY_MS);
                }}
              >
                <DropdownMenu.Root
                  modal={false}
                  open={addMenuOpen}
                  onOpenChange={(open) => {
                    if (!open) setAddMenuOpen(false);
                  }}
                >
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      className="h-11 w-11 rounded-[14px] inline-flex items-center justify-center bg-transparent transition-colors hover:bg-white/12"
                      style={{ color: 'rgba(255,255,255,0.86)' }}
                      title="新增"
                      aria-label="新增"
                    >
                      <span className="text-[22px] leading-none font-semibold">+</span>
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      side="right"
                      align="start"
                      sideOffset={8}
                      className="z-50 rounded-[18px] p-3"
                      style={{
                        ...glassPanel,
                        minWidth: 260,
                        background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.96) 0%, rgba(255, 255, 255, 0.90) 100%)',
                        border: '1px solid rgba(0, 0, 0, 0.08)',
                        boxShadow: '0 18px 60px rgba(0,0,0,0.18), 0 0 0 1px rgba(255, 255, 255, 0.8) inset',
                        color: '#0b0b0f',
                      }}
                      onPointerEnter={() => {
                        if (addMenuCloseTimerRef.current != null) {
                          window.clearTimeout(addMenuCloseTimerRef.current);
                          addMenuCloseTimerRef.current = null;
                        }
                      }}
                      onPointerLeave={() => {
                        if (addMenuCloseTimerRef.current != null) window.clearTimeout(addMenuCloseTimerRef.current);
                        addMenuCloseTimerRef.current = window.setTimeout(() => {
                          setAddMenuOpen(false);
                          addMenuCloseTimerRef.current = null;
                        }, HOVER_MENU_CLOSE_DELAY_MS);
                      }}
                    >
                      <div className="text-[14px] font-semibold" style={{ color: 'rgba(0,0,0,0.55)' }}>
                        新增
                      </div>
                      <div className="mt-2 text-[12px] font-semibold" style={{ color: 'rgba(0,0,0,0.45)' }}>
                        悬浮 - 展开菜单
                      </div>
                      <div className="mt-0.5 text-[12px] font-semibold" style={{ color: 'rgba(0,0,0,0.45)' }}>
                        点按 - 执行操作
                      </div>
                      <div className="mt-2 h-px" style={{ background: 'rgba(0,0,0,0.10)' }} />

                      <div className="mt-3 grid gap-2">
                        <button
                          type="button"
                          className="w-full flex items-center gap-3 rounded-[14px] px-3 py-2 hover:bg-black/5"
                          onClick={() => {
                            setAddMenuOpen(false);
                            openImageFilePicker();
                          }}
                        >
                          <ImagePlus size={18} color="#0b0b0f" />
                          <span className="text-[16px] font-semibold" style={{ color: '#0b0b0f' }}>
                            上传图片
                          </span>
                        </button>
                        <button
                          type="button"
                          className="w-full flex items-center gap-3 rounded-[14px] px-3 py-2 hover:bg-black/5 opacity-60 cursor-not-allowed"
                          disabled
                        >
                          <Video size={18} color="#0b0b0f" />
                          <span className="text-[16px] font-semibold" style={{ color: 'rgba(11,11,15,0.65)' }}>
                            上传视频
                          </span>
                        </button>
                        <button
                          type="button"
                          className="w-full flex items-center gap-3 rounded-[14px] px-3 py-2 hover:bg-black/5 opacity-60 cursor-not-allowed"
                          disabled
                        >
                          <span
                            className="inline-flex h-5 w-5 items-center justify-center text-[18px] font-black"
                            style={{ color: 'rgba(11,11,15,0.65)' }}
                          >
                            #
                          </span>
                          <span className="text-[16px] font-semibold" style={{ color: 'rgba(11,11,15,0.65)' }}>
                            智能画板
                          </span>
                          <span className="ml-auto inline-flex items-center gap-2 text-[14px] font-semibold">
                            <span style={{ color: 'rgba(0,0,0,0.22)' }}>-</span>
                            <span style={{ color: 'rgba(0,0,0,0.35)' }}>F</span>
                          </span>
                        </button>
                      </div>
                                          </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>

              {/* 形状 */}
              <div
                onPointerEnter={() => {
                  if (shapeMenuCloseTimerRef.current != null) {
                    window.clearTimeout(shapeMenuCloseTimerRef.current);
                    shapeMenuCloseTimerRef.current = null;
                  }
                  setShapeMenuOpen(true);
                }}
                onPointerLeave={() => {
                  if (shapeMenuCloseTimerRef.current != null) window.clearTimeout(shapeMenuCloseTimerRef.current);
                  shapeMenuCloseTimerRef.current = window.setTimeout(() => {
                    setShapeMenuOpen(false);
                    shapeMenuCloseTimerRef.current = null;
                  }, HOVER_MENU_CLOSE_DELAY_MS);
                }}
              >
                <DropdownMenu.Root
                  modal={false}
                  open={shapeMenuOpen}
                  onOpenChange={(open) => {
                    if (!open) setShapeMenuOpen(false);
                  }}
                >
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      className="h-11 w-11 rounded-[14px] inline-flex items-center justify-center bg-transparent transition-colors hover:bg-white/12"
                      style={{ color: 'rgba(255,255,255,0.86)' }}
                      title="形状"
                      aria-label="形状"
                    >
                      <Square size={18} />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      side="right"
                      align="start"
                      sideOffset={8}
                      className="z-50 rounded-[18px] p-3"
                      style={{
                        ...glassPanel,
                        minWidth: 320,
                        background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.96) 0%, rgba(255, 255, 255, 0.90) 100%)',
                        border: '1px solid rgba(0, 0, 0, 0.08)',
                        boxShadow: '0 18px 60px rgba(0,0,0,0.18), 0 0 0 1px rgba(255, 255, 255, 0.8) inset',
                      }}
                      onPointerEnter={() => {
                        if (shapeMenuCloseTimerRef.current != null) {
                          window.clearTimeout(shapeMenuCloseTimerRef.current);
                          shapeMenuCloseTimerRef.current = null;
                        }
                      }}
                      onPointerLeave={() => {
                        if (shapeMenuCloseTimerRef.current != null) window.clearTimeout(shapeMenuCloseTimerRef.current);
                        shapeMenuCloseTimerRef.current = window.setTimeout(() => {
                          setShapeMenuOpen(false);
                          shapeMenuCloseTimerRef.current = null;
                        }, HOVER_MENU_CLOSE_DELAY_MS);
                      }}
                    >
                      <div className="text-[14px] font-semibold" style={{ color: 'rgba(0,0,0,0.55)' }}>
                        形状
                      </div>
                      <div className="mt-2 text-[12px] font-semibold" style={{ color: 'rgba(0,0,0,0.45)' }}>
                        悬浮 - 展开菜单
                      </div>
                      <div className="mt-0.5 text-[12px] font-semibold" style={{ color: 'rgba(0,0,0,0.45)' }}>
                        点按 - 在画布放置
                      </div>
                      <div className="mt-2 h-px" style={{ background: 'rgba(0,0,0,0.10)' }} />

                      <div className="mt-3 grid grid-cols-4 gap-3">
                        <button
                          type="button"
                          className="h-12 rounded-[14px] bg-white hover:bg-black/5 border border-black/10"
                          title="矩形"
                          aria-label="矩形"
                          onClick={() => {
                            setShapeMenuOpen(false);
                            setActiveTool('select');
                            setPlacing({ kind: 'shape', shapeType: 'rect' });
                            stageRef.current?.focus();
                          }}
                        />
                        <button
                          type="button"
                          className="h-12 rounded-[999px] bg-white hover:bg-black/5 border border-black/10"
                          title="圆形"
                          aria-label="圆形"
                          onClick={() => {
                            setShapeMenuOpen(false);
                            setActiveTool('select');
                            setPlacing({ kind: 'shape', shapeType: 'circle' });
                            stageRef.current?.focus();
                          }}
                        />
                        <button
                          type="button"
                          className="h-12 rounded-[14px] bg-white hover:bg-black/5 border border-black/10"
                          style={{ clipPath: 'polygon(50% 15%, 10% 85%, 90% 85%)' }}
                          title="三角形"
                          aria-label="三角形"
                          onClick={() => {
                            setShapeMenuOpen(false);
                            setActiveTool('select');
                            setPlacing({ kind: 'shape', shapeType: 'triangle' });
                            stageRef.current?.focus();
                          }}
                        />
                        <button
                          type="button"
                          className="h-12 rounded-[14px] bg-white hover:bg-black/5 border border-black/10"
                          style={{ clipPath: 'polygon(50% 10%, 61% 38%, 90% 38%, 66% 56%, 76% 86%, 50% 68%, 24% 86%, 34% 56%, 10% 38%, 39% 38%)' }}
                          title="星形"
                          aria-label="星形"
                          onClick={() => {
                            setShapeMenuOpen(false);
                            setActiveTool('select');
                            setPlacing({ kind: 'shape', shapeType: 'star' });
                            stageRef.current?.focus();
                          }}
                        />
                      </div>
                      <div className="mt-4 text-[14px] font-semibold" style={{ color: 'rgba(0,0,0,0.55)' }}>
                        形状文本
                      </div>
                      <div className="mt-3 grid grid-cols-5 gap-3">
                        <button type="button" className="h-12 rounded-[14px] bg-white border border-black/10 opacity-60 cursor-not-allowed" disabled />
                        <button type="button" className="h-12 rounded-[999px] bg-white border border-black/10 opacity-60 cursor-not-allowed" disabled />
                        <button type="button" className="h-12 rounded-[14px] bg-white border border-black/10 opacity-60 cursor-not-allowed" disabled />
                        <button type="button" className="h-12 rounded-[14px] bg-white border border-black/10 opacity-60 cursor-not-allowed" disabled />
                        <button type="button" className="h-12 rounded-[14px] bg-white border border-black/10 opacity-60 cursor-not-allowed" disabled />
                      </div>
                                          </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>

              {/* 文字 */}
              <button
                type="button"
                className="h-11 w-11 rounded-[14px] inline-flex items-center justify-center bg-transparent transition-colors hover:bg-white/12"
                style={{ color: 'rgba(255,255,255,0.86)' }}
                title="文字（T）"
                aria-label="文字"
                onClick={() => {
                  setActiveTool('select');
                  setPlacing({ kind: 'text' });
                  stageRef.current?.focus();
                }}
              >
                <Type size={18} />
              </button>

              {/* 分隔线（图1 中间那根杠）：区分“编辑工具”与“生成器/媒体” */}
              <div className="my-1 h-px" style={{ background: 'rgba(255,255,255,0.12)' }} aria-hidden="true" />

              {/* 图像生成器 */}
              <button
                type="button"
                className="h-11 w-11 rounded-[14px] inline-flex items-center justify-center bg-transparent transition-colors hover:bg-white/12"
                style={{ color: 'rgba(255,255,255,0.86)' }}
                title="图像生成器（A）"
                aria-label="图像生成器"
                onClick={() => {
                  // 允许创建多个"生成器区域"：每次点击都新建一个（不覆盖旧的）
                  const w = 1024;
                  const h = 1024;
                  const near = stageCenterWorld();
                  const key = `generator_${Date.now()}`;
                  setCanvas((prev) => {
                    const existingRects = prev
                      .filter(
                        (x) =>
                          ((x.kind ?? 'image') === 'generator' ||
                            (x.kind ?? 'image') === 'shape' ||
                            (x.kind ?? 'image') === 'text' ||
                            !!x.src ||
                            x.status === 'running' ||
                            x.status === 'error')
                      )
                      .map((x) => ({ x: x.x ?? 0, y: x.y ?? 0, w: x.w ?? 1, h: x.h ?? 1 }));
                    const pos = findNearestFreeTopLeft(existingRects, w, h, near);
                    const next: CanvasImageItem = {
                      key,
                      kind: 'generator',
                      createdAt: Date.now(),
                      prompt: 'Image Generator',
                      src: '',
                      status: 'done',
                      x: pos.x,
                      y: pos.y,
                      w,
                      h,
                    };
                    focusKeyRef.current = { key, cx: pos.x + w / 2, cy: pos.y + h / 2, w, h };
                    return [next, ...prev].slice(0, 80);
                  });
                  setSelectionWithoutChip([key]); // generator 不需要 chip
                  requestAnimationFrame(() => {
                    const f = focusKeyRef.current;
                    if (!f || f.key !== key) return;
                    // 生成器区域固定缩放 30%，避免过大
                    if (f.w && f.h) {
                      animateCameraToFitRect({ x: f.cx - f.w / 2, y: f.cy - f.h / 2, w: f.w, h: f.h }, { maxZoom: 0.3 });
                    } else {
                      animateCameraToWorldCenter(f.cx, f.cy);
                    }
                  });
                  focusQuickComposer();
                }}
              >
                <ImagePlus size={18} />
              </button>

              {/* 手绘板 */}
              <button
                type="button"
                className="h-11 w-11 rounded-[14px] inline-flex items-center justify-center bg-transparent transition-colors hover:bg-white/12"
                style={{ color: 'rgba(255,255,255,0.86)' }}
                title="手绘板"
                aria-label="手绘板"
                onClick={() => setDrawingBoardOpen(true)}
              >
                <PenTool size={18} />
              </button>

              {/* 删除选中（放到底部） */}
              <button
                type="button"
                className="h-11 w-11 rounded-[14px] inline-flex items-center justify-center bg-transparent transition-colors hover:bg-white/12 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ color: 'rgba(255,255,255,0.86)' }}
                onClick={() => void confirmAndDeleteSelectedKeys([...selectedKeys])}
                disabled={selectedKeys.length === 0}
                title="删除选中"
                aria-label="删除选中"
              >
                <Trash size={18} />
              </button>
            </div>
          </div>

          {/* 底部缩略图条：你想要“开放世界”，默认不再显示；如未来需要可在这里恢复 */}

          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept="image/*"
            multiple
            onChange={(e) => {
              const fs = Array.from(e.currentTarget.files ?? []);
              e.currentTarget.value = '';
              void onUploadImages(fs);
            }}
          />
        </div>
          </div>

          {/* 移动端：底部工具栏 (替代隐藏的左侧工具栏) */}
          {isMobile && (
            <div
              className="absolute left-1/2 -translate-x-1/2 bottom-3 z-40 inline-flex items-center gap-1 px-1.5 rounded-full h-12"
              style={{
                ...glassTooltip,
                border: '1px solid rgba(255,255,255,0.14)',
                background: 'rgba(0,0,0,0.45)',
                boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
              }}
            >
              {/* 手型工具 — 拖拽画布 */}
              <button
                type="button"
                onClick={() => { setActiveTool('hand'); setMobileShowChat(false); }}
                className="h-10 w-10 rounded-full inline-flex items-center justify-center shrink-0"
                style={{
                  background: activeTool === 'hand' && !mobileShowChat ? 'rgba(255,255,255,0.15)' : 'transparent',
                  color: activeTool === 'hand' && !mobileShowChat ? 'var(--text-primary)' : 'var(--text-muted)',
                }}
                aria-label="拖拽画布"
              >
                <Hand size={18} />
              </button>
              {/* 选择工具 — 选中/移动图片 */}
              <button
                type="button"
                onClick={() => { setActiveTool('select'); setMobileShowChat(false); }}
                className="h-10 w-10 rounded-full inline-flex items-center justify-center shrink-0"
                style={{
                  background: activeTool === 'select' && !mobileShowChat ? 'rgba(255,255,255,0.15)' : 'transparent',
                  color: activeTool === 'select' && !mobileShowChat ? 'var(--text-primary)' : 'var(--text-muted)',
                }}
                aria-label="选择/移动"
              >
                <MousePointer2 size={18} />
              </button>
              <div className="w-px h-5 shrink-0" style={{ background: 'rgba(255,255,255,0.15)' }} />
              {/* 上传图片 */}
              <button
                type="button"
                onClick={() => openImageFilePicker()}
                className="h-10 w-10 rounded-full inline-flex items-center justify-center shrink-0"
                style={{
                  background: 'transparent',
                  color: 'var(--text-muted)',
                }}
                aria-label="上传图片"
              >
                <ImagePlus size={18} />
              </button>
              {/* 手绘板 */}
              <button
                type="button"
                onClick={() => setDrawingBoardOpen(true)}
                className="h-10 w-10 rounded-full inline-flex items-center justify-center shrink-0"
                style={{
                  background: 'transparent',
                  color: 'var(--text-muted)',
                }}
                aria-label="手绘板"
              >
                <PenTool size={18} />
              </button>
              <div className="w-px h-5 shrink-0" style={{ background: 'rgba(255,255,255,0.15)' }} />
              {/* 聊天面板切换 */}
              <button
                type="button"
                onClick={() => setMobileShowChat((v) => !v)}
                className="h-10 w-10 rounded-full inline-flex items-center justify-center shrink-0"
                style={{
                  background: mobileShowChat ? 'var(--accent-gold)' : 'transparent',
                  color: mobileShowChat ? '#1a1a1a' : 'var(--text-muted)',
                }}
                aria-label={mobileShowChat ? '返回画布' : '打开聊天'}
              >
                <MessageSquare size={18} />
              </button>
            </div>
          )}

          {/* 右侧：浮动对话面板（液态大玻璃效果）— 移动端全屏覆盖 / 桌面端浮动 */}
          <div
            className={`${isMobile ? 'absolute inset-0' : 'absolute right-3 top-3'} z-30 flex flex-col`}
            style={{
              width: isMobile ? '100%' : 420,
              height: isMobile ? '100%' : 'calc(100% - 24px)',
              display: isMobile && !mobileShowChat ? 'none' : undefined,
              // 移动端：底部留出工具栏空间
              paddingBottom: isMobile ? 60 : undefined,
            }}
          >
            <div
              className={`flex flex-col h-full ${isMobile ? 'p-3' : 'p-2.5 rounded-[14px]'}`}
              style={{
                ...glassPanel,
                background: isMobile
                  ? 'linear-gradient(180deg, rgba(18, 18, 22, 0.96) 0%, rgba(14, 14, 18, 0.98) 100%)'
                  : 'linear-gradient(180deg, var(--glass-bg-start, rgba(30, 30, 35, 0.85)) 0%, var(--glass-bg-end, rgba(25, 25, 30, 0.80)) 100%)',
                border: isMobile ? 'none' : '1px solid var(--glass-border, rgba(255, 255, 255, 0.12))',
                boxShadow: isMobile ? 'none' : '0 12px 40px rgba(0,0,0,0.50), 0 0 0 1px rgba(255, 255, 255, 0.05) inset',
                borderRadius: isMobile ? 0 : 14,
              }}
            >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  Hi，我是你的 AI 设计师
                </div>
                {!isMobile && (
                  <div className="mt-0.5 text-[9px] leading-tight" style={{ color: 'var(--text-muted)' }}>
                    点画板图片即可选中，未来可作为图生图首帧。
                  </div>
                )}
              </div>
              <div className="flex items-center gap-0.5 shrink-0">
                <button
                  type="button"
                  onClick={() => setShowLogs(true)}
                  className="h-6 w-6 inline-flex items-center justify-center rounded-md transition-colors duration-200 hover:bg-white/10 shrink-0"
                  style={{ color: 'var(--text-muted)' }}
                  aria-label="查看 LLM 日志"
                  title="查看 LLM 日志"
                >
                  <Eye size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDefectFlash(false);
                    useGlobalDefectStore.getState().openDialog();
                  }}
                  className="h-6 w-6 inline-flex items-center justify-center rounded-md transition-colors duration-200 hover:bg-white/10 shrink-0"
                  style={{ color: 'var(--text-muted)' }}
                  aria-label="提交缺陷"
                  title="提交缺陷"
                >
                  <Bug size={14} className={defectFlash ? 'defect-submit-flash' : ''} />
                </button>
                {/* 移动端：关闭聊天面板按钮 */}
                {isMobile && (
                  <button
                    type="button"
                    onClick={() => setMobileShowChat(false)}
                    className="h-6 w-6 inline-flex items-center justify-center rounded-md transition-colors duration-200 hover:bg-white/10 shrink-0"
                    style={{ color: 'var(--text-muted)' }}
                    aria-label="关闭聊天"
                  >
                    <ChevronDown size={14} />
                  </button>
                )}
              </div>
            </div>

            {(!input.trim() && messages.length === 0) ? (
              <div className="mt-2 grid gap-1.5">
                {templates.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className="w-full text-left rounded-[10px] px-2.5 py-2 hover:bg-white/5 transition-colors"
                    style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}
                    onClick={() => {
                      const text = buildTemplate(t.id);
                      setInput(text);
                      requestAnimationFrame(() => inputRef.current?.focus());
                    }}
                  >
                    <div className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {t.title}
                    </div>
                    <div className="mt-0.5 text-[9px]" style={{ color: 'var(--text-muted)' }}>
                      {t.desc}
                    </div>
                  </button>
                ))}
              </div>
            ) : null}

            <div ref={scrollRef} className="mt-2 flex-1 min-h-0 overflow-auto pr-1">
              <div ref={msgContentRef} className="space-y-1.5">
              {/* 向上滚动加载指示器 */}
              {hasMoreMessages ? (
                <div className="flex justify-center py-2">
                  <button
                    type="button"
                    className="text-[10px] px-3 py-1 rounded-full transition-colors hover:bg-white/10"
                    style={{ color: 'var(--text-muted)', border: '1px solid rgba(255,255,255,0.1)' }}
                    onClick={() => void loadOlderMessages()}
                  >
                    {loadingMoreRef.current ? '加载中…' : '加载更早的消息'}
                  </button>
                </div>
              ) : null}
              {messages.map((m) => (
                <ChatMessageItem
                  key={m.id}
                  msg={m}
                  allMessages={messages}
                  canvas={canvas}
                  sizeToAspectMap={sizeToAspectMap}
                  onPreview={handleMsgPreview}
                  onRetry={handleMsgRetry}
                />
              ))}
              <div ref={bottomRef} />
              </div>
            </div>

            {error ? (
              <div className="mt-2 text-[10px]" style={{ color: 'rgba(239,68,68,0.95)' }}>
                {error}
              </div>
            ) : null}

            <div
              ref={inputPanelRef}
              className="mt-2 rounded-[12px] p-2 relative shrink-0"
              style={{
                ...glassTooltip,
                border: directPrompt ? '1px solid var(--border-subtle)' : '1px solid rgba(251,146,60,0.55)',
                background: directPrompt ? 'rgba(20,20,24,0.72)' : 'rgba(251,146,60,0.06)',
                boxShadow: undefined,
              }}
            >
              {/* 若直连被关闭（auto/解析模式）：做明显提示，避免用户误以为"直连默认开启" */}
              {!directPrompt ? (
                <div
                  className="absolute z-30 inline-flex items-center gap-1 rounded-full px-2 h-5 text-[10px] font-extrabold tracking-wide"
                  style={{
                    left: 12,
                    top: -10,
                    background: 'rgba(251,146,60,0.16)',
                    border: '1px solid rgba(251,146,60,0.42)',
                    color: 'rgba(251,146,60,0.95)',
                    boxShadow: '0 10px 28px rgba(0,0,0,0.35)',
                    pointerEvents: 'none',
                  }}
                >
                  <Sparkles size={12} className="shrink-0" />
                  AUTO
                </div>
              ) : null}

              {/* 两阶段选择：待确认计数提示 */}
              {pendingChipKeys.size > 0 ? (
                <div
                  className="absolute z-30 inline-flex items-center gap-1 rounded-full px-2 h-5 text-[10px] font-medium"
                  style={{
                    right: 12,
                    top: -10,
                    background: 'rgba(156, 163, 175, 0.16)',
                    border: '1px solid rgba(156, 163, 175, 0.42)',
                    color: 'rgba(156, 163, 175, 1)',
                    boxShadow: '0 10px 28px rgba(0,0,0,0.35)',
                  }}
                >
                  <span>待确认 {pendingChipKeys.size} 张</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      // 清除按钮：同时清除四个球和钩子
                      selectionManagerRef.current?.clear();
                    }}
                    style={{
                      marginLeft: 4,
                      padding: '1px 4px',
                      fontSize: 9,
                      background: 'rgba(156, 163, 175, 0.25)',
                      border: '1px solid rgba(156, 163, 175, 0.4)',
                      borderRadius: 3,
                      color: 'rgba(156, 163, 175, 1)',
                      cursor: 'pointer',
                    }}
                  >
                    清除
                  </button>
                </div>
              ) : null}

              {/* 两阶段选择富文本编辑器 - 内置容器点击确认 pending chips
                  注：已删除老代码的 selectedImagesForComposer chip 显示区域，
                  现在完全由 TwoPhaseRichComposer 内部管理 chip 显示 */}
              <TwoPhaseRichComposer
                ref={richComposerRef}
                placeholder="请输入你的设计需求（Enter 发送，Shift+Enter 换行）"
                imageOptions={imageOptions}
                onChange={(text) => {
                  activeComposerRef.current = 'right';
                  setInput(text);
                }}
                onSubmit={() => {
                  // IME 合成输入时不触发发送
                  if (composingRef.current) return false;
                  void onSendRich();
                  return true;
                }}
                onPasteImage={(file) => {
                  // 粘贴图片到文本框时，上传到画板（与画板粘贴行为一致）
                  const now = Date.now();
                  const type = (file.type || 'image/png').toLowerCase();
                  const ext = type.includes('png') ? 'png' : type.includes('jpeg') || type.includes('jpg') ? 'jpg' : type.includes('webp') ? 'webp' : 'png';
                  const name = (file.name && file.name.trim()) ? file.name : `clipboard_${now}.${ext}`;
                  const normalizedFile = new File([file], name, { type });
                  void onUploadImages([normalizedFile], { mode: 'add' });
                  return true;
                }}
                onPendingKeysChange={handlePendingKeysChange}
                style={{
                  paddingTop: composerMetaPadTop,
                }}
                minHeight={MIN_TA_HEIGHT}
                maxHeight={120}
              />

              {mentionOpen ? (
                <div
                  className="absolute left-2 right-2 z-30 rounded-[14px] overflow-hidden"
                  style={{
                    ...glassTooltip,
                    bottom: 56, // 让出底部工具条高度，避免挤压
                    border: '1px solid rgba(255,255,255,0.12)',
                    background: 'rgba(0,0,0,0.32)',
                    boxShadow: '0 24px 90px rgba(0,0,0,0.65)',
                  }}
                >
                  <div className="px-3 py-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    @ 提示（输入 @model / @vision / @ascii）
                  </div>
                  <div className="max-h-[220px] overflow-auto">
                    {(() => {
                      const q = mentionQuery || '';
                      const showModel = q === '' || 'model'.startsWith(q) || q.startsWith('m');
                      const showVision = q === '' || 'vision'.startsWith(q) || q.startsWith('v');
                      const showAscii = q === '' || 'ascii'.startsWith(q) || q.startsWith('a');
                      const visionModels: ModelWithSource[] = []; // 视觉模型通过 Gateway 自动调度，暂不支持 @mention 选择
                      const imageModels = enabledImageModels;
                      return (
                        <div className="p-2 space-y-2">
                          {showModel ? (
                            <div>
                              <div className="px-2 py-1 text-[11px]" style={{ color: 'rgba(255,255,255,0.55)' }}>
                                生图模型（强制）
                              </div>
                              {imageModels.length === 0 ? (
                                <div className="px-2 py-1.5 text-[12px]" style={{ color: 'rgba(255,255,255,0.65)' }}>
                                  暂无启用的 isImageGen 模型（可在“模型管理”设置）
                                </div>
                              ) : (
                                imageModels.map((m) => (
                                    <button
                                      key={m.id}
                                      type="button"
                                      className="w-full text-left rounded-[10px] px-2 py-1.5 hover:bg-white/5"
                                      style={{ color: 'var(--text-primary)' }}
                                      onClick={() => {
                                        replaceMentionAtCursor(`@model(${m.name || m.modelName}) `);
                                      }}
                                    >
                                      <div className="text-[13px] font-semibold truncate">{m.name || m.modelName}</div>
                                      <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                        插入 @model(...) 标记（将覆盖模型偏好）
                                      </div>
                                    </button>
                                  ))
                              )}
                            </div>
                          ) : null}

                          {showVision ? (
                            <div>
                              <div className="px-2 py-1 text-[11px]" style={{ color: 'rgba(255,255,255,0.55)' }}>
                                视觉模型
                              </div>
                              {visionModels.length === 0 ? (
                                <div className="px-2 py-1.5 text-[12px]" style={{ color: 'rgba(255,255,255,0.65)' }}>
                                  暂无启用的 isVision 模型（可在“模型管理”设置）
                                </div>
                              ) : (
                                visionModels.map((m) => (
                                  <button
                                    key={m.id}
                                    type="button"
                                    className="w-full text-left rounded-[10px] px-2 py-1.5 hover:bg-white/5"
                                    style={{ color: 'var(--text-primary)' }}
                                    onClick={() => {
                                      replaceMentionAtCursor(`@vision(${m.name || m.modelName}) `);
                                    }}
                                  >
                                    <div className="text-[13px] font-semibold truncate">{m.name || m.modelName}</div>
                                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                      插入 @vision(...) 标记
                                    </div>
                                  </button>
                                ))
                              )}
                            </div>
                          ) : null}

                          {showAscii ? (
                            <div>
                              <div className="px-2 py-1 text-[11px]" style={{ color: 'rgba(255,255,255,0.55)' }}>
                                字符画
                              </div>
                              <button
                                type="button"
                                className="w-full text-left rounded-[10px] px-2 py-1.5 hover:bg-white/5"
                                style={{ color: 'var(--text-primary)' }}
                                onClick={() => {
                                  setMentionOpen(false);
                                  setMentionQuery('');
                                  setAsciiOpen(true);
                                }}
                              >
                                <div className="text-[13px] font-semibold">@ascii（生成字符画并插入）</div>
                                <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                  等宽字体预览，避免字符漂移
                                </div>
                              </button>
                            </div>
                          ) : null}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              ) : null}

              <div className="mt-1 flex items-center justify-between gap-1.5">
                {/* 左侧：尺寸/比例选择器 */}
                <div ref={sizeSelectorRef} className="relative flex items-center gap-1.5">
                  <button
                    type="button"
                    className="h-7 px-2 rounded-full inline-flex items-center gap-1"
                    style={{
                      border: '1px solid rgba(255,255,255,0.10)',
                      background: sizeSelectorOpen ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.04)',
                      color: 'var(--text-secondary)',
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                    aria-label="尺寸比例"
                    title="选择分辨率和比例"
                    onClick={() => setSizeSelectorOpen((v) => !v)}
                  >
                    {(() => {
                      const size = composerSize ?? autoSizeForSelectedImage ?? '1024x1024';
                      const tier = detectTierFromSize(size);
                      // 优先使用后端返回的 aspectRatio，避免 GCD 计算偏差（如 1344x768 应该是 16:9 而不是 7:4）
                      const aspect = sizeToAspectMap.get(size.toLowerCase()) || detectAspectFromSize(size);
                      const tierLabel = tier === '4k' ? '4K' : tier === '2k' ? '2K' : '1K';
                      return (
                        <span style={{ whiteSpace: 'nowrap' }}>{tierLabel} · {aspect || '1:1'}</span>
                      );
                    })()}
                    <span className="text-[9px]" style={{ color: 'rgba(255,255,255,0.55)' }}>▾</span>
                  </button>

                  {/* 尺寸/比例 Popover */}
                  {sizeSelectorOpen ? (
                      <div
                        className="absolute bottom-full right-0 mb-2 z-50 rounded-[14px] p-3"
                        style={{
                          ...glassPopoverCompact,
                          width: 260,
                          background: 'rgba(32, 32, 36, 0.96)',
                          border: '1px solid rgba(255, 255, 255, 0.18)',
                          boxShadow: '0 18px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255, 255, 255, 0.08) inset',
                        }}
                      >
                        {/* 分辨率（档位）- 只显示模型支持的分辨率 */}
                        {(() => {
                          const availableTiers = (['1k', '2k', '4k'] as const).filter((t) => ratiosByResolution[t].size > 0);
                          if (availableTiers.length === 0) return null;
                          return (
                            <>
                              <div className="text-[11px] font-semibold mb-1.5" style={{ color: 'rgba(255,255,255,0.55)' }}>分辨率</div>
                              <div className="flex gap-1.5 mb-3">
                                {availableTiers.map((tier) => {
                                  const currentSize = composerSize ?? autoSizeForSelectedImage ?? '1024x1024';
                                  const currentTier = detectTierFromSize(currentSize);
                                  const isSelected = currentTier === tier;
                                  const label = tier === '4k' ? '4K' : tier === '2k' ? '2K' : '1K';
                                  return (
                                    <button
                                      key={tier}
                                      type="button"
                                      className="h-7 flex-1 rounded-[8px] text-[12px] font-semibold transition-colors"
                                      style={{
                                        background: isSelected ? 'rgba(99, 102, 241, 0.22)' : 'rgba(255,255,255,0.08)',
                                        border: isSelected ? '1px solid rgba(99, 102, 241, 0.6)' : '1px solid rgba(255,255,255,0.14)',
                                        color: isSelected ? 'rgba(129, 140, 248, 1)' : 'rgba(255,255,255,0.88)',
                                      }}
                                      onClick={() => {
                                        // 优先使用后端返回的 aspectRatio
                                        const currentAspect = sizeToAspectMap.get(currentSize.toLowerCase()) || detectAspectFromSize(currentSize);
                                        const targetOpt = ratiosByResolution[tier].get(currentAspect);
                                        if (targetOpt) {
                                          composerSizeAutoRef.current = false;
                                          setComposerSize(targetOpt.size);
                                        } else {
                                          // 当前比例在目标分辨率不存在，选第一个
                                          const first = ratiosByResolution[tier].values().next().value;
                                          if (first) {
                                            composerSizeAutoRef.current = false;
                                            setComposerSize(first.size);
                                          }
                                        }
                                      }}
                                    >
                                      {label}
                                    </button>
                                  );
                                })}
                              </div>
                            </>
                          );
                        })()}

                        {/* 比例 */}
                        <div className="text-[11px] font-semibold mb-1.5" style={{ color: 'rgba(255,255,255,0.55)' }}>Size</div>
                        <div className="grid grid-cols-4 gap-1.5">
                          {(() => {
                            const currentSize = composerSize ?? autoSizeForSelectedImage ?? '1024x1024';
                            const currentTier = detectTierFromSize(currentSize);
                            // 优先使用后端返回的 aspectRatio
                            const currentAspect = sizeToAspectMap.get(currentSize.toLowerCase()) || detectAspectFromSize(currentSize);
                            const ratios = ratiosByResolution[currentTier];

                            return Array.from(ratios.entries()).map(([ratio, opt]) => {
                              const isSelected = ratio === currentAspect;
                              const [rw, rh] = ratio.includes(':') ? ratio.split(':').map(Number) : [1, 1];
                              const aspectVal = rw && rh ? rw / rh : 1;
                              const iconW = aspectVal >= 1 ? 24 : Math.round(24 * aspectVal);
                              const iconH = aspectVal <= 1 ? 24 : Math.round(24 / aspectVal);
                              return (
                                <button
                                  key={ratio}
                                  type="button"
                                  className="flex flex-col items-center justify-center gap-1 py-2 rounded-[8px] transition-colors"
                                  style={{
                                    background: isSelected ? 'rgba(99, 102, 241, 0.22)' : 'rgba(255,255,255,0.08)',
                                    border: isSelected ? '1px solid rgba(99, 102, 241, 0.6)' : '1px solid rgba(255,255,255,0.14)',
                                    color: isSelected ? 'rgba(129, 140, 248, 1)' : 'rgba(255,255,255,0.88)',
                                  }}
                                  onClick={() => {
                                    composerSizeAutoRef.current = false;
                                    setComposerSize(opt.size);
                                    setSizeSelectorOpen(false);
                                  }}
                                >
                                  <div style={{ width: iconW, height: iconH, border: '1.5px solid currentColor', borderRadius: 3, opacity: 0.7 }} />
                                  <span className="text-[10px] font-medium">{ratio}</span>
                                </button>
                              );
                            });
                          })()}
                        </div>
                      </div>
                  ) : null}
                </div>

                {/* 右侧：模型偏好 + 水印 */}
                <div className="flex items-center gap-1.5">
                  {/* 模型名称 + 模型偏好下拉菜单 */}
                  <DropdownMenu.Root open={modelPrefOpen} onOpenChange={setModelPrefOpen}>
                    <DropdownMenu.Trigger asChild>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded-full px-2 h-7 text-[11px] font-medium truncate max-w-[140px] cursor-pointer hover:opacity-80 transition-opacity"
                        style={{
                          background: 'rgba(99, 102, 241, 0.12)',
                          border: '1px solid rgba(99, 102, 241, 0.35)',
                          color: 'rgba(129, 140, 248, 0.95)',
                        }}
                        aria-label="模型偏好"
                        title={effectiveModel ? `${effectiveModel.name || effectiveModel.modelName || ''} - 点击切换模型` : '选择模型'}
                      >
                        <Sparkles size={10} className="shrink-0" />
                        <span className="truncate">{effectiveModel?.name || '选择模型'}</span>
                        <span className="text-[8px] ml-0.5" style={{ opacity: 0.6 }}>▾</span>
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        side="top"
                        align="end"
                        sideOffset={10}
                        className="z-50 rounded-[16px] p-3"
                        style={{
                          width: 360,
                          maxWidth: 'min(92vw, 360px)',
                          ...glassPanel,
                        }}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                              模型偏好
                            </div>
                            <div className="mt-0.5 text-[12px] truncate" style={{ color: 'var(--text-muted)' }}>
                              仅影响本页生图；候选项以启用 isImageGen 为准
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <span className="text-[12px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
                              自动
                            </span>
                            <Switch checked={modelPrefAuto} onCheckedChange={(v) => setModelPrefAuto(v)} ariaLabel="自动选择模型" />
                          </div>
                        </div>

                        <div className="mt-3 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                              提示词模式
                            </div>
                            <div className="mt-0.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                              直连开启后不再调用解析接口，输入原样作为 prompt
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="text-[12px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
                              直连
                            </span>
                            <Switch
                              checked={directPrompt}
                              onCheckedChange={() => {
                                // 需求变更：固定开启（若未来需要恢复可配置，再改回可切换）
                                setDirectPrompt(true);
                              }}
                              disabled
                              ariaLabel="直连模式（固定开启）"
                            />
                          </div>
                        </div>

                        <div className="mt-3 max-h-[360px] overflow-auto pr-1">
                          {enabledImageModels.length === 0 ? (
                            <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
                              暂无启用的 isImageGen 模型（可在“模型管理”开启）
                            </div>
                          ) : (
                            <div className="space-y-2">
                              {enabledImageModels.map((m) => {
                                  const picked = (!modelPrefAuto && modelPrefModelId === m.id) || (modelPrefAuto && serverDefaultModel?.id === m.id);
                                  return (
                                    <button
                                      key={m.id}
                                      type="button"
                                      className="w-full text-left rounded-[16px] px-3 py-2 hover:bg-white/5 transition-colors"
                                      style={{
                                        border: picked ? '1px solid rgba(250,204,21,0.35)' : '1px solid rgba(255,255,255,0.10)',
                                        background: 'rgba(255,255,255,0.02)',
                                      }}
                                      onClick={() => {
                                        setModelPrefAuto(false);
                                        setModelPrefModelId(m.id);
                                        setModelPrefOpen(false);
                                      }}
                                    >
                                      <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                          <div className="text-[14px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                                            {m.name || m.modelName}
                                          </div>
                                        </div>
                                        <div className="shrink-0">
                                          <span
                                            className="inline-flex items-center justify-center h-8 w-8 rounded-full"
                                            style={{
                                              background: picked ? 'rgba(250,204,21,0.18)' : 'rgba(255,255,255,0.04)',
                                              border: picked ? '1px solid rgba(250,204,21,0.35)' : '1px solid rgba(255,255,255,0.10)',
                                              color: picked ? 'rgba(250,204,21,0.95)' : 'rgba(255,255,255,0.28)',
                                            }}
                                            aria-label={picked ? '已选择' : '未选择'}
                                          >
                                            <Check size={18} />
                                          </span>
                                        </div>
                                      </div>
                                    </button>
                                  );
                                })}
                            </div>
                          )}
                        </div>

                                              </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>

                  {/* 设置按钮 */}
                  <button
                    type="button"
                    className="h-7 w-7 rounded-full inline-flex items-center justify-center"
                    style={{
                      border: watermarkStatus.enabled ? '1px solid rgba(245, 158, 11, 0.35)' : '1px solid rgba(255,255,255,0.10)',
                      background: watermarkStatus.enabled ? 'rgba(245, 158, 11, 0.12)' : 'rgba(255,255,255,0.04)',
                      color: watermarkStatus.enabled ? 'rgba(245, 158, 11, 0.85)' : 'var(--text-secondary)',
                    }}
                    aria-label="设置"
                    title={watermarkStatus.enabled ? `设置 (水印: ${watermarkStatus.name || '已启用'})` : '设置'}
                    onClick={() => configDialogRef.current?.open()}
                  >
                    <Settings size={14} />
                  </button>

                  {(runningCount > 0 || pendingCount > 0) ? (
                    <div
                      className="text-[9px] px-1.5 h-7 inline-flex items-center rounded-full"
                      style={{
                        border: '1px solid rgba(255,255,255,0.10)',
                        background: 'rgba(0,0,0,0.18)',
                        color: 'rgba(255,255,255,0.60)',
                      }}
                      title="生成队列：运行中 / 排队"
                      aria-label="生成队列"
                    >
                      {runningCount}/{pendingCount}
                    </div>
                  ) : null}

                  {/* 发送按钮 */}
                  <button
                    type="button"
                    className="h-7 w-7 rounded-full inline-flex items-center justify-center transition-all"
                    style={{
                      background: 'rgba(99, 102, 241, 0.85)',
                      border: '1px solid rgba(99, 102, 241, 0.65)',
                      color: 'rgba(255, 255, 255, 0.95)',
                      boxShadow: '0 2px 8px rgba(99, 102, 241, 0.3)',
                    }}
                    aria-label="发送"
                    title="发送（Enter）"
                    onClick={() => void onSendRich()}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(99, 102, 241, 1)';
                      e.currentTarget.style.boxShadow = '0 4px 12px rgba(99, 102, 241, 0.4)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(99, 102, 241, 0.85)';
                      e.currentTarget.style.boxShadow = '0 2px 8px rgba(99, 102, 241, 0.3)';
                    }}
                  >
                    <Send size={14} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 快捷操作栏 + 快捷编辑输入框 已移至 worldUiRef 层 */}

      {/* 图片右键菜单 */}
      {imgContextMenu.open ? (
        <div
          className="fixed inset-0 z-[9999]"
          onClick={() => setImgContextMenu((p) => ({ ...p, open: false }))}
          onContextMenu={(e) => {
            e.preventDefault();
            setImgContextMenu((p) => ({ ...p, open: false }));
          }}
        >
          <div
            className="absolute rounded-[12px] py-1.5 min-w-[170px] shadow-2xl"
            style={{
              ...glassTooltip,
              left: imgContextMenu.x,
              top: imgContextMenu.y,
              background: 'rgba(32,32,38,0.96)',
              border: '1px solid rgba(255,255,255,0.12)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="w-full flex items-center gap-2.5 px-3 py-2 text-[14px] font-medium hover:bg-white/8 transition-colors"
              style={{ color: 'rgba(255,255,255,0.88)' }}
              onClick={() => {
                void downloadImage(imgContextMenu.src, imgContextMenu.prompt || 'image');
                setImgContextMenu((p) => ({ ...p, open: false }));
              }}
            >
              <Download size={16} />
              下载图片
            </button>
            {imgContextMenu.src ? (
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-2 text-[14px] font-medium hover:bg-white/8 transition-colors"
                style={{ color: 'rgba(255,255,255,0.88)' }}
                onClick={() => {
                  void copyImageToClipboard(imgContextMenu.src);
                  setImgContextMenu((p) => ({ ...p, open: false }));
                }}
              >
                <Clipboard size={16} />
                复制到剪贴板
              </button>
            ) : null}
            <button
              type="button"
              className="w-full flex items-center gap-2.5 px-3 py-2 text-[14px] font-medium hover:bg-white/8 transition-colors"
              style={{ color: 'rgba(255,255,255,0.88)' }}
              onClick={() => {
                void copyToClipboard(imgContextMenu.prompt || '');
                setImgContextMenu((p) => ({ ...p, open: false }));
              }}
            >
              <Copy size={16} />
              复制提示词
            </button>
            {imgContextMenu.src ? (
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-2 text-[14px] font-medium hover:bg-white/8 transition-colors"
                style={{ color: 'rgba(255,255,255,0.88)' }}
                onClick={() => {
                  setPreview({ open: true, src: imgContextMenu.src, prompt: imgContextMenu.prompt });
                  setImgContextMenu((p) => ({ ...p, open: false }));
                }}
              >
                <Maximize2 size={16} />
                预览大图
              </button>
            ) : null}

            {/* 导出子菜单 */}
            {imgContextMenu.src ? (
              <>
                <div className="my-1.5 mx-2 h-px" style={{ background: 'rgba(255,255,255,0.12)' }} />
                <div className="group/export relative">
                  <button
                    type="button"
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-[14px] font-medium hover:bg-white/8 transition-colors"
                    style={{ color: 'rgba(255,255,255,0.88)' }}
                  >
                    <Share size={16} />
                    导出
                    <ChevronRight size={14} className="ml-auto opacity-50" />
                  </button>
                  <div
                    className="absolute left-full top-0 ml-1 rounded-[10px] py-1 min-w-[120px] shadow-2xl opacity-0 pointer-events-none group-hover/export:opacity-100 group-hover/export:pointer-events-auto transition-opacity duration-150"
                    style={{
                      ...glassTooltip,
                      background: 'rgba(32,32,38,0.96)',
                      border: '1px solid rgba(255,255,255,0.12)',
                    }}
                  >
                    <button
                      type="button"
                      className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium hover:bg-white/8 transition-colors"
                      style={{ color: 'rgba(255,255,255,0.88)' }}
                      onClick={() => {
                        void exportImageAs(imgContextMenu.src, imgContextMenu.prompt || 'image', 'png');
                        setImgContextMenu((p) => ({ ...p, open: false }));
                      }}
                    >
                      <FileImage size={14} />
                      PNG
                    </button>
                    <button
                      type="button"
                      className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium hover:bg-white/8 transition-colors"
                      style={{ color: 'rgba(255,255,255,0.88)' }}
                      onClick={() => {
                        void exportImageAs(imgContextMenu.src, imgContextMenu.prompt || 'image', 'jpg');
                        setImgContextMenu((p) => ({ ...p, open: false }));
                      }}
                    >
                      <FileImage size={14} />
                      JPG
                    </button>
                    <button
                      type="button"
                      className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium hover:bg-white/8 transition-colors"
                      style={{ color: 'rgba(255,255,255,0.88)' }}
                      onClick={() => {
                        void exportImageAs(imgContextMenu.src, imgContextMenu.prompt || 'image', 'svg');
                        setImgContextMenu((p) => ({ ...p, open: false }));
                      }}
                    >
                      <FileImage size={14} />
                      SVG
                    </button>
                  </div>
                </div>
              </>
            ) : null}

            {/* 分隔线 */}
            <div className="my-1.5 mx-2 h-px" style={{ background: 'rgba(255,255,255,0.12)' }} />

            {/* 图层操作 */}
            <button
              type="button"
              className="w-full flex items-center gap-2.5 px-3 py-2 text-[14px] font-medium hover:bg-white/8 transition-colors"
              style={{ color: 'rgba(255,255,255,0.88)' }}
              onClick={() => {
                layerBringToFront();
                setImgContextMenu((p) => ({ ...p, open: false }));
              }}
            >
              <ArrowUpToLine size={16} />
              置于顶层
              <span className="ml-auto text-[11px] opacity-50">Cmd+Shift+]</span>
            </button>
            <button
              type="button"
              className="w-full flex items-center gap-2.5 px-3 py-2 text-[14px] font-medium hover:bg-white/8 transition-colors"
              style={{ color: 'rgba(255,255,255,0.88)' }}
              onClick={() => {
                layerMoveUp();
                setImgContextMenu((p) => ({ ...p, open: false }));
              }}
            >
              <ChevronUp size={16} />
              上移一层
              <span className="ml-auto text-[11px] opacity-50">Cmd+]</span>
            </button>
            <button
              type="button"
              className="w-full flex items-center gap-2.5 px-3 py-2 text-[14px] font-medium hover:bg-white/8 transition-colors"
              style={{ color: 'rgba(255,255,255,0.88)' }}
              onClick={() => {
                layerMoveDown();
                setImgContextMenu((p) => ({ ...p, open: false }));
              }}
            >
              <ChevronDown size={16} />
              下移一层
              <span className="ml-auto text-[11px] opacity-50">Cmd+[</span>
            </button>
            <button
              type="button"
              className="w-full flex items-center gap-2.5 px-3 py-2 text-[14px] font-medium hover:bg-white/8 transition-colors"
              style={{ color: 'rgba(255,255,255,0.88)' }}
              onClick={() => {
                layerSendToBack();
                setImgContextMenu((p) => ({ ...p, open: false }));
              }}
            >
              <ArrowDownToLine size={16} />
              置于底层
              <span className="ml-auto text-[11px] opacity-50">Cmd+Shift+[</span>
            </button>
          </div>
        </div>
      ) : null}

      <Dialog
        open={preview.open}
        onOpenChange={(open) => setPreview((p) => ({ ...p, open }))}
        title="图片预览"
        description="完整显示（不裁切）"
        maxWidth={1100}
        contentStyle={{ height: 'min(90vh, 880px)' }}
        content={
          <div className="h-full min-h-0 flex flex-col">
            <div className="flex items-center justify-end gap-2 pb-2">
              <Button variant="secondary" size="sm" onClick={() => void downloadImage(preview.src, preview.prompt || 'image')} disabled={!preview.src}>
                <Download size={16} />
                下载
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void copyToClipboard(preview.prompt || '')} disabled={!preview.prompt}>
                <Copy size={16} />
                复制提示词
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void copyToClipboard(preview.src || '')} disabled={!preview.src} title="复制图片 dataURL（或原始 URL）">
                <Copy size={16} />
                复制链接
              </Button>
              {preview.runId ? (
                <Button variant="secondary" size="sm" onClick={() => void copyToClipboard(preview.runId || '')} title="复制请求ID（用于后台日志排查）">
                  <Copy size={16} />
                  复制请求ID
                </Button>
              ) : null}
            </div>

            <div className="flex-1 min-h-0 overflow-auto rounded-[14px] p-3" style={{ border: '1px solid rgba(255,255,255,0.10)' }}>
              {preview.src ? (
                <div className="w-full h-full flex items-center justify-center">
                  <img
                    src={preview.src}
                    alt={preview.prompt}
                    className="block"
                    style={{ maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', objectFit: 'contain' }}
                  />
                </div>
              ) : (
                <div className="h-full min-h-[220px] flex items-center justify-center text-sm" style={{ color: 'var(--text-muted)' }}>
                  （无图片）
                </div>
              )}
            </div>
          </div>
        }
      />

      <Dialog
        open={asciiOpen}
        onOpenChange={(open) => setAsciiOpen(open)}
        title="字符画"
        description="等宽字体预览；确认后会插入到输入框当前位置"
        maxWidth={920}
        contentStyle={{ height: 'min(86vh, 760px)' }}
        content={
          <div className="h-full min-h-0 flex flex-col gap-3">
            <textarea
              value={asciiSource}
              onChange={(e) => setAsciiSource(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
                  e.preventDefault();
                  e.currentTarget.select();
                }
              }}
              className="w-full min-h-[96px] resize-none rounded-[14px] px-3 py-2.5 text-sm outline-none"
              style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.10)', color: 'var(--text-primary)' }}
              placeholder="输入要生成字符画的内容（建议英文/数字；中文也可尝试但可能宽度不一致）"
            />
            <div
              className="flex-1 min-h-0 overflow-auto rounded-[14px] p-3"
              style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.16)' }}
            >
              <pre
                className="text-[12px] leading-tight whitespace-pre"
                style={{
                  color: 'rgba(255,255,255,0.86)',
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                  fontVariantLigatures: 'none',
                }}
              >
                {makeAsciiArt(asciiSource || 'ASCII')}
              </pre>
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" onClick={() => setAsciiOpen(false)}>
                取消
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  const art = makeAsciiArt(asciiSource || 'ASCII');
                  if (mentionAtPos != null) {
                    replaceMentionAtCursor(`@ascii\n${art}\n`);
                  } else {
                    insertAtCursor(`\n@ascii\n${art}\n`);
                  }
                  setAsciiOpen(false);
                  setAsciiSource('');
                }}
              >
                插入
              </Button>
            </div>
          </div>
        }
      />

      <Dialog
        open={textEdit.open}
        onOpenChange={(open) => setTextEdit((p) => ({ ...p, open }))}
        title="编辑文字"
        description="确认后会写入画布文本元素"
        maxWidth={640}
        content={
          <div className="h-full min-h-0 flex flex-col gap-3">
            <textarea
              value={textEdit.value}
              onChange={(e) => setTextEdit((p) => ({ ...p, value: e.target.value }))}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
                  e.preventDefault();
                  e.currentTarget.select();
                  return;
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                }
              }}
              className="w-full min-h-[120px] resize-none rounded-[14px] px-3 py-2.5 text-sm outline-none"
              style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.10)', color: 'var(--text-primary)' }}
              placeholder="输入文本（Enter=确认，Shift+Enter=换行）"
            />
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setTextEdit({ open: false, key: '', value: '' });
                }}
              >
                取消
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  const key = textEdit.key;
                  if (!key) {
                    setTextEdit({ open: false, key: '', value: '' });
                    return;
                  }
                  const val = String(textEdit.value ?? '').trim() || 'Text';
                  setCanvas((prev) =>
                    prev.map((it) => (it.key === key ? { ...it, kind: 'text', text: val, prompt: val } : it))
                  );
                  setTextEdit({ open: false, key: '', value: '' });
                }}
              >
                确认
              </Button>
            </div>
          </div>
        }
      />

      <Dialog
        open={showLogs}
        onOpenChange={setShowLogs}
        title="LLM 调用日志 (Visual Agent)"
        maxWidth={1200}
        contentStyle={{ height: '80vh' }}
        content={
          <LlmLogsPanel
            embedded
            defaultAppKey="visual-agent"
            customApis={{
              getLogs: getVisualAgentLogsReal,
              getMeta: getVisualAgentLogsMetaReal,
              getDetail: getVisualAgentLogDetailReal,
            }}
          />
        }
      />
      </GlassCard>

      {/* 设置对话框 - 使用通用 ConfigManagementDialogBase */}
      <ConfigManagementDialogBase
        ref={configDialogRef}
        mineTitle="配置管理"
        mineDescription="水印设置"
        maxWidth={1200}
        showColumnDividers={false}
        columns={[
          {
            key: 'watermark',
            title: '水印设置',
            filterLabel: '水印',
            titleAction: (
              <Button variant="secondary" size="xs" onClick={() => watermarkPanelRef.current?.addSpec()}>
                <Plus size={14} />
                新增配置
              </Button>
            ),
            renderMineContent: () => (
              <WatermarkSettingsPanel
                ref={watermarkPanelRef}
                appKey="visual-agent"
                onStatusChange={handleWatermarkStatusChange}
                hideAddButton
                cardWidth={460}
              />
            ),
            loadMarketplace: async ({ keyword, sort }) => {
              const res = await listWatermarksMarketplace({ keyword, sort });
              return res.success && res.data?.items ? res.data.items : [];
            },
            renderMarketplaceCard: (config: MarketplaceWatermarkConfig, ctx: MarketplaceCardContext) => (
              <MarketplaceWatermarkCard
                key={config.id}
                config={config}
                ctx={ctx}
                onFork={async () => {
                  const res = await forkWatermark({ id: config.id });
                  if (res.success) {
                    toast.success('下载成功，已添加到「我的」');
                    return true;
                  }
                  return false;
                }}
              />
            ),
          } as ConfigColumn<MarketplaceWatermarkConfig>,
        ]}
      />

      {/* 快捷指令管理弹窗 */}
      <QuickActionConfigPanel
        open={quickActionDialogOpen}
        onOpenChange={setQuickActionDialogOpen}
        actions={diyQuickActions}
        onChange={setDiyQuickActions}
      />

      {/* 局部重绘蒙版编辑器 */}
      {inpaintTarget && inpaintTarget.src && (
        <MaskPaintCanvas
          imageSrc={inpaintTarget.originalSrc || inpaintTarget.src}
          imageWidth={inpaintTarget.naturalW || inpaintTarget.w || 1024}
          imageHeight={inpaintTarget.naturalH || inpaintTarget.h || 1024}
          onCancel={() => setInpaintTarget(null)}
          onConfirm={async (maskDataUri) => {
            const target = inpaintTarget;
            setInpaintTarget(null);
            // 弹出提示词输入
            const desc = await systemDialog.prompt({
              title: '局部重绘',
              message: '请输入重绘区域的描述',
              placeholder: '如：将这里替换为蓝色的天空',
            });
            if (!desc?.trim()) {
              toast.error('请输入重绘描述');
              return;
            }
            void executeQuickAction(desc.trim(), target, undefined, maskDataUri, '局部重绘');
          }}
        />
      )}

      {/* 手绘板 */}
      <DrawingBoardDialog
        open={drawingBoardOpen}
        onOpenChange={setDrawingBoardOpen}
        onConfirm={async (dataUri, chatHistory, sizeHint) => {
          setDrawingBoardOpen(false);

          // 同步手绘板 AI 对话记录到消息面板（可追溯）
          if (chatHistory.length > 0) {
            const chatSummary = chatHistory.map(m => `${m.role === 'user' ? '我' : 'AI'}: ${m.content.length > 200 ? m.content.slice(0, 200) + '…' : m.content}`).join('\n');
            pushMsg('User', `[手绘板对话]\n${chatSummary}`);
          }

          // 弹出提示词输入
          const desc = await systemDialog.prompt({
            title: '草图生成',
            message: '请描述你想基于这张草图生成的图片',
            placeholder: '如：一只猫坐在窗台上，水彩风格',
          });
          if (!desc?.trim()) {
            toast.error('请输入生成描述');
            return;
          }

          const pickedModel = effectiveModel;
          if (!pickedModel) {
            toast.error('暂无可用生图模型');
            return;
          }
          const modelPoolName = pickedModel?.name || pickedModel?.modelName || '';
          const sketchUserMsg = `[手绘板生图] ${desc.trim()}`;
          pushMsg('User', sketchUserMsg);
          // 后端消息会在上传后用 COS URL 重建
          let sketchMsgForBackend = sketchUserMsg;

          // 添加草图到画布（用于展示参考）
          const sketchKey = `sketch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const near = stageCenterWorld();
          const sketchParsed = tryParseWxH(sizeHint);
          const sketchW = sketchParsed?.w ?? 640;
          const sketchH = sketchParsed?.h ?? 480;
          setCanvas(prev => [
            ...prev,
            {
              key: sketchKey,
              kind: 'image' as const,
              createdAt: Date.now(),
              prompt: `手绘草图: ${desc.trim()}`,
              src: dataUri,
              status: 'done' as const,
              syncStatus: 'pending' as const,
              syncError: null,
              w: sketchW,
              h: sketchH,
              naturalW: sketchW,
              naturalH: sketchH,
              x: near.x - sketchW / 2 - sketchW / 2 - 16,
              y: near.y - sketchH / 2,
            },
          ].slice(-60));

          // 上传草图作为资产
          const up = await uploadVisualAgentWorkspaceAsset({
            id: workspaceId,
            data: dataUri,
            prompt: `手绘草图: ${desc.trim()}`,
            width: sketchW,
            height: sketchH,
          });

          if (!up.success) {
            const msg = '草图上传失败：' + (up.error?.message || '未知错误');
            pushMsg('Assistant', buildGenErrorContent({ msg, prompt: desc.trim() }));
            return;
          }

          const assetSha256 = up.data.asset.sha256;
          const refSrc = up.data.asset.url || '';
          // 用 COS URL 重建后端消息（刷新后可直接展示草图缩略图）
          if (refSrc) {
            sketchMsgForBackend = `[手绘板生图] [IMG:${refSrc}|手绘草图] ${desc.trim()}`;
          }
          setCanvas(prev =>
            prev.map(x =>
              x.key === sketchKey
                ? { ...x, assetId: up.data.asset.id, sha256: up.data.asset.sha256, src: refSrc || x.src, syncStatus: 'synced' as const, syncError: null }
                : x
            )
          );

          // 生成占位
          const genKey = `sketch_gen_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const resolvedSize = sizeHint || imageGenSize;
          const parsedSize = tryParseWxH(resolvedSize);
          const genW = parsedSize?.w ?? 1024;
          const genH = parsedSize?.h ?? 1024;

          setCanvas(prev => [
            ...prev,
            {
              key: genKey,
              kind: 'image' as const,
              createdAt: Date.now(),
              prompt: desc.trim(),
              src: '',
              status: 'running' as const,
              w: genW,
              h: genH,
              x: near.x - genW / 2 + genW / 2 + 16,
              y: near.y - genH / 2,
            },
          ].slice(-60));
          setSelectionWithoutChip([genKey]);

          // 创建生图任务
          try {
            const runRes = await createWorkspaceImageGenRun({
              id: workspaceId,
              input: {
                prompt: desc.trim(),
                targetKey: genKey,
                ...(pickedModel.id.startsWith('pool_')
                  ? { platformId: pickedModel.platformId, modelId: pickedModel.modelName }
                  : { configModelId: pickedModel.id }),
                size: resolvedSize,
                responseFormat: 'url',
                imageRefs: [
                  {
                    refId: 1,
                    assetSha256,
                    url: refSrc,
                    label: '手绘草图',
                  },
                ],
                userMessageContent: sketchMsgForBackend,
              },
              idempotencyKey: `sketchRun_${workspaceId}_${genKey}`,
            });

            if (!runRes.success) {
              const msg = runRes.error?.message || '草图生图失败';
              setCanvas(prev => prev.map(x => x.key === genKey ? { ...x, status: 'error' as const } : x));
              pushMsg('Assistant', buildGenErrorContent({ msg, refSrc, prompt: desc.trim() }));
              return;
            }

            // 订阅 Run 事件流
            const runId = runRes.data.runId;
            setCanvas(prev => prev.map(x => x.key === genKey ? { ...x, runId } : x));
            const sketchAc = new AbortController();
            void streamImageGenRunWithRetry({
              runId,
              signal: sketchAc.signal,
              onEvent: (evt) => {
                const evData = String(evt.data ?? '').trim();
                if (!evData) return;
                let obj: unknown = null;
                try { obj = JSON.parse(evData); } catch { return; }
                const o = obj as ImageGenRunStreamPayload;
                const t = String(o.type ?? '');
                if (t === 'imageDone') {
                  const assetRaw = o.asset ?? null;
                  const asset = assetRaw
                    ? { id: String(assetRaw.id ?? ''), sha256: String(assetRaw.sha256 ?? ''), url: String(assetRaw.url ?? ''), originalUrl: String(assetRaw.originalUrl ?? ''), originalSha256: String(assetRaw.originalSha256 ?? '') }
                    : null;
                  const u = String(asset?.url ?? o.url ?? '');
                  const originalU = String(asset?.originalUrl || o.originalUrl || u || '');
                  const originalSha = String(asset?.originalSha256 || o.originalSha256 || asset?.sha256 || '');
                  if (!u) return;
                  setCanvas(prev => prev.map(x =>
                    x.key === genKey
                      ? { ...x, kind: 'image' as const, status: 'done' as const, src: u, originalSrc: originalU, assetId: (asset?.id || '').trim() || x.assetId, sha256: (asset?.sha256 || '').trim() || x.sha256, originalSha256: originalSha.trim() || x.originalSha256, syncStatus: 'synced' as const, syncError: null }
                      : x
                  ));
                  pushMsg('Assistant', buildGenDoneContent({ src: u, refSrc, prompt: desc.trim(), runId, modelPool: modelPoolName }));
                } else if (t === 'imageError' || t === 'error') {
                  const msg = String(o.errorMessage ?? '草图生图失败');
                  setCanvas(prev => prev.map(x => x.key === genKey ? { ...x, status: 'error' as const, errorMessage: msg } : x));
                  pushMsg('Assistant', buildGenErrorContent({ msg, refSrc, prompt: desc.trim(), runId, modelPool: modelPoolName }));
                }
              },
            }).then(() => {
              setCanvas(prev => {
                const item = prev.find(x => x.key === genKey);
                if (item && item.status === 'running') {
                  pushMsg('Assistant', buildGenErrorContent({ msg: '生成超时或连接中断，请重试', refSrc, prompt: desc.trim(), modelPool: modelPoolName }));
                }
                return prev.map(x =>
                  x.key === genKey && x.status === 'running'
                    ? { ...x, status: 'error' as const, errorMessage: '生成超时或连接中断，请重试' }
                    : x
                );
              });
            });
          } catch (e) {
            const msg = (e as Error).message || '草图生图异常';
            setCanvas(prev => prev.map(x => x.key === genKey ? { ...x, status: 'error' as const } : x));
            pushMsg('Assistant', buildGenErrorContent({ msg, refSrc, prompt: desc.trim() }));
          }
        }}
      />
    </div>
  );
}
