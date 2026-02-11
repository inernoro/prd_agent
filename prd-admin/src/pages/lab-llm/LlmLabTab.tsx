import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Clock3, Copy, Download, Expand, ImagePlus, Layers, Maximize2, Plus, Save, ScanEye, Sparkles, Star, Tag, TimerOff, Trash2, XCircle, Zap } from 'lucide-react';
import JSZip from 'jszip';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

import { GlassCard } from '@/components/design/GlassCard';
import { glassPanel } from '@/lib/glassStyles';
import { GlassSwitch } from '@/components/design/GlassSwitch';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { PlatformLabel } from '@/components/design/PlatformLabel';
import { cn } from '@/lib/cn';
import { ConfirmTip } from '@/components/ui/ConfirmTip';
import { Dialog } from '@/components/ui/Dialog';
import { PrdLoader } from '@/components/ui/PrdLoader';
import { SuccessConfettiButton } from '@/components/ui/SuccessConfettiButton';
import type { Platform } from '@/types/admin';
import type { Model } from '@/types/admin';
import {
  createModel,
  createModelLabExperiment,
  deleteModelLabExperiment,
  getModels,
  getPlatforms,
  listModelLabExperiments,
  listModelLabModelSets,
  runModelLabStream,
  planImageGen,
  generateImageGen,
  runImageGenBatchStream,
  clearIntentModel,
  clearVisionModel,
  clearImageGenModel,
  setImageGenModel,
  setIntentModel,
  setMainModel,
  setVisionModel,
  updateModelLabExperiment,
  upsertModelLabModelSet,
  getAdminImageGenPlanPromptOverride,
  putAdminImageGenPlanPromptOverride,
  deleteAdminImageGenPlanPromptOverride,
} from '@/services';
import type { ModelLabExperiment, ModelLabModelSet, ModelLabParams, ModelLabSelectedModel, ModelLabSuite } from '@/services/contracts/modelLab';
import type { ImageGenGenerateResponse, ImageGenPlanItem, ImageGenPlanResponse } from '@/services/contracts/imageGen';
import { ModelPickerDialog } from '@/pages/lab-llm/components/ModelPickerDialog';
import { useAuthStore } from '@/stores/authStore';
import { clearLlmLabImagesForUser, getLlmLabImageBlob, putLlmLabImageBlob } from '@/lib/llmLabImageDb';
import { emitBackdropBusyEnd, emitBackdropBusyStart, waitForBackdropBusyStopped } from '@/lib/backdropBusy';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import { ASPECT_OPTIONS as NEW_ASPECT_OPTIONS } from '@/lib/imageAspectOptions';

type ViewRunItem = {
  itemId: string;
  modelId: string;
  displayName: string;
  modelName: string;
  /** 兼容字段：历史版本可能回传“配置模型内部 id”；当前以 platformId+modelId 为准 */
  configModelId?: string;
  status: 'running' | 'done' | 'error';
  /** repeatN > 1 时：第几次请求（后端会把每次请求拆成独立 itemId） */
  repeatIndex?: number;
  /** repeatN > 1 时：总重复次数 */
  repeatN?: number;
  /** 并发排队等待耗时（不计入 TTFT；用于解释“并发导致看起来很慢”） */
  queueMs?: number;
  ttftMs?: number;
  totalMs?: number;
  preview: string;
  /** 流式拼接的原始输出（前端累积；有上限；用于校验/展开/复制） */
  rawText?: string;
  rawTruncated?: boolean;
  errorMessage?: string;
};

type SortBy = 'ttft' | 'total' | 'imagePlanItemsDesc';

type MainMode = 'infer' | 'image';
type ImageSubMode = 'single' | 'batch' | 'fullSize';

type ImageViewItem = {
  key: string;
  status: 'running' | 'done' | 'error';
  prompt: string;
  /** 实际使用的 size（批量时可能来自单条覆盖）；用于展示/复核 */
  size?: string;
  requestedSize?: string;
  effectiveSize?: string;
  sizeAdjusted?: boolean;
  ratioAdjusted?: boolean;
  createdAt: number;
  groupId?: string;
  variantIndex?: number;
  /** 批量生图：在解析清单中的 item 序号（用于稳定排序） */
  itemIndex?: number;
  /** 批量生图：同一 item 下的图片序号（用于稳定排序） */
  imageIndex?: number;
  sourceModelId?: string;
  sourceModelName?: string;
  sourceDisplayName?: string;
  sourceModelIndex?: number;
  base64?: string | null;
  url?: string | null;
  revisedPrompt?: string | null;
  errorMessage?: string;
};

type CachedImageItem = Omit<ImageViewItem, 'base64'> & {
  /** true 表示图片内容已写入 IndexedDB（key 即 ImageViewItem.key） */
  hasLocalBlob?: boolean;
  /** 不持久化 blob: URL；仅保留 http(s) URL 或空 */
  url?: string | null;
  base64?: null;
};

type ExpectedFormat = 'json' | 'mcp' | 'functionCall' | 'imageGenPlan';
type LabMode = ModelLabSuite | ExpectedFormat;

type LlmLabCacheV1 = {
  version: 1;
  savedAt: number;
  activeExperimentId: string;
  mainMode: MainMode;
  mode: LabMode;
  suite: ModelLabSuite;
  sortBy: SortBy;
  /** 临时禁用模型（仅本次测试用；不写入实验） */
  disabledModelKeys: Record<string, boolean>;
  imageSubMode: ImageSubMode;
  imgSize: string;
  singleN: number;
  promptText: string;
  /** 生图意图解析：system prompt（本地缓存；真正持久化在后端） */
  imageGenPlanSystemPromptText?: string;

  runError: string | null;
  runItems: ViewRunItem[];

  imageError: string | null;
  imageItems: CachedImageItem[];
  singleGroupId: string;
  singleSelected: Record<string, boolean>;

  planResult: ImageGenPlanResponse | null;
  batchError: string | null;
  batchItems: CachedImageItem[];
};

type AspectOption = {
  id: '1:1' | '4:3' | '3:4' | '4:5' | '5:4' | '16:9' | '9:16';
  label: string;
  // 传给后端 images api 的 size（兼容 openai-like 的宽x高）
  size: string;
  // 用于展示的小图标（w/h 比例）
  iconW: number;
  iconH: number;
};

const ASPECT_OPTIONS: AspectOption[] = [
  { id: '1:1', label: '1:1', size: '1024x1024', iconW: 20, iconH: 20 },
  { id: '4:3', label: '4:3', size: '1024x768', iconW: 22, iconH: 16 },
  { id: '3:4', label: '3:4', size: '768x1024', iconW: 16, iconH: 22 },
  { id: '4:5', label: '4:5', size: '1024x1280', iconW: 16, iconH: 20 },
  { id: '5:4', label: '5:4', size: '1280x1024', iconW: 20, iconH: 16 },
  { id: '16:9', label: '16:9', size: '1280x720', iconW: 24, iconH: 14 },
  { id: '9:16', label: '9:16', size: '720x1280', iconW: 14, iconH: 24 },
];

type CopyToast = { id: string; text: string };

type PromptSizeMeta = {
  size?: string;
  width?: number;
  height?: number;
  ratio?: string; // e.g. "4:5"
};

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1;
}

function simplifyRatio(w: number, h: number): string | null {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const g = gcd(w, h);
  return `${Math.round(w / g)}:${Math.round(h / g)}`;
}

function ratioFromSizeString(size: string | undefined | null): string | null {
  const s = String(size ?? '').trim();
  if (!s) return null;
  const m = /^\s*(\d+)\s*[xX]\s*(\d+)\s*$/.exec(s);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return simplifyRatio(w, h);
}

function parsePromptSizeMeta(prompt: string): PromptSizeMeta {
  const text = String(prompt ?? '');
  if (!text.trim()) return {};

  // 1) 优先：像素 WxH（支持 x/X/×/*）
  const px = /(\d{2,5})\s*[xX×＊*]\s*(\d{2,5})/.exec(text);
  if (px) {
    const w = Number(px[1]);
    const h = Number(px[2]);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      // 在 size 附近再尝试抓一次显式比例（如 "（4:5）"），用于展示更符合用户写法
      const around = text.slice(Math.max(0, (px.index ?? 0) - 24), Math.min(text.length, (px.index ?? 0) + px[0].length + 24));
      const rm = /(\d{1,2})\s*[:：]\s*(\d{1,2})/.exec(around);
      const ratio = rm ? simplifyRatio(Number(rm[1]), Number(rm[2])) : simplifyRatio(w, h);
      return { size: `${w}x${h}`, width: w, height: h, ratio: ratio ?? undefined };
    }
  }

  // 2) 只有比例（优先括号内）
  const ratioCandidates = [
    /[（(]\s*(\d{1,2})\s*[:：]\s*(\d{1,2})\s*[）)]/.exec(text),
    /(\d{1,2})\s*[:：]\s*(\d{1,2})/.exec(text),
  ].filter(Boolean) as RegExpExecArray[];
  if (ratioCandidates.length) {
    const m = ratioCandidates[0];
    const a = Number(m[1]);
    const b = Number(m[2]);
    const ratio = simplifyRatio(a, b);
    if (!ratio) return {};
    // 映射到一个“可用”的默认像素，避免批量时无 size 无法落到后端
    const opt = ASPECT_OPTIONS.find((x) => x.id === ratio);
    return { ratio, size: opt?.size };
  }

  return {};
}

function signatureOfSelectedModels(list: ModelLabSelectedModel[]) {
  // 用于“是否需要自动保存”的变更检测；与 setSelectedModelsDedupe 的唯一性规则保持一致（平台 + modelId）
  return (list ?? [])
    .map((m) => {
      const pid = String(m.platformId ?? '').trim();
      const mid = String((m as any).modelId ?? m.modelName ?? '').trim();
      return `${pid}:${mid}`.toLowerCase();
    })
    .filter(Boolean)
    .sort()
    .join('|');
}

function modelKeyOfSelected(m: ModelLabSelectedModel): string {
  const pid = String(m?.platformId ?? '').trim();
  const mid = String((m as any)?.modelId ?? m?.modelName ?? '').trim();
  return `${pid}:${mid}`.toLowerCase();
}

function filenameSafe(s: string) {
  const base = (s || '').trim().slice(0, 32) || 'image';
  return base
    .replace(/[\s/\\:*?"<>|]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const MAX_RUN_RAW_CHARS = 60_000;

function pickRunText(rawText?: string, preview?: string): string {
  const a = String(rawText ?? '').trim();
  if (a) return a;
  const b = String(preview ?? '').trim();
  return b;
}

function normalizeJsonCandidatesFromText(raw: string): string[] {
  const t = (raw ?? '').trim();
  if (!t) return [];

  const candidates: string[] = [];

  // 1) 全文尝试（严格）
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) candidates.push(t);

  // 2) fenced code blocks（可多个）
  const fenceRe = /```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(t)) !== null) {
    const inner = (m[1] ?? '').trim();
    if (!inner) continue;
    if ((inner.startsWith('{') && inner.endsWith('}')) || (inner.startsWith('[') && inner.endsWith(']'))) candidates.push(inner);
  }

  // 3) 兜底：截取最外层 JSON（容错，避免模型加了前后说明）
  const firstObj = t.indexOf('{');
  const lastObj = t.lastIndexOf('}');
  if (firstObj >= 0 && lastObj > firstObj) {
    const sub = t.slice(firstObj, lastObj + 1).trim();
    if (sub.startsWith('{') && sub.endsWith('}')) candidates.push(sub);
  }
  const firstArr = t.indexOf('[');
  const lastArr = t.lastIndexOf(']');
  if (firstArr >= 0 && lastArr > firstArr) {
    const sub = t.slice(firstArr, lastArr + 1).trim();
    if (sub.startsWith('[') && sub.endsWith(']')) candidates.push(sub);
  }

  // 去重
  return Array.from(new Set(candidates));
}

function parseAnyJson(raw: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  const cands = normalizeJsonCandidatesFromText(raw);
  if (cands.length === 0) return { ok: false, reason: '未发现可解析的 JSON（全文/代码块/截取均失败）' };

  for (const c of cands) {
    try {
      const v = JSON.parse(c) as unknown;
      return { ok: true, value: v };
    } catch {
      // continue
    }
  }
  return { ok: false, reason: '发现疑似 JSON，但 JSON.parse 均失败' };
}

function normalizeStrictJsonCandidate(raw: string): { ok: true; json: string } | { ok: false; reason: string } {
  const t0 = (raw ?? '').trim();
  if (!t0) return { ok: false, reason: '空内容' };

  // 允许 ```json ... ``` 这种“整体代码块包裹”的返回
  if (t0.startsWith('```')) {
    const m = t0.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
    if (!m) return { ok: false, reason: '代码块格式不完整（缺少闭合 ```）' };
    const inner = (m[1] ?? '').trim();
    if (!inner) return { ok: false, reason: '代码块为空' };
    if (!inner.startsWith('{') && !inner.startsWith('[')) return { ok: false, reason: '代码块内容不是 JSON（未以 { 或 [ 开头）' };
    if (!(inner.endsWith('}') || inner.endsWith(']'))) return { ok: false, reason: '代码块内容不是 JSON（未以 } 或 ] 结尾）' };
    return { ok: true, json: inner };
  }

  if (!t0.startsWith('{') && !t0.startsWith('[')) return { ok: false, reason: '不是 JSON（未以 { 或 [ 开头）' };
  if (!(t0.endsWith('}') || t0.endsWith(']'))) return { ok: false, reason: '不是 JSON（未以 } 或 ] 结尾）' };
  return { ok: true, json: t0 };
}

function validateStrictJson(raw: string): { ok: true } | { ok: false; reason: string } {
  const c = normalizeStrictJsonCandidate(raw);
  if (!c.ok) return c;
  try {
    JSON.parse(c.json);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `JSON.parse 失败：${msg}` };
  }
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function isFunctionCallShape(v: unknown): { ok: true } | { ok: false; reason: string } {
  if (!isPlainRecord(v)) return { ok: false, reason: '不是对象' };
  const obj = v;

  // OpenAI 新版：tool_calls
  const toolCalls = obj.tool_calls;
  if (Array.isArray(toolCalls)) {
    const first = toolCalls[0];
    if (!isPlainRecord(first)) return { ok: false, reason: 'tool_calls[0] 不是对象' };

    const type = first.type;
    const fn = first.function;
    if (!isPlainRecord(fn)) return { ok: false, reason: 'tool_calls[0].function 缺失或不是对象' };

    const name = fn.name;
    const args = fn.arguments;
    if (type === 'function' && typeof name === 'string' && name.trim()) {
      if (typeof args === 'string' || isPlainRecord(args)) return { ok: true };
      return { ok: false, reason: 'tool_calls[0].function.arguments 缺失或类型不对' };
    }
    return { ok: false, reason: 'tool_calls 结构不符合（缺少 type=function / function.name / function.arguments）' };
  }

  // 旧版：function_call
  const fc = obj.function_call;
  if (isPlainRecord(fc)) {
    const name = fc.name;
    const args = fc.arguments;
    if (typeof name === 'string' && name.trim()) {
      if (typeof args === 'string' || isPlainRecord(args)) return { ok: true };
      return { ok: false, reason: 'function_call.arguments 缺失或类型不对' };
    }
  }

  // 简化形态：{ name, arguments }
  if (typeof obj.name === 'string' && obj.name.trim() && obj.arguments !== undefined) {
    return { ok: true };
  }

  return { ok: false, reason: '未命中 function_call/tool_calls/name+arguments 任一形态' };
}

function isMcpJsonShape(v: unknown): { ok: true } | { ok: false; reason: string } {
  if (!isPlainRecord(v)) return { ok: false, reason: '不是对象' };
  const obj = v;

  // 允许 { calls: [...] } 或 { mcp: [...] } 包裹
  const list = obj.calls ?? obj.mcp;
  if (Array.isArray(list) && list.length > 0) {
    const first = list[0];
    if (!isPlainRecord(first)) return { ok: false, reason: 'calls/mcp[0] 不是对象' };
    const server = first.server;
    const uri = first.uri;
    const tool = first.tool ?? first.name ?? first.method;
    if (typeof server === 'string' && server.trim() && (typeof uri === 'string' || typeof tool === 'string')) return { ok: true };
    return { ok: false, reason: 'calls/mcp[0] 缺少 server + (uri/tool/name/method)' };
  }

  // 直接形态：{ server, uri } / { server, tool, arguments }
  const server = obj.server;
  const uri = obj.uri;
  const tool = obj.tool ?? obj.name ?? obj.method;
  if (typeof server === 'string' && server.trim() && (typeof uri === 'string' || typeof tool === 'string')) return { ok: true };

  return { ok: false, reason: '未命中 MCP 形态（需要 server + (uri/tool/name/method)）' };
}

type SuiteCheck = {
  label: string;
  ok: boolean;
  reason: string;
};

function validateByFormatTest(expectedFormat: ExpectedFormat | null | undefined, raw: string): SuiteCheck | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  if (!expectedFormat) return null;

  // imageGenPlan：此处不做“通过/失败”的强校验，避免误导；仅在 UI 里展示识别条目数。
  if (expectedFormat === 'imageGenPlan') return null;

  const parsed = parseAnyJson(raw);
  const label: SuiteCheck['label'] = expectedFormat === 'json' ? 'JSON' : expectedFormat === 'mcp' ? 'MCP' : 'FunctionCall';
  if (!parsed.ok) return { label, ok: false, reason: parsed.reason };

  if (expectedFormat === 'json') {
    return { label: 'JSON', ok: true, reason: '通过（JSON.parse 成功）' };
  }

  if (expectedFormat === 'functionCall') {
    const fc = isFunctionCallShape(parsed.value);
    return { label: 'FunctionCall', ok: fc.ok, reason: fc.ok ? '通过（识别到 FunctionCall 结构）' : fc.reason };
  }

  // formatTest === 'mcp'
  const mcp = isMcpJsonShape(parsed.value);
  return { label: 'MCP', ok: mcp.ok, reason: mcp.ok ? '通过（识别到 MCP 结构）' : mcp.reason };
}

function tryParseImageGenPlan(raw: string): { ok: true; itemsLen: number } | { ok: false; reason: string } {
  const text0 = (raw ?? '').trim();
  if (!text0) return { ok: false, reason: '空输出' };

  // 容错：允许整体 code block / 前后说明；优先解析为 JSON（object/array）
  const parsed = parseAnyJson(text0);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const v = parsed.value as any;
  if (Array.isArray(v)) return { ok: true, itemsLen: v.length };
  const items = v?.items;
  if (!Array.isArray(items)) return { ok: false, reason: '未找到 items 数组' };
  return { ok: true, itemsLen: items.length };
}

function getImagePlanItemsInfoFromRaw(raw: string): { ok: true; itemsLen: number } | { ok: false; reason: string } | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  const parsed = tryParseImageGenPlan(t);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  return { ok: true, itemsLen: parsed.itemsLen };
}

function getImagePlanItemsLenFromRaw(raw: string): number | null {
  const info = getImagePlanItemsInfoFromRaw(raw);
  if (!info) return null;
  return info.ok ? info.itemsLen : 0;
}

async function downloadImage(src: string, filename: string) {
  const name = filenameSafe(filename) || 'image';
  const finalName = name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg') ? name : `${name}.png`;

  // data url / blob url：直接下载
  if (src.startsWith('data:') || src.startsWith('blob:')) {
    const a = document.createElement('a');
    a.href = src;
    a.download = finalName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return;
  }

  // http(s)：优先 fetch 成 blob 再下载（跨域可能失败），失败则降级直接打开
  try {
    const res = await fetch(src, { mode: 'cors' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = finalName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return;
  } catch {
    window.open(src, '_blank', 'noopener,noreferrer');
  }
}

function base64ToUint8Array(b64: string) {
  const clean = (b64 || '').trim();
  const comma = clean.indexOf(',');
  const data = clean.startsWith('data:') && comma >= 0 ? clean.slice(comma + 1) : clean;
  const binStr = atob(data);
  const len = binStr.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binStr.charCodeAt(i);
  return bytes;
}

async function downloadAllAsZip(items: { src: string; filename: string }[], zipName: string) {
  const zip = new JSZip();
  let okCount = 0;
  const nameCounts: Record<string, number> = {};

  const dedupeFilename = (finalName: string) => {
    const key = finalName.toLowerCase();
    const prev = nameCounts[key] ?? 0;
    nameCounts[key] = prev + 1;
    if (prev === 0) return finalName;
    const dot = finalName.lastIndexOf('.');
    const base = dot > 0 ? finalName.slice(0, dot) : finalName;
    const ext = dot > 0 ? finalName.slice(dot) : '';
    return `${base}_${prev + 1}${ext}`;
  };

  for (const it of items) {
    const src = (it.src || '').trim();
    const name = filenameSafe(it.filename) || 'image';
    const finalName0 = name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg') ? name : `${name}.png`;
    const finalName = dedupeFilename(finalName0);
    if (!src) continue;

    try {
      if (src.startsWith('data:') || /^[A-Za-z0-9+/=]+$/.test(src)) {
        const bytes = base64ToUint8Array(src);
        zip.file(finalName, bytes);
        okCount++;
        continue;
      }

      const res = await fetch(src, { mode: 'cors' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      zip.file(finalName, blob);
      okCount++;
    } catch {
      // ignore failed file
    }
  }

  if (okCount === 0) {
    toast.warning('没有可下载的图片（可能被跨域限制）');
    return;
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (filenameSafe(zipName) || 'images') + '.zip';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function copyImageToClipboardFromSrc(src: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const s = String(src || '').trim();
  if (!s) return { ok: false, reason: '无图片内容' };

  const nav: any = navigator as any;
  const ClipboardItemCtor = (window as any).ClipboardItem;
  if (!nav?.clipboard?.write || !ClipboardItemCtor) {
    return { ok: false, reason: '当前浏览器不支持复制图片（需要 ClipboardItem）' };
  }

  try {
    const res = await fetch(s, { mode: 'cors' });
    if (!res.ok) return { ok: false, reason: `读取图片失败：HTTP ${res.status}` };
    const blob = await res.blob();
    const mime = blob.type || 'image/png';
    const item = new ClipboardItemCtor({ [mime]: blob });
    await nav.clipboard.write([item]);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `复制失败：${msg || '未知原因'}` };
  }
}

const defaultParams: ModelLabParams = {
  temperature: 0.2,
  maxTokens: null,
  timeoutMs: 600000,
  maxConcurrency: 10,
  repeatN: 1,
};

function normalizeSavedSuite(s: unknown): ModelLabSuite {
  // 速度/自定义 与 意图语义合并：历史数据也统一映射到 intent
  if (s === 'intent') return 'intent';
  if (s === 'speed' || s === 'custom') return 'intent';
  return 'intent';
}

function normalizeSavedMode(m: unknown): LabMode {
  // 速度/自定义 与 意图语义合并：历史数据也统一映射到 intent
  if (m === 'intent') return 'intent';
  if (m === 'speed' || m === 'custom') return 'intent';
  if (m === 'json' || m === 'mcp' || m === 'functionCall' || m === 'imageGenPlan') return m;
  return 'intent';
}

/**
 * InlineMarquee - 简化版预览文本组件
 *
 * 之前使用 CSS 跑马灯动画，但超长文本（4000+px）会导致：
 * 1. 与 backdrop-filter（液态玻璃）产生 GPU 合成层冲突
 * 2. 页面闪烁和渲染抖动
 *
 * 现改为纯静态 ellipsis 截断，用户可通过 hover title 或点击"展开"查看完整内容。
 */
function InlineMarquee({
  text,
  title,
  className,
  style,
}: {
  text: string;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim() || '（无输出）';

  return (
    <div
      className={className}
      title={title || normalized}
      style={{
        minWidth: 0,
        width: '100%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {normalized}
    </div>
  );
}

const builtInPrompts: Record<LabMode, { label: string; promptText: string }[]> = {
  speed: [
    { label: '短回复', promptText: '你好，请用一句话简短回复。' },
    { label: '固定长度', promptText: '请输出恰好 20 个中文字符（不要标点）。' },
  ],
  intent: [
    { label: '登录/鉴权', promptText: '用户话术：我登录失败，一直提示 token 过期。请判断意图。' },
    { label: '支付/退款', promptText: '用户话术：我要申请退款，订单号 12345。请判断意图。' },
  ],
  custom: [{ label: '自定义', promptText: '' }],
  json: [
    {
      label: 'JSON',
      promptText: '请把下面内容转换为结构化 JSON，并严格只输出 JSON（不要 Markdown/解释/多余字符）。\n\n输入：我想申请退款，订单号 12345。',
    },
  ],
  mcp: [
    {
      label: 'MCP',
      promptText:
        '用户输入：请在知识库里搜索“退款流程”，并给出下一步建议。\n\n请严格只输出 MCP JSON（不要 Markdown/解释）。\n推荐：{"server":"kb","tool":"search","arguments":{"query":"退款流程"}}',
    },
  ],
  functionCall: [
    {
      label: 'FunctionCall',
      promptText:
        '用户输入：查询订单 12345 的状态。\n\n请严格只输出 FunctionCall JSON（不要 Markdown/解释）。\n推荐：{"name":"order.getStatus","arguments":{"orderId":"12345"}}',
    },
  ],
  imageGenPlan: [
    {
      label: '生图意图',
      // 不在 textarea 里塞“模板文字”，避免用户误以为这是 system prompt；
      // 真实 system prompt 已在后端以 expectedFormat=imageGenPlan 注入。
      promptText: '',
    },
  ],
};

export default function LlmLabTab() {
  const authUser = useAuthStore((s) => s.user);
  const cacheUserId = (authUser?.userId ?? 'anonymous').trim() || 'anonymous';
  const labCacheKey = useMemo(() => `prd-admin-llm-lab-cache:v1:${cacheUserId}`, [cacheUserId]);
  const hydratedRef = useRef(false);
  const appliedExperimentIdRef = useRef<string>('');
  const cacheSaveTimerRef = useRef<number | null>(null);
  const storedBlobKeysRef = useRef<Set<string>>(new Set());
  const objectUrlByKeyRef = useRef<Map<string, string>>(new Map());

  const [allModels, setAllModels] = useState<Model[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [platforms, setPlatforms] = useState<Platform[]>([]);

  const [experiments, setExperiments] = useState<ModelLabExperiment[]>([]);
  const [experimentsLoading, setExperimentsLoading] = useState(true);
  const [activeExperimentId, setActiveExperimentId] = useState<string>('');
  const [createExperimentOpen, setCreateExperimentOpen] = useState(false);
  const [createExperimentName, setCreateExperimentName] = useState('');
  const [loadExperimentOpen, setLoadExperimentOpen] = useState(false);
  const [loadExperimentId, setLoadExperimentId] = useState<string>('');

  // suite：会被保存进实验（历史 speed/custom 已合并到 intent）
  const [suite, setSuite] = useState<ModelLabSuite>('intent');
  // mode：纯 UI 选择（6 个互斥类型），不写入实验，避免被 suite 回填覆盖
  const [mode, setMode] = useState<LabMode>('intent');
  const expectedFormat: ExpectedFormat | undefined =
    mode === 'json' || mode === 'mcp' || mode === 'functionCall' || mode === 'imageGenPlan' ? mode : undefined;
  const [params, setParams] = useState<ModelLabParams>(defaultParams);
  const [promptText, setPromptText] = useState<string>('');
  // 生图意图解析：system prompt（可编辑；按管理员账号持久化在后端）
  const [imageGenPlanSystemPromptText, setImageGenPlanSystemPromptText] = useState<string>('');
  const [imageGenPlanSystemPromptDefaultText, setImageGenPlanSystemPromptDefaultText] = useState<string>('');
  const [imageGenPlanSystemPromptIsOverridden, setImageGenPlanSystemPromptIsOverridden] = useState<boolean>(false);
  const [imageGenPlanSystemPromptUpdatedAt, setImageGenPlanSystemPromptUpdatedAt] = useState<string | null>(null);
  const [imageGenPlanSystemPromptLoading, setImageGenPlanSystemPromptLoading] = useState<boolean>(false);
  // 默认锁定：避免用户误以为需要在这里输入；明确点击“解锁”后再编辑
  const [imageGenPlanSystemPromptUnlocked, setImageGenPlanSystemPromptUnlocked] = useState(false);
  const imageGenPlanSystemPromptRef = useRef<HTMLTextAreaElement | null>(null);
  const imageGenPlanSystemPromptBaselineRef = useRef<string>('');
  const imageGenPlanSystemPromptLoadedRef = useRef<boolean>(false);

  const imageGenPlanSystemPromptDirty = useMemo(() => {
    return String(imageGenPlanSystemPromptText ?? '') !== String(imageGenPlanSystemPromptBaselineRef.current ?? '');
  }, [imageGenPlanSystemPromptText]);

  const makeIdempotencyKey = useCallback(() => {
    try {
      if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
    } catch {
      // ignore
    }
    return `idem_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }, []);
  const [selectedModels, setSelectedModels] = useState<ModelLabSelectedModel[]>([]);
  // 临时禁用：仅影响“本次运行”（startRun 时过滤），不写入实验 selectedModels
  const [disabledModelKeys, setDisabledModelKeys] = useState<Record<string, boolean>>({});

  const [mainMode, setMainMode] = useState<MainMode>('infer');
  const [imageSubMode, setImageSubMode] = useState<ImageSubMode>('single');

  const shouldShowImageGenPlanPromptSplit = useMemo(() => {
    return (mainMode === 'image' && imageSubMode === 'batch') || (mainMode === 'infer' && mode === 'imageGenPlan');
  }, [imageSubMode, mainMode, mode]);

  const loadImageGenPlanSystemPrompt = useCallback(
    async (args?: { force?: boolean }) => {
      if (!shouldShowImageGenPlanPromptSplit) return;
      if (!useAuthStore.getState().token) return;

      // 避免覆盖用户未保存的编辑：非 force 且已 dirty 时跳过
      if (!args?.force && imageGenPlanSystemPromptDirty) return;

      setImageGenPlanSystemPromptLoading(true);
      try {
        const res = await getAdminImageGenPlanPromptOverride();
        if (!res.success) return;
        const dto = res.data;
        const promptText = dto.promptText ?? '';
        const defaultPromptText = dto.defaultPromptText ?? '';
        const isOverridden = dto.isOverridden;
        const updatedAt = dto.updatedAt ?? null;

        setImageGenPlanSystemPromptText(promptText);
        setImageGenPlanSystemPromptDefaultText(defaultPromptText);
        setImageGenPlanSystemPromptIsOverridden(isOverridden);
        setImageGenPlanSystemPromptUpdatedAt(updatedAt);
        imageGenPlanSystemPromptBaselineRef.current = promptText;
        imageGenPlanSystemPromptLoadedRef.current = true;
      } finally {
        setImageGenPlanSystemPromptLoading(false);
      }
    },
    [imageGenPlanSystemPromptDirty, shouldShowImageGenPlanPromptSplit]
  );

  const saveImageGenPlanSystemPrompt = useCallback(async () => {
    if (!useAuthStore.getState().token) return;
    setImageGenPlanSystemPromptLoading(true);
    try {
      const res = await putAdminImageGenPlanPromptOverride({
        promptText: String(imageGenPlanSystemPromptText ?? ''),
        idempotencyKey: makeIdempotencyKey(),
      });
      if (!res.success) {
        toast.error(res.error?.message || '保存失败');
        return;
      }
      const dto = res.data;
      const promptText = dto.promptText ?? '';
      const defaultPromptText = dto.defaultPromptText ?? '';
      const isOverridden = dto.isOverridden;
      const updatedAt = dto.updatedAt ?? null;

      setImageGenPlanSystemPromptText(promptText);
      setImageGenPlanSystemPromptDefaultText(defaultPromptText);
      setImageGenPlanSystemPromptIsOverridden(isOverridden);
      setImageGenPlanSystemPromptUpdatedAt(updatedAt);
      imageGenPlanSystemPromptBaselineRef.current = promptText;
      imageGenPlanSystemPromptLoadedRef.current = true;
    } finally {
      setImageGenPlanSystemPromptLoading(false);
    }
  }, [imageGenPlanSystemPromptText, makeIdempotencyKey]);

  const resetImageGenPlanSystemPrompt = useCallback(async () => {
    if (!useAuthStore.getState().token) return;
    setImageGenPlanSystemPromptLoading(true);
    try {
      const res = await deleteAdminImageGenPlanPromptOverride({ idempotencyKey: makeIdempotencyKey() });
      if (!res.success) {
        toast.error(res.error?.message || '恢复默认失败');
        return;
      }
      const dto = res.data;
      const promptText = dto.promptText ?? '';
      const defaultPromptText = dto.defaultPromptText ?? '';
      const isOverridden = dto.isOverridden;
      const updatedAt = dto.updatedAt ?? null;

      setImageGenPlanSystemPromptText(promptText);
      setImageGenPlanSystemPromptDefaultText(defaultPromptText);
      setImageGenPlanSystemPromptIsOverridden(isOverridden);
      setImageGenPlanSystemPromptUpdatedAt(updatedAt);
      imageGenPlanSystemPromptBaselineRef.current = promptText;
      imageGenPlanSystemPromptLoadedRef.current = true;
    } finally {
      setImageGenPlanSystemPromptLoading(false);
    }
  }, [makeIdempotencyKey]);

  const [imgSize, setImgSize] = useState<string>('1024x1024');
  const currentAspectOpt = useMemo(() => {
    return ASPECT_OPTIONS.find((x) => x.size === imgSize) ?? ASPECT_OPTIONS[0];
  }, [imgSize]);
  const [singleN, setSingleN] = useState<number>(1);
  const [singleGroupId, setSingleGroupId] = useState<string>('');
  const [singleSelected, setSingleSelected] = useState<Record<string, boolean>>({});

  const [imageRunning, setImageRunning] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageItems, setImageItems] = useState<ImageViewItem[]>([]);

  const [planLoading, setPlanLoading] = useState(false);
  const [planDialogOpen, setPlanDialogOpen] = useState(false);
  const [planResult, setPlanResult] = useState<ImageGenPlanResponse | null>(null);

  const [batchRunning, setBatchRunning] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchItems, setBatchItems] = useState<Record<string, ImageViewItem>>({});
  const batchAbortRef = useRef<AbortController | null>(null);
  const batchStopRequestedRef = useRef(false);
  const [batchActiveModelLabel, setBatchActiveModelLabel] = useState<string>('');

  // 全尺寸模式：30 种尺寸（10 比例 × 3 档）
  const [fullSizeRunning, setFullSizeRunning] = useState(false);
  const [fullSizeItems, setFullSizeItems] = useState<Record<string, ImageViewItem>>({});
  const fullSizeAbortRef = useRef<AbortController | null>(null);

  const [imageGridEl, setImageGridEl] = useState<HTMLDivElement | null>(null);
  const imageGridRef = useCallback((el: HTMLDivElement | null) => setImageGridEl(el), []);
  const [imageThumbHeight, setImageThumbHeight] = useState(220);

  const [modelSets, setModelSets] = useState<ModelLabModelSet[]>([]);

  const [pickerOpen, setPickerOpen] = useState(false);

  const [running, setRunning] = useState(false);
  const [runItems, setRunItems] = useState<Record<string, ViewRunItem>>({});
  const [runError, setRunError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const didMountForBackdropBusyRef = useRef(false);
  const suiteCycleRef = useRef<Record<LabMode, number>>({} as Record<LabMode, number>);
  const [sortBy, setSortBy] = useState<SortBy>('ttft');
  const allModelsRef = useRef<Model[]>([]);
  const selectedModelsRef = useRef<ModelLabSelectedModel[]>([]);

  const [previewDialog, setPreviewDialog] = useState<{ open: boolean; title: string; text: string }>({
    open: false,
    title: '输出预览',
    text: '',
  });

  const [previewJsonCheckPhase, setPreviewJsonCheckPhase] = useState<'idle' | 'scanning' | 'passed' | 'failed'>('idle');
  const previewJsonCheckLastRef = useRef<{ ok: boolean; reason?: string } | null>(null);
  const [previewJsonHint, setPreviewJsonHint] = useState<string>('');

  const resetPreviewJsonCheck = useCallback(() => {
    previewJsonCheckLastRef.current = null;
    setPreviewJsonCheckPhase('idle');
    setPreviewJsonHint('');
  }, []);

  useEffect(() => {
    // 每次打开“新内容”时重置（避免上一次通过/失败残留）
    if (!previewDialog.open) return;
    resetPreviewJsonCheck();
  }, [previewDialog.open, previewDialog.text, resetPreviewJsonCheck]);

  const [imagePreviewDialog, setImagePreviewDialog] = useState<{ open: boolean; title: string; src: string }>({
    open: false,
    title: '图片预览',
    src: '',
  });

  const [copyToast, setCopyToast] = useState<CopyToast | null>(null);
  const copyToastTimerRef = useRef<number | null>(null);
  const showCopyToast = useCallback((text: string) => {
    const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    setCopyToast({ id, text });
    if (copyToastTimerRef.current) window.clearTimeout(copyToastTimerRef.current);
    copyToastTimerRef.current = window.setTimeout(() => setCopyToast(null), 3000);
  }, []);
  useEffect(() => {
    return () => {
      if (copyToastTimerRef.current) window.clearTimeout(copyToastTimerRef.current);
    };
  }, []);

  // 自动保存（防抖）：避免“加入实验后刷新丢失”
  const autoSaveTimerRef = useRef<number | null>(null);
  const lastSavedSigRef = useRef<string>('');
  const lastSavedExperimentIdRef = useRef<string>('');
  const isModeSwitchingRef = useRef(false); // 标记是否正在切换模式（json/mcp/functionCall），用于跳过自动保存

  const revokeAllObjectUrls = useCallback(() => {
    const m = objectUrlByKeyRef.current;
    for (const [, url] of m) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    }
    m.clear();
  }, []);

  useEffect(() => {
    // 组件卸载时释放 blob: URL，避免内存泄漏
    return () => {
      revokeAllObjectUrls();
    };
  }, [revokeAllObjectUrls]);

  // “一键开始实验/运行中”期间：联动全局背景（变亮 + 转动），直到完成/取消/失败
  useEffect(() => {
    if (!didMountForBackdropBusyRef.current) {
      didMountForBackdropBusyRef.current = true;
      return;
    }
    if (running) emitBackdropBusyStart();
    else emitBackdropBusyEnd();
  }, [running]);

  const attachLocalBlobsToImageItems = useCallback(
    async (items: CachedImageItem[], kind: 'single' | 'batch') => {
      if (!items?.length) return;
      const updated = await Promise.all(
        items.map(async (it) => {
          const hasLocal = Boolean(it.hasLocalBlob);
          if (!hasLocal) return it as unknown as ImageViewItem;
          const blob = await getLlmLabImageBlob(cacheUserId, it.key);
          if (!blob) {
            return {
              ...(it as any),
              status: 'error',
              errorMessage: `本地图片缓存不存在（可能已清理或异地登录）。图片仅保存在本机浏览器本地。`,
              base64: null,
              url: null,
            } as ImageViewItem;
          }
          const url = URL.createObjectURL(blob);
          const prev = objectUrlByKeyRef.current.get(it.key);
          if (prev && prev !== url) {
            try {
              URL.revokeObjectURL(prev);
            } catch {
              // ignore
            }
          }
          objectUrlByKeyRef.current.set(it.key, url);
          return { ...(it as any), base64: null, url } as ImageViewItem;
        })
      );

      if (kind === 'single') setImageItems(updated);
      else setBatchItems(Object.fromEntries(updated.map((x) => [x.key, x])));
    },
    [cacheUserId]
  );

  // 启动时：从本地恢复 UI 选择与结果（除非用户手动清空）
  useEffect(() => {
    hydratedRef.current = false;
    // 切换用户/刷新时：让 system prompt 重新按“本地缓存 -> 后端配置”流程加载
    imageGenPlanSystemPromptLoadedRef.current = false;
    imageGenPlanSystemPromptBaselineRef.current = '';
    try {
      const raw = localStorage.getItem(labCacheKey);
      if (!raw) {
        hydratedRef.current = true;
        return;
      }
      const data = JSON.parse(raw) as Partial<LlmLabCacheV1>;
      if (!data || (data as any).version !== 1) {
        hydratedRef.current = true;
        return;
      }

      if (typeof data.activeExperimentId === 'string') setActiveExperimentId(data.activeExperimentId);
      if (data.mainMode === 'infer' || data.mainMode === 'image') setMainMode(data.mainMode);
      if (typeof data.mode === 'string') setMode(normalizeSavedMode(data.mode));
      setSuite(normalizeSavedSuite((data as any).suite));
      if (data.sortBy === 'ttft' || data.sortBy === 'total' || data.sortBy === 'imagePlanItemsDesc') setSortBy(data.sortBy);
      if (data.disabledModelKeys && typeof data.disabledModelKeys === 'object') setDisabledModelKeys(data.disabledModelKeys as any);
      if (data.imageSubMode === 'single' || data.imageSubMode === 'batch' || data.imageSubMode === 'fullSize') setImageSubMode(data.imageSubMode);
      if (typeof data.imgSize === 'string' && data.imgSize.trim()) setImgSize(data.imgSize.trim());
      if (typeof data.singleN === 'number') setSingleN(Math.max(1, Math.min(20, Number(data.singleN || 1))));
      if (typeof data.promptText === 'string') setPromptText(data.promptText);
      if (typeof data.imageGenPlanSystemPromptText === 'string') {
        setImageGenPlanSystemPromptText(data.imageGenPlanSystemPromptText);
        imageGenPlanSystemPromptBaselineRef.current = data.imageGenPlanSystemPromptText;
      }

      if (typeof data.runError === 'string' || data.runError === null) setRunError(data.runError ?? null);
      if (Array.isArray(data.runItems)) setRunItems(Object.fromEntries(data.runItems.map((x) => [x.itemId, x])));

      if (typeof data.imageError === 'string' || data.imageError === null) setImageError(data.imageError ?? null);
      if (typeof data.singleGroupId === 'string') setSingleGroupId(data.singleGroupId);
      if (data.singleSelected && typeof data.singleSelected === 'object') setSingleSelected(data.singleSelected as any);

      if (data.planResult && typeof data.planResult === 'object') setPlanResult(data.planResult as any);
      if (typeof data.batchError === 'string' || data.batchError === null) setBatchError(data.batchError ?? null);

      const cachedSingle = Array.isArray(data.imageItems) ? (data.imageItems as CachedImageItem[]) : [];
      const cachedBatch = Array.isArray(data.batchItems) ? (data.batchItems as CachedImageItem[]) : [];

      // 先落状态，再异步挂载本地图片（blob->objectURL）
      setImageItems(cachedSingle as unknown as ImageViewItem[]);
      setBatchItems(Object.fromEntries(cachedBatch.map((x) => [x.key, x])) as any);

      void attachLocalBlobsToImageItems(cachedSingle, 'single');
      void attachLocalBlobsToImageItems(cachedBatch, 'batch');
    } catch {
      // ignore
    } finally {
      hydratedRef.current = true;
    }
  }, [attachLocalBlobsToImageItems, labCacheKey]);

  // 生图意图解析：当进入相关模式时，从后端拉取“系统提示词覆盖”（避免黑盒）
  useEffect(() => {
    if (!shouldShowImageGenPlanPromptSplit) return;
    if (!useAuthStore.getState().token) return;
    if (imageGenPlanSystemPromptLoadedRef.current) return;
    void loadImageGenPlanSystemPrompt();
  }, [cacheUserId, loadImageGenPlanSystemPrompt, shouldShowImageGenPlanPromptSplit]);

  // 持久化：保存 UI 选择与结果到 localStorage（图片内容单独进 IndexedDB）
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (cacheSaveTimerRef.current) window.clearTimeout(cacheSaveTimerRef.current);

    cacheSaveTimerRef.current = window.setTimeout(() => {
      try {
        const stripImage = (it: ImageViewItem): CachedImageItem => {
          const isBlobUrl = typeof it.url === 'string' && it.url.startsWith('blob:');
          const hasLocalBlob = it.status === 'done' && typeof it.base64 === 'string' && it.base64.trim().length > 0;
          return {
            ...(it as any),
            base64: null,
            hasLocalBlob: hasLocalBlob || isBlobUrl || Boolean((it as any).hasLocalBlob),
            url: isBlobUrl ? null : (it.url ?? null),
          } as CachedImageItem;
        };

        const cache: LlmLabCacheV1 = {
          version: 1,
          savedAt: Date.now(),
          activeExperimentId: activeExperimentId || '',
          mainMode,
          mode,
          suite,
          sortBy,
          disabledModelKeys: disabledModelKeys ?? {},
          imageSubMode,
          imgSize,
          singleN: Number(singleN || 1),
          promptText: promptText ?? '',
          imageGenPlanSystemPromptText: imageGenPlanSystemPromptText ?? '',

          runError: runError ?? null,
          runItems: Object.values(runItems ?? {}),

          imageError: imageError ?? null,
          imageItems: (imageItems ?? []).map(stripImage),
          singleGroupId: singleGroupId ?? '',
          singleSelected: singleSelected ?? {},

          planResult: planResult ?? null,
          batchError: batchError ?? null,
          batchItems: Object.values(batchItems ?? {}).map(stripImage),
        };

        localStorage.setItem(labCacheKey, JSON.stringify(cache));
      } catch {
        // ignore
      }
    }, 350);

    return () => {
      if (cacheSaveTimerRef.current) window.clearTimeout(cacheSaveTimerRef.current);
    };
  }, [
    activeExperimentId,
    batchError,
    batchItems,
      disabledModelKeys,
    imageError,
    imageItems,
    imageSubMode,
    imageGenPlanSystemPromptText,
    imgSize,
    labCacheKey,
    mainMode,
    mode,
    planResult,
    promptText,
    runError,
    runItems,
    singleGroupId,
    singleN,
    singleSelected,
    sortBy,
    suite,
  ]);

  // 将生成的图片内容写入 IndexedDB（避免刷新后丢失；并与 userId 隔离）
  useEffect(() => {
    if (!hydratedRef.current) return;
    const userId = cacheUserId;

    const upsertFrom = async (list: ImageViewItem[]) => {
      for (const it of list) {
        if (it.status !== 'done') continue;
        const b64 = typeof it.base64 === 'string' ? it.base64.trim() : '';
        if (!b64) continue;
        const k = `${userId}:${it.key}`;
        if (storedBlobKeysRef.current.has(k)) continue;
        try {
          const bytes = base64ToUint8Array(b64);
          const blob = new Blob([bytes], { type: 'image/png' });
          await putLlmLabImageBlob(userId, it.key, blob);
          storedBlobKeysRef.current.add(k);
        } catch {
          // ignore
        }
      }
    };

    void upsertFrom(imageItems ?? []);
    void upsertFrom(Object.values(batchItems ?? {}));
  }, [batchItems, cacheUserId, imageItems]);

  useEffect(() => {
    allModelsRef.current = allModels ?? [];
  }, [allModels]);

  useEffect(() => {
    selectedModelsRef.current = selectedModels ?? [];
  }, [selectedModels]);

  const imageGenModels = useMemo(() => {
    // 生图沿用“左侧已选模型池”：不区分“已配置/未配置”。
    // - 已配置：modelId 是 llmmodels.id，可从 allModels 回查更多信息
    // - 未配置：modelId 可能是 modelName（见 ModelPickerDialog 的注释），这时需用 platformId+modelName 回退调用
    const enabledById = new Map<string, Model>();
    for (const m of allModels ?? []) {
      if (!m.enabled) continue;
      enabledById.set(m.id, m);
    }

    const list: { modelId: string; platformId: string; modelName: string; displayName: string }[] = [];
    const seen = new Set<string>();
    for (const sm of selectedModels ?? []) {
      // 临时禁用：生图也要尊重左侧“禁用模型”开关（与大模型实验保持一致）
      if (disabledModelKeys[modelKeyOfSelected(sm)]) continue;

      const pid = String(sm.platformId ?? '').trim();
      const mname = String(sm.modelName ?? '').trim();
      const mid = String(sm.modelId ?? '').trim();
      if (!pid || !mname || !mid) continue;

      const cfg = enabledById.get(mid) ?? null;
      const key = cfg ? `cfg:${cfg.id}` : `pool:${pid}:${mname}`;
      if (seen.has(key)) continue;
      seen.add(key);

      list.push({
        modelId: cfg ? cfg.id : mid,
        platformId: cfg ? (cfg.platformId || pid) : pid,
        modelName: cfg ? (cfg.modelName || mname) : mname,
        displayName: (cfg?.name || sm.name || mname || mid).trim(),
      });
    }
    return list;
  }, [allModels, disabledModelKeys, selectedModels]);

  const imageGenModelCount = imageGenModels.length;

  const activeExperiment = useMemo(
    () => experiments.find((e) => e.id === activeExperimentId) ?? null,
    [experiments, activeExperimentId]
  );

  const platformNameById = useMemo(() => {
    return new Map<string, string>((platforms ?? []).map((p) => [p.id, p.name]));
  }, [platforms]);

  const openCreateExperiment = () => {
    setCreateExperimentName('');
    setCreateExperimentOpen(true);
  };

  const confirmCreateExperiment = async () => {
    const name = createExperimentName.trim();
    if (!name) return;
    const created = await createModelLabExperiment({ name, suite: 'intent', params: defaultParams, selectedModels: [] });
    if (!created.success) {
      toast.error(created.error?.message || '创建失败');
      return;
    }
    setExperiments((p) => [created.data, ...p]);
    setActiveExperimentId(created.data.id);
    setCreateExperimentOpen(false);
    setCreateExperimentName('');
  };

  const openLoadExperiment = () => {
    setLoadExperimentId(activeExperimentId);
    setLoadExperimentOpen(true);
  };

  const shortId = (id: string) => (id || '').slice(0, 8);

  const formatDateTime = (iso: string | undefined) => {
    if (!iso) return '-';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleString('zh-CN', { hour12: false });
  };

  const deleteExperiment = async (id: string) => {
    const res = await deleteModelLabExperiment(id);
    if (!res.success) {
      toast.error(res.error?.message || '删除失败');
      return;
    }

    setExperiments((prev) => {
      const remaining = prev.filter((x) => x.id !== id);
      setLoadExperimentId((cur) => (cur === id ? '' : cur));
      setActiveExperimentId((cur) => (cur === id ? (remaining[0]?.id || '') : cur));
      return remaining;
    });
  };

  const confirmLoadExperiment = () => {
    if (!loadExperimentId) return;
    setActiveExperimentId(loadExperimentId);
    setLoadExperimentOpen(false);
  };

  const load = async () => {
    setModelsLoading(true);
    setExperimentsLoading(true);
    try {
      const [m, exps, ps] = await Promise.all([getModels(), listModelLabExperiments({ page: 1, pageSize: 50 }), getPlatforms()]);
      if (m.success) setAllModels(m.data);
      if (exps.success) setExperiments(exps.data.items);
      if (ps.success) setPlatforms(ps.data);

      // 没有实验时，自动创建一个默认实验，方便直接使用
      if (exps.success && exps.data.items.length === 0) {
        const created = await createModelLabExperiment({
          name: '默认实验',
          suite: 'intent',
          selectedModels: [],
          params: defaultParams,
        });
        if (created.success) {
          setExperiments([created.data]);
          setActiveExperimentId(created.data.id);
        }
      } else if (exps.success) {
        setActiveExperimentId((cur) => cur || exps.data.items[0]?.id || '');
      }
    } finally {
      setModelsLoading(false);
      setExperimentsLoading(false);
    }
  };

  const loadModelSets = async () => {
    const res = await listModelLabModelSets({ limit: 100 });
    if (res.success) setModelSets(res.data.items);
  };

  useEffect(() => {
    load();
    loadModelSets();
  }, []);

  useLayoutEffect(() => {
    const el = imageGridEl;
    if (!el) return;

    const parseRatio = (s: string) => {
      const m = String(s || '').trim().match(/^(\d+)\s*x\s*(\d+)$/i);
      const w = m ? Number(m[1]) : 1;
      const h = m ? Number(m[2]) : 1;
      const ww = Number.isFinite(w) && w > 0 ? w : 1;
      const hh = Number.isFinite(h) && h > 0 ? h : 1;
      return { w: ww, h: hh };
    };

    const GAP = 8; // 对应 gap-2
    const MIN_CARD_W = 240;
    const MAX_COLS = 4;

    const recompute = () => {
      const w = el.clientWidth || 0;
      if (w <= 0) return;

      const cols = Math.max(1, Math.min(MAX_COLS, Math.floor((w + GAP) / (MIN_CARD_W + GAP)) || 1));
      const cardW = (w - GAP * (cols - 1)) / cols;
      const ratio = parseRatio(imgSize);
      const h = Math.round(cardW * (ratio.h / ratio.w));

      setImageThumbHeight(Math.max(160, Math.min(420, h)));
    };

    recompute();
    const ro = new ResizeObserver(() => recompute());
    ro.observe(el);
    return () => ro.disconnect();
  }, [imageGridEl, imgSize, mainMode, imageSubMode]);

  useEffect(() => {
    if (!activeExperiment) return;
    // 关键：仅在“切换实验”时才从实验回填到 UI。
    // 否则在用户输入触发自动保存后（experiments 列表刷新导致 activeExperiment 引用变化），会把当前 mode 强行改回 suite（常见为 speed）。
    const isSwitchingExperiment = appliedExperimentIdRef.current !== activeExperiment.id;
    if (!isSwitchingExperiment) return;

    appliedExperimentIdRef.current = activeExperiment.id;

    const normalizedSuite = normalizeSavedSuite(activeExperiment.suite);
    setSuite(normalizedSuite);
    setMode(normalizedSuite);
    setParams(activeExperiment.params ?? defaultParams);
    setPromptText(activeExperiment.promptText ?? '');
    setSelectedModels(activeExperiment.selectedModels ?? []);

    // 同步“已保存快照”，避免首次加载/切换实验就触发自动保存
    const sig = [
      String(activeExperiment.suite ?? ''),
      JSON.stringify(activeExperiment.params ?? defaultParams),
      String(activeExperiment.promptText ?? ''),
      signatureOfSelectedModels(activeExperiment.selectedModels ?? []),
    ].join('||');
    lastSavedSigRef.current = sig;
    lastSavedExperimentIdRef.current = activeExperiment.id;
  }, [activeExperiment]);

  const setSelectedModelsDedupe = (list: ModelLabSelectedModel[]) => {
    // 唯一选择：平台 + modelId
    const map = new Map<string, ModelLabSelectedModel>();
    for (const m of list) {
      const pid = String(m.platformId ?? '').trim();
      const mid = String((m as any).modelId ?? m.modelName ?? '').trim();
      if (!pid || !mid) continue;
      const key = `${pid}:${mid}`.toLowerCase();
      if (!map.has(key)) map.set(key, m);
    }
    setSelectedModels(Array.from(map.values()));
  };

  const removeSelectedModel = (m: Pick<ModelLabSelectedModel, 'platformId' | 'modelId'>) => {
    const pid = String(m.platformId ?? '').trim();
    const mid = String(m.modelId ?? '').trim();
    if (!pid || !mid) return;
    setSelectedModels((prev) => prev.filter((x) => modelKeyOfSelected(x) !== `${pid}:${mid}`.toLowerCase()));
  };

  const toggleDisabledSelectedModel = (m: ModelLabSelectedModel) => {
    const key = modelKeyOfSelected(m);
    if (!key) return;
    setDisabledModelKeys((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const saveExperiment = async (opts?: { silent?: boolean }) => {
    if (!activeExperimentId) return;
    try {
      const res = await updateModelLabExperiment(activeExperimentId, {
        suite,
        promptText,
        selectedModels,
        params,
      });
      if (!res.success) {
        if (!opts?.silent) toast.error(res.error?.message || '保存失败');
        return;
      }
      // 刷新本地列表
      setExperiments((prev) => prev.map((e) => (e.id === res.data.id ? res.data : e)));
    } finally {
      // no-op
    }
  };

  useEffect(() => {
    if (!activeExperimentId) return;
    if (experimentsLoading) return;
    if (modelsLoading) return;

    // 切换实验后，先等上面的 activeExperiment 同步快照
    if (lastSavedExperimentIdRef.current !== activeExperimentId) return;

    // 只对"实验会保存的字段"做自动保存，避免 mode（JSON/MCP/FunctionCall）切换触发保存并被 suite 回填覆盖
    const sig = [String(suite ?? ''), JSON.stringify(params ?? {}), String(promptText ?? ''), signatureOfSelectedModels(selectedModels)].join('||');
    if (sig === lastSavedSigRef.current) return;

    // 如果是模式切换（json/mcp/functionCall）导致的 promptText 变化，只更新签名但不保存
    if (isModeSwitchingRef.current) {
      lastSavedSigRef.current = sig;
      // 这里清除标记，避免 setTimeout 竞争导致“模式切换也触发保存 -> suite 回填 -> mode 跳回 speed”
      isModeSwitchingRef.current = false;
      return;
    }

    // debounce：避免快速点选/输入导致频繁请求
    if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = window.setTimeout(() => {
      void (async () => {
        await saveExperiment({ silent: true });
        lastSavedSigRef.current = sig;
      })();
    }, 650);

    return () => {
      if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeExperimentId, experimentsLoading, modelsLoading, suite, params, promptText, selectedModels]);

  const stopRun = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  };

  const stopBatchRun = (opts?: { forRestart?: boolean }) => {
    if (!opts?.forRestart) batchStopRequestedRef.current = true;
    batchAbortRef.current?.abort();
    batchAbortRef.current = null;
    setBatchRunning(false);
    setBatchActiveModelLabel('');
    // 批量生图停止：同步结束背景运行态
    emitBackdropBusyEnd();
  };

  const clearLabLocalCacheAndResults = useCallback(async () => {
    // 停止流式任务
    stopRun();
    stopBatchRun({ forRestart: true });

    // 清理本地 UI/结果
    setRunItems({});
    setRunError(null);
    setImageItems([]);
    setBatchItems({});
    setPlanResult(null);
    setBatchError(null);
    setImageError(null);
    setSingleGroupId('');
    setSingleSelected({});
    setBatchActiveModelLabel('');
    setDisabledModelKeys({});

    // 清理本地持久化（localStorage + IndexedDB），并释放 blob URL
    try {
      localStorage.removeItem(labCacheKey);
    } catch {
      // ignore
    }
    storedBlobKeysRef.current.clear();
    revokeAllObjectUrls();
    try {
      await clearLlmLabImagesForUser(cacheUserId);
    } catch {
      // ignore
    }

    // 重置部分按钮/排序（避免刷新后“默认值覆盖”与用户期待不一致）
    setMainMode('infer');
    setImageSubMode('single');
    setMode('intent');
    setSuite('intent');
    setSortBy('ttft');
  }, [cacheUserId, labCacheKey, revokeAllObjectUrls]);

  const DEFAULT_IMAGE_PROMPT = '生成一张 Hello Kitty 的图片，卡通风格，纯色背景，高清。';

  const onMainModeChange = (m: MainMode) => {
    // 切换模式时，尽量停止正在进行的流式任务，避免 UI 混乱
    if (m !== 'infer' && running) stopRun();
    if (m !== 'image' && batchRunning) stopBatchRun();
    setMainMode(m);

    // 生图给一个默认示例 prompt（仅在空文本时）
    if (m === 'image') {
      setPromptText((cur) => (cur && cur.trim() ? cur : DEFAULT_IMAGE_PROMPT));
    }
  };

  const startGenerateImage = async () => {
    const prompt = (promptText ?? '').trim();
    if (!prompt) {
      toast.warning('请输入要生图的描述');
      return;
    }
    if (imageGenModels.length === 0) {
      toast.warning('请先在左侧选择至少 1 个模型');
      return;
    }

    const perModelN = Math.max(1, Math.min(20, Number(singleN || 1)));
    const total = perModelN * imageGenModels.length;
    if (total > 3) {
      const ok = await systemDialog.confirm(
        `你将使用 ${imageGenModels.length} 个模型生成 ${perModelN} × ${imageGenModels.length} = ${total} 张图片，是否继续？`
      );
      if (!ok) return;
    }

    setImageError(null);
    setImageRunning(true);
    setSingleSelected({});
    // 单张生图：让全局背景进入运行态（直到生成完成/失败）
    emitBackdropBusyStart();

    const groupId = `single_${Date.now()}`;
    setSingleGroupId(groupId);

    // 先放占位（让布局按数量立即生效）
    setImageItems((prev) => {
      const rest = prev.filter((x) => x.groupId !== groupId);
      const now = Date.now();
      const placeholders: ImageViewItem[] = imageGenModels.flatMap((m, mi) =>
        Array.from({ length: perModelN }).map((_, i) => ({
          key: `${groupId}_${m.modelId}_${i}`,
          groupId,
          variantIndex: i,
          status: 'running' as const,
          prompt,
          size: imgSize,
          requestedSize: imgSize,
          createdAt: now,
          sourceModelId: m.modelId,
          sourceModelName: m.modelName,
          sourceDisplayName: m.displayName,
          sourceModelIndex: mi,
        }))
      );
      return [...placeholders, ...rest];
    });

    // 这里不暴露给用户选择返回格式：默认 b64_json（更利于直接展示/下载，且避免部分网关跨域问题）
    let anyFailed = false;
    try {
    for (const m of imageGenModels) {
      const res = await generateImageGen({
        modelId: m.modelId,
        platformId: m.platformId,
        modelName: m.modelName,
        prompt,
        n: perModelN,
        size: imgSize,
        responseFormat: 'b64_json',
      });
      if (!res.success) {
        anyFailed = true;
        const msg = res.error?.message || '生图失败';
        setImageItems((prev) =>
          prev.map((x) => (x.groupId === groupId && x.sourceModelId === m.modelId ? { ...x, status: 'error', errorMessage: msg } : x))
        );
        continue;
      }

      const images = (res.data?.images ?? []) as ImageGenGenerateResponse['images'];
      const meta = res.data?.meta ?? null;
      setImageItems((prev) => {
        return prev.map((x) => {
          if (x.groupId !== groupId) return x;
          if (x.sourceModelId !== m.modelId) return x;
          const idx = typeof x.variantIndex === 'number' ? x.variantIndex : 0;
          const img = images[idx];
          if (!img) return { ...x, status: 'error', errorMessage: '未返回对应图片' };
          return {
            ...x,
            status: 'done',
            base64: (img as any).base64 ?? null,
            url: (img as any).url ?? null,
            revisedPrompt: (img as any).revisedPrompt ?? null,
            requestedSize: String(meta?.requestedSize ?? x.requestedSize ?? imgSize),
            effectiveSize: String(meta?.effectiveSize ?? x.effectiveSize ?? ''),
            sizeAdjusted: Boolean(meta?.sizeAdjusted ?? false),
            ratioAdjusted: Boolean(meta?.ratioAdjusted ?? false),
          };
        });
      });
    }
    if (anyFailed) setImageError('部分模型生成失败（请查看对应图片卡片）');
    } finally {
    setImageRunning(false);
      emitBackdropBusyEnd();
    }
  };

  const startFullSizeGeneration = async () => {
    const prompt = (promptText ?? '').trim();
    if (!prompt) {
      toast.warning('请输入图片描述');
      return;
    }
    if (imageGenModels.length === 0) {
      toast.warning('请先在左侧选择至少 1 个模型');
      return;
    }

    // 生成 30 种尺寸（10 比例 × 3 档）
    const allSizes: Array<{ aspectId: string; tier: string; size: string }> = [];
    for (const opt of NEW_ASPECT_OPTIONS) {
      allSizes.push({ aspectId: opt.id, tier: '1k', size: opt.size1k });
      allSizes.push({ aspectId: opt.id, tier: '2k', size: opt.size2k });
      allSizes.push({ aspectId: opt.id, tier: '4k', size: opt.size4k });
    }

    const ok = await systemDialog.confirm(`将使用 ${imageGenModels.length} 个模型生成 30 × ${imageGenModels.length} = ${30 * imageGenModels.length} 张图片，是否继续？`);
    if (!ok) return;

    setFullSizeRunning(true);
    setFullSizeItems({});

    try {
      for (const m of imageGenModels) {
        for (const { size, aspectId, tier } of allSizes) {
          if (fullSizeAbortRef.current?.signal.aborted) break;
          
          const key = `full_${m.modelId}_${aspectId}_${tier}_${Date.now()}`;
          const newItem: ImageViewItem = {
            key,
            groupId: 'fullSize',
            status: 'running',
            prompt,
            createdAt: Date.now(),
            sourceModelId: m.modelId,
            sourceModelName: m.modelName,
            sourceDisplayName: m.displayName,
            size,
          };
          
          setFullSizeItems((prev) => ({ ...prev, [key]: newItem }));

          try {
            const res = await generateImageGen({ prompt, n: 1, size, modelId: m.modelId });
            if (!res.success) throw new Error(res.error?.message || '生成失败');
            
            const asset = (res.data as any)?.asset;
            const url = asset?.url || (res.data as any)?.url || '';
            const updated: ImageViewItem = { ...newItem, status: 'done', url };
            setFullSizeItems((prev) => ({ ...prev, [key]: updated }));
          } catch (err: any) {
            const updated: ImageViewItem = { ...newItem, status: 'error', errorMessage: String(err?.message || err || '生成失败') };
            setFullSizeItems((prev) => ({ ...prev, [key]: updated }));
          }
        }
        if (fullSizeAbortRef.current?.signal.aborted) break;
      }
    } finally {
      setFullSizeRunning(false);
    }
  };

  const parseBatchPlan = async () => {
    const text = (promptText ?? '').trim();
    if (!text) {
      toast.warning('请输入要批量生图的描述');
      return;
    }
    if (imageGenModels.length === 0) {
      toast.warning('请先在左侧选择至少 1 个模型');
      return;
    }

    setBatchError(null);
    setPlanLoading(true);
    emitBackdropBusyStart();
    let nextPlan: ImageGenPlanResponse | null = null;
    let stopId: string | null = null;
    try {
      const sp = String(imageGenPlanSystemPromptText ?? '').trim();
      const res = await planImageGen({ text, maxItems: 10, systemPromptOverride: sp || undefined });
      if (!res.success) {
        setBatchError(res.error?.message || '解析失败');
        return;
      }
      nextPlan = res.data ?? null;
      // 批量场景：从每条 prompt 里解析尺寸/比例（如 "1080x1350（4:5）"），并写入 item.size（单条覆盖）
      if (nextPlan?.items?.length) {
        nextPlan = {
          ...nextPlan,
          items: nextPlan.items.map((it) => {
            const existingSize = String(it.size ?? '').trim();
            if (existingSize) return { ...it, size: existingSize };
            const meta = parsePromptSizeMeta(it.prompt);
            return meta.size ? { ...it, size: meta.size } : it;
          }),
        };
      }
    } finally {
      setPlanLoading(false);
      stopId = emitBackdropBusyEnd() || null;
    }
    if (nextPlan) {
      setPlanResult(nextPlan);
      // 顺序：先请求背景 stop（刹车到停）-> 背景完全停止后再弹窗
      if (stopId) await waitForBackdropBusyStopped(stopId, 2800);
      setPlanDialogOpen(true);
    }
  };

  const startBatchFromPlan = async () => {
    if (!planResult) return;
    if (imageGenModels.length === 0) {
      toast.warning('请先在左侧选择至少 1 个模型');
      return;
    }

    const planTotal = Math.max(0, Number(planResult.total || 0));
    const total = planTotal * imageGenModels.length;
    if (total > 3) {
      const ok = await systemDialog.confirm(
        `你将使用 ${imageGenModels.length} 个模型生成 ${planTotal} × ${imageGenModels.length} = ${total} 张图片，是否继续？`
      );
      if (!ok) return;
    }

    stopBatchRun({ forRestart: true });
    batchStopRequestedRef.current = false;
    setBatchError(null);
    setBatchItems({});
    setPlanDialogOpen(false);
    setBatchRunning(true);
    emitBackdropBusyStart();

    const items = (planResult.items ?? []) as ImageGenPlanItem[];
    try {
    for (const m of imageGenModels) {
      if (batchStopRequestedRef.current) break;
      setBatchActiveModelLabel(m.displayName);
      const ac = new AbortController();
      batchAbortRef.current = ac;

      const res = await runImageGenBatchStream({
        input: { modelId: m.modelId, platformId: m.platformId, modelName: m.modelName, items, size: imgSize, responseFormat: 'b64_json', maxConcurrency: params.maxConcurrency },
        signal: ac.signal,
        onEvent: (evt) => {
          if (!evt.data) return;
          try {
            const obj = JSON.parse(evt.data);
            const evtModelId = String(obj.modelId ?? m.modelId ?? '').trim() || m.modelId;
            if (evt.event === 'run') {
              if (obj.type === 'error') {
                setBatchError(obj.errorMessage || '批量生图失败');
                batchStopRequestedRef.current = true;
                setBatchRunning(false);
                setBatchActiveModelLabel('');
                return;
              }
              return;
            }
            if (evt.event === 'image') {
              const key = `${evtModelId}_${obj.itemIndex ?? 0}-${obj.imageIndex ?? 0}`;
              if (obj.type === 'imageStart') {
                const reqSize = String(obj.requestedSize ?? obj.size ?? '').trim() || imgSize;
                const item: ImageViewItem = {
                  key,
                  status: 'running',
                  prompt: String(obj.prompt ?? ''),
                  size: reqSize,
                  requestedSize: reqSize,
                  createdAt: Date.now(),
                  itemIndex: Number(obj.itemIndex ?? 0),
                  imageIndex: Number(obj.imageIndex ?? 0),
                  sourceModelId: m.modelId,
                  sourceModelName: m.modelName,
                  sourceDisplayName: m.displayName,
                };
                setBatchItems((p) => ({ ...p, [key]: item }));
                return;
              }
              if (obj.type === 'imageDone') {
                setBatchItems((p) => {
                  const reqSize = String(obj.requestedSize ?? obj.size ?? '').trim() || imgSize;
                  const effSize = String(obj.effectiveSize ?? '').trim() || undefined;
                  const cur = p[key] || {
                    key,
                    createdAt: Date.now(),
                    prompt: String(obj.prompt ?? ''),
                    status: 'running' as const,
                    itemIndex: Number(obj.itemIndex ?? 0),
                    imageIndex: Number(obj.imageIndex ?? 0),
                    sourceModelId: m.modelId,
                    sourceModelName: m.modelName,
                    sourceDisplayName: m.displayName,
                    size: reqSize,
                    requestedSize: reqSize,
                    effectiveSize: effSize,
                  };
                  return {
                    ...p,
                    [key]: {
                      ...cur,
                      status: 'done',
                      base64: obj.base64 ?? null,
                      url: obj.url ?? null,
                      revisedPrompt: obj.revisedPrompt ?? null,
                      size: effSize || reqSize || cur.size,
                      requestedSize: reqSize || cur.requestedSize,
                      effectiveSize: effSize || cur.effectiveSize,
                      sizeAdjusted: Boolean(obj.sizeAdjusted ?? cur.sizeAdjusted ?? false),
                      ratioAdjusted: Boolean(obj.ratioAdjusted ?? cur.ratioAdjusted ?? false),
                    },
                  };
                });
                return;
              }
              if (obj.type === 'imageError') {
                setBatchItems((p) => {
                  const reqSize = String(obj.requestedSize ?? obj.size ?? '').trim() || imgSize;
                  const cur = p[key] || {
                    key,
                    createdAt: Date.now(),
                    prompt: String(obj.prompt ?? ''),
                    status: 'running' as const,
                    itemIndex: Number(obj.itemIndex ?? 0),
                    imageIndex: Number(obj.imageIndex ?? 0),
                    sourceModelId: m.modelId,
                    sourceModelName: m.modelName,
                    sourceDisplayName: m.displayName,
                    size: reqSize,
                    requestedSize: reqSize,
                  };
                  return {
                    ...p,
                    [key]: {
                      ...cur,
                      status: 'error',
                      errorMessage: obj.errorMessage || '失败',
                      size: reqSize || cur.size,
                      requestedSize: reqSize || cur.requestedSize,
                    },
                  };
                });
                return;
              }
            }
          } catch {
            // ignore
          }
        },
      });

      if (!res.success) {
        setBatchError(res.error?.message || '批量生图失败');
        setBatchRunning(false);
        setBatchActiveModelLabel('');
        return;
      }
    }
    } finally {
    batchAbortRef.current = null;
    setBatchRunning(false);
    setBatchActiveModelLabel('');
      emitBackdropBusyEnd();
    }
  };

  const resolveConfigModelId = (evtModelId: unknown, evtModelName: unknown): string | null => {
    const id = String(evtModelId ?? '').trim();
    const name = String(evtModelName ?? '').trim();

    if (!id && !name) return null;

    // 1) 优先：evtModelId 就是配置模型 id
    if (id && allModelsRef.current.some((m) => m.id === id)) return id;

    // 2) 次优：用 modelName 回查（当前实验里一般唯一）
    if (name) {
      const lower = name.toLowerCase();
      const byName =
        allModelsRef.current.find((m) => (m.modelName || '').toLowerCase() === lower) ??
        selectedModelsRef.current.find((m) => (m.modelName || '').toLowerCase() === lower);

      if (byName) return (byName as any).id ?? (byName as any).modelId ?? null;
    }

    // 3) 兜底：如果实验里恰好有 modelId 与 evtModelId 一致
    if (id) {
      const bySelected = selectedModelsRef.current.find((m) => m.modelId === id);
      if (bySelected) return bySelected.modelId;
    }

    return null;
  };

  const startRun = async () => {
    if (!activeExperimentId) {
      toast.warning('请先选择实验');
      return;
    }
    if (selectedModels.length === 0) {
      toast.warning('请先加入至少 1 个模型');
      return;
    }

    // 安全提示：如果选中列表里包含“生图模型”，一键实验可能造成较高费用/更长耗时（尤其在生图相关套件）
    const imageGenModelIds = new Set(allModelsRef.current.filter((m) => (m as any).isImageGen).map((m) => m.id));
    const imageGenModelNames = new Set(
      allModelsRef.current
        .filter((m) => (m as any).isImageGen)
        .map((m) => String(m.modelName ?? '').trim().toLowerCase())
        .filter(Boolean)
    );
    const hasImageGenSelected = (selectedModels ?? []).some(
      (sm) => imageGenModelIds.has(sm.modelId) || (sm.modelName ? imageGenModelNames.has(String(sm.modelName).trim().toLowerCase()) : false)
    );
    if (hasImageGenSelected) {
      const ok = await systemDialog.confirm('检测到已选择模型中包含“生图模型”。一键开始实验可能导致更长耗时/更高费用，是否继续？');
      if (!ok) return;
    }

    // 临时禁用：本次运行只跑"未禁用模型"，不改实验配置
    const enabledModels = (selectedModels ?? []).filter((m) => !disabledModelKeys[modelKeyOfSelected(m)]);
    if (enabledModels.length === 0) {
      toast.warning('当前已将所有模型临时禁用，请先点击模型恢复至少 1 个再运行');
      return;
    }

    setRunError(null);
    setRunItems({});
    stopRun();
    setRunning(true);
    const ac = new AbortController();
    abortRef.current = ac;

    // 运行前先保存一次实验配置
    await saveExperiment();

    const res = await runModelLabStream({
      input: {
        experimentId: activeExperimentId,
        suite,
        expectedFormat,
        // 若显式传 models，则后端将以此作为“本次运行模型列表”（用于临时禁用/过滤），不会写入实验
        models: enabledModels,
        ...(expectedFormat === 'imageGenPlan'
          ? {
              imagePlanMaxItems: 10,
              systemPromptOverride: String(imageGenPlanSystemPromptText ?? '').trim() || undefined,
              includeMainModelAsStandard: true,
            }
          : {}),
        promptText,
        params,
      },
      signal: ac.signal,
      onEvent: (evt) => {
        if (!evt.data) return;
        try {
          const obj = JSON.parse(evt.data);
          if (evt.event === 'run') {
            if (obj.type === 'error') {
              const code = String(obj.errorCode ?? '').trim();
              const msg = String(obj.errorMessage ?? '').trim() || '运行失败';
              setRunError(code ? `[${code}] ${msg}` : msg);
              setRunning(false);
            }
            if (obj.type === 'runDone') {
              setRunning(false);
            }
            return;
          }

          if (evt.event === 'model') {
            if (obj.type === 'modelStart') {
              const configModelId = resolveConfigModelId(obj.modelId, obj.modelName);
              const item: ViewRunItem = {
                itemId: obj.itemId,
                modelId: obj.modelId,
                displayName: obj.displayName || obj.modelName || obj.modelId,
                modelName: obj.modelName || '',
                configModelId: configModelId || undefined,
                status: 'running',
                queueMs: typeof obj.queueMs === 'number' ? Number(obj.queueMs) : undefined,
                repeatIndex: typeof obj.repeatIndex === 'number' ? Number(obj.repeatIndex) : undefined,
                repeatN: typeof obj.repeatN === 'number' ? Number(obj.repeatN) : undefined,
                preview: '',
                rawText: '',
                rawTruncated: false,
              };
              setRunItems((p) => ({ ...p, [item.itemId]: item }));
              return;
            }
            if (obj.type === 'delta' && typeof obj.content === 'string') {
              setRunItems((p) => {
                const cur = p[obj.itemId];
                if (!cur) return p;
                const nextPreview = (cur.preview + obj.content).slice(0, 512);
                const raw = String(cur.rawText ?? '');
                const canAppend = raw.length < MAX_RUN_RAW_CHARS;
                const nextRaw = canAppend ? (raw + obj.content).slice(0, MAX_RUN_RAW_CHARS) : raw;
                const truncated = (cur.rawTruncated ?? false) || (raw.length + obj.content.length > MAX_RUN_RAW_CHARS);
                return { ...p, [obj.itemId]: { ...cur, preview: nextPreview, rawText: nextRaw, rawTruncated: truncated } };
              });
              return;
            }
            if (obj.type === 'firstToken') {
              setRunItems((p) => {
                const cur = p[obj.itemId];
                if (!cur) return p;
                return { ...p, [obj.itemId]: { ...cur, ttftMs: Number(obj.ttftMs) } };
              });
              return;
            }
            if (obj.type === 'modelDone') {
              setRunItems((p) => {
                const cur = p[obj.itemId];
                if (!cur) return p;
                const nextPreview = typeof obj.preview === 'string' ? obj.preview : cur.preview;
                const shouldFillRaw = !String(cur.rawText ?? '').trim() && typeof obj.preview === 'string' && obj.preview.trim().length > 0;
                return {
                  ...p,
                  [obj.itemId]: {
                    ...cur,
                    status: 'done',
                    ttftMs: obj.ttftMs ?? cur.ttftMs,
                    totalMs: obj.totalMs ?? cur.totalMs,
                    preview: nextPreview,
                    rawText: shouldFillRaw ? String(obj.preview) : cur.rawText,
                    repeatIndex: typeof obj.repeatIndex === 'number' ? Number(obj.repeatIndex) : cur.repeatIndex,
                    repeatN: typeof obj.repeatN === 'number' ? Number(obj.repeatN) : cur.repeatN,
                  },
                };
              });
              return;
            }
            if (obj.type === 'modelError') {
              setRunItems((p) => {
                const cur = p[obj.itemId];
                if (!cur) return p;
                const code = String(obj.errorCode ?? '').trim();
                const msg = String(obj.errorMessage ?? '').trim() || '失败';
                const em = code ? `[${code}] ${msg}` : msg;
                return { ...p, [obj.itemId]: { ...cur, status: 'error', errorMessage: em } };
              });
              return;
            }
          }
        } catch {
          // ignore
        }
      },
    });

    if (!res.success) {
      setRunError(res.error?.message || '运行失败');
      setRunning(false);
    }
  };

  const itemsList = useMemo(() => Object.values(runItems), [runItems]);
  const sortedItems = useMemo(() => {
    const list = [...itemsList];
    return list.sort((a, b) => {
      const aTtft = a.ttftMs ?? Number.POSITIVE_INFINITY;
      const bTtft = b.ttftMs ?? Number.POSITIVE_INFINITY;
      const aTotal = a.totalMs ?? Number.POSITIVE_INFINITY;
      const bTotal = b.totalMs ?? Number.POSITIVE_INFINITY;

      if (sortBy === 'imagePlanItemsDesc') {
        const aText = pickRunText(a.rawText, a.preview);
        const bText = pickRunText(b.rawText, b.preview);
        const aLen = getImagePlanItemsLenFromRaw(aText) ?? 0;
        const bLen = getImagePlanItemsLenFromRaw(bText) ?? 0;
        if (aLen !== bLen) return bLen - aLen; // 倒序：条目数越多越靠前
        if (aTtft !== bTtft) return aTtft - bTtft;
        return aTotal - bTotal;
      }

      if (sortBy === 'total') {
        if (aTotal !== bTotal) return aTotal - bTotal;
        return aTtft - bTtft;
      }

      if (aTtft !== bTtft) return aTtft - bTtft;
      return aTotal - bTotal;
    });
  }, [itemsList, sortBy]);

  const failedRunItems = useMemo(() => Object.values(runItems).filter((x) => x.status === 'error'), [runItems]);
  const failedRunCount = failedRunItems.length;

  // suiteValidationSummary 已移除：专项测试由用户显式选择（JSON/MCP/FunctionCall），避免“看上去总失败”的误导。

  const batchList = useMemo(() => {
    return Object.values(batchItems).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }, [batchItems]);

  const batchPlanTotal = useMemo(() => {
    const t = Number((planResult as any)?.total ?? 0);
    if (Number.isFinite(t) && t > 0) return t;
    const items = (planResult as any)?.items;
    return Array.isArray(items) ? items.length : 0;
  }, [planResult]);

  const batchTotal = batchPlanTotal * imageGenModelCount;
  const batchHasFormula = batchPlanTotal > 0 && imageGenModelCount > 0;

  const batchDoneCount = useMemo(() => {
    return batchList.filter((x) => x.status === 'done' && (x.url || x.base64)).length;
  }, [batchList]);

  const batchErrorCount = useMemo(() => {
    return batchList.filter((x) => x.status === 'error').length;
  }, [batchList]);

  const singleList = useMemo(() => {
    const list = (imageItems ?? []).filter((x) => x.groupId === singleGroupId);
    return list.sort(
      (a, b) =>
        Number(a.sourceModelIndex ?? 0) - Number(b.sourceModelIndex ?? 0) ||
        Number(a.variantIndex ?? 0) - Number(b.variantIndex ?? 0)
    );
  }, [imageItems, singleGroupId]);

  const modelById = useMemo(() => new Map<string, Model>((allModels ?? []).map((m) => [m.id, m])), [allModels]);

  const refreshModelsSilent = async () => {
    const m = await getModels();
    if (m.success) setAllModels(m.data);
  };

  const setUniqueFlagLocal = (modelId: string, flag: 'isMain' | 'isIntent' | 'isVision' | 'isImageGen') => {
    // 同类型只允许一个为 true，避免出现多个意图/多个主模型
    setAllModels((prev) => prev.map((m) => ({ ...m, [flag]: m.id === modelId } as any)));
  };

  const onSetMainFromRun = async (modelId: string) => {
    setUniqueFlagLocal(modelId, 'isMain');
    const m = modelById.get(modelId) ?? null;
    if (!m?.platformId || !m.modelName) return await refreshModelsSilent();
    const res = await setMainModel({ platformId: m.platformId, modelId: m.modelName });
    if (!res.success) return await refreshModelsSilent();
    await refreshModelsSilent();
  };

  const onSetIntentFromRun = async (modelId: string) => {
    setUniqueFlagLocal(modelId, 'isIntent');
    const m = modelById.get(modelId) ?? null;
    if (!m?.platformId || !m.modelName) return await refreshModelsSilent();
    const res = await setIntentModel({ platformId: m.platformId, modelId: m.modelName });
    if (!res.success) return await refreshModelsSilent();
    await refreshModelsSilent();
  };

  const onClearIntentFromRun = async () => {
    setAllModels((prev) => prev.map((m) => ({ ...m, isIntent: false } as any)));
    const res = await clearIntentModel();
    if (!res.success) return await refreshModelsSilent();
    await refreshModelsSilent();
  };

  const onClearVisionFromRun = async () => {
    setAllModels((prev) => prev.map((m) => ({ ...m, isVision: false } as any)));
    const res = await clearVisionModel();
    if (!res.success) {
      await refreshModelsSilent();
      toast.error(res.error?.message || '取消视觉模型失败');
      return;
    }
    await refreshModelsSilent();
  };

  const onClearImageGenFromRun = async () => {
    setAllModels((prev) => prev.map((m) => ({ ...m, isImageGen: false } as any)));
    const res = await clearImageGenModel();
    if (!res.success) {
      await refreshModelsSilent();
      toast.error(res.error?.message || '取消生图模型失败');
      return;
    }
    await refreshModelsSilent();
  };

  const onSetVisionFromRun = async (modelId: string) => {
    setUniqueFlagLocal(modelId, 'isVision');
    const m = modelById.get(modelId) ?? null;
    if (!m?.platformId || !m.modelName) return await refreshModelsSilent();
    const res = await setVisionModel({ platformId: m.platformId, modelId: m.modelName });
    if (!res.success) return await refreshModelsSilent();
    await refreshModelsSilent();
  };

  const onSetImageGenFromRun = async (modelId: string) => {
    setUniqueFlagLocal(modelId, 'isImageGen');
    const m = modelById.get(modelId) ?? null;
    if (!m?.platformId || !m.modelName) return await refreshModelsSilent();
    const res = await setImageGenModel({ platformId: m.platformId, modelId: m.modelName });
    if (!res.success) return await refreshModelsSilent();
    await refreshModelsSilent();
  };

  const normalizeModelNameKey = (s: string) => (s || '').trim().toLowerCase();

  const getPlatformIdForRunItem = (evtModelName: string, evtModelId: string): string | null => {
    const nameKey = normalizeModelNameKey(evtModelName);
    const idKey = String(evtModelId ?? '').trim();

    // 优先：从“当前实验已选择模型”里回查 platformId
    const fromSelected =
      (nameKey ? selectedModelsRef.current.find((m) => normalizeModelNameKey(m.modelName) === nameKey) : undefined) ??
      (idKey ? selectedModelsRef.current.find((m) => String(m.modelId ?? '').trim() === idKey) : undefined);
    if (fromSelected?.platformId) return fromSelected.platformId;

    // 次优：从全量配置模型里回查（同 modelName）
    const fromAll = nameKey ? allModelsRef.current.find((m) => normalizeModelNameKey(m.modelName) === nameKey) : undefined;
    if (fromAll?.platformId) return fromAll.platformId;

    return null;
  };

  const ensureConfigModelId = async (it: ViewRunItem): Promise<string | null> => {
    // 以“平台 + 模型id（modelName）”为唯一键；不存在则创建后返回 id
    const evtModelName = (it.modelName || '').trim() || String(it.modelId ?? '').trim();
    const evtModelId = String(it.modelId ?? '').trim();
    const platformId = getPlatformIdForRunItem(evtModelName, evtModelId);
    if (!platformId) return null;

    const nameKey = normalizeModelNameKey(evtModelName);
    const existing =
      allModelsRef.current.find((m) => m.platformId === platformId && normalizeModelNameKey(m.modelName) === nameKey) ??
      null;
    if (existing?.id) return existing.id;

    const created = await createModel({
      name: (it.displayName || evtModelName || evtModelId).trim() || evtModelName || evtModelId,
      modelName: evtModelName,
      platformId,
      enabled: true,
      enablePromptCache: true,
    });
    if (!created.success) {
      await refreshModelsSilent();
      return null;
    }

    // 刷新并回查，保证与后端一致
    await refreshModelsSilent();
    const now =
      allModelsRef.current.find((m) => m.platformId === platformId && normalizeModelNameKey(m.modelName) === nameKey) ??
      (created.data?.id ? allModelsRef.current.find((m) => m.id === created.data.id) : null);
    return now?.id ?? created.data?.id ?? null;
  };

  const ensureAndMark = async (itemId: string): Promise<string | null> => {
    const cur = runItems[itemId];
    if (!cur) return null;
    const id = await ensureConfigModelId(cur);
    if (!id) return null;
    setRunItems((p) => {
      const x = p[itemId];
      if (!x) return p;
      return { ...p, [itemId]: { ...x, configModelId: id } };
    });
    return id;
  };

  const onSetMainFromItem = async (itemId: string) => {
    const id = await ensureAndMark(itemId);
    if (!id) return;
    await onSetMainFromRun(id);
  };

  const onSetIntentFromItem = async (itemId: string) => {
    const id = await ensureAndMark(itemId);
    if (!id) return;
    await onSetIntentFromRun(id);
  };

  const onSetVisionFromItem = async (itemId: string) => {
    const id = await ensureAndMark(itemId);
    if (!id) return;
    await onSetVisionFromRun(id);
  };

  const onSetImageGenFromItem = async (itemId: string) => {
    const id = await ensureAndMark(itemId);
    if (!id) return;
    await onSetImageGenFromRun(id);
  };

  const applyBuiltInPrompt = (p: string) => {
    setPromptText(p);
  };

  const onModeClick = (next: LabMode) => {
    const normalizedNext = normalizeSavedMode(next);
    if (mode !== normalizedNext) {
      // 切换“意图”时，同步 suite（会写入实验）
      if (normalizedNext === 'intent') {
        setSuite('intent');
        isModeSwitchingRef.current = false; // 这些模式会保存，所以允许自动保存
      } else {
        // json/mcp/functionCall/imageGenPlan 只是模板切换，不触发保存
        isModeSwitchingRef.current = true;
      }
      // 生图意图：默认按“识别条目数倒序”排序；其他模式回到 TTFT/总耗时
      if (normalizedNext === 'imageGenPlan') setSortBy('imagePlanItemsDesc');
      else if (sortBy === 'imagePlanItemsDesc') setSortBy('ttft');
      setMode(normalizedNext);
      // 关键：切换模式时不自动塞模板内容，避免用户还没粘贴就要先删一堆字；
      // 如果用户想用内置模板，重复点击当前 mode 会循环填充（见下面分支）。
      // 下一次再点时，从第一条开始循环
      suiteCycleRef.current[normalizedNext] = 0;
      return;
    }

    // 重复点击当前 mode：循环填充内置提示词
    const list = builtInPrompts[normalizedNext] ?? [];
    if (list.length === 0) return;
    const cur = suiteCycleRef.current[normalizedNext] ?? 0;
    const idx = ((cur % list.length) + list.length) % list.length;
    // 重复点击时，如果是 json/mcp/functionCall/imageGenPlan，也不触发保存
    if (normalizedNext === 'json' || normalizedNext === 'mcp' || normalizedNext === 'functionCall' || normalizedNext === 'imageGenPlan') {
      isModeSwitchingRef.current = true;
    }
    applyBuiltInPrompt(list[idx].promptText);
    suiteCycleRef.current[normalizedNext] = (idx + 1) % list.length;
  };

  const saveModelSet = async () => {
    if (selectedModels.length === 0) {
      toast.warning('当前没有已选择的模型');
      return;
    }
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const now = new Date();
    const suggested = `标签组-${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}`;
    const name = (
      (await systemDialog.prompt({ title: '标签组名称', message: '请输入标签组名称', defaultValue: suggested })) ??
      ''
    ).trim();
    if (!name) return;
    const res = await upsertModelLabModelSet({ name, models: selectedModels });
    if (!res.success) {
      toast.error(res.error?.message || '保存失败');
      return;
    }
    await loadModelSets();
  };

  const canRun = !running && selectedModels.length > 0;

  const formatParamChips = useMemo(() => {
    const chips: { key: string; label: string }[] = [];
    const modeLabel =
      mode === 'json'
        ? 'JSON'
        : mode === 'mcp'
          ? 'MCP'
          : mode === 'functionCall'
            ? 'FunctionCall'
            : mode === 'imageGenPlan'
              ? '生图意图'
              : '意图';
    chips.push({ key: 'mode', label: `类型：${modeLabel}` });
    chips.push({ key: 'temperature', label: `温度：${Number.isFinite(params.temperature as any) ? params.temperature : '-'}` });
    if (params.maxTokens != null) chips.push({ key: 'maxTokens', label: `MaxTokens：${params.maxTokens}` });
    chips.push({ key: 'timeout', label: `超时：${Math.round((params.timeoutMs ?? 0) / 1000)}s` });
    chips.push({ key: 'concurrency', label: `并发：${params.maxConcurrency ?? '-'}` });
    chips.push({ key: 'repeat', label: `重复：${params.repeatN ?? '-'}` });
    return chips;
  }, [params, mode]);

  const copyToClipboard = async (text: string) => {
    const t = text ?? '';
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(t);
        return;
      }
    } catch {
      // ignore and fallback
    }
    try {
      const el = document.createElement('textarea');
      el.value = t;
      el.setAttribute('readonly', 'true');
      el.style.position = 'fixed';
      el.style.left = '-9999px';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    } catch {
      // ignore
    }
  };

  return (
    <div className="h-full min-h-0">
      {copyToast ? (
        <div
          key={copyToast.id}
          className="fixed left-1/2 top-[88px] -translate-x-1/2 z-[9999] px-3 py-2 rounded-[12px] text-[13px] font-semibold"
          style={{
            background: 'rgba(0,0,0,0.72)',
            border: '1px solid rgba(255,255,255,0.12)',
            color: 'rgba(255,255,255,0.92)',
            backdropFilter: 'blur(10px)',
            boxShadow: '0 10px 28px rgba(0,0,0,0.35)',
            pointerEvents: 'none',
          }}
        >
          {copyToast.text}
        </div>
      ) : null}
      <div className="h-full min-h-0 grid grid-cols-1 gap-x-5 gap-y-4 lg:grid-cols-[360px_1fr] lg:grid-rows-[auto_1fr]">
        {/* 左上：试验区 */}
        <div className="min-w-0 min-h-0 lg:col-start-1 lg:row-start-1">
          <GlassCard glow accentHue={210} className="lg:h-full">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                试验区
              </div>
              <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                保存实验配置与历史（Mongo）
              </div>
            </div>
            <button
              type="button"
              className="inline-flex items-center justify-center gap-2 font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed h-[30px] px-3 rounded-[10px] text-[12px] text-(--text-primary) hover:bg-white/8 hover:border-white/20 shrink-0"
              style={{ background: 'rgba(255, 255, 255, 0.06)', border: '1px solid rgba(255, 255, 255, 0.12)' }}
              onClick={openCreateExperiment}
              disabled={experimentsLoading}
            >
              <Plus size={14} />
              新建
            </button>
          </div>

          <div className="mt-3">
            <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
              当前实验
            </div>
            <button
              type="button"
              className="h-10 w-full rounded-[14px] px-3 text-sm inline-flex items-center justify-between gap-2"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
              onClick={openLoadExperiment}
              disabled={experimentsLoading}
              title="点击加载实验"
            >
              <span className="min-w-0 truncate">{activeExperiment?.name || '未选择实验'}</span>
              <span className="shrink-0 text-xs" style={{ color: 'var(--text-muted)' }}>
                加载
              </span>
            </button>
          </div>

          <div className="mt-3 grid gap-2 grid-cols-1 sm:grid-cols-2">
            <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
              并发（1-50）
              <input
                type="number"
                value={params.maxConcurrency}
                min={1}
                max={50}
                onChange={(e) => setParams((p) => ({ ...p, maxConcurrency: Math.max(1, Math.min(50, Number(e.target.value || 1))) }))}
                className="mt-1 h-9 w-full rounded-[12px] px-2 text-sm outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
              />
            </label>
            <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
              重复 N 次
              <input
                type="number"
                value={params.repeatN}
                min={1}
                onChange={(e) => setParams((p) => ({ ...p, repeatN: Math.max(1, Number(e.target.value || 1)) }))}
                className="mt-1 h-9 w-full rounded-[12px] px-2 text-sm outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
              />
            </label>
          </div>

          {runError ? (
            <div className="mt-2 text-xs" style={{ color: 'rgba(239,68,68,0.95)' }}>
              {runError}
            </div>
          ) : null}
          </GlassCard>
        </div>

        {/* 左下：自定义模型集合 + 大模型实验 */}
        <div className="min-w-0 min-h-0 lg:col-start-1 lg:row-start-2">
          <GlassCard glow accentHue={270} className="overflow-hidden flex flex-col min-h-0 lg:h-full">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                大模型实验
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" size="xs" className="shrink-0" onClick={() => setPickerOpen(true)} disabled={modelsLoading}>
                <Plus size={16} />
                添加模型
              </Button>
            </div>
          </div>

          {/* 分组/集合 */}
          <div className="mt-4 shrink-0">
            <div className="flex items-center justify-between">
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                自定义模型集合
              </div>
            </div>

            <div className="mt-3">
              {modelSets.length === 0 ? (
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  暂无集合
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {modelSets.map((s) => (
                    <ConfirmTip
                      key={s.id}
                      title="确定将模型增加到试验区?"
                      description={`将集合“${s.name}”中的模型加入当前实验`}
                      confirmText="确定"
                      cancelText="取消"
                      onConfirm={() => setSelectedModelsDedupe([...selectedModels, ...(s.models ?? [])])}
                      side="top"
                      align="start"
                    >
                      <button
                        type="button"
                        className="inline-flex items-center justify-center gap-2 font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed h-[30px] px-3 rounded-[10px] text-[12px] text-(--text-primary) hover:bg-white/8 hover:border-white/20 shrink-0"
                        style={{ background: 'rgba(255, 255, 255, 0.06)', border: '1px solid rgba(255, 255, 255, 0.12)' }}
                        title="将该集合模型加入当前实验"
                      >
                        <Tag size={14} />
                        {s.name}
                      </button>
                    </ConfirmTip>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 已选择模型 */}
          <div className="mt-4 flex-1 min-h-0 flex flex-col">
            <div className="flex items-center justify-between">
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {(() => {
                  const disabled = (selectedModels ?? []).filter((m) => disabledModelKeys[modelKeyOfSelected(m)]).length;
                  return `已选择模型 ${selectedModels.length} 个${disabled > 0 ? `（已禁用 ${disabled}）` : ''}`;
                })()}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="xs" onClick={saveModelSet} disabled={selectedModels.length === 0}>
                  <Save size={14} />
                  保存为标签组
                </Button>
                {modelsLoading ? <Badge variant="subtle">加载中</Badge> : null}
              </div>
            </div>
            <div className="mt-3 flex-1 min-h-0 overflow-auto pr-1">
              {selectedModels.length === 0 ? (
                <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  暂无模型。点击“添加模型”从已配置模型中选择。
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {(() => {
                    // 按 platform 分组（按出现顺序稳定展示）
                    const order: string[] = [];
                    const groups = new Map<string, ModelLabSelectedModel[]>();
                    for (const m of selectedModels) {
                      const pid = String(m.platformId ?? '').trim() || 'unknown';
                      if (!groups.has(pid)) {
                        groups.set(pid, []);
                        order.push(pid);
                      }
                      groups.get(pid)!.push(m);
                    }

                    return order.map((pid) => {
                      const list = groups.get(pid) ?? [];
                      const platformLabel = platformNameById.get(pid) || pid;
                      const disabledCount = list.filter((m) => disabledModelKeys[modelKeyOfSelected(m)]).length;
                      return (
                        <div
                          key={pid}
                          className="rounded-[14px] p-3"
                          style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <PlatformLabel name={platformLabel} />
                              <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                                {list.length} 个{disabledCount > 0 ? `（禁用 ${disabledCount}）` : ''}
                              </div>
                            </div>
                          </div>

                          <div className="mt-2 flex flex-col gap-2">
                            {list.map((m) => {
                              const isDisabled = !!disabledModelKeys[modelKeyOfSelected(m)];
                              const mid = String((m as any).modelId ?? m.modelName ?? '').trim();
                              const rowKey = modelKeyOfSelected({ ...(m as any), modelId: mid });
                              return (
                                <div
                                  key={rowKey}
                                  role="button"
                                  tabIndex={0}
                                  className={cn(
                                    'w-full rounded-[12px] px-3 py-[6px] text-xs flex items-center justify-between gap-3 min-w-0',
                                    'transition-[transform,filter,background-color,border-color] duration-150',
                                    isDisabled ? 'hover:brightness-[1.03]' : 'hover:-translate-y-px hover:brightness-[1.06]'
                                  )}
                                  style={{
                                    border: isDisabled ? '1px solid rgba(255,255,255,0.06)' : '1px solid rgba(255,255,255,0.10)',
                                    background: isDisabled ? 'rgba(255,255,255,0.01)' : 'rgba(255,255,255,0.02)',
                                    color: isDisabled ? 'var(--text-muted)' : 'var(--text-primary)',
                                    opacity: isDisabled ? 0.78 : 1,
                                  }}
                                  onClick={() => toggleDisabledSelectedModel(m)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault();
                                      toggleDisabledSelectedModel(m);
                                    }
                                  }}
                                  title={mid}
                                >
                                  <span className="flex items-center gap-2 min-w-0">
                                    <span
                                      className="min-w-0 truncate"
                                      style={{
                                        color: isDisabled ? 'var(--text-muted)' : 'var(--text-primary)',
                                        textDecoration: isDisabled ? 'line-through' : 'none',
                                      }}
                                    >
                                      {mid}
                                    </span>
                                  </span>
                                  <button
                                    type="button"
                                    className="shrink-0 inline-flex items-center justify-center h-7 w-7 rounded-[10px] transition-colors hover:bg-white/6"
                                    style={{ border: '1px solid rgba(255,255,255,0.10)', color: 'var(--text-muted)' }}
                                    title="从实验中移除该模型"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      removeSelectedModel({ platformId: m.platformId, modelId: mid });
                                      const k = modelKeyOfSelected(m);
                                      if (k)
                                        setDisabledModelKeys((p) => {
                                          if (!p[k]) return p;
                                          const next = { ...p };
                                          delete next[k];
                                          return next;
                                        });
                                    }}
                                    aria-label="移除模型"
                                  >
                                    ×
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </div>
          </div>
          </GlassCard>
        </div>

        {/* 右上：提示词 */}
        <div className="min-w-0 min-h-0 lg:col-start-2 lg:row-start-1">
          <GlassCard glow variant="gold" className="lg:h-full">
          {/* Row 1: 一行放所有“切换/动作”按钮（避免堆叠） */}
          <div className="flex items-start justify-between gap-3 min-w-0">
            <div className="min-w-0 flex-1 overflow-x-auto pr-1">
              <div className="inline-flex items-center gap-2 w-max">
                <GlassSwitch
                  options={[
                    { key: 'infer', label: '推理' },
                    { key: 'image', label: '生图' },
                  ]}
                  value={mainMode}
                  onChange={(key) => onMainModeChange(key as MainMode)}
                  accentHue={45}
                />

                {mainMode === 'infer' ? (
                  <GlassSwitch
                    options={[
                      { key: 'intent', label: '意图' },
                      { key: 'json', label: 'JSON' },
                      { key: 'mcp', label: 'MCP' },
                      { key: 'functionCall', label: 'FunctionCall' },
                      { key: 'imageGenPlan', label: '生图意图' },
                    ]}
                    value={mode}
                    onChange={(key) => onModeClick(key as LabMode)}
                    accentHue={45}
                  />
                ) : (
                  <div className="inline-flex items-center gap-2 w-max">
                    <GlassSwitch
                      options={[
                        { key: 'single', label: '单张' },
                        { key: 'batch', label: '批量' },
                        { key: 'fullSize', label: '全尺寸' },
                      ]}
                      value={imageSubMode}
                      onChange={(key) => setImageSubMode(key as ImageSubMode)}
                      accentHue={45}
                    />
                    {imageSubMode === 'single' ? (
                      <label className="text-xs shrink-0" style={{ color: 'var(--text-muted)' }}>
                        数量
                        <input
                          type="number"
                          value={singleN}
                          min={1}
                          max={20}
                          onChange={(e) => setSingleN(Math.max(1, Math.min(20, Number(e.target.value || 1))))}
                          className="ml-2 h-[28px] w-[64px] rounded-[10px] px-2 text-[12px] outline-none"
                          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                        />
                      </label>
                    ) : null}
                    <div className="flex items-center gap-2 shrink-0">
                      <div className="text-xs font-semibold leading-[28px]" style={{ color: 'var(--text-muted)' }}>
                        图片比例
                      </div>
                      <DropdownMenu.Root>
                        <DropdownMenu.Trigger asChild>
                          <button
                            type="button"
                            className="shrink-0 h-[28px] rounded-[10px] px-2 transition-colors inline-flex items-center gap-2 hover:bg-white/6"
                            style={{
                              background: 'rgba(255,255,255,0.03)',
                              border: '1px solid rgba(255,255,255,0.10)',
                              color: 'var(--text-primary)',
                            }}
                            aria-label="选择图片比例"
                            title="选择图片比例"
                          >
                            <span
                              className="rounded-[6px] flex items-center justify-center shrink-0"
                              style={{
                                width: 16,
                                height: 16,
                                border: '1px solid rgba(255,255,255,0.12)',
                                background: 'rgba(255,255,255,0.02)',
                              }}
                            >
                              <span
                                style={{
                                  width: Math.max(6, Math.round(currentAspectOpt.iconW * 0.55)),
                                  height: Math.max(6, Math.round(currentAspectOpt.iconH * 0.55)),
                                  borderRadius: 4,
                                  border: '2px solid rgba(255,255,255,0.22)',
                                  background: 'rgba(255,255,255,0.02)',
                                }}
                              />
                            </span>
                            <span className="text-[11px] font-semibold whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
                              {currentAspectOpt.label}
                            </span>
                            <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} />
                          </button>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content
                            side="bottom"
                            align="start"
                            sideOffset={8}
                            className="rounded-[12px] p-1 min-w-[200px]"
                            style={{
                              zIndex: 90,
                              ...glassPanel,
                            }}
                          >
                            {ASPECT_OPTIONS.map((opt) => {
                              const active = imgSize === opt.size;
                              const scale = 0.6;
                              return (
                                <DropdownMenu.Item
                                  key={opt.id}
                                  className="flex items-center justify-between gap-3 rounded-[10px] px-2 py-2 text-sm outline-none cursor-pointer hover:bg-white/5"
                                  style={{ color: 'var(--text-primary)' }}
                                  onSelect={() => setImgSize(opt.size)}
                                >
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span
                                      className="rounded-[8px] flex items-center justify-center shrink-0"
                                      style={{
                                        width: 22,
                                        height: 22,
                                        border: '1px solid rgba(255,255,255,0.12)',
                                        background: 'rgba(255,255,255,0.02)',
                                      }}
                                    >
                                      <span
                                        style={{
                                          width: Math.max(6, Math.round(opt.iconW * scale)),
                                          height: Math.max(6, Math.round(opt.iconH * scale)),
                                          borderRadius: 5,
                                          border: '2px solid rgba(255,255,255,0.22)',
                                          background: 'rgba(255,255,255,0.02)',
                                        }}
                                      />
                                    </span>
                                    <div className="min-w-0">
                                      <div className="text-[12px] font-semibold leading-tight">{opt.label}</div>
                                      <div className="text-[11px] leading-tight" style={{ color: 'var(--text-muted)' }}>
                                        {opt.size}
                                      </div>
                                    </div>
                                  </div>
                                  {active ? <Check size={14} style={{ color: 'rgba(250,204,21,0.95)' }} /> : null}
                                </DropdownMenu.Item>
                              );
                            })}
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Root>
                    </div>
                    {imageSubMode === 'batch' && planResult ? (
                      <span className="text-xs shrink-0" style={{ color: 'var(--text-muted)' }}>
                        已解析：{planResult.total} 张
                      </span>
                    ) : null}
                  </div>
                )}
              </div>
            </div>

            <div className="flex gap-2 shrink-0">
              {mainMode === 'infer' ? (
                <SuccessConfettiButton
                  title="一键开始实验"
                  size="md"
                  readyText="一键开始实验"
                  loadingText="运行中"
                  showLoadingText
                  successText="OK"
                  onAction={startRun}
                  onCancel={stopRun}
                  disabled={!canRun || !activeExperimentId}
                />
              ) : imageSubMode === 'single' ? (
                <>
                  <Button variant="primary" size="md" onClick={startGenerateImage} disabled={imageRunning}>
                    <ImagePlus size={16} />
                    {imageRunning ? '生成中' : `生成 ${Math.max(1, Math.min(20, Number(singleN || 1)))} 张`}
                  </Button>
                  <Button
                    variant="secondary"
                    size="md"
                    onClick={() => {
                      void clearLabLocalCacheAndResults();
                    }}
                    disabled={imageRunning || imageItems.length === 0}
                  >
                    清空
                  </Button>
                </>
              ) : imageSubMode === 'batch' ? (
                <Button
                  variant={batchRunning ? 'danger' : 'primary'}
                  size="md"
                  onClick={() => (batchRunning ? stopBatchRun() : void parseBatchPlan())}
                  disabled={planLoading}
                >
                  <Sparkles size={16} />
                  {batchRunning ? '停止' : planLoading ? '解析中' : '解析并预览'}
                </Button>
              ) : (
                <>
                  <Button
                    variant="primary"
                    size="md"
                    onClick={() => void startFullSizeGeneration()}
                    disabled={fullSizeRunning}
                  >
                    <Layers size={16} />
                    {fullSizeRunning ? '生成中' : '生成全部 30 张'}
                  </Button>
                  <Button
                    variant="secondary"
                    size="md"
                    onClick={() => {
                      setFullSizeItems({});
                    }}
                    disabled={fullSizeRunning || Object.keys(fullSizeItems).length === 0}
                  >
                    清空
                  </Button>
                </>
              )}
            </div>
          </div>

          {/* Row 2: 一行文本（状态/输出要求） */}
          <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
            {mainMode === 'infer'
              ? `当前：推理 · 类型：${mode === 'intent' ? '意图' : mode === 'imageGenPlan' ? '生图意图' : mode}`
              : `当前：生图 · ${imageSubMode === 'single' ? '单张' : imageSubMode === 'batch' ? '批量' : '全尺寸'}${imageSubMode === 'single' ? ` · 比例：${imgSize}` : ''}`}
          </div>

          {/* Row 3: 按钮一排 -> 标题一排 -> 文本框一排 */}
          <div className="mt-3">
            {/* 3.1 按钮一排（系统提示词操作） */}
            {shouldShowImageGenPlanPromptSplit && imageGenPlanSystemPromptUnlocked ? (
              <div className="flex items-center gap-2 flex-nowrap overflow-x-auto pr-1">
                <Button
                  size="xs"
                  variant="secondary"
                  className="shrink-0"
                  disabled={imageGenPlanSystemPromptLoading}
                  onClick={async () => {
                    if (imageGenPlanSystemPromptDirty) {
                      const ok = await systemDialog.confirm('将丢弃未保存的系统提示词修改并从后端重新加载，是否继续？');
                      if (!ok) return;
                    }
                    await loadImageGenPlanSystemPrompt({ force: true });
                  }}
                >
                  <ScanEye size={14} />
                  刷新
                </Button>
                <Button
                  size="xs"
                  variant="secondary"
                  className="shrink-0"
                  disabled={imageGenPlanSystemPromptLoading || !String(imageGenPlanSystemPromptDefaultText ?? '').trim()}
                  onClick={() => {
                    setImageGenPlanSystemPromptText(String(imageGenPlanSystemPromptDefaultText ?? ''));
                  }}
                >
                  <Copy size={14} />
                  复制默认
                </Button>
                <Button
                  size="xs"
                  variant="secondary"
                  className="shrink-0"
                  disabled={imageGenPlanSystemPromptLoading}
                  onClick={async () => {
                    const ok = await systemDialog.confirm('将恢复为默认系统提示词（并清除已保存覆盖），是否继续？');
                    if (!ok) return;
                    await resetImageGenPlanSystemPrompt();
                  }}
                >
                  <Trash2 size={14} />
                  恢复默认
                </Button>
                <Button
                  size="xs"
                  variant="primary"
                  className="shrink-0"
                  disabled={imageGenPlanSystemPromptLoading || !imageGenPlanSystemPromptDirty}
                  onClick={async () => {
                    await saveImageGenPlanSystemPrompt();
                  }}
                >
                  <Save size={14} />
                  保存
                </Button>
              </div>
            ) : null}

            {shouldShowImageGenPlanPromptSplit ? (
              <>
                {/* 3.2 标题一排（分别位于各自文本框上方；不要把文字堆在一起） */}
                <div className={cn('grid grid-cols-1 lg:grid-cols-2 gap-3', 'mt-3')}>
                  <div className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                    系统提示词
                  </div>
                  <div className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                    用户输入
                  </div>
                </div>

                {/* 3.3 文本框一排 */}
                <div className="mt-2 grid grid-cols-1 lg:grid-cols-2 gap-3">
                  <div className="min-w-0">
                    <div className="relative">
                    <textarea
                      ref={imageGenPlanSystemPromptRef}
                      value={imageGenPlanSystemPromptText}
                      onChange={(e) => setImageGenPlanSystemPromptText(e.target.value)}
                      className="h-36 w-full rounded-[14px] px-3 py-2 text-[12px] outline-none resize-none disabled:opacity-60"
                      style={{
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(255,255,255,0.12)',
                        color: 'var(--text-primary)',
                      }}
                      placeholder="系统提示词"
                      disabled={!imageGenPlanSystemPromptUnlocked}
                    />

                    {!imageGenPlanSystemPromptUnlocked ? (
                      <div
                        className="absolute inset-0 rounded-[14px] flex items-center justify-center"
                        style={{
                          background: 'rgba(0,0,0,0.35)',
                          border: '1px solid rgba(255,255,255,0.10)',
                          backdropFilter: 'blur(6px)',
                        }}
                      >
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => {
                            setImageGenPlanSystemPromptUnlocked(true);
                            // 下一帧 focus，避免被 overlay 阻挡
                            requestAnimationFrame(() => imageGenPlanSystemPromptRef.current?.focus());
                          }}
                        >
                          解锁
                        </Button>
                      </div>
                    ) : null}
                    </div>
                    <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      状态：{imageGenPlanSystemPromptIsOverridden ? '已覆盖' : '默认'}
                      {imageGenPlanSystemPromptUpdatedAt ? ` · updatedAt=${imageGenPlanSystemPromptUpdatedAt}` : ''}
                      {typeof imageGenPlanSystemPromptText === 'string' ? ` · ${imageGenPlanSystemPromptText.length} chars` : ''}
                    </div>
                  </div>

                  <div className="min-w-0">
                    <textarea
                      value={promptText}
                      onChange={(e) => setPromptText(e.target.value)}
                      onKeyDown={(e) => {
                        // 部分 WebView/快捷键拦截环境下 Cmd/Ctrl+A 可能失效，这里兜底强制全选
                        if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
                          e.preventDefault();
                          (e.currentTarget as HTMLTextAreaElement).select();
                        }
                      }}
                      className="h-36 w-full rounded-[14px] px-3 py-2 text-sm outline-none resize-none"
                      style={{
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(255,255,255,0.12)',
                        color: 'var(--text-primary)',
                      }}
                      placeholder={mainMode === 'infer' ? '输入或粘贴内容' : imageSubMode === 'single' ? '输入图片描述' : imageSubMode === 'batch' ? '输入需求描述' : '输入图片描述（将生成 10 比例 × 3 档 = 30 张）'}
                    />
                  </div>
                </div>
              </>
            ) : (
              <>
                {/* 单张（以及不需要解析时）：隐藏系统提示词，仅保留用户输入 */}
                <div className="mt-3 text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                  用户输入
                </div>
                <textarea
                  value={promptText}
                  onChange={(e) => setPromptText(e.target.value)}
                  onKeyDown={(e) => {
                    // 部分 WebView/快捷键拦截环境下 Cmd/Ctrl+A 可能失效，这里兜底强制全选
                    if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
                      e.preventDefault();
                      (e.currentTarget as HTMLTextAreaElement).select();
                    }
                  }}
                  className="mt-2 h-36 w-full rounded-[14px] px-3 py-2 text-sm outline-none resize-none"
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    color: 'var(--text-primary)',
                  }}
                  placeholder={mainMode === 'infer' ? '输入或粘贴内容' : imageSubMode === 'single' ? '输入图片描述' : '输入需求描述'}
                />
              </>
            )}
          </div>
          </GlassCard>
        </div>

        {/* 右下：实时结果 */}
        <div className="min-w-0 min-h-0 lg:col-start-2 lg:row-start-2">
          <GlassCard glow accentHue={150} className="overflow-hidden flex flex-col min-h-0 lg:h-full">
          {mainMode === 'infer' ? (
            <>
          <div className="flex items-center justify-between shrink-0">
            <div className="text-sm font-semibold min-w-0" style={{ color: 'var(--text-primary)' }}>
              {mode === 'imageGenPlan'
                ? '实时结果（按 识别条目数 分组（倒序），组内按 TTFT/总耗时）'
                : `实时结果（按 ${sortBy === 'ttft' ? '首字延迟 TTFT' : '总时长'} 优先排序）`}
            </div>
            <div className="flex items-center gap-2">
              {mode === 'imageGenPlan' ? (
                <div
                  className="px-2 py-1 rounded-[10px] text-xs font-semibold"
                  style={{ border: '1px solid rgba(250, 204, 21, 0.55)', background: 'rgba(250, 204, 21, 0.08)', color: 'rgba(250, 204, 21, 0.95)' }}
                  title="标准答案由系统设置的主模型生成（会自动加入本次对比）"
                >
                  判定主模型：{(allModels.find((m) => (m as any).isMain && (m as any).enabled)?.name ?? '未设置').toString()}
                </div>
              ) : null}
              <GlassSwitch
                options={
                  mode === 'imageGenPlan'
                    ? [{ key: 'imagePlanItemsDesc', label: '识别条目', icon: <Zap size={14} /> }]
                    : [
                        { key: 'ttft', label: '首字延迟', icon: <Zap size={14} /> },
                        { key: 'total', label: '总时长', icon: <Clock3 size={14} /> },
                      ]
                }
                value={sortBy}
                onChange={(key) => setSortBy(key as SortBy)}
                accentHue={45}
              />
              {!running && failedRunCount > 0 ? (
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={async () => {
                    if (!activeExperimentId) return;
                    const ok = await systemDialog.confirm(`检测到 ${failedRunCount} 个失败模型，是否一键从“已选择模型”中剔除并保存？`);
                    if (!ok) return;

                    // 失败模型定位策略：
                    // 1) 优先使用 run item 的 configModelId（最准确）
                    // 2) 其次，如果 item.modelId 本身就是配置模型 id
                    // 3) 否则退化为用 platformId(可推断) + modelName 匹配（选中列表本身保证 platform+modelName 唯一）
                    const removeIdSet = new Set<string>();
                    const removeKeySet = new Set<string>();

                    for (const it of failedRunItems) {
                      const cfgId = (it.configModelId && modelById.has(it.configModelId) ? it.configModelId : null) ?? (modelById.has(it.modelId) ? it.modelId : null);
                      if (cfgId) {
                        removeIdSet.add(cfgId);
                        continue;
                      }
                      const name = (it.modelName ?? '').trim();
                      const platformId = getPlatformIdForRunItem(name, String(it.modelId ?? '').trim());
                      if (platformId && name) {
                        removeKeySet.add(`${platformId}:${name}`.toLowerCase());
                      }
                    }

                    const nextSelected = (selectedModels ?? []).filter((m) => {
                      if (removeIdSet.has(m.modelId)) return false;
                      const key = `${String(m.platformId ?? '').trim()}:${String(m.modelName ?? '').trim()}`.toLowerCase();
                      if (removeKeySet.has(key)) return false;
                      return true;
                    });

                    if (nextSelected.length === selectedModels.length) {
                      toast.warning('未能匹配到需要剔除的模型（可能缺少平台信息或已被移除）');
                      return;
                    }

                    // 先更新 UI，再写库
                    setSelectedModels(nextSelected);
                    const res = await updateModelLabExperiment(activeExperimentId, {
                      suite,
                      promptText,
                      selectedModels: nextSelected,
                      params,
                    });
                    if (!res.success) {
                      toast.error(res.error?.message || '保存失败');
                      return;
                    }
                    setExperiments((prev) => prev.map((e) => (e.id === res.data.id ? res.data : e)));

                    // 同步"已保存快照"，避免自动保存再触发一次
                    const sig = [String(suite ?? ''), JSON.stringify(params ?? {}), String(promptText ?? ''), signatureOfSelectedModels(nextSelected)].join('||');
                    lastSavedSigRef.current = sig;
                    lastSavedExperimentIdRef.current = res.data.id;
                    toast.success(`已剔除 ${selectedModels.length - nextSelected.length} 个失败模型并保存`);
                  }}
                  title="将本次运行失败（status=error）的模型从已选择列表中移除，并保存到实验配置"
                >
                  一键剔除失败模型
                </Button>
              ) : null}
              {running ? <Badge variant="subtle">运行中</Badge> : <Badge variant="subtle">就绪</Badge>}
            </div>
          </div>

          {runError ? (
            <div
              className="mt-2 rounded-[12px] px-3 py-2 text-xs flex items-start gap-2 min-w-0"
              style={{
                background: 'rgba(239,68,68,0.06)',
                border: '1px solid rgba(239,68,68,0.18)',
                color: 'rgba(239,68,68,0.95)',
              }}
            >
              <XCircle size={14} className="shrink-0 mt-[1px]" />
              <div className="min-w-0 break-words" style={{ wordBreak: 'break-word' }}>
                {runError}
              </div>
            </div>
          ) : null}

          <div className="mt-3 flex-1 min-h-0 overflow-auto pr-1 pb-6">
            {sortedItems.length === 0 ? (
              <div className="h-full min-h-[220px] flex flex-col items-center justify-center text-center px-6">
                <div
                  className="h-12 w-12 rounded-full flex items-center justify-center"
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border-subtle)' }}
                >
                  <TimerOff size={22} style={{ color: 'var(--text-muted)' }} />
                </div>
                <div className="mt-3 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  这里将实时展示对比结果
                </div>
                <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                  点击上方“一键开始实验”，会按模型展示 TTFT、总耗时与输出预览
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {params.repeatN > 1 && sortedItems.length > 0 && sortedItems.every((x) => !x.repeatIndex && !x.repeatN) ? (
                  <div
                    className="rounded-[12px] px-3 py-2 text-xs"
                    style={{
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.10)',
                      color: 'var(--text-muted)',
                    }}
                  >
                    已设置重复 {params.repeatN} 次，但当前返回仍为聚合结果（未拆分为多个 block）。这通常表示你连接的后端实例未升级到支持 repeat 拆分的版本。
                  </div>
                ) : null}
                {sortedItems.map((it, idx) => (
                  <div
                    key={it.itemId}
                    className="rounded-[14px] p-3"
                    style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}
                  >
                    {mode === 'imageGenPlan'
                      ? (() => {
                          const curText = pickRunText(it.rawText, it.preview);
                          const curInfo = curText ? getImagePlanItemsInfoFromRaw(curText) : null;
                          const curKey = curInfo ? (curInfo.ok ? `ok:${curInfo.itemsLen}` : 'bad') : 'empty';

                          const prev = idx > 0 ? sortedItems[idx - 1] : null;
                          const prevText = prev ? pickRunText(prev.rawText, prev.preview) : '';
                          const prevInfo = prevText ? getImagePlanItemsInfoFromRaw(prevText) : null;
                          const prevKey = prevInfo ? (prevInfo.ok ? `ok:${prevInfo.itemsLen}` : 'bad') : 'empty';

                          const show = idx === 0 || curKey !== prevKey;
                          if (!show) return null;

                          const label = curInfo ? (curInfo.ok ? `识别条目 ${curInfo.itemsLen}` : '识别条目 无法解析') : '识别条目 -';
                          const title = curInfo && !curInfo.ok ? curInfo.reason : '按识别条目数分组（组间倒序）';

                          return (
                            <div
                              className="mb-2 px-2 py-1 rounded-[10px] text-xs font-semibold inline-flex items-center"
                              style={{
                                border: '1px solid rgba(250, 204, 21, 0.22)',
                                background: 'rgba(250, 204, 21, 0.06)',
                                color: 'rgba(250, 204, 21, 0.92)',
                              }}
                              title={title}
                            >
                              {label}
                            </div>
                          );
                        })()
                      : null}
                    {(() => {
                      const raw = pickRunText(it.rawText, it.preview);
                      const v = raw ? validateByFormatTest(expectedFormat, raw) : null;
                      const planInfo = mode === 'imageGenPlan' && raw ? getImagePlanItemsInfoFromRaw(raw) : null;
                      const chipStyle = (ok: boolean): React.CSSProperties => ({
                        background: ok ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.10)',
                        border: ok ? '1px solid rgba(34,197,94,0.28)' : '1px solid rgba(239,68,68,0.22)',
                        color: ok ? 'rgba(34,197,94,0.95)' : 'rgba(239,68,68,0.92)',
                      });
                      const planChipStyle = (st: 'ok' | 'bad' | 'empty'): React.CSSProperties => {
                        if (st === 'ok') {
                          return {
                            background: 'rgba(250, 204, 21, 0.06)',
                            border: '1px solid rgba(250, 204, 21, 0.22)',
                            color: 'rgba(250, 204, 21, 0.92)',
                          };
                        }
                        if (st === 'bad') return chipStyle(false);
                        return {
                          background: 'rgba(255,255,255,0.04)',
                          border: '1px solid rgba(255,255,255,0.12)',
                          color: 'var(--text-secondary)',
                        };
                      };
                      const planLabel = planInfo ? (planInfo.ok ? `识别条目 ${planInfo.itemsLen}` : '识别条目 无法解析') : '识别条目 -';
                      const planTitle = planInfo ? (planInfo.ok ? '识别条目数（items.length）' : planInfo.reason) : '未解析到可用 JSON';
                      const planTone = planInfo ? (planInfo.ok ? 'ok' : 'bad') : 'empty';
                      return (
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          {mode === 'imageGenPlan' ? (
                            <span
                              className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide"
                              style={planChipStyle(planTone)}
                              title={planTitle}
                            >
                              {planLabel}
                            </span>
                          ) : null}
                          {v ? (
                            <span
                              className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide"
                              style={chipStyle(v.ok)}
                              title={v.reason}
                            >
                              {v.label} {v.ok ? '通过' : '失败'}
                            </span>
                          ) : null}
                          {it.rawTruncated ? (
                            <span
                              className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide"
                              style={{
                                background: 'rgba(255,255,255,0.04)',
                                border: '1px solid rgba(255,255,255,0.12)',
                                color: 'var(--text-secondary)',
                              }}
                              title={`原始输出超过上限 ${MAX_RUN_RAW_CHARS} 字符，已截断；校验基于截断文本`}
                            >
                              已截断
                            </span>
                          ) : null}
                        </div>
                      );
                    })()}
                    <div className="flex items-center justify-between gap-3 min-w-0">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          {(() => {
                            const pid = getPlatformIdForRunItem((it.modelName || '').trim(), String(it.modelId ?? '').trim());
                            const label = pid ? platformNameById.get(pid) || pid : null;
                            if (!label) return null;
                            return <PlatformLabel name={label} />;
                          })()}
                          <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                            {String(it.modelId ?? '').trim() || String(it.modelName ?? '').trim() || '-'}
                          </div>
                          {typeof it.repeatN === 'number' && it.repeatN > 1 && typeof it.repeatIndex === 'number' ? (
                            <span
                              className="inline-flex items-center rounded-full px-2 py-[2px] text-[11px] font-semibold shrink-0"
                              style={{
                                background: 'rgba(255,255,255,0.04)',
                                border: '1px solid rgba(255,255,255,0.12)',
                                color: 'var(--text-secondary)',
                              }}
                              title="重复请求序号"
                            >
                              第 {it.repeatIndex}/{it.repeatN} 次
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <div className="shrink-0 flex items-center justify-end gap-2">
                        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          TTFT {typeof it.ttftMs === 'number' ? `${it.ttftMs}ms` : '-'}
                          {typeof it.queueMs === 'number' ? `（排队 ${it.queueMs}ms）` : ''}
                          · 总耗时 {typeof it.totalMs === 'number' ? `${it.totalMs}ms` : '-'}
                        </div>
                        <div
                          className="text-xs"
                          style={{
                            color:
                              it.status === 'error'
                                ? 'rgba(239,68,68,0.95)'
                                : it.status === 'done'
                                  ? 'rgba(34,197,94,0.95)'
                                  : 'var(--text-muted)',
                          }}
                        >
                          {it.status === 'running' ? '进行中' : it.status === 'done' ? '完成' : '失败'}
                        </div>
                      </div>
                    </div>

                    {(() => {
                      const cfgId =
                        (it.configModelId && modelById.has(it.configModelId) ? it.configModelId : null) ??
                        (modelById.has(it.modelId) ? it.modelId : null);
                      const m = cfgId ? modelById.get(cfgId) : undefined;
                      const canInferPlatform = !!getPlatformIdForRunItem((it.modelName || '').trim(), String(it.modelId ?? '').trim());
                      const reason = !cfgId
                        ? (canInferPlatform ? '该模型未添加到“模型管理”，点击将自动添加并执行设定' : '未能定位平台信息，无法自动添加模型')
                        : '';
                      return (
                        <div className="mt-2 flex items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2 min-w-0">
                            {formatParamChips.map((c) => (
                              <span
                                key={c.key}
                                className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide"
                                style={{
                                  background: 'rgba(255,255,255,0.04)',
                                  border: '1px solid rgba(255,255,255,0.12)',
                                  color: 'var(--text-secondary)',
                                }}
                              >
                                {c.label}
                              </span>
                            ))}
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <Button
                              variant="ghost"
                              size="xs"
                              onClick={() => (cfgId ? onSetMainFromRun(cfgId) : onSetMainFromItem(it.itemId))}
                              disabled={(!cfgId && !canInferPlatform) || Boolean(m?.isMain)}
                              title={!cfgId ? reason : (m?.isMain ? '已是主模型' : '设为主模型（全局唯一）')}
                              className={m?.isMain ? 'disabled:opacity-100' : ''}
                              style={m?.isMain ? { color: 'rgba(250,204,21,0.95)' } : { color: 'var(--text-secondary)' }}
                            >
                              <Star size={14} fill={m?.isMain ? 'currentColor' : 'none'} />
                              主
                            </Button>
                            <Button
                              variant="ghost"
                              size="xs"
                              onClick={() => {
                                if (m?.isIntent) return void onClearIntentFromRun();
                                return cfgId ? void onSetIntentFromRun(cfgId) : void onSetIntentFromItem(it.itemId);
                              }}
                              disabled={!cfgId && !canInferPlatform}
                              title={!cfgId ? reason : (m?.isIntent ? '取消意图模型（将回退主模型执行）' : '设为意图模型（全局唯一）')}
                              style={m?.isIntent ? { color: 'rgba(34,197,94,0.95)' } : { color: 'var(--text-secondary)' }}
                            >
                              <Sparkles size={14} />
                              意图
                            </Button>
                            <Button
                              variant="ghost"
                              size="xs"
                              onClick={() => {
                                if (m?.isVision) return void onClearVisionFromRun();
                                return cfgId ? void onSetVisionFromRun(cfgId) : void onSetVisionFromItem(it.itemId);
                              }}
                              disabled={!cfgId && !canInferPlatform}
                              title={!cfgId ? reason : (m?.isVision ? '取消视觉模型（将回退主模型执行）' : '设为视觉模型（全局唯一）')}
                              style={m?.isVision ? { color: 'rgba(59,130,246,0.95)' } : { color: 'var(--text-secondary)' }}
                            >
                              <ScanEye size={14} />
                              视觉
                            </Button>
                            <Button
                              variant="ghost"
                              size="xs"
                              onClick={() => {
                                if (m?.isImageGen) return void onClearImageGenFromRun();
                                return cfgId ? void onSetImageGenFromRun(cfgId) : void onSetImageGenFromItem(it.itemId);
                              }}
                              disabled={!cfgId && !canInferPlatform}
                              title={!cfgId ? reason : (m?.isImageGen ? '取消生图模型（将回退主模型执行）' : '设为生图模型（全局唯一）')}
                              style={m?.isImageGen ? { color: 'rgba(168,85,247,0.95)' } : { color: 'var(--text-secondary)' }}
                            >
                              <ImagePlus size={14} />
                              生图
                            </Button>
                          </div>
                        </div>
                      );
                    })()}
                    {it.errorMessage ? (
                      <div className="mt-2 text-xs" style={{ color: 'rgba(239,68,68,0.95)' }}>
                        {it.errorMessage}
                      </div>
                    ) : null}
                    <div className="mt-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>
                          输出预览
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-[10px] px-2 py-1 text-[11px] font-semibold transition-colors hover:bg-white/6"
                            style={{ border: '1px solid rgba(255,255,255,0.10)', color: 'var(--text-secondary)' }}
                            onClick={() => {
                              const text = it.rawText || it.preview || (it.status === 'running' ? '（等待输出）' : '（无输出）');
                              void copyToClipboard(text);
                            }}
                            aria-label="复制输出"
                            title="复制输出"
                          >
                            <Copy size={12} />
                            复制
                          </button>
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-[10px] px-2 py-1 text-[11px] font-semibold transition-colors hover:bg-white/6"
                            style={{ border: '1px solid rgba(255,255,255,0.10)', color: 'var(--text-secondary)' }}
                            onClick={() => {
                              const text = it.rawText || it.preview || (it.status === 'running' ? '（等待输出）' : '（无输出）');
                              setPreviewDialog({ open: true, title: it.displayName || '输出预览', text });
                            }}
                            aria-label="展开查看完整输出"
                            title="展开查看完整输出"
                          >
                            <Expand size={12} />
                            展开
                          </button>
                        </div>
                      </div>
                      <div
                        className="mt-1 rounded-[12px] px-2.5 py-2 min-w-0"
                        style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(255,255,255,0.02)' }}
                      >
                        <InlineMarquee
                          text={it.preview || (it.status === 'running' ? '（等待输出）' : '（无输出）')}
                          title={it.preview || ''}
                          className="text-xs font-semibold"
                          style={{ color: 'var(--text-primary)' }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          </>
          ) : imageSubMode === 'single' ? (
            <>
              <div className="flex items-center justify-between shrink-0">
                <div className="text-sm font-semibold min-w-0" style={{ color: 'var(--text-primary)' }}>
                  生图（单张）
                </div>
                <div className="flex items-center gap-2">
                  {imageRunning ? <Badge variant="subtle">生成中</Badge> : <Badge variant="subtle">就绪</Badge>}
                </div>
              </div>
              {imageError ? (
                <div className="mt-2 text-xs" style={{ color: 'rgba(239,68,68,0.95)' }}>
                  {imageError}
                </div>
              ) : null}
              <div className="mt-3 flex-1 min-h-0 overflow-auto pr-1 pb-6">
                {(() => {
                      const wantN = Math.max(1, Math.min(20, Number(singleN || 1)));
                      const modelCount = imageGenModels.length;
                      const hasAnyOutput = singleList.length > 0;

                      if (modelCount === 0) {
                        return (
                          <div className="py-10 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                            当前未选择模型。请先在左侧选择至少 1 个模型后再生成。
                          </div>
                        );
                      }

                      const prompt = ((promptText || '').trim() || DEFAULT_IMAGE_PROMPT).trim();
                      const total = wantN * modelCount;

                      const srcOf = (it: ImageViewItem) =>
                        it.url || (it.base64 ? (it.base64.startsWith('data:') ? it.base64 : `data:image/png;base64,${it.base64}`) : '');

                      // 为每个模型准备“显示列表”：始终补齐到 wantN（生成后修改数量也保持预览占位）
                      const now = Date.now();
                      const groups = imageGenModels.map((m, mi) => {
                        const real = singleList.filter((x) => x.sourceModelId === m.modelId);
                        const byIdx = new Map<number, ImageViewItem>();
                        for (const it of real) {
                          const idx = typeof it.variantIndex === 'number' ? it.variantIndex : null;
                          if (idx == null) continue;
                          if (!byIdx.has(idx)) byIdx.set(idx, it);
                        }

                        const items: ImageViewItem[] = Array.from({ length: wantN }).map((_, i) => {
                          const hit = byIdx.get(i);
                          if (hit) return hit;
                          return {
                            key: `preview_${m.modelId}_${i}`,
                            groupId: 'preview',
                            variantIndex: i,
                            status: 'running' as const,
                            prompt,
                            createdAt: now,
                            sourceModelId: m.modelId,
                            sourceModelName: m.modelName,
                            sourceDisplayName: m.displayName,
                            sourceModelIndex: mi,
                          };
                        });
                        return { model: m, modelIndex: mi, items };
                      });

                      const all = groups.flatMap((g) => g.items);
                      const done = all.filter((x) => x.status === 'done' && (x.url || x.base64));
                      const selectedKeys = Object.keys(singleSelected).filter((k) => singleSelected[k]);

                      const downloadSelected = async () => {
                        const items = all
                          .filter((x) => singleSelected[x.key])
                          .map((x) => ({ src: srcOf(x), filename: `${x.sourceDisplayName || 'model'}_${prompt}_${Number(x.variantIndex ?? 0) + 1}` }));
                        await downloadAllAsZip(items, `${prompt || 'single'}_${Date.now()}`);
                      };

                      const downloadAll = async () => {
                        const items = done.map((x) => ({ src: srcOf(x), filename: `${x.sourceDisplayName || 'model'}_${prompt}_${Number(x.variantIndex ?? 0) + 1}` }));
                        await downloadAllAsZip(items, `${prompt || 'single'}_${Date.now()}`);
                      };

                      const setAllSelected = (v: boolean) => {
                        const next: Record<string, boolean> = {};
                        for (const it of done) next[it.key] = v;
                        setSingleSelected(next);
                      };

                      const tile = (it: ImageViewItem) => {
                        const src = srcOf(it);
                        const selected = !!singleSelected[it.key];
                        const canSelect = it.status === 'done' && !!src;
                        const isPreviewSlot = it.groupId === 'preview';
                        return (
                          <div
                            key={it.key}
                            className={[
                              'rounded-[12px] overflow-hidden relative',
                              canSelect ? 'cursor-zoom-in' : 'cursor-default',
                            ].join(' ')}
                            style={{
                              border: selected ? '2px solid rgba(250,204,21,0.95)' : '1px solid rgba(255,255,255,0.10)',
                              background: 'rgba(255,255,255,0.02)',
                              height: '100%',
                            }}
                            onClick={() => {
                              if (!canSelect) return;
                              setImagePreviewDialog({
                                open: true,
                                title: `模型 #${Number(it.sourceModelIndex ?? 0) + 1} · #${Number(it.variantIndex ?? 0) + 1}`,
                                src,
                              });
                            }}
                            title={it.prompt}
                          >
                            {it.status === 'done' && src ? (
                              <img src={src} alt={it.prompt} className="w-full h-full block" style={{ objectFit: 'contain' }} />
                            ) : (
                              <div className="w-full h-full flex flex-col items-center justify-center gap-2 px-3 text-center">
                                {it.status === 'error' ? (
                                  <div className="text-xs" style={{ color: 'rgba(239,68,68,0.95)' }}>
                                    {it.errorMessage || '失败'}
                                  </div>
                                ) : (
                                  <>
                                    {!isPreviewSlot && it.status === 'running' && imageRunning ? (
                                      <>
                                        <PrdLoader size={40} />
                                        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                          正在生成中…
                                        </div>
                                      </>
                                    ) : !isPreviewSlot && it.status === 'running' ? (
                                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                        等待生成…
                                      </div>
                                    ) : (
                                      <>
                                        <div
                                          className="w-10 h-10 rounded-full flex items-center justify-center"
                                          style={{ border: '1px dashed rgba(255,255,255,0.22)', background: 'rgba(255,255,255,0.01)' }}
                                        >
                                          <ImagePlus size={18} style={{ color: 'var(--text-muted)' }} />
                                        </div>
                                        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                          预览位置
                                        </div>
                                      </>
                                    )}
                                  </>
                                )}
                              </div>
                            )}

                            {/* 选择（用于“下载选中”） */}
                            {canSelect ? (
                              <button
                                type="button"
                                className="absolute right-2 top-2 h-8 w-8 rounded-[10px] inline-flex items-center justify-center transition-colors hover:bg-white/6"
                                style={{
                                  border: selected ? '2px solid rgba(250,204,21,0.95)' : '1px solid rgba(255,255,255,0.10)',
                                  background: selected ? 'rgba(250,204,21,0.12)' : 'rgba(0,0,0,0.20)',
                                  color: selected ? 'rgba(250,204,21,0.95)' : 'var(--text-secondary)',
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSingleSelected((p) => ({ ...p, [it.key]: !p[it.key] }));
                                }}
                                aria-label={selected ? '取消选择' : '选择'}
                                title={selected ? '取消选择' : '选择'}
                              >
                                <Check size={16} />
                              </button>
                            ) : null}

                            {/* 放大提示 */}
                            {canSelect ? (
                              <div
                                className="absolute left-2 bottom-2 h-8 w-8 rounded-[10px] inline-flex items-center justify-center"
                                style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.20)', color: 'var(--text-secondary)' }}
                                title="点击放大预览"
                                aria-label="点击放大预览"
                              >
                                <Maximize2 size={14} />
                              </div>
                            ) : null}

                            <div className="absolute right-2 bottom-2 flex items-center gap-1">
                              <button
                                type="button"
                                className={[
                                  'inline-flex items-center gap-1 rounded-[10px] px-2 py-1 text-[11px] font-semibold',
                                  'transition-all duration-150',
                                  'border border-white/15 text-white/90 bg-black/35 backdrop-blur-sm shadow-sm',
                                  'hover:bg-black/55 hover:border-white/30 hover:-translate-y-px',
                                ].join(' ')}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (!src) return;
                                  void (async () => {
                                    const r = await copyImageToClipboardFromSrc(src);
                                    if (r.ok) showCopyToast('复制成功');
                                    else showCopyToast(r.reason);
                                  })();
                                }}
                                aria-label="复制图片"
                                title="复制图片"
                                disabled={it.status !== 'done' || !src}
                              >
                                <Copy size={12} />
                                复制
                              </button>
                              <button
                                type="button"
                                className={[
                                  'inline-flex items-center gap-1 rounded-[10px] px-2 py-1 text-[11px] font-semibold',
                                  'transition-all duration-150',
                                  'border border-white/15 text-white/90 bg-black/35 backdrop-blur-sm shadow-sm',
                                  'hover:bg-black/55 hover:border-white/30 hover:-translate-y-px',
                                ].join(' ')}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void downloadImage(src, `${it.prompt}_${Number(it.variantIndex ?? 0) + 1}`);
                                }}
                                aria-label="下载图片"
                                title="下载图片"
                                disabled={it.status !== 'done' || !src}
                              >
                                <Download size={12} />
                                下载
                              </button>
                            </div>

                            <div
                              className="absolute left-2 top-2 text-[11px] font-semibold px-2 py-1 rounded-[10px] border border-white/15 bg-black/40 backdrop-blur-sm shadow-sm"
                              style={{ color: 'rgba(255,255,255,0.92)' }}
                            >
                              {`模型 #${Number(it.sourceModelIndex ?? 0) + 1} · #${Number(it.variantIndex ?? 0) + 1}`}
                            </div>
                          </div>
                        );
                      };

                      const toolbar = (
                        <div className="pb-2">
                          <div className="flex items-center justify-between gap-2">
                            <div
                              className="px-2 py-1 rounded-[10px] text-xs font-semibold shrink-0"
                              style={{
                                border: '1px solid rgba(250,204,21,0.55)',
                                background: 'rgba(250,204,21,0.08)',
                                color: 'rgba(250,204,21,0.95)',
                              }}
                            >
                              布局预览：将生成 {wantN} × {modelCount} = {total} 张
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <Button variant="secondary" size="xs" onClick={() => setAllSelected(true)} disabled={done.length === 0}>
                                全选
                              </Button>
                              <Button variant="secondary" size="xs" onClick={() => setAllSelected(false)} disabled={selectedKeys.length === 0}>
                                清空选择
                              </Button>
                              <Button variant="secondary" size="xs" onClick={downloadSelected} disabled={selectedKeys.length === 0}>
                                <Download size={14} />
                                下载选中
                              </Button>
                              <Button variant="primary" size="xs" onClick={downloadAll} disabled={done.length === 0}>
                                <Download size={14} />
                                下载全部
                              </Button>
                            </div>
                          </div>
                          <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                            {hasAnyOutput
                              ? `已生成 ${done.length}/${total} 张（点击图片可放大，右上角勾选用于下载选中）`
                              : `选择模型后会按“每模型 ${wantN} 张”进行对比展示`}
                          </div>
                        </div>
                      );

                      return (
                        <div>
                          {toolbar}
                          <div
                            ref={imageGridRef}
                            className="grid gap-3"
                            style={{
                              gridTemplateColumns: modelCount >= 4 ? 'repeat(4, minmax(0, 1fr))' : `repeat(${modelCount}, minmax(0, 1fr))`,
                            }}
                          >
                            {groups.map((g) => {
                              const perCols = Math.max(1, Math.min(3, wantN));
                              return (
                                <div
                                  key={g.model.modelId}
                                  className="rounded-[14px] p-3 flex flex-col min-h-0"
                                  style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }} title={g.model.displayName}>
                                      模型 #{g.modelIndex + 1} · {g.model.displayName}
                                    </div>
                                    <div className="text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>
                                      {wantN} 张
                                    </div>
                                  </div>
                                  <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: `repeat(${perCols}, minmax(0, 1fr))` }}>
                                    {g.items.map((x) => (
                                      <div key={x.key} style={{ height: imageThumbHeight }}>
                                        {tile(x)}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between shrink-0">
                <div className="text-sm font-semibold min-w-0" style={{ color: 'var(--text-primary)' }}>
                  批量生图
                </div>
                <div className="flex items-center gap-2">
                  {batchRunning ? <Badge variant="subtle">运行中</Badge> : <Badge variant="subtle">就绪</Badge>}
                  {batchActiveModelLabel ? (
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      当前模型：{batchActiveModelLabel}
                    </span>
                  ) : null}
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    模型数 {imageGenModelCount || 0}
                  </span>
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={async () => {
                      const items = batchList
                        .filter((x) => x.status === 'done' && (x.url || x.base64))
                        .map((x) => {
                          const src =
                            x.url ||
                            (x.base64 ? (x.base64.startsWith('data:') ? x.base64 : `data:image/png;base64,${x.base64}`) : '');
                          return { src, filename: `${x.prompt}_${x.key}` };
                        });
                      await downloadAllAsZip(items, `batch_${Date.now()}`);
                    }}
                    disabled={batchList.filter((x) => x.status === 'done' && (x.url || x.base64)).length === 0}
                    title="打包下载当前批量生成的所有已完成图片"
                  >
                    <Download size={14} />
                    一键下载
                  </Button>
                  <Button variant="secondary" size="xs" onClick={() => void clearLabLocalCacheAndResults()} disabled={batchRunning || batchList.length === 0}>
                    清空
                  </Button>
                </div>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {batchHasFormula ? (
                    <div
                      className="px-2 py-1 rounded-[10px] text-xs font-semibold"
                      style={{
                        border: '1px solid rgba(250,204,21,0.55)',
                        background: 'rgba(250,204,21,0.08)',
                        color: 'rgba(250,204,21,0.95)',
                      }}
                    >
                      布局预览：将生成 {batchPlanTotal} × {imageGenModelCount} = {batchTotal} 张
                    </div>
                  ) : (
                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      提示：解析后会按“清单项 × 模型数”生成，方便你按模型对比效果
                    </div>
                  )}
                  {batchHasFormula ? (
                    <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                      已生成 {batchDoneCount}/{batchTotal} 张{batchErrorCount ? `，失败 ${batchErrorCount}` : ''}
                    </div>
                  ) : null}
                </div>
              </div>
              {batchError ? (
                <div className="mt-2 text-xs" style={{ color: 'rgba(239,68,68,0.95)' }}>
                  {batchError}
                </div>
              ) : null}
              <div className="mt-3 flex-1 min-h-0 overflow-auto pr-1 pb-6">
                {batchList.length === 0 ? (
                  <div className="h-full min-h-[220px] flex flex-col items-center justify-center text-center px-6">
                    <div
                      className="h-12 w-12 rounded-full flex items-center justify-center"
                      style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border-subtle)' }}
                    >
                      <Layers size={22} style={{ color: 'var(--text-muted)' }} />
                    </div>
                    <div className="mt-3 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      这里将展示批量生图结果
                    </div>
                    <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                      点击上方“解析并预览”，确认后开始生成
                    </div>
                  </div>
                ) : (
                  <>
                    {(() => {
                      const byModelId = new Map<string, ImageViewItem[]>();
                      for (const it of batchList) {
                        const id = String(it.sourceModelId ?? '').trim() || '__unknown__';
                        const arr = byModelId.get(id) ?? [];
                        arr.push(it);
                        byModelId.set(id, arr);
                      }

                      const sortByIndex = (a: ImageViewItem, b: ImageViewItem) => {
                        return (
                          Number(a.itemIndex ?? 0) - Number(b.itemIndex ?? 0) ||
                          Number(a.imageIndex ?? 0) - Number(b.imageIndex ?? 0) ||
                          Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0)
                        );
                      };

                      const known = new Set(imageGenModels.map((m) => m.modelId));

                      const baseGroups = imageGenModels.map((m, mi) => ({
                        key: m.modelId,
                        model: m,
                        modelIndex: mi,
                        items: (byModelId.get(m.modelId) ?? []).slice().sort(sortByIndex),
                      }));

                      const extraGroups: { key: string; model: { modelId: string; displayName: string }; modelIndex: number; items: ImageViewItem[] }[] = [];
                      for (const [id, items] of byModelId.entries()) {
                        if (known.has(id)) continue;
                        const first = items[0];
                        const displayName = first?.sourceDisplayName || first?.sourceModelName || (id === '__unknown__' ? '未知模型' : id);
                        extraGroups.push({
                          key: `extra_${id}`,
                          model: { modelId: id, displayName },
                          modelIndex: baseGroups.length + extraGroups.length,
                          items: items.slice().sort(sortByIndex),
                        });
                      }

                      const groups = [...baseGroups, ...extraGroups];
                      const groupCount = Math.max(1, groups.length);
                      const outerCols = groupCount >= 4 ? 4 : groupCount;
                      const perCols = Math.max(1, Math.min(3, batchPlanTotal || 3));

                      const tile = (it: ImageViewItem) => {
                        const src = it.url || (it.base64 ? (it.base64.startsWith('data:') ? it.base64 : `data:image/png;base64,${it.base64}`) : '');
                        return (
                          <div
                            key={it.key}
                            className="rounded-[14px] p-3 flex flex-col gap-2"
                            style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="text-xs font-semibold min-w-0" style={{ color: 'var(--text-primary)' }}>
                                <span className="block truncate" title={it.prompt}>
                                  {it.prompt}
                                </span>
                                <span className="block text-[11px] font-normal mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                  来源：{it.sourceDisplayName || it.sourceModelName || it.sourceModelId || '未知'}
                                </span>
                                <span className="block text-[11px] font-normal mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                  {(() => {
                                    const sizeText = String(it.size ?? '').trim() || imgSize;
                                    const ratio = ratioFromSizeString(sizeText) ?? parsePromptSizeMeta(it.prompt).ratio ?? null;
                                    if (it.sizeAdjusted && it.effectiveSize) {
                                      const req = String(it.requestedSize ?? sizeText).trim() || sizeText;
                                      const eff = String(it.effectiveSize ?? '').trim() || sizeText;
                                      return `${it.ratioAdjusted ? '比例已微调' : '尺寸已替换'}：${req} → ${eff}${ratio ? `（${ratio}）` : ''}`;
                                    }
                                    return `尺寸：${sizeText}${ratio ? `（${ratio}）` : ''}`;
                                  })()}
                                </span>
                              </div>
                              <div
                                className="text-xs shrink-0"
                                style={{
                                  color:
                                    it.status === 'error'
                                      ? 'rgba(239,68,68,0.95)'
                                      : it.status === 'done'
                                        ? 'rgba(34,197,94,0.95)'
                                        : 'var(--text-muted)',
                                }}
                              >
                                {it.status === 'running' ? '生成中' : it.status === 'done' ? '完成' : '失败'}
                              </div>
                            </div>
                            <div
                              className="rounded-[12px] overflow-hidden relative"
                              style={{
                                border: '1px solid rgba(255,255,255,0.10)',
                                background: 'rgba(255,255,255,0.02)',
                                height: imageThumbHeight,
                              }}
                              onClick={() => {
                                if (!(it.status === 'done' && src)) return;
                                setImagePreviewDialog({ open: true, title: '图片预览', src });
                              }}
                              role={it.status === 'done' && src ? 'button' : undefined}
                              tabIndex={it.status === 'done' && src ? 0 : undefined}
                            >
                              {it.status === 'done' && src ? (
                                <img src={src} alt={it.prompt} className="w-full h-full block" style={{ objectFit: 'contain' }} />
                              ) : (
                                <div className="w-full h-full flex flex-col items-center justify-center gap-2 px-3 text-center">
                                  {it.status === 'error' ? (
                                    <div className="text-xs" style={{ color: 'rgba(239,68,68,0.95)' }}>
                                      {it.errorMessage || '失败'}
                                    </div>
                                  ) : (
                                    <>
                                      <PrdLoader size={40} />
                                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                        正在生成中…
                                      </div>
                                    </>
                                  )}
                                </div>
                              )}

                              {it.status === 'done' && src ? (
                                <div
                                  className="absolute left-2 bottom-2 h-8 w-8 rounded-[10px] inline-flex items-center justify-center pointer-events-none"
                                  style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.20)', color: 'var(--text-secondary)' }}
                                  title="点击放大预览"
                                  aria-label="点击放大预览"
                                >
                                  <Maximize2 size={14} />
                                </div>
                              ) : null}

                              <div className="absolute right-2 bottom-2 flex items-center gap-1">
                                <button
                                  type="button"
                                  className={[
                                    'inline-flex items-center gap-1 rounded-[10px] px-2 py-1 text-[11px] font-semibold',
                                    'transition-all duration-150',
                                    'border border-white/15 text-white/90 bg-black/35 backdrop-blur-sm shadow-sm',
                                    'hover:bg-black/55 hover:border-white/30 hover:-translate-y-px',
                                  ].join(' ')}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (!src) return;
                                    void (async () => {
                                      const r = await copyImageToClipboardFromSrc(src);
                                      if (r.ok) showCopyToast('复制成功');
                                      else showCopyToast(r.reason);
                                    })();
                                  }}
                                  aria-label="复制图片"
                                  title="复制图片"
                                  disabled={it.status !== 'done' || !src}
                                >
                                  <Copy size={12} />
                                  复制
                                </button>
                                <button
                                  type="button"
                                  className={[
                                    'inline-flex items-center gap-1 rounded-[10px] px-2 py-1 text-[11px] font-semibold',
                                    'transition-all duration-150',
                                    'border border-white/15 text-white/90 bg-black/35 backdrop-blur-sm shadow-sm',
                                    'hover:bg-black/55 hover:border-white/30 hover:-translate-y-px',
                                  ].join(' ')}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void downloadImage(src, it.prompt);
                                  }}
                                  aria-label="下载图片"
                                  title="下载图片"
                                  disabled={it.status !== 'done' || !src}
                                >
                                  <Download size={12} />
                                  下载
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      };

                      return (
                        <div
                          ref={imageGridRef}
                          className="grid gap-3"
                          style={{
                            gridTemplateColumns: outerCols >= 4 ? 'repeat(4, minmax(0, 1fr))' : `repeat(${outerCols}, minmax(0, 1fr))`,
                          }}
                        >
                          {groups.map((g) => (
                            <div
                              key={g.key}
                              className="rounded-[14px] p-3 flex flex-col min-h-0"
                              style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }} title={g.model.displayName}>
                                  模型 #{g.modelIndex + 1} · {g.model.displayName}
                                </div>
                                <div className="text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>
                                  {g.items.length} 张
                                </div>
                              </div>
                              {g.items.length === 0 ? (
                                <div
                                  className="mt-2 rounded-[12px] flex items-center justify-center text-xs"
                                  style={{
                                    border: '1px solid rgba(255,255,255,0.10)',
                                    background: 'rgba(255,255,255,0.02)',
                                    height: imageThumbHeight,
                                    color: 'var(--text-muted)',
                                  }}
                                >
                                  {batchRunning ? '等待生成…' : '暂无输出'}
                                </div>
                              ) : (
                                <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: `repeat(${perCols}, minmax(0, 1fr))` }}>
                                  {g.items.map((x) => tile(x))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </>
                )}
              </div>
            </>
          )}
          </GlassCard>
        </div>
      </div>

      <Dialog
        open={planDialogOpen}
        onOpenChange={(open) => setPlanDialogOpen(open)}
        title="批量生图确认"
        description={
          planResult
            ? `将生成 ${planResult.total} × ${imageGenModelCount || 0} = ${(planResult.total || 0) * (imageGenModelCount || 0)} 张图片`
            : '确认生成数量后开始'
        }
        maxWidth={900}
        contentStyle={{ height: 'min(80vh, 680px)' }}
        content={
          <div className="h-full min-h-0 flex flex-col">
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {planResult?.usedPurpose === 'fallbackMain'
                ? '提示：当前未配置意图模型，已回退使用主模型进行解析'
                : '解析模型：意图模型'}
            </div>

            <div className="mt-3 flex-1 min-h-0 overflow-auto rounded-[14px] p-3" style={{ border: '1px solid rgba(255,255,255,0.10)' }}>
              {planResult?.items?.length ? (
                <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 md:grid-cols-3">
                  {planResult.items.map((it, idx) => (
                    <div
                      key={`${idx}_${it.prompt}`}
                      className="rounded-[14px] p-3 flex flex-col min-h-0"
                      style={{
                        border: '1px solid var(--border-subtle)',
                        background: 'rgba(255, 255, 255, 0.02)',
                        minHeight: 306,
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }} title={it.prompt}>
                          条目 #{idx + 1}
                        </div>
                        <div className="text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>
                          {Math.max(1, Number(it.count || 1))} 张
                        </div>
                      </div>

                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {(() => {
                          const explicit = String(it.size ?? '').trim();
                          const meta = explicit ? { size: explicit, ratio: ratioFromSizeString(explicit) } : parsePromptSizeMeta(it.prompt);
                          const usedSize = String(meta.size ?? '').trim() || imgSize;
                          const ratio = meta.ratio ?? ratioFromSizeString(usedSize) ?? null;
                          const sizeLabel = explicit || meta.size ? usedSize : `继承 ${imgSize}`;
                          return (
                            <>
                              <span
                                className="inline-flex items-center rounded-[10px] px-2 py-1 text-[11px] font-semibold"
                                style={{
                                  border: '1px solid rgba(255,255,255,0.10)',
                                  background: 'rgba(0,0,0,0.20)',
                                  color: 'var(--text-secondary)',
                                }}
                                title="解析到的尺寸（单条覆盖）或回退全局尺寸"
                              >
                                尺寸：{sizeLabel}
                              </span>
                              <span
                                className="inline-flex items-center rounded-[10px] px-2 py-1 text-[11px] font-semibold"
                                style={{
                                  border: '1px solid rgba(255,255,255,0.10)',
                                  background: 'rgba(0,0,0,0.20)',
                                  color: 'var(--text-secondary)',
                                }}
                                title="从提示词/尺寸推导出的比例"
                              >
                                比例：{ratio ?? '—'}
                              </span>
                            </>
                          );
                        })()}
                      </div>

                      {/* 中间区域：做成“预览窗”尺寸与风格，内容展示提示词 */}
                      <div
                        className="mt-2 rounded-[12px] flex flex-col items-center justify-center gap-2 px-3 text-center"
                        style={{
                          border: '1px solid rgba(255,255,255,0.10)',
                          background: 'rgba(255,255,255,0.02)',
                          height: 208,
                          color: 'var(--text-muted)',
                        }}
                        title={it.prompt}
                      >
                        <div
                          className="text-xs font-semibold whitespace-pre-wrap wrap-break-word"
                          style={{
                            color: 'var(--text-primary)',
                            display: '-webkit-box',
                            WebkitLineClamp: 8,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                          }}
                        >
                          {it.prompt}
                        </div>
                      </div>

                      <div className="mt-2 flex items-center justify-between gap-2">
                        <div className="inline-flex items-center rounded-[10px] px-2 py-1 text-[11px] font-semibold"
                             style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.20)', color: 'var(--text-secondary)' }}>
                          条目 #{idx + 1}
                        </div>
                        <Button
                          variant="secondary"
                          size="xs"
                          onClick={() => void copyToClipboard(it.prompt)}
                          title="复制提示词"
                        >
                          <Copy size={14} />
                          复制
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  暂无解析结果
                </div>
              )}
            </div>

            <div className="pt-3 flex items-center justify-end gap-2">
              <Button variant="secondary" size="md" onClick={() => setPlanDialogOpen(false)}>
                取消
              </Button>
              <Button variant="primary" size="md" onClick={startBatchFromPlan} disabled={!planResult?.items?.length}>
                开始生成
              </Button>
            </div>
          </div>
        }
      />

      <Dialog
        open={previewDialog.open}
        onOpenChange={(open) => {
          setPreviewDialog((p) => ({ ...p, open }));
          if (!open) resetPreviewJsonCheck();
        }}
        title={previewDialog.title || '输出预览'}
        description="查看完整输出内容"
        maxWidth={900}
        contentStyle={{ height: 'min(80vh, 680px)' }}
        content={
          <div className="h-full min-h-0 flex flex-col">
            <div className="flex items-center justify-end gap-2 pb-2">
              {previewJsonHint ? (
                <div className="text-[11px] mr-auto" style={{ color: 'var(--text-muted)' }}>
                  {previewJsonHint}
                </div>
              ) : null}
              <SuccessConfettiButton
                title="对输出做严格 JSON 校验"
                size="sm"
                style={
                  {
                    // 对齐本区域其它 secondary sm 按钮（35px 高度）
                    '--sa-h': '35px',
                    '--sa-radius': '10px',
                    '--sa-font': '13px',
                    '--sa-px': '14px',
                    '--sa-minw': '86px',
                  } as unknown as React.CSSProperties
                }
                readyText={previewJsonCheckPhase === 'failed' ? '不通过' : 'JSON检查'}
                loadingText="检查中"
                successText="通过"
                showLoadingText
                loadingMinMs={680}
                completeMode="hold"
                disabled={!((previewDialog.text ?? '').trim()) || previewJsonCheckPhase === 'passed'}
                className={previewJsonCheckPhase === 'failed' ? 'llm-json-sa-failed' : previewJsonCheckPhase === 'passed' ? 'llm-json-sa-passed' : ''}
                onAction={() => {
                  const raw = (previewDialog.text ?? '').trim();
                  const res = validateStrictJson(raw);
                  previewJsonCheckLastRef.current = res.ok ? { ok: true } : { ok: false, reason: res.reason };
                  return res.ok;
                }}
                onPhaseChange={(p) => {
                  if (p === 'loading') {
                    setPreviewJsonCheckPhase('scanning');
                    return;
                  }
                  if (p === 'complete') {
                    setPreviewJsonCheckPhase('passed');
                    setPreviewJsonHint('扫描通过');
                    window.setTimeout(() => setPreviewJsonHint(''), 1200);
                    return;
                  }
                  // 回到 ready（失败路径）：保持红色状态到弹窗关闭/切换
                  if (p === 'ready') {
                    const last = previewJsonCheckLastRef.current;
                    if (last && last.ok === false) {
                      setPreviewJsonCheckPhase('failed');
                      setPreviewJsonHint(`JSON 不合法：${last.reason || '未知原因'}`);
                      window.setTimeout(() => setPreviewJsonHint(''), 2800);
                    } else {
                      setPreviewJsonCheckPhase('idle');
                    }
                  }
                }}
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void copyToClipboard(previewDialog.text || '')}
              >
                <Copy size={16} />
                复制
              </Button>
            </div>
            <div
              className={[
                'flex-1 min-h-0 overflow-auto rounded-[14px] p-3 llm-json-scanBox',
                previewJsonCheckPhase === 'scanning' ? 'llm-json-scanBox--scanning' : '',
                previewJsonCheckPhase === 'failed' ? 'llm-json-scanBox--failed' : '',
                previewJsonCheckPhase === 'passed' ? 'llm-json-scanBox--passed' : '',
              ].join(' ')}
              style={{ border: '1px solid var(--border-subtle)', background: 'rgba(0,0,0,0.22)' }}
            >
              <pre className="text-xs whitespace-pre-wrap wrap-break-word" style={{ color: 'var(--text-primary)' }}>
                {previewDialog.text || '（无输出）'}
              </pre>
            </div>
          </div>
        }
      />

      <Dialog
        open={imagePreviewDialog.open}
        onOpenChange={(open) => setImagePreviewDialog((p) => ({ ...p, open }))}
        title={imagePreviewDialog.title || '图片预览'}
        description="点击图片缩略图可打开此预览"
        maxWidth={1100}
        // 重要：预览图必须“完整可见”，避免使用基于 viewport 的 maxHeight 导致在 Dialog 头部/内边距存在时出现上下裁切
        contentStyle={{ height: 'min(90vh, 880px)' }}
        content={
          <div className="h-full min-h-0 flex flex-col">
            <div className="flex items-center justify-end gap-2 pb-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void downloadImage(imagePreviewDialog.src, imagePreviewDialog.title || 'image')}
                disabled={!imagePreviewDialog.src}
              >
                <Download size={16} />
                下载
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const src = String(imagePreviewDialog.src || '').trim();
                  if (!src) return;
                  void (async () => {
                    const r = await copyImageToClipboardFromSrc(src);
                    if (r.ok) showCopyToast('复制成功');
                    else showCopyToast(r.reason);
                  })();
                }}
                disabled={!imagePreviewDialog.src}
                title="复制图片"
              >
                <Copy size={16} />
                复制图片
              </Button>
            </div>

            <div className="flex-1 min-h-0 overflow-auto rounded-[14px] p-3" style={{ border: '1px solid rgba(255,255,255,0.10)' }}>
              {imagePreviewDialog.src ? (
                <div className="w-full h-full flex items-center justify-center">
                  <img
                    src={imagePreviewDialog.src}
                    alt={imagePreviewDialog.title}
                    className="block"
                    style={{
                      maxWidth: '100%',
                      maxHeight: '100%',
                      width: 'auto',
                      height: 'auto',
                      objectFit: 'contain',
                    }}
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

      {/* 弹窗放在 grid 外，避免参与布局 */}
      <ModelPickerDialog
        open={pickerOpen}
        onOpenChange={(o) => setPickerOpen(o)}
        platforms={platforms}
        selectedModels={selectedModels}
        onConfirm={(finalList) => {
          setSelectedModelsDedupe(finalList);
        }}
      />

      <Dialog
        open={createExperimentOpen}
        onOpenChange={(o) => setCreateExperimentOpen(o)}
        title="新建实验"
        description="输入实验名称后创建"
        content={
          <div className="grid gap-3">
            <input
              value={createExperimentName}
              onChange={(e) => setCreateExperimentName(e.target.value)}
              className="h-10 w-full rounded-[14px] px-3 text-sm outline-none"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
              placeholder="例如：默认实验"
              autoFocus
            />
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                className="inline-flex items-center justify-center gap-2 font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed h-10 px-4 rounded-[12px] text-[13px] text-(--text-primary) hover:bg-white/8 hover:border-white/20"
                style={{ background: 'rgba(255, 255, 255, 0.02)', border: '1px solid rgba(255, 255, 255, 0.12)' }}
                onClick={() => setCreateExperimentOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="inline-flex items-center justify-center gap-2 font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed h-10 px-4 rounded-[12px] text-[13px] text-(--text-primary) hover:bg-white/8 hover:border-white/20"
                style={{ background: 'rgba(255, 255, 255, 0.06)', border: '1px solid rgba(255, 255, 255, 0.12)' }}
                onClick={confirmCreateExperiment}
                disabled={!createExperimentName.trim()}
              >
                创建
              </button>
            </div>
          </div>
        }
      />

      <Dialog
        open={loadExperimentOpen}
        onOpenChange={(o) => setLoadExperimentOpen(o)}
        title="加载实验"
        description="选择一个实验加载到试验区"
        content={
          <div className="grid gap-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                共 {experiments.length} 个实验
              </div>
              <button
                type="button"
                className="inline-flex items-center justify-center gap-2 font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed h-[30px] px-3 rounded-[10px] text-[12px] text-(--text-primary) hover:bg-white/8 hover:border-white/20 shrink-0"
                style={{ background: 'rgba(255, 255, 255, 0.06)', border: '1px solid rgba(255, 255, 255, 0.12)' }}
                onClick={load}
                disabled={experimentsLoading}
              >
                刷新列表
              </button>
            </div>

            {experiments.length === 0 ? (
              <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                暂无实验
              </div>
            ) : (
              <div className="max-h-[420px] overflow-auto pr-1 rounded-[14px]" style={{ border: '1px solid rgba(255,255,255,0.10)' }}>
                <div className="p-2 grid gap-1">
                  {experiments.map((e) => (
                    <div
                      key={e.id}
                      className="flex items-center justify-between gap-3 rounded-[12px] px-3 py-2 hover:bg-white/4"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      <button
                        type="button"
                        className="flex items-center gap-3 min-w-0 flex-1 text-left cursor-pointer"
                        style={{ color: 'inherit' }}
                        onClick={() => setLoadExperimentId(e.id)}
                      >
                        <input type="radio" name="load-experiment" checked={loadExperimentId === e.id} onChange={() => setLoadExperimentId(e.id)} />
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold truncate">{e.name}</span>
                          <span className="block text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                            #{shortId(e.id)} · 模型 {e.selectedModels?.length ?? 0} · {formatDateTime(e.updatedAt)}
                          </span>
                        </span>
                      </button>

                      <button
                        type="button"
                        className="inline-flex items-center justify-center gap-2 font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed h-[30px] px-3 rounded-[10px] text-[12px] text-(--text-primary) hover:bg-white/8 hover:border-white/20 shrink-0"
                        style={{ background: 'rgba(255, 255, 255, 0.02)', border: '1px solid rgba(255, 255, 255, 0.12)' }}
                        onClick={async (evt) => {
                          evt.stopPropagation();
                          const ok = await systemDialog.confirm({
                            title: '确认删除',
                            message: `确定删除实验“${e.name}”？（不可恢复）`,
                            tone: 'danger',
                            confirmText: '删除',
                            cancelText: '取消',
                          });
                          if (!ok) return;
                          await deleteExperiment(e.id);
                        }}
                        title="删除实验"
                      >
                        <Trash2 size={14} />
                        删除
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                className="inline-flex items-center justify-center gap-2 font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed h-10 px-4 rounded-[12px] text-[13px] text-(--text-primary) hover:bg-white/8 hover:border-white/20"
                style={{ background: 'rgba(255, 255, 255, 0.02)', border: '1px solid rgba(255, 255, 255, 0.12)' }}
                onClick={() => setLoadExperimentOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="inline-flex items-center justify-center gap-2 font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed h-10 px-4 rounded-[12px] text-[13px] text-(--text-primary) hover:bg-white/8 hover:border-white/20"
                style={{ background: 'rgba(255, 255, 255, 0.06)', border: '1px solid rgba(255, 255, 255, 0.12)' }}
                onClick={confirmLoadExperiment}
                disabled={!loadExperimentId}
              >
                加载
              </button>
            </div>
          </div>
        }
      />
    </div>
  );
}
