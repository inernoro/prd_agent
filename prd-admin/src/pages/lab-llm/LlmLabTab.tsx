import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, Clock3, Copy, Cpu, Download, Expand, ImagePlus, Layers, Maximize2, Plus, ScanEye, Sparkles, Star, TimerOff, Trash2, Zap } from 'lucide-react';
import JSZip from 'jszip';

import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
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
} from '@/services';
import type { ModelLabExperiment, ModelLabModelSet, ModelLabParams, ModelLabSelectedModel, ModelLabSuite } from '@/services/contracts/modelLab';
import type { ImageGenGenerateResponse, ImageGenPlanItem, ImageGenPlanResponse } from '@/services/contracts/imageGen';
import { ModelPickerDialog } from '@/pages/lab-llm/components/ModelPickerDialog';
import { useAuthStore } from '@/stores/authStore';
import { clearLlmLabImagesForUser, getLlmLabImageBlob, putLlmLabImageBlob } from '@/lib/llmLabImageDb';
import { emitBackdropBusyEnd, emitBackdropBusyStart, waitForBackdropBusyStopped } from '@/lib/backdropBusy';

type ViewRunItem = {
  itemId: string;
  modelId: string;
  displayName: string;
  modelName: string;
  /** 配置模型的真实 id（用于“设为主/意图”等全局设置）。如果流里返回的 modelId 不是配置 id，会用 modelName 回查得到 */
  configModelId?: string;
  status: 'running' | 'done' | 'error';
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
type ImageSubMode = 'single' | 'batch';

type ImageViewItem = {
  key: string;
  status: 'running' | 'done' | 'error';
  prompt: string;
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
  id: '1:1' | '4:3' | '3:4' | '16:9' | '9:16';
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
  { id: '16:9', label: '16:9', size: '1280x720', iconW: 24, iconH: 14 },
  { id: '9:16', label: '9:16', size: '720x1280', iconW: 14, iconH: 24 },
];

function signatureOfSelectedModels(list: ModelLabSelectedModel[]) {
  // 用于“是否需要自动保存”的变更检测；与 setSelectedModelsDedupe 的唯一性规则保持一致（平台 + modelName）
  return (list ?? [])
    .map((m) => `${String(m.platformId ?? '').trim()}:${String(m.modelName ?? '').trim()}`.toLowerCase())
    .filter(Boolean)
    .sort()
    .join('|');
}

function modelKeyOfSelected(m: ModelLabSelectedModel): string {
  const pid = String(m?.platformId ?? '').trim();
  const name = String(m?.modelName ?? '').trim();
  return `${pid}:${name}`.toLowerCase();
}

function filenameSafe(s: string) {
  const base = (s || '').trim().slice(0, 32) || 'image';
  return base
    .replace(/[\s/\\:*?"<>|]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const MAX_RUN_RAW_CHARS = 60_000;

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
    return { label: 'FunctionCall', ok: fc.ok, reason: fc.ok ? '通过（识别到 function call 结构）' : fc.reason };
  }

  // formatTest === 'mcp'
  const mcp = isMcpJsonShape(parsed.value);
  return { label: 'MCP', ok: mcp.ok, reason: mcp.ok ? '通过（识别到 MCP JSON 结构）' : mcp.reason };
}

function tryParseImageGenPlan(raw: string): { ok: true; itemsLen: number } | { ok: false; reason: string } {
  const text0 = (raw ?? '').trim();
  if (!text0) return { ok: false, reason: '空输出' };

  // 容错：截取最外层 JSON 对象（与后端 plan 逻辑一致）
  let text = text0;
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    text = text.slice(first, last + 1);
  }

  try {
    const obj = JSON.parse(text) as any;
    const items = obj?.items;
    if (!Array.isArray(items)) return { ok: false, reason: 'items 不是数组' };
    return { ok: true, itemsLen: items.length };
  } catch {
    return { ok: false, reason: '返回不是合法 JSON' };
  }
}

function getImagePlanItemsLenFromRaw(raw: string): number | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  const parsed = tryParseImageGenPlan(t);
  if (!parsed.ok) return 0;
  return parsed.itemsLen;
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

  for (const it of items) {
    const src = (it.src || '').trim();
    const name = filenameSafe(it.filename) || 'image';
    const finalName = name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg') ? name : `${name}.png`;
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
    alert('没有可下载的图片（可能被跨域限制）');
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

const defaultParams: ModelLabParams = {
  temperature: 0.2,
  maxTokens: null,
  timeoutMs: 60000,
  maxConcurrency: 10,
  repeatN: 1,
};

const HMARQUEE_GAP_PX = 28;
const HMARQUEE_SPEED_PX_PER_SEC = 64;

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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLSpanElement | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [shiftPx, setShiftPx] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const [paused, setPaused] = useState(false);

  const normalized = (text ?? '').replace(/\s+/g, ' ').trim() || '（无输出）';

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return;

    const recompute = () => {
      const containerW = container.clientWidth;
      const contentW = measure.offsetWidth;
      const need = contentW > containerW + 2;
      const shift = contentW + HMARQUEE_GAP_PX;
      setEnabled(need);
      setShiftPx(shift);
      setDurationSec(Math.max(6, shift / HMARQUEE_SPEED_PX_PER_SEC));
    };

    recompute();
    const ro = new ResizeObserver(() => recompute());
    ro.observe(container);
    return () => ro.disconnect();
  }, [normalized]);

  const vars = useMemo(() => {
    const v: Record<'--prd-hmarquee-shift' | '--prd-hmarquee-duration' | '--prd-hmarquee-gap', string> = {
      '--prd-hmarquee-shift': `${shiftPx}px`,
      '--prd-hmarquee-duration': `${durationSec}s`,
      '--prd-hmarquee-gap': `${HMARQUEE_GAP_PX}px`,
    };
    return v as unknown as React.CSSProperties;
  }, [durationSec, shiftPx]);

  return (
    <div
      ref={containerRef}
      className={className}
      title={title || normalized}
      style={{
        minWidth: 0,
        width: '100%',
        overflow: 'hidden',
        ...vars,
        ...style,
      }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <style>{`
@keyframes prd-hmarquee {
  0% { transform: translateX(0); }
  100% { transform: translateX(calc(-1 * var(--prd-hmarquee-shift))); }
}
`}</style>

      {enabled ? (
        <div
          style={{
            display: 'flex',
            gap: `var(--prd-hmarquee-gap)`,
            whiteSpace: 'nowrap',
            animation: 'prd-hmarquee var(--prd-hmarquee-duration) linear infinite',
            animationPlayState: paused ? 'paused' : 'running',
            willChange: 'transform',
          }}
        >
          <span ref={measureRef} style={{ whiteSpace: 'nowrap' }}>
            {normalized}
          </span>
          <span aria-hidden style={{ whiteSpace: 'nowrap' }}>
            {normalized}
          </span>
        </div>
      ) : (
        <div
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          <span ref={measureRef} style={{ whiteSpace: 'nowrap' }}>
            {normalized}
          </span>
        </div>
      )}
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
    { label: 'JSON', promptText: '请把下面内容转换为结构化 JSON，并严格只输出 JSON（不要 Markdown/解释/多余字符）。\n\n输入：我想申请退款，订单号 12345。' },
  ],
  mcp: [
    { label: 'MCP', promptText: '用户输入：请在知识库里搜索“退款流程”，并给出下一步建议。\n\n请严格只输出 MCP JSON（不要 Markdown/解释）。\n推荐：{"server":"kb","tool":"search","arguments":{"query":"退款流程"}}' },
  ],
  functionCall: [
    { label: 'FunctionCall', promptText: '用户输入：查询订单 12345 的状态。\n\n请严格只输出 FunctionCall JSON（不要 Markdown/解释）。\n推荐：{"name":"order.getStatus","arguments":{"orderId":"12345"}}' },
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

  // suite：会被保存进实验（仅 speed/intent/custom）
  const [suite, setSuite] = useState<ModelLabSuite>('speed');
  // mode：纯 UI 选择（6 个互斥类型），不写入实验，避免被 suite 回填覆盖
  const [mode, setMode] = useState<LabMode>('speed');
  const expectedFormat: ExpectedFormat | undefined =
    mode === 'json' || mode === 'mcp' || mode === 'functionCall' || mode === 'imageGenPlan' ? mode : undefined;
  const [params, setParams] = useState<ModelLabParams>(defaultParams);
  const [promptText, setPromptText] = useState<string>('');
  const [selectedModels, setSelectedModels] = useState<ModelLabSelectedModel[]>([]);
  // 临时禁用：仅影响“本次运行”（startRun 时过滤），不写入实验 selectedModels
  const [disabledModelKeys, setDisabledModelKeys] = useState<Record<string, boolean>>({});

  const [mainMode, setMainMode] = useState<MainMode>('infer');
  const [imageSubMode, setImageSubMode] = useState<ImageSubMode>('single');
  const [imgSize, setImgSize] = useState<string>('1024x1024');
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

  const [imageGridEl, setImageGridEl] = useState<HTMLDivElement | null>(null);
  const imageGridRef = useCallback((el: HTMLDivElement | null) => setImageGridEl(el), []);
  const [imageThumbHeight, setImageThumbHeight] = useState(220);

  const [modelSets, setModelSets] = useState<ModelLabModelSet[]>([]);
  const [modelSetName, setModelSetName] = useState('');

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

  const [imagePreviewDialog, setImagePreviewDialog] = useState<{ open: boolean; title: string; src: string }>({
    open: false,
    title: '图片预览',
    src: '',
  });

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
      if (typeof data.mode === 'string') setMode(data.mode as any);
      if (data.suite === 'speed' || data.suite === 'intent' || data.suite === 'custom') setSuite(data.suite);
      if (data.sortBy === 'ttft' || data.sortBy === 'total' || data.sortBy === 'imagePlanItemsDesc') setSortBy(data.sortBy);
      if (data.disabledModelKeys && typeof data.disabledModelKeys === 'object') setDisabledModelKeys(data.disabledModelKeys as any);
      if (data.imageSubMode === 'single' || data.imageSubMode === 'batch') setImageSubMode(data.imageSubMode);
      if (typeof data.imgSize === 'string' && data.imgSize.trim()) setImgSize(data.imgSize.trim());
      if (typeof data.singleN === 'number') setSingleN(Math.max(1, Math.min(20, Number(data.singleN || 1))));
      if (typeof data.promptText === 'string') setPromptText(data.promptText);

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
    const created = await createModelLabExperiment({ name, suite: 'speed', params: defaultParams, selectedModels: [] });
    if (!created.success) return alert(created.error?.message || '创建失败');
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
    if (!res.success) return alert(res.error?.message || '删除失败');

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
          suite: 'speed',
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

    setSuite(activeExperiment.suite);
    setMode(activeExperiment.suite);
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
    // 唯一选择：平台 + modelName
    const map = new Map<string, ModelLabSelectedModel>();
    for (const m of list) {
      const key = `${m.platformId}:${m.modelName}`.toLowerCase();
      const prev = map.get(key);
      // 若冲突，优先保留有 name 的那条（更像“配置模型”）
      if (!prev || (m.name && !prev.name)) map.set(key, m);
    }
    setSelectedModels(Array.from(map.values()));
  };

  const removeSelectedModel = (modelId: string) => {
    setSelectedModels((prev) => prev.filter((x) => x.modelId !== modelId));
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
        if (!opts?.silent) alert(res.error?.message || '保存失败');
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
    setMode('speed');
    setSuite('speed');
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
    if (!prompt) return alert('请输入要生图的描述');
    if (imageGenModels.length === 0) return alert('请先在左侧选择至少 1 个模型');

    const perModelN = Math.max(1, Math.min(20, Number(singleN || 1)));
    const total = perModelN * imageGenModels.length;
    if (total > 3) {
      const ok = window.confirm(`你将使用 ${imageGenModels.length} 个模型生成 ${perModelN} × ${imageGenModels.length} = ${total} 张图片，是否继续？`);
      if (!ok) return;
    }

    setImageError(null);
    setImageRunning(true);
    setSingleSelected({});

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
          };
        });
      });
    }
    if (anyFailed) setImageError('部分模型生成失败（请查看对应图片卡片）');
    setImageRunning(false);
  };

  const parseBatchPlan = async () => {
    const text = (promptText ?? '').trim();
    if (!text) return alert('请输入要批量生图的描述');
    if (imageGenModels.length === 0) return alert('请先在左侧选择至少 1 个模型');

    setBatchError(null);
    setPlanLoading(true);
    emitBackdropBusyStart();
    let nextPlan: ImageGenPlanResponse | null = null;
    let stopId: string | null = null;
    try {
      const res = await planImageGen({ text, maxItems: 10 });
      if (!res.success) {
        setBatchError(res.error?.message || '解析失败');
        return;
      }
      nextPlan = res.data ?? null;
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
    if (imageGenModels.length === 0) return alert('请先在左侧选择至少 1 个模型');

    const planTotal = Math.max(0, Number(planResult.total || 0));
    const total = planTotal * imageGenModels.length;
    if (total > 3) {
      const ok = window.confirm(`你将使用 ${imageGenModels.length} 个模型生成 ${planTotal} × ${imageGenModels.length} = ${total} 张图片，是否继续？`);
      if (!ok) return;
    }

    stopBatchRun({ forRestart: true });
    batchStopRequestedRef.current = false;
    setBatchError(null);
    setBatchItems({});
    setPlanDialogOpen(false);
    setBatchRunning(true);

    const items = (planResult.items ?? []) as ImageGenPlanItem[];
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
                const item: ImageViewItem = {
                  key,
                  status: 'running',
                  prompt: String(obj.prompt ?? ''),
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
                  };
                  return {
                    ...p,
                    [key]: {
                      ...cur,
                      status: 'done',
                      base64: obj.base64 ?? null,
                      url: obj.url ?? null,
                      revisedPrompt: obj.revisedPrompt ?? null,
                    },
                  };
                });
                return;
              }
              if (obj.type === 'imageError') {
                setBatchItems((p) => {
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
                  };
                  return {
                    ...p,
                    [key]: {
                      ...cur,
                      status: 'error',
                      errorMessage: obj.errorMessage || '失败',
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

    batchAbortRef.current = null;
    setBatchRunning(false);
    setBatchActiveModelLabel('');
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
    if (!activeExperimentId) return alert('请先选择实验');
    if (selectedModels.length === 0) return alert('请先加入至少 1 个模型');

    // 临时禁用：本次运行只跑“未禁用模型”，不改实验配置
    const enabledModels = (selectedModels ?? []).filter((m) => !disabledModelKeys[modelKeyOfSelected(m)]);
    if (enabledModels.length === 0) return alert('当前已将所有模型临时禁用，请先点击模型恢复至少 1 个再运行');

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
              setRunError(obj.errorMessage || '运行失败');
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
                return {
                  ...p,
                  [obj.itemId]: {
                    ...cur,
                    status: 'done',
                    ttftMs: obj.ttftMs ?? cur.ttftMs,
                    totalMs: obj.totalMs ?? cur.totalMs,
                    preview: typeof obj.preview === 'string' ? obj.preview : cur.preview,
                  },
                };
              });
              return;
            }
            if (obj.type === 'modelError') {
              setRunItems((p) => {
                const cur = p[obj.itemId];
                if (!cur) return p;
                return { ...p, [obj.itemId]: { ...cur, status: 'error', errorMessage: obj.errorMessage || '失败' } };
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
        const aLen = getImagePlanItemsLenFromRaw(a.rawText ?? a.preview ?? '') ?? 0;
        const bLen = getImagePlanItemsLenFromRaw(b.rawText ?? b.preview ?? '') ?? 0;
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
    const res = await setMainModel(modelId);
    if (!res.success) return await refreshModelsSilent();
    await refreshModelsSilent();
  };

  const onSetIntentFromRun = async (modelId: string) => {
    setUniqueFlagLocal(modelId, 'isIntent');
    const res = await setIntentModel(modelId);
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
      alert(res.error?.message || '取消视觉模型失败');
      return;
    }
    await refreshModelsSilent();
  };

  const onClearImageGenFromRun = async () => {
    setAllModels((prev) => prev.map((m) => ({ ...m, isImageGen: false } as any)));
    const res = await clearImageGenModel();
    if (!res.success) {
      await refreshModelsSilent();
      alert(res.error?.message || '取消生图模型失败');
      return;
    }
    await refreshModelsSilent();
  };

  const onSetVisionFromRun = async (modelId: string) => {
    setUniqueFlagLocal(modelId, 'isVision');
    const res = await setVisionModel(modelId);
    if (!res.success) return await refreshModelsSilent();
    await refreshModelsSilent();
  };

  const onSetImageGenFromRun = async (modelId: string) => {
    setUniqueFlagLocal(modelId, 'isImageGen');
    const res = await setImageGenModel(modelId);
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
    if (mode !== next) {
      // 切换 speed/intent/custom 时，同步 suite（会写入实验）
      if (next === 'speed' || next === 'intent' || next === 'custom') {
        setSuite(next);
        isModeSwitchingRef.current = false; // 这些模式会保存，所以允许自动保存
      } else {
        // json/mcp/functionCall/imageGenPlan 只是模板切换，不触发保存
        isModeSwitchingRef.current = true;
      }
      // 生图意图：默认按“识别条目数倒序”排序；其他模式回到 TTFT/总耗时
      if (next === 'imageGenPlan') setSortBy('imagePlanItemsDesc');
      else if (sortBy === 'imagePlanItemsDesc') setSortBy('ttft');
      setMode(next);
      // 关键：切换模式时不自动塞模板内容，避免用户还没粘贴就要先删一堆字；
      // 如果用户想用内置模板，重复点击当前 mode 会循环填充（见下面分支）。
      // 下一次再点时，从第一条开始循环
      suiteCycleRef.current[next] = 0;
      return;
    }

    // 重复点击当前 mode：循环填充内置提示词
    const list = builtInPrompts[next] ?? [];
    if (list.length === 0) return;
    const cur = suiteCycleRef.current[next] ?? 0;
    const idx = ((cur % list.length) + list.length) % list.length;
    // 重复点击时，如果是 json/mcp/functionCall/imageGenPlan，也不触发保存
    if (next === 'json' || next === 'mcp' || next === 'functionCall' || next === 'imageGenPlan') {
      isModeSwitchingRef.current = true;
    }
    applyBuiltInPrompt(list[idx].promptText);
    suiteCycleRef.current[next] = (idx + 1) % list.length;
  };

  const saveModelSet = async () => {
    if (!modelSetName.trim()) return alert('请输入集合名称');
    if (selectedModels.length === 0) return alert('当前没有已选择的模型');
    const res = await upsertModelLabModelSet({ name: modelSetName.trim(), models: selectedModels });
    if (!res.success) return alert(res.error?.message || '保存失败');
    await loadModelSets();
    setModelSetName('');
  };

  const canRun = !running && selectedModels.length > 0;

  const formatParamChips = useMemo(() => {
    const chips: { key: string; label: string }[] = [];
    const modeLabel =
      mode === 'speed'
        ? '速度'
        : mode === 'intent'
          ? '意图'
          : mode === 'custom'
            ? '自定义'
            : mode === 'json'
              ? 'JSON'
              : mode === 'mcp'
                ? 'MCP'
                : mode === 'imageGenPlan'
                  ? '生图意图'
                  : 'FunctionCall';
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
      <div className="h-full min-h-0 grid gap-x-5 gap-y-4 lg:grid-cols-[360px_1fr] lg:grid-rows-[auto_1fr]">
        {/* 左上：试验区 */}
        <div className="min-w-0 min-h-0 lg:col-start-1 lg:row-start-1">
          <Card className="p-4">
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

          <div className="mt-3 grid gap-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
              并发
              <input
                type="number"
                value={params.maxConcurrency}
                onChange={(e) => setParams((p) => ({ ...p, maxConcurrency: Math.max(1, Number(e.target.value || 1)) }))}
                className="mt-1 h-9 w-full rounded-[12px] px-2 text-sm outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
              />
            </label>
            <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
              重复 N 次
              <input
                type="number"
                value={params.repeatN}
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
          </Card>
        </div>

        {/* 左下：自定义模型集合 + 大模型实验 */}
        <div className="min-w-0 min-h-0 lg:col-start-1 lg:row-start-2">
          <Card className="p-4 overflow-hidden flex flex-col min-h-0 h-full">
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

            <div className="mt-3 flex items-center gap-2">
              <input
                value={modelSetName}
                onChange={(e) => setModelSetName(e.target.value)}
                className="h-10 flex-1 rounded-[14px] px-3 text-sm outline-none"
                style={{ background: 'rgba(255, 255, 255, 0.04)', border: '1px solid rgba(255, 255, 255, 0.12)', color: 'var(--text-primary)' }}
                placeholder="集合名称（用于保存当前选择）"
              />
              <button
                type="button"
                className="inline-flex items-center justify-center gap-2 font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed h-10 px-4 rounded-[12px] text-[13px] text-(--text-primary) hover:bg-white/8 hover:border-white/20"
                style={{ background: 'rgba(255, 255, 255, 0.06)', border: '1px solid rgba(255, 255, 255, 0.12)' }}
                onClick={saveModelSet}
                disabled={selectedModels.length === 0}
              >
                <Layers size={16} />
                保存
              </button>
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
                        <Layers size={14} />
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
              {modelsLoading ? <Badge variant="subtle">加载中</Badge> : null}
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
                              <label
                                className="inline-flex items-center gap-1 rounded-[999px] px-2 py-[2px] text-[11px] shrink-0 max-w-full truncate"
                                style={{
                                  border: '1px solid rgba(255,255,255,0.10)',
                                  background: 'rgba(255,255,255,0.04)',
                                  color: 'var(--text-muted)',
                                }}
                                title={platformLabel}
                              >
                                <Cpu size={12} className="shrink-0" />
                                <span className="truncate">{platformLabel}</span>
                              </label>
                              <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                                {list.length} 个{disabledCount > 0 ? `（禁用 ${disabledCount}）` : ''}
                              </div>
                            </div>
                          </div>

                          <div className="mt-2 flex flex-col gap-2">
                            {list.map((m) => {
                              const isDisabled = !!disabledModelKeys[modelKeyOfSelected(m)];
                              return (
                                <button
                                  key={m.modelId}
                                  className="w-full rounded-[12px] px-3 py-2 text-xs flex items-center justify-between gap-3 min-w-0"
                                  style={{
                                    border: isDisabled ? '1px solid rgba(255,255,255,0.06)' : '1px solid rgba(255,255,255,0.10)',
                                    background: isDisabled ? 'rgba(255,255,255,0.01)' : 'rgba(255,255,255,0.02)',
                                    color: isDisabled ? 'var(--text-muted)' : 'var(--text-primary)',
                                    opacity: isDisabled ? 0.78 : 1,
                                  }}
                                  onClick={() => toggleDisabledSelectedModel(m)}
                                  title={m.name || m.modelName}
                                  type="button"
                                >
                                  <span className="flex items-center gap-2 min-w-0">
                                    <span
                                      className="min-w-0 truncate"
                                      style={{
                                        color: isDisabled ? 'var(--text-muted)' : 'var(--text-primary)',
                                        textDecoration: isDisabled ? 'line-through' : 'none',
                                      }}
                                    >
                                      {m.name || m.modelName}
                                    </span>
                                  </span>
                                  <button
                                    type="button"
                                    className="shrink-0 inline-flex items-center justify-center h-7 w-7 rounded-[10px] transition-colors hover:bg-white/6"
                                    style={{ border: '1px solid rgba(255,255,255,0.10)', color: 'var(--text-muted)' }}
                                    title="从实验中移除该模型"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      removeSelectedModel(m.modelId);
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
                                </button>
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
          </Card>
        </div>

        {/* 右上：提示词 */}
        <div className="min-w-0 min-h-0 lg:col-start-2 lg:row-start-1">
          <Card className="p-4 h-full">
          <div className="flex items-center justify-between gap-3 min-w-0">
            <div className="flex gap-2 overflow-x-auto pr-1">
              <Button size="xs" variant={mainMode === 'infer' ? 'primary' : 'secondary'} className="shrink-0" onClick={() => onMainModeChange('infer')}>
                推理
              </Button>
              <Button
                size="xs"
                variant={mainMode === 'image' ? 'primary' : 'secondary'}
                className="shrink-0"
                onClick={() => onMainModeChange('image')}
              >
                生图
              </Button>
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
              ) : (
                <>
                  <Button
                    variant={batchRunning ? 'danger' : 'primary'}
                    size="md"
                    onClick={() => (batchRunning ? stopBatchRun() : void parseBatchPlan())}
                    disabled={planLoading}
                  >
                    <Sparkles size={16} />
                    {batchRunning ? '停止' : planLoading ? '解析中' : '解析并预览'}
                  </Button>
                </>
              )}
            </div>
          </div>

          {mainMode === 'infer' ? (
            <div className="mt-2 flex gap-2 overflow-x-auto pr-1">
              <Button size="xs" variant={mode === 'speed' ? 'primary' : 'secondary'} className="shrink-0" onClick={() => onModeClick('speed')}>
              <Sparkles size={14} />
              速度
            </Button>
            <Button size="xs" variant={mode === 'intent' ? 'primary' : 'secondary'} className="shrink-0" onClick={() => onModeClick('intent')}>
              <Sparkles size={14} />
              意图
            </Button>
            <Button size="xs" variant={mode === 'custom' ? 'primary' : 'secondary'} className="shrink-0" onClick={() => onModeClick('custom')}>
              <Sparkles size={14} />
              自定义
            </Button>
            <Button size="xs" variant={mode === 'json' ? 'primary' : 'secondary'} className="shrink-0" onClick={() => onModeClick('json')}>
              JSON
            </Button>
            <Button size="xs" variant={mode === 'mcp' ? 'primary' : 'secondary'} className="shrink-0" onClick={() => onModeClick('mcp')}>
              MCP
            </Button>
            <Button size="xs" variant={mode === 'functionCall' ? 'primary' : 'secondary'} className="shrink-0" onClick={() => onModeClick('functionCall')}>
              FunctionCall
            </Button>
            <Button size="xs" variant={mode === 'imageGenPlan' ? 'primary' : 'secondary'} className="shrink-0" onClick={() => onModeClick('imageGenPlan')}>
              <Sparkles size={14} />
              生图意图
            </Button>
          </div>
          ) : (
            <div className="mt-2 flex flex-nowrap items-center gap-2 overflow-x-auto pr-1">
              <div className="flex gap-2 shrink-0">
                <Button
                  size="xs"
                  variant={imageSubMode === 'single' ? 'primary' : 'secondary'}
                  className="shrink-0"
                  onClick={() => setImageSubMode('single')}
                >
                  单张
                </Button>
                <Button
                  size="xs"
                  variant={imageSubMode === 'batch' ? 'primary' : 'secondary'}
                  className="shrink-0"
                  onClick={() => setImageSubMode('batch')}
                >
                  批量
                </Button>
              </div>
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
                <div className="flex items-center gap-2">
                  {ASPECT_OPTIONS.map((opt) => {
                    const active = imgSize === opt.size;
                    const scale = 0.55;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        className="shrink-0 h-[28px] rounded-[10px] px-2 transition-colors inline-flex items-center justify-center gap-1.5"
                        style={{
                          width: 64,
                          background: active ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.03)',
                          border: active ? '1px solid rgba(255,255,255,0.18)' : '1px solid rgba(255,255,255,0.10)',
                          color: 'var(--text-primary)',
                        }}
                        onClick={() => setImgSize(opt.size)}
                        title={opt.label}
                        aria-pressed={active}
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
                              width: Math.max(6, Math.round(opt.iconW * scale)),
                              height: Math.max(6, Math.round(opt.iconH * scale)),
                              borderRadius: 4,
                              border: '2px solid rgba(255,255,255,0.22)',
                              background: 'rgba(255,255,255,0.02)',
                            }}
                          />
                        </span>
                        <span className="text-[11px] font-semibold" style={{ color: active ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                          {opt.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              {imageSubMode === 'batch' && planResult?.total ? (
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  已解析：{planResult.total} 张
                </span>
              ) : null}
            </div>
          )}

          <textarea
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            className="mt-2 h-20 w-full rounded-[14px] px-3 py-2 text-sm outline-none resize-none"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
            placeholder={
              mainMode === 'infer'
                ? mode === 'imageGenPlan'
                  ? '粘贴文章/PRD/需求（系统会用内置“生图意图解析”提示词生成 JSON：{total, items:[{prompt,count}] }）'
                  : '输入本次对比测试的 prompt（可使用内置模板快速填充）'
                : imageSubMode === 'single'
                  ? '输入要生成的图片描述（将直接交给生图模型）'
                  : '输入需求描述（将先用意图模型解析出图片清单并提示数量）'
            }
          />
          </Card>
        </div>

        {/* 右下：实时结果 */}
        <div className="min-w-0 min-h-0 lg:col-start-2 lg:row-start-2">
          <Card className="p-4 overflow-hidden flex flex-col min-h-0 h-full">
          {mainMode === 'infer' ? (
            <>
          <div className="flex items-center justify-between shrink-0">
            <div className="text-sm font-semibold min-w-0" style={{ color: 'var(--text-primary)' }}>
              实时结果（按 {sortBy === 'imagePlanItemsDesc' ? '识别条目数（倒序）' : sortBy === 'ttft' ? '首字延迟 TTFT' : '总时长'} 优先排序）
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
              <div
                className="inline-flex p-[3px] rounded-[12px]"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)' }}
              >
                <button
                  type="button"
                  onClick={() => setSortBy(mode === 'imageGenPlan' ? 'imagePlanItemsDesc' : 'ttft')}
                  aria-pressed={mode === 'imageGenPlan' ? sortBy === 'imagePlanItemsDesc' : sortBy === 'ttft'}
                  className="h-[30px] px-3 rounded-[10px] text-[12px] font-semibold transition-colors inline-flex items-center gap-1.5"
                  style={{
                    color: 'var(--text-primary)',
                    background: (mode === 'imageGenPlan' ? sortBy === 'imagePlanItemsDesc' : sortBy === 'ttft') ? 'rgba(255,255,255,0.08)' : 'transparent',
                    border: (mode === 'imageGenPlan' ? sortBy === 'imagePlanItemsDesc' : sortBy === 'ttft') ? '1px solid rgba(255,255,255,0.16)' : '1px solid transparent',
                  }}
                  title={mode === 'imageGenPlan' ? '按识别条目数（倒序）排序' : '按首字延迟（TTFT）排序'}
                >
                  <Zap size={14} />
                  {mode === 'imageGenPlan' ? '识别条目' : '首字延迟'}
                </button>
                {mode !== 'imageGenPlan' ? (
                  <button
                    type="button"
                    onClick={() => setSortBy('total')}
                    aria-pressed={sortBy === 'total'}
                    className="h-[30px] px-3 rounded-[10px] text-[12px] font-semibold transition-colors inline-flex items-center gap-1.5"
                    style={{
                      color: 'var(--text-primary)',
                      background: sortBy === 'total' ? 'rgba(255,255,255,0.08)' : 'transparent',
                      border: sortBy === 'total' ? '1px solid rgba(255,255,255,0.16)' : '1px solid transparent',
                    }}
                    title="按总耗时排序"
                  >
                    <Clock3 size={14} />
                    总时长
                  </button>
                ) : null}
              </div>
              {!running && failedRunCount > 0 ? (
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={async () => {
                    if (!activeExperimentId) return;
                    const ok = window.confirm(`检测到 ${failedRunCount} 个失败模型，是否一键从“已选择模型”中剔除并保存？`);
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
                      alert('未能匹配到需要剔除的模型（可能缺少平台信息或已被移除）');
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
                      alert(res.error?.message || '保存失败');
                      return;
                    }
                    setExperiments((prev) => prev.map((e) => (e.id === res.data.id ? res.data : e)));

                    // 同步“已保存快照”，避免自动保存再触发一次
                    const sig = [String(suite ?? ''), JSON.stringify(params ?? {}), String(promptText ?? ''), signatureOfSelectedModels(nextSelected)].join('||');
                    lastSavedSigRef.current = sig;
                    lastSavedExperimentIdRef.current = res.data.id;
                    alert(`已剔除 ${selectedModels.length - nextSelected.length} 个失败模型并保存`);
                  }}
                  title="将本次运行失败（status=error）的模型从已选择列表中移除，并保存到实验配置"
                >
                  一键剔除失败模型
                </Button>
              ) : null}
              {running ? <Badge variant="subtle">运行中</Badge> : <Badge variant="subtle">就绪</Badge>}
            </div>
          </div>

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
                {sortedItems.map((it) => (
                  <div
                    key={it.itemId}
                    className="rounded-[14px] p-3"
                    style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}
                  >
                    {(() => {
                      const raw = (it.rawText ?? it.preview ?? '').trim();
                      const v = raw ? validateByFormatTest(expectedFormat, raw) : null;
                      const imgPlanLen = mode === 'imageGenPlan' && raw ? getImagePlanItemsLenFromRaw(raw) : null;
                      const chipStyle = (ok: boolean): React.CSSProperties => ({
                        background: ok ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.10)',
                        border: ok ? '1px solid rgba(34,197,94,0.28)' : '1px solid rgba(239,68,68,0.22)',
                        color: ok ? 'rgba(34,197,94,0.95)' : 'rgba(239,68,68,0.92)',
                      });
                      return (
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          {v ? (
                            <span
                              className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide"
                              style={chipStyle(v.ok)}
                              title={v.reason}
                            >
                              {v.label} {v.ok ? '通过' : '失败'}
                            </span>
                          ) : null}
                          {mode === 'imageGenPlan' ? (
                            <span
                              className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide"
                              style={{
                                background: 'rgba(250, 204, 21, 0.08)',
                                border: '1px solid rgba(250, 204, 21, 0.30)',
                                color: 'rgba(250, 204, 21, 0.95)',
                              }}
                              title="识别条目数 = items.length（按此字段倒序排序）"
                            >
                              识别条目 {typeof imgPlanLen === 'number' ? imgPlanLen : '-'}
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
                        <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                          {it.displayName}
                        </div>
                        <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                          {(() => {
                            const name = (it.modelName ?? '').trim();
                            const id = (it.modelId ?? '').trim();
                            if (name && id && name !== id) return `${name} · ${id}`;
                            return name || id || '-';
                          })()}
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
                                  'hover:bg-black/55 hover:border-white/30 hover:-translate-y-[1px]',
                                ].join(' ')}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void copyToClipboard(it.prompt);
                                }}
                                aria-label="复制提示词"
                                title="复制提示词"
                                disabled={!it.prompt}
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
                                  'hover:bg-black/55 hover:border-white/30 hover:-translate-y-[1px]',
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
                        <div className="flex items-center justify-between gap-2 pb-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <div
                              className="px-2 py-1 rounded-[10px] text-xs font-semibold"
                              style={{
                                border: '1px solid rgba(250,204,21,0.55)',
                                background: 'rgba(250,204,21,0.08)',
                                color: 'rgba(250,204,21,0.95)',
                              }}
                            >
                              布局预览：将生成 {wantN} × {modelCount} = {total} 张
                            </div>
                            {hasAnyOutput ? (
                              <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                                已生成 {done.length}/{total} 张（点击图片可放大，右上角勾选用于下载选中）
                              </div>
                            ) : (
                              <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                                选择模型后会按“每模型 {wantN} 张”进行对比展示
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
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
                                    'hover:bg-black/55 hover:border-white/30 hover:-translate-y-[1px]',
                                  ].join(' ')}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void copyToClipboard(it.prompt);
                                  }}
                                  aria-label="复制提示词"
                                  title="复制提示词"
                                  disabled={!it.prompt}
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
                                    'hover:bg-black/55 hover:border-white/30 hover:-translate-y-[1px]',
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
          </Card>
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
        onOpenChange={(open) => setPreviewDialog((p) => ({ ...p, open }))}
        title={previewDialog.title || '输出预览'}
        description="查看完整输出内容"
        maxWidth={900}
        contentStyle={{ height: 'min(80vh, 680px)' }}
        content={
          <div className="h-full min-h-0 flex flex-col">
            <div className="flex items-center justify-end gap-2 pb-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void copyToClipboard(previewDialog.text || '')}
              >
                <Copy size={16} />
                复制
              </Button>
            </div>
            <div className="flex-1 min-h-0 overflow-auto rounded-[14px] p-3" style={{ border: '1px solid rgba(255,255,255,0.10)' }}>
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
        contentStyle={{ height: 'min(86vh, 820px)' }}
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
                onClick={() => void copyToClipboard(imagePreviewDialog.src || '')}
                disabled={!imagePreviewDialog.src}
                title="复制图片 dataURL（或原始 URL）"
              >
                <Copy size={16} />
                复制链接
              </Button>
            </div>

            <div className="flex-1 min-h-0 overflow-auto rounded-[14px] p-3" style={{ border: '1px solid rgba(255,255,255,0.10)' }}>
              {imagePreviewDialog.src ? (
                <div className="w-full h-full flex items-center justify-center">
                  <img
                    src={imagePreviewDialog.src}
                    alt={imagePreviewDialog.title}
                    className="block max-w-full h-auto"
                    style={{ maxHeight: '78vh', objectFit: 'contain' }}
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
        allModels={allModels}
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
                          if (!window.confirm(`确定删除实验“${e.name}”？（不可恢复）`)) return;
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
