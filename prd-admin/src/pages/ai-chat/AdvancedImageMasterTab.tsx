import { Button } from '@/components/design/Button';
import { Card } from '@/components/design/Card';
import { Switch } from '@/components/design/Switch';
import { Dialog } from '@/components/ui/Dialog';
import { PrdLoader } from '@/components/ui/PrdLoader';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  addImageMasterMessage,
  createImageMasterSession,
  generateImageGen,
  getImageMasterSession,
  getModels,
  listImageMasterSessions,
  planImageGen,
  uploadImageAsset,
} from '@/services';
import { systemDialog } from '@/lib/systemDialog';
import type { ImageGenPlanResponse } from '@/services/contracts/imageGen';
import type { ImageAsset, ImageMasterMessage, ImageMasterSession } from '@/services/contracts/imageMaster';
import type { Model } from '@/types/admin';
import {
  ArrowUp,
  AtSign,
  Check,
  Copy,
  Download,
  Hand,
  ImagePlus,
  Loader2,
  MapPin,
  MousePointer2,
  Paperclip,
  SlidersHorizontal,
  Square,
  Type,
  Trash,
  Video,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useAuthStore } from '@/stores/authStore';

type CanvasImageItem = {
  key: string;
  createdAt: number;
  prompt: string;
  src: string;
  status: 'done' | 'error' | 'running';
  kind?: 'image' | 'generator' | 'shape' | 'text';
  errorMessage?: string | null;
  refId?: number;
  checked?: boolean;
  checkedAt?: number;
  assetId?: string;
  sha256?: string;
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

type UiMsg = {
  id: string;
  role: 'User' | 'Assistant';
  content: string;
  ts: number;
};

type CanvasTool = 'select' | 'hand' | 'mark';
type CanvasPlacing =
  | null
  | { kind: 'shape'; shapeType: NonNullable<CanvasImageItem['shapeType']> }
  | { kind: 'text' };

const clampZoom = (z: number) => Math.max(0.05, Math.min(3, z));
const clampZoomFactor = (f: number) => Math.max(0.93, Math.min(1.07, f));
const zoomFactorFromDeltaY = (deltaY: number) => {
  // 更细腻：factor = exp(-dy*k)，并限制单次变化幅度，避免“一滚就跳”
  const k = 0.0016;
  return clampZoomFactor(Math.exp(-deltaY * k));
};

function loaderSizeForBox(w: number, h: number) {
  // 需求：loader ≈ 面板的 1/2，并且随画布缩放一起缩放（这里用世界尺寸计算，最终会乘 zoom）
  const base = Math.round(Math.max(24, Math.min(w, h) * 0.5));
  return Math.max(44, Math.min(640, base));
}

function renderMentionHighlights(text: string) {
  const s = String(text ?? '');
  // 仅高亮“原子 tag”：@model(...) / @vision(...) / @imgN
  const rx = /@model\([^)]+\)|@vision\([^)]+\)|@img\d+/g;
  const out: Array<JSX.Element | string> = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(s))) {
    const start = m.index;
    const end = start + m[0].length;
    if (start > last) out.push(s.slice(last, start));
    const token = s.slice(start, end);
    out.push(
      <span
        key={`${start}_${end}`}
        style={{
          background: 'rgba(250, 204, 21, 0.18)',
          border: '1px solid rgba(250, 204, 21, 0.22)',
          borderRadius: 10,
          boxDecorationBreak: 'clone',
          WebkitBoxDecorationBreak: 'clone',
        }}
      >
        {token}
      </span>
    );
    last = end;
  }
  if (last < s.length) out.push(s.slice(last));
  return out.length > 0 ? out : [''];
}

function firstEnabledImageModel(models: Model[]): Model | null {
  const list = (models ?? []).filter((m) => m.enabled && m.isImageGen);
  list.sort(
    (a, b) =>
      Number(a.priority ?? 1e9) - Number(b.priority ?? 1e9) ||
      String(a.name || a.modelName || '').localeCompare(String(b.name || b.modelName || ''), undefined, { numeric: true, sensitivity: 'base' })
  );
  return list[0] ?? null;
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
  const a = document.createElement('a');
  a.href = src;
  a.download = safe ? `${safe}.png` : 'image.png';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function readImageSizeFromSrc(src: string): Promise<{ w: number; h: number } | null> {
  const s = String(src ?? '');
  if (!s) return null;
  try {
    const img = new Image();
    // data: 同源；http(s) 可能跨域，但失败时我们会 fallback
    img.decoding = 'async';
    img.src = s;
    // decode 更可靠，不支持则走 onload
    await (img.decode ? img.decode() : new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('load failed'));
    }));
    const w = img.naturalWidth || 0;
    const h = img.naturalHeight || 0;
    if (!w || !h) return null;
    return { w, h };
  } catch {
    return null;
  }
}

function tryParseWxH(size: string | null | undefined): { w: number; h: number } | null {
  const s = String(size ?? '').trim();
  if (!s) return null;
  const m = /^\s*(\d+)\s*[xX×＊*]\s*(\d+)\s*$/.exec(s);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { w: Math.round(w), h: Math.round(h) };
}

function computeRequestedSizeByRefRatio(ref: { w: number; h: number } | null | undefined): string | null {
  if (!ref || !ref.w || !ref.h) return null;
  const w0 = Math.max(1, Math.round(ref.w));
  const h0 = Math.max(1, Math.round(ref.h));
  const r = w0 / h0;
  if (!Number.isFinite(r) || r <= 0) return null;

  // 目标：保持原图比例；以 1024 为基准，最大边限制到 1792（与常见 OpenAI 生图尺寸相容），过极端比例则夹到 1792:1024。
  const minSide = 1024;
  const maxSide = 1792;
  const maxRatio = maxSide / minSide; // 1.75

  let tw: number;
  let th: number;
  if (r >= 1) {
    if (r >= maxRatio) {
      tw = maxSide;
      th = minSide;
    } else {
      tw = minSide * r;
      th = minSide;
    }
  } else {
    const inv = 1 / r;
    if (inv >= maxRatio) {
      tw = minSide;
      th = maxSide;
    } else {
      tw = minSide;
      th = minSide * inv;
    }
  }

  // 多数网关要求整 8/16：这里先做 8 对齐，最终不支持的尺寸仍由后端自动选择最近 allowed size。
  const round8 = (n: number) => Math.max(8, Math.round(n / 8) * 8);
  const w = round8(tw);
  const h = round8(th);
  return `${w}x${h}`;
}

async function fetchImageAsDataUrl(src: string): Promise<{ ok: true; dataUrl: string } | { ok: false; reason: string }> {
  const url = String(src ?? '').trim();
  if (!url) return { ok: false, reason: '图片地址为空' };
  try {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) return { ok: false, reason: `读取参考图失败：HTTP ${res.status}` };
    const blob = await res.blob();
    // 后端 edits 首帧图限制 10MB；前端提前拦截
    if (blob.size > 10 * 1024 * 1024) return { ok: false, reason: '参考图过大（上限 10MB）' };
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(new Error('FileReader 失败'));
      fr.readAsDataURL(blob);
    });
    if (!dataUrl || !dataUrl.startsWith('data:')) return { ok: false, reason: '参考图转换失败（非 dataURL）' };
    return { ok: true, dataUrl };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : '读取参考图失败' };
  }
}

async function readImageSizeFromFile(file: File): Promise<{ w: number; h: number } | null> {
  try {
    // createImageBitmap 能可靠拿到本地文件像素尺寸（不受跨域/解码限制影响）
    const bmp = await createImageBitmap(file);
    const w = bmp.width || 0;
    const h = bmp.height || 0;
    bmp.close();
    if (!w || !h) return null;
    return { w, h };
  } catch {
    return null;
  }
}

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

export default function AdvancedImageMasterTab() {
  // 固定默认参数：用户不需要选择
  const DEFAULT_RESPONSE_FORMAT = 'b64_json' as const;
  // 输入区已移除“大小/比例”控制按钮：v1 固定用 1K 方形，避免过多配置干扰
  const imageGenSize = '1024x1024' as const;
  const DEFAULT_ZOOM = 0.5;

  const [models, setModels] = useState<Model[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const serverDefaultModel = useMemo(() => firstEnabledImageModel(models), [models]);

  const userId = useAuthStore((s) => s.user?.userId ?? '');
  const splitKey = userId ? `prdAdmin.imageMaster.splitWidth.${userId}` : '';
  const SPLIT_MIN = 240;
  const SPLIT_MAX = 420;

  // 模型偏好：按账号持久化（不写 DB）
  const modelPrefKey = userId ? `prdAdmin.imageMaster.modelPref.${userId}` : '';
  const [modelPrefOpen, setModelPrefOpen] = useState(false);
  const [modelPrefAuto, setModelPrefAuto] = useState(true);
  const [modelPrefModelId, setModelPrefModelId] = useState<string>('');
  const enabledImageModels = useMemo(() => (models ?? []).filter((m) => m.enabled && m.isImageGen), [models]);
  // 提示词模式：按账号持久化（不写 DB）
  // - 关闭：先调用 planImageGen 解析/改写成候选提示词，再生图
  // - 开启：跳过解析，直接把输入原样作为 prompt 发给生图模型
  const directPromptKey = userId ? `prdAdmin.imageMaster.directPrompt.${userId}` : '';
  const [directPrompt, setDirectPrompt] = useState(false);
  const effectiveModel = useMemo(() => {
    const byId = modelPrefModelId ? enabledImageModels.find((m) => m.id === modelPrefModelId) ?? null : null;
    if (modelPrefAuto) return serverDefaultModel;
    return byId ?? serverDefaultModel;
  }, [enabledImageModels, modelPrefAuto, modelPrefModelId, serverDefaultModel]);

  const [messages, setMessages] = useState<UiMsg[]>([
    {
      id: 'assistant-hello',
      role: 'Assistant',
      content:
        'Hi，我是你的 AI 设计师。描述你的需求，我会把它转成可执行的生图提示词并把结果放到左侧画板。若你想让输入直接作为提示词发送（不再二次解析/改写），可在“模型偏好”里开启“直连”。',
      ts: Date.now(),
    },
  ]);

  // 右侧对话输入（与画布快捷输入互不影响）
  const [input, setInput] = useState('');
  // 画布快捷输入（仅在选中生成器区域时出现）
  const [quickInput, setQuickInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const quickInputRef = useRef<HTMLTextAreaElement | null>(null);
  const activeComposerRef = useRef<'right' | 'quick'>('right');
  const composingRef = useRef(false);
  const inputPanelRef = useRef<HTMLDivElement | null>(null);
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const MIN_TA_HEIGHT = 132; // 默认高度较之前下降约 1/4（177 -> 132）
  const [taHeight, setTaHeight] = useState<number>(MIN_TA_HEIGHT);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionAtPos, setMentionAtPos] = useState<number | null>(null);
  const [asciiOpen, setAsciiOpen] = useState(false);
  const [asciiSource, setAsciiSource] = useState('');

  const [canvas, setCanvas] = useState<CanvasImageItem[]>([]);
  const canvasRef = useRef<CanvasImageItem[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const primarySelectedKey = selectedKeys[0] ?? '';
  const selected = useMemo(() => canvas.find((x) => x.key === primarySelectedKey) ?? null, [canvas, primarySelectedKey]);
  const isSelectedKey = (k: string) => selectedKeys.includes(k);

  const HOVER_MENU_CLOSE_DELAY_MS = 320;

  const [activeTool, setActiveTool] = useState<CanvasTool>('select');
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
  const [nextRefId, setNextRefId] = useState(1);

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

  const focusComposer = useCallback(() => {
    try {
      inputPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    } catch {
      // ignore
    }
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, []);


  // splitter：右侧宽度（px）
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [rightWidth, setRightWidth] = useState(0);
  const dragRef = useRef<{ dragging: boolean; startX: number; startRight: number } | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>('');
  const [masterSession, setMasterSession] = useState<ImageMasterSession | null>(null);
  const [, setBooting] = useState(false);
  const initSessionRef = useRef<{ userId: string; started: boolean }>({ userId: '', started: false });

  const fileRef = useRef<HTMLInputElement | null>(null);

  const [preview, setPreview] = useState<{ open: boolean; src: string; prompt: string }>({ open: false, src: '', prompt: '' });

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setModelsLoading(true);
    getModels()
      .then((res) => {
        if (!res.success) return;
        setModels(res.data ?? []);
      })
      .finally(() => setModelsLoading(false));
  }, []);

  // 读取模型偏好（仅在有 userId 时）
  useEffect(() => {
    if (!modelPrefKey) return;
    try {
      const raw = localStorage.getItem(modelPrefKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { auto?: boolean; modelId?: string };
      if (typeof parsed.auto === 'boolean') setModelPrefAuto(parsed.auto);
      if (typeof parsed.modelId === 'string') setModelPrefModelId(parsed.modelId);
    } catch {
      // ignore
    }
  }, [modelPrefKey]);

  // 写入模型偏好
  useEffect(() => {
    if (!modelPrefKey) return;
    try {
      localStorage.setItem(modelPrefKey, JSON.stringify({ auto: modelPrefAuto, modelId: modelPrefModelId }));
    } catch {
      // ignore
    }
  }, [modelPrefAuto, modelPrefKey, modelPrefModelId]);

  // 读取直连模式（仅在有 userId 时）
  useEffect(() => {
    if (!directPromptKey) return;
    try {
      const raw = localStorage.getItem(directPromptKey);
      if (raw == null) return;
      if (raw === '1' || raw === 'true') setDirectPrompt(true);
      if (raw === '0' || raw === 'false') setDirectPrompt(false);
    } catch {
      // ignore
    }
  }, [directPromptKey]);

  // 写入直连模式
  useEffect(() => {
    if (!directPromptKey) return;
    try {
      localStorage.setItem(directPromptKey, directPrompt ? '1' : '0');
    } catch {
      // ignore
    }
  }, [directPrompt, directPromptKey]);

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

  // 启动时：按账号持久化加载/创建会话，并回放历史消息+画板资产
  useEffect(() => {
    if (!userId) return;
    // 关键：只初始化一次；否则 setBooting(false) 会触发依赖变化导致死循环请求
    if (initSessionRef.current.userId === userId && initSessionRef.current.started) return;
    initSessionRef.current = { userId, started: true };

    let cancelled = false;
    setBooting(true);
    (async () => {
      const list = await listImageMasterSessions({ limit: 10 });
      let sid = '';
      if (list.success && Array.isArray(list.data?.items) && list.data!.items.length > 0) {
        sid = list.data!.items[0].id;
      } else {
        const created = await createImageMasterSession({ title: '高级视觉创作' });
        if (created.success) sid = created.data.session.id;
      }
      if (!sid) {
        // 不自动重试，避免触发后端限流（429）
        if (!cancelled) setError(list.success ? '创建会话失败' : (list.error?.message || '加载会话失败'));
        return;
      }

      const detail = await getImageMasterSession({ id: sid, messageLimit: 200, assetLimit: 80 });
      if (!detail.success) {
        if (!cancelled) setError(detail.error?.message || '加载会话详情失败');
        return;
      }
      if (cancelled) return;
      setMasterSession(detail.data.session);

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
      if (assets.length > 0) {
        const items: CanvasImageItem[] = (assets as ImageAsset[])
          .map((a) => ({
            key: a.id,
            assetId: a.id,
            sha256: a.sha256,
            createdAt: Number.isFinite(Date.parse(a.createdAt)) ? Date.parse(a.createdAt) : Date.now(),
            prompt: a.prompt ?? '',
            src: a.url || '',
            status: 'done' as const,
            // 规则：若后端记录了像素尺寸，则画布直接按原始尺寸展示
            w: typeof a.width === 'number' && a.width > 0 ? a.width : undefined,
            h: typeof a.height === 'number' && a.height > 0 ? a.height : undefined,
            naturalW: typeof a.width === 'number' && a.width > 0 ? a.width : undefined,
            naturalH: typeof a.height === 'number' && a.height > 0 ? a.height : undefined,
          }))
          .filter((x) => !!x.src)
          .slice(0, 60);
        setCanvas(items);
        if (items.length > 0) {
          setSelectedKeys((cur) => (cur.length > 0 ? cur : [items[0].key]));
        }
      }
    })()
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : '加载会话失败');
      })
      .finally(() => {
        if (!cancelled) setBooting(false);
      });

    return () => {
      cancelled = true;
    };
  }, [userId]);

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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: busy ? 'auto' : 'smooth' });
  }, [messages, busy]);

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
        // 避免 Space 滚动页面
        e.preventDefault();
        setSpacePressed(true);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === ' ' || e.code === 'Space') {
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
      // “最近路径”思路：在网格上做 BFS，从中心向外扩展，找到第一个不重叠的位置
      const step = 48;
      // 自适应搜索半径：大图/密集场景时固定半径不够会 fallback 到中心，从而出现“还是盖住老图”
      const viewSpan = Math.max(stageSizeRef.current.w || 900, stageSizeRef.current.h || 700);
      const existingMax = existing.length ? Math.max(...existing.map((r) => Math.max(r.w, r.h))) : 0;
      const maxDim = Math.max(viewSpan * 2, existingMax * 2, w * 2, h * 2);
      const maxSteps = Math.max(26, Math.ceil((maxDim + 240) / step));
      const q: Array<{ gx: number; gy: number }> = [{ gx: 0, gy: 0 }];
      const seen = new Set<string>(['0,0']);
      const dirs = [
        { dx: 1, dy: 0 },
        { dx: -1, dy: 0 },
        { dx: 0, dy: 1 },
        { dx: 0, dy: -1 },
      ];
      while (q.length) {
        const cur = q.shift()!;
        const dist = Math.abs(cur.gx) + Math.abs(cur.gy);
        if (dist <= maxSteps) {
          const worldCx = nearWorld.x + cur.gx * step;
          const worldCy = nearWorld.y + cur.gy * step;
          const x = Math.round(worldCx - w / 2);
          const y = Math.round(worldCy - h / 2);
          const cand = { x, y, w, h };
          const hit = existing.some((r) => intersects(r, cand, 18));
          if (!hit) return { x, y };
        }
        for (const d of dirs) {
          const nx = cur.gx + d.dx;
          const ny = cur.gy + d.dy;
          const nd = Math.abs(nx) + Math.abs(ny);
          if (nd > maxSteps) continue;
          const key = `${nx},${ny}`;
          if (seen.has(key)) continue;
          seen.add(key);
          q.push({ gx: nx, gy: ny });
        }
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
        setSelectedKeys([key]);
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
      setSelectedKeys([key]);
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

  const pushMsg = (role: UiMsg['role'], content: string) => {
    const msg: UiMsg = { id: `${role}-${Date.now()}`, role, content, ts: Date.now() };
    setMessages((prev) => prev.concat(msg));
    if (masterSession?.id) {
      const backendRole: ImageMasterMessage['role'] = role === 'User' ? 'User' : 'Assistant';
      void addImageMasterMessage({ sessionId: masterSession.id, role: backendRole, content });
    }
  };

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

  const insertTextAtCursor = (text: string, opts?: { openMention?: boolean }) => {
    const ta = getActiveTa();
    if (!ta) return;
    const value = ta.value ?? '';
    const start = ta.selectionStart ?? value.length;
    const end = ta.selectionEnd ?? start;
    const next = value.slice(0, start) + text + value.slice(end);
    setActiveValue(next);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + text.length;
      ta.setSelectionRange(pos, pos);
      if (opts?.openMention) refreshMention(next, pos);
    });
  };

  const findAtomicTagRangeAt = (s: string, caret: number) => {
    const patterns = [
      /@model\([^)]+\)\s?/g,
      /@vision\([^)]+\)\s?/g,
      /@img\d+\s?/g,
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

  const refreshMention = (val: string, caret: number) => {
    // 快捷输入面板：暂不弹 @ 菜单（避免菜单出现在右侧输入框区域）；仍可手动输入 @tag
    if (activeComposerRef.current === 'quick') return;
    const s = String(val ?? '');
    const pos = Math.max(0, Math.min(caret, s.length));
    const before = s.slice(0, pos);
    const at = before.lastIndexOf('@');
    if (at < 0) {
      setMentionOpen(false);
      setMentionQuery('');
      setMentionAtPos(null);
      return;
    }
    const token = before.slice(at + 1);
    // token 内出现空白/换行，视为不在 @ 模式
    if (token.length > 24 || /\s/.test(token)) {
      setMentionOpen(false);
      setMentionQuery('');
      setMentionAtPos(null);
      return;
    }
    setMentionAtPos(at);
    setMentionQuery(token.toLowerCase());
    setMentionOpen(true);
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

  const recomputeTextareaHeight = useCallback(() => {
    const ta = inputRef.current;
    const wrap = inputPanelRef.current;
    if (!ta || !wrap) return;
    // max: 父容器高度的一半
    const parent = wrap.parentElement;
    const parentH = parent?.clientHeight ?? 0;
    const maxH = Math.max(MIN_TA_HEIGHT, Math.floor(parentH / 2));
    // 先清空高度再测 scrollHeight
    ta.style.height = 'auto';
    const next = Math.min(Math.max(ta.scrollHeight, MIN_TA_HEIGHT), maxH);
    setTaHeight(next);
  }, [MIN_TA_HEIGHT]);

  useEffect(() => {
    recomputeTextareaHeight();
  }, [input, mentionOpen, recomputeTextareaHeight, rightWidth]);

  useEffect(() => {
    const onResize = () => recomputeTextareaHeight();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [recomputeTextareaHeight]);

  const runFromText = async (displayText: string, requestText: string, primaryRef: CanvasImageItem | null) => {
    const display = String(displayText ?? '').trim();
    // 直连模式：解析 @model(...) 只用于“强制选模型”，不应当把标记本身发给生图 prompt
    const stripModelMention = (s: string) => String(s ?? '').replace(/@model\([^)]*\)/gi, '').replace(/\s{2,}/g, ' ').trim();

    const forcedPick = extractForcedImageModel(directPrompt ? displayText : requestText);
    const reqText = String(forcedPick.clean ?? '').trim();
    if (!reqText) return;
    const pickedModel = forcedPick.forced ?? effectiveModel;
    if (!pickedModel) {
      const msg = modelsLoading ? '模型加载中' : '暂无可用生图模型（请先在“模型管理”启用 isImageGen 模型）';
      setError(msg);
      pushMsg('Assistant', '暂无可用生图模型（请先在“模型管理”启用 isImageGen 模型）');
      return;
    }

    setError('');
    setBusy(true);
    pushMsg('User', display || reqText);

    let items: Array<{ prompt: string }> = [];
    let firstPrompt = '';
    if (directPrompt) {
      firstPrompt = stripModelMention(reqText) || stripModelMention(display) || '';
      if (!firstPrompt) {
        const msg = '内容为空';
        setError(msg);
        pushMsg('Assistant', `生成失败：${msg}`);
        setBusy(false);
        return;
      }
    } else {
      let plan: ImageGenPlanResponse | null = null;
      try {
        const pres = await planImageGen({ text: reqText, maxItems: 8 });
        if (!pres.success) {
          const msg = pres.error?.message || '解析失败';
          setError(msg);
          pushMsg('Assistant', `解析失败：${msg}`);
          setBusy(false);
          return;
        }
        plan = pres.data ?? null;
      } catch (e) {
        const msg = e instanceof Error ? e.message : '网络错误';
        setError(msg);
        pushMsg('Assistant', `解析失败：${msg}`);
        setBusy(false);
        return;
      }

      items = Array.isArray(plan?.items) ? (plan!.items as Array<{ prompt: string }>) : [];
      const fallbackPrompt = stripModelMention(reqText) || reqText;
      firstPrompt = String(items[0]?.prompt ?? '').trim() || fallbackPrompt;
    }

    const pickedIsVolcesSeedream = /volces|doubao|seedream/i.test(String(pickedModel?.modelName || ''));
    const refDim =
      (primaryRef?.naturalW && primaryRef?.naturalH ? { w: primaryRef.naturalW, h: primaryRef.naturalH } : null) ??
      (selected?.naturalW && selected?.naturalH ? { w: selected.naturalW, h: selected.naturalH } : null);
    const resolvedSizeForGen = computeRequestedSizeByRefRatio(refDim) ?? imageGenSize;

    pushMsg(
      'Assistant',
      [
        `本次使用模型：${pickedModel?.name || pickedModel?.modelName}${forcedPick.forced ? '（@ 强制）' : ''}`,
        directPrompt ? '直连模式：输入将原样作为提示词发送（未进行解析/改写）。' : `我已把需求解析成 ${items.length || 1} 条生图提示词。`,
        !directPrompt && items.length ? '候选提示词（前 3 条）：\n' + items.slice(0, 3).map((x, i) => `${i + 1}. ${x.prompt}`).join('\n') : '',
        (primaryRef || selected) && pickedIsVolcesSeedream
          ? directPrompt
            ? '你选择了首帧图，但当前模型（seedream/Volces）通常不支持标准图生图首帧；且你开启了直连模式，本次不会自动做“风格提取→拼进提示词”，可能导致生成失败。需要该能力请关闭直连。'
            : '你选择了首帧图。当前使用的 seedream/Volces 生图通常不支持标准图生图首帧，我会自动改为“风格提取→拼进提示词”的方式来尽量保持一致。'
          : (primaryRef || selected)
            ? '你已选中一张图片作为参考图。本次将作为图生图参考传给生图接口（若上游平台不支持，会返回参数错误）。'
            : '',
      ]
        .filter(Boolean)
        .join('\n\n')
    );

    // 画板占位
    const near = stageCenterWorld();
    const selectedFirstKey = selectedKeys[0] ?? '';
    const selectedIsGenerator = selectedFirstKey ? (canvas.find((x) => x.key === selectedFirstKey)?.kind ?? 'image') === 'generator' : false;
    const generatorExistingKey = selectedIsGenerator
      ? selectedFirstKey
      : pickNearestGeneratorKey(canvas, near);
    const key = generatorExistingKey ?? `gen_${Date.now()}`;
    setCanvas((prev) => {
      const existingRects = prev
        .filter(
          (x) =>
            x.status !== 'error' &&
            ((x.kind ?? 'image') === 'generator' ||
              (x.kind ?? 'image') === 'shape' ||
              (x.kind ?? 'image') === 'text' ||
              !!x.src ||
              x.status === 'running')
        )
        .map((x) => ({ x: x.x ?? 0, y: x.y ?? 0, w: x.w ?? 1, h: x.h ?? 1 }));
      // 占位尺寸随 requested size（保持比例），避免“永远 1K 方形”的观感
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
        focusKeyRef.current = { key, cx: gx + gw / 2, cy: gy + gh / 2 };
        return prev.map((x) =>
          x.key === generatorExistingKey
            ? {
                ...x,
                // 需求：一旦开始生成，生成器立即转换为“普通图片”（running）
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
      };
      focusKeyRef.current = { key, cx: pos.x + genW / 2, cy: pos.y + genH / 2 };
      // 重要：新元素要在最上层 => 放到数组末尾（后渲染覆盖先渲染）
      return [...prev, placeholder].slice(-60);
    });

    try {
      const initSrc = (primaryRef?.src || selected?.src) ?? '';
      let initImageBase64: string | undefined;
      if (initSrc && initSrc.startsWith('data:')) {
        initImageBase64 = initSrc;
      } else if (initSrc) {
        // 参考图通常已被持久化为自托管 URL；此时需要拉取并转 dataURL，否则后端永远收不到首帧
        const got = await fetchImageAsDataUrl(initSrc);
        if (got.ok) {
          initImageBase64 = got.dataUrl;
        } else {
          // 不阻断本次生成：降级为文生图，并把原因反馈给用户
          pushMsg('Assistant', `参考图未能传递，本次已降级为文生图：${got.reason}`);
        }
      }

      const gres = await generateImageGen({
        modelId: pickedModel!.id,
        prompt: firstPrompt,
        n: 1,
        size: resolvedSizeForGen,
        responseFormat: DEFAULT_RESPONSE_FORMAT,
        initImageBase64,
      });
      if (!gres.success) {
        const msg = gres.error?.message || '生成失败';
        setCanvas((prev) => prev.map((x) => (x.key === key ? { ...x, status: 'error', errorMessage: msg } : x)));
        setError(msg);
        pushMsg('Assistant', `生成失败：${msg}`);
        return;
      }
      const img0 = (gres.data?.images ?? [])[0];
      const meta = gres.data?.meta ?? null;
      const src =
        (img0?.url ?? '') ||
        (img0?.base64 ? (img0.base64.startsWith('data:') ? img0.base64 : `data:image/png;base64,${img0.base64}`) : '');
      if (!src) {
        setCanvas((prev) => prev.map((x) => (x.key === key ? { ...x, status: 'error', errorMessage: '未返回图片' } : x)));
        setError('未返回图片');
        pushMsg('Assistant', '生成失败：未返回图片');
        return;
      }
      const eff = String(meta?.effectiveSize || '') || resolvedSizeForGen;
      const req = String(meta?.requestedSize || '') || resolvedSizeForGen;
      const effParsed = tryParseWxH(eff);
      setCanvas((prev) =>
        prev.map((x) =>
          x.key === key
            ? {
                ...x,
                // 需求：生成结束仍保持为“普通图片”
                kind: 'image',
                status: 'done',
                src,
                requestedSize: req,
                effectiveSize: eff,
                sizeAdjusted: Boolean(meta?.sizeAdjusted ?? false),
                ratioAdjusted: Boolean(meta?.ratioAdjusted ?? false),
                // 统一按图片逻辑更新占位尺寸（若解析失败则保留原尺寸）
                w: effParsed?.w ?? x.w,
                h: effParsed?.h ?? x.h,
              }
            : x
        )
      );
      setSelectedKeys([key]);
      // 自动把视角移动到新生成的图上方（更像“在当前屏幕附近新增并跟随”）
      requestAnimationFrame(() => {
        const f = focusKeyRef.current;
        if (!f || f.key !== key) return;
        animateCameraToWorldCenter(f.cx, f.cy);
      });

      // 上传并持久化资产：把外部签名 URL / base64 转为自托管 URL（避免过期）
      const parsed = tryParseWxH(eff) ?? tryParseWxH(resolvedSizeForGen);
      const width = parsed?.w;
      const height = parsed?.h;
      const isAlreadyHosted = src.startsWith('/api/v1/admin/image-master/assets/file/');
      if (!isAlreadyHosted) {
        const up = await uploadImageAsset({
          data: src.startsWith('data:') ? src : undefined,
          sourceUrl: src.startsWith('http') ? src : undefined,
          prompt: firstPrompt,
          width,
          height,
        });
        if (up.success) {
          const a = up.data.asset;
          setCanvas((prev) =>
            prev.map((x) =>
              x.key === key
                ? {
                    ...x,
                    assetId: a.id,
                    sha256: a.sha256,
                    src: a.url || x.src,
                  }
                : x
            )
          );
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : '生成失败';
      setCanvas((prev) => prev.map((x) => (x.key === key ? { ...x, status: 'error', errorMessage: msg } : x)));
      setError(msg);
      pushMsg('Assistant', `生成失败：${msg}`);
    } finally {
      setBusy(false);
    }
  };

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

  const extractReferencedImagesInOrder = (text: string) => {
    const s = String(text ?? '');
    const rx = /@img(\d+)/g;
    const ids: number[] = [];
    const seen = new Set<number>();
    let m: RegExpExecArray | null;
    while ((m = rx.exec(s))) {
      const id = Number(m[1]);
      if (!Number.isFinite(id) || id <= 0) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    const items: CanvasImageItem[] = [];
    for (const id of ids) {
      const it = canvas.find((x) => x.refId === id);
      if (it && (it.kind ?? 'image') === 'image') items.push(it);
    }
    return items;
  };

  const buildRequestTextWithRefs = (rawText: string) => {
    const refsByText = extractReferencedImagesInOrder(rawText);

    const merged: CanvasImageItem[] = [];
    const seen = new Set<string>();
    for (const it of refsByText) {
      if (seen.has(it.key)) continue;
      seen.add(it.key);
      merged.push(it);
    }
    // 若文本没有 @imgN 引用：默认用当前选中（按 selectedKeys 顺序）作为引用顺序
    if (merged.length === 0 && selectedKeys.length > 0) {
      for (const k of selectedKeys) {
        const it = canvas.find((x) => x.key === k);
        if (!it) continue;
        if ((it.kind ?? 'image') !== 'image') continue;
        if (!it.src) continue;
        if (seen.has(it.key)) continue;
        seen.add(it.key);
        merged.push(it);
      }
    }

    if (merged.length === 0) return { requestText: rawText, primaryRef: null as CanvasImageItem | null };
    const lines = merged.map((it) => {
      const id = it.refId ?? ensureRefIdForKey(it.key) ?? '?';
      return `- @img${id}: ${it.prompt || '（无描述）'}`;
    });
    const requestText = `${rawText}\n\n【引用图片（按顺序）】\n${lines.join('\n')}`;
    return { requestText, primaryRef: merged[0] ?? null };
  };

  const sendText = async (rawText: string) => {
    const raw = String(rawText ?? '').trim();
    if (!raw) return;
    const { requestText, primaryRef } = buildRequestTextWithRefs(raw);
    await runFromText(raw, requestText, primaryRef);
  };

  const onSend = async () => {
    const raw = input.trim();
    if (!raw) return;
    setInput('');
    await sendText(raw);
  };

  const onSendQuick = async () => {
    const raw = quickInput.trim();
    if (!raw) return;
    setQuickInput('');
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
                x.status !== 'error' &&
                ((x.kind ?? 'image') === 'generator' ||
                  (x.kind ?? 'image') === 'shape' ||
                  (x.kind ?? 'image') === 'text' ||
                  !!x.src ||
                  x.status === 'running')
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
          focusKeyRef.current = { key: targetKey, cx: pos.x + nextW / 2, cy: pos.y + nextH / 2 };
          requestAnimationFrame(() => {
            const f = focusKeyRef.current;
            if (!f || f.key !== targetKey) return;
            animateCameraToWorldCenter(f.cx, f.cy);
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
      const up = await uploadImageAsset({ data: src, prompt: file.name || 'uploaded' });
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
                }
              : x
          )
        );
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
            x.status !== 'error' &&
            ((x.kind ?? 'image') === 'generator' ||
              (x.kind ?? 'image') === 'shape' ||
              (x.kind ?? 'image') === 'text' ||
              !!x.src ||
              x.status === 'running')
        )
        .map((x) => ({ x: x.x ?? 0, y: x.y ?? 0, w: x.w ?? 1, h: x.h ?? 1 }));
      const placed: CanvasImageItem[] = [];
      let focus: { key: string; cx: number; cy: number } | null = null;
      for (const it of added) {
        const w = it.w ?? 1;
        const h = it.h ?? 1;
        const pos = findNearestFreeTopLeft(existingRects, w, h, near);
        const nextIt: CanvasImageItem = { ...it, w, h, x: pos.x, y: pos.y };
        placed.push(nextIt);
        existingRects.push({ x: pos.x, y: pos.y, w, h });
        focus = { key: it.key, cx: pos.x + w / 2, cy: pos.y + h / 2 };
      }
      // 重要：新元素要在最上层 => 放到数组末尾（后渲染覆盖先渲染）
      const merged = [...prev, ...placed].slice(-60);
      if (focus) focusKeyRef.current = focus;
      canvasRef.current = merged;
      setCanvas(merged);
    }
    // 默认选中最新一张（放在最上层的那张）
    setSelectedKeys([added[added.length - 1]!.key]);
    requestAnimationFrame(() => {
      const f = focusKeyRef.current;
      if (!f) return;
      animateCameraToWorldCenter(f.cx, f.cy);
    });
    pushMsg('Assistant', `已把 ${added.length} 张图片加入画板。你可以选中其中一张作为首帧，或用 @imgN 引用多张图。`);

    // 持久化：上传到后端并替换为自托管 URL（避免 dataURL 过大、也方便跨设备恢复）
    void (async () => {
      for (const it of added) {
        if (!it.src || !it.src.startsWith('data:')) continue;
        const up = await uploadImageAsset({ data: it.src, prompt: it.prompt });
        if (!up.success) continue;
        const a = up.data.asset;
        setCanvas((prev) =>
          prev.map((x) =>
            x.key === it.key
              ? {
                  ...x,
                  assetId: a.id,
                  sha256: a.sha256,
                  src: a.url || x.src,
                }
              : x
          )
        );
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

  const fitToStage = () => {
    const el = stageRef.current;
    if (!el) return;
    const itemsAll = canvas.filter(
      (x) =>
        x.status !== 'error' &&
        ((x.kind ?? 'image') === 'generator' ||
          (x.kind ?? 'image') === 'shape' ||
          (x.kind ?? 'image') === 'text' ||
          !!x.src ||
          x.status === 'running')
    );
    const items =
      selectedKeys.length > 0 ? itemsAll.filter((x) => selectedKeys.includes(x.key)) : itemsAll;
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
  };

  const focusKeyRef = useRef<{ key: string; cx: number; cy: number } | null>(null);

  const selectedGenerator = useMemo(() => {
    const k = selectedKeys[0];
    if (!k) return null;
    const it = canvas.find((x) => x.key === k) ?? null;
    if (!it) return null;
    if ((it.kind ?? 'image') !== 'generator') return null;
    return it;
  }, [canvas, selectedKeys]);

  return (
    <div ref={containerRef} className="h-full min-h-0">
      {/* 单一框架：左右无缝拼接 */}
      <Card className="h-full min-h-0 overflow-hidden p-0!">
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
              cursor: activeTool === 'hand' ? 'grab' : 'default',
            }}
            tabIndex={0}
            onPointerEnter={() => {
              stageHoverRef.current = true;
            }}
            onPointerDownCapture={(e) => {
              if (!placing) return;
              const placed = placeAtPointer(e);
              if (!placed) return;
              e.preventDefault();
              e.stopPropagation();
            }}
            onMouseDown={() => stageRef.current?.focus()}
            onBlur={() => {
              // 失焦时清掉框选残留
              setMarquee((prev) => (prev.active ? { ...prev, active: false, w: 0, h: 0 } : prev));
              panRef.current.active = false;
              dragItemsRef.current.active = false;
            }}
            onPointerDown={(e) => {
              stageRef.current?.focus();

              // Hand tool / Space + 拖拽：平移（Hand 模式允许在任意元素上拖动）
              if (activeTool === 'hand' || spacePressed) {
                panRef.current = {
                  active: true,
                  pointerId: e.pointerId,
                  startX: e.clientX,
                  startY: e.clientY,
                  baseCamX: cameraRef.current.x,
                  baseCamY: cameraRef.current.y,
                };
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
                // 点击空白：取消选中
                if (!box.shift) setSelectedKeys([]);
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
                    it.status !== 'error' &&
                    ((it.kind ?? 'image') === 'generator' ||
                      (it.kind ?? 'image') === 'shape' ||
                      (it.kind ?? 'image') === 'text' ||
                      !!it.src ||
                      it.status === 'running')
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

              if (!box.shift) {
                setSelectedKeys(hits);
              } else {
                setSelectedKeys((prev) => {
                  const set = new Set(prev);
                  for (const k of hits) set.add(k);
                  return Array.from(set);
                });
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
                void (async () => {
                  const ok = await systemDialog.confirm({
                    title: '确认删除',
                    message: `确认删除选中的 ${selectedKeys.length} 张图片？`,
                    tone: 'danger',
                    confirmText: '删除',
                    cancelText: '取消',
                  });
                  if (!ok) return;
                  const set = new Set(selectedKeys);
                  setCanvas((prev) => prev.filter((it) => !set.has(it.key)));
                  setSelectedKeys([]);
                })();
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
                // 错误态：普通图片暂不展示（避免画面噪音）；生成器需要展示错误与重试入口
                if (it.status === 'error' && kind !== 'generator') return null;
                if (kind === 'image' && !it.src && it.status !== 'running' && it.status !== 'error') return null;
                const x = it.x ?? 0;
                const y = it.y ?? 0;
                const w = it.w ?? 320;
                const h = it.h ?? 220;
                const active = isSelectedKey(it.key);
                return (
                  <div
                    key={it.key}
                    className="absolute rounded-[16px]"
                    style={{
                      left: Math.round(x),
                      top: Math.round(y),
                      width: Math.max(40, Math.round(w)),
                      height: Math.max(40, Math.round(h)),
                      // 外层容器仅负责布局/拖拽命中；边框应贴合图片本体，因此容器不画边框
                      border: '1px solid transparent',
                      // 根因：这里的 background/boxShadow 会永远渲染一个“长方形卡片”
                      // 需求：元素本体就是图片本身，不应出现任何额外长方形框 => 直接去掉
                      background: 'transparent',
                      boxShadow: 'none',
                      overflow: 'visible',
                      cursor: activeTool === 'hand' ? 'grab' : 'pointer',
                    }}
                    onMouseDown={(e) => {
                      if (activeTool !== 'hand') e.stopPropagation();
                    }}
                    onPointerDown={(e) => {
                      if (activeTool === 'hand') return;
                      e.stopPropagation();
                      // 确定本次拖拽涉及的选中集合（按 Figma：未选中则先选中）
                      const shift = e.shiftKey;
                      const cur = selectedKeys;
                      let nextKeys: string[];
                      if (shift) {
                        // shift+拖拽不做“取消选择”，只做追加选择
                        nextKeys = cur.includes(it.key) ? cur : cur.concat(it.key);
                        setSelectedKeys(nextKeys);
                      } else {
                        nextKeys = cur.includes(it.key) ? cur : [it.key];
                        setSelectedKeys(nextKeys);
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
                      e.stopPropagation();
                      if (activeTool === 'hand') return;
                      // 生成器区域：仅做选中，不做 @img 引用插入
                      if (kind === 'generator') {
                        if (e.shiftKey) {
                          setSelectedKeys((prev) => {
                            const set = new Set(prev);
                            if (set.has(it.key)) set.delete(it.key);
                            else set.add(it.key);
                            return Array.from(set);
                          });
                        } else {
                          setSelectedKeys([it.key]);
                        }
                        focusComposer();
                        return;
                      }
                      // Cmd/Ctrl + 点击：插入图片引用 @imgN
                      if (kind === 'image' && (e.metaKey || e.ctrlKey)) {
                        setSelectedKeys((prev) => (prev.includes(it.key) ? prev : prev.concat(it.key)));
                        const id = ensureRefIdForKey(it.key);
                        if (id) insertAtCursor(`@img${id} `);
                        focusComposer();
                        return;
                      }
                      if (e.shiftKey) {
                        setSelectedKeys((prev) => {
                          const set = new Set(prev);
                          if (set.has(it.key)) set.delete(it.key);
                          else set.add(it.key);
                          return Array.from(set);
                        });
                      } else {
                        setSelectedKeys([it.key]);
                      }
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
                          border: active ? '2px solid rgba(96,165,250,0.85)' : '1px solid rgba(96,165,250,0.25)',
                          boxShadow: active ? '0 0 0 1px rgba(0,0,0,0.18) inset' : 'none',
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
                          <div className="absolute inset-0 flex items-center justify-center">
                            <PrdLoader size={loaderSizeForBox(w, h)} />
                          </div>
                        ) : it.status === 'error' ? (
                          <div
                            className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center"
                            style={{ color: 'rgba(255,255,255,0.82)' }}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div className="text-[13px] font-extrabold" style={{ color: 'rgba(255,255,255,0.92)' }}>
                              生成失败
                            </div>
                            <div className="text-[12px]" style={{ color: 'rgba(255,255,255,0.70)' }}>
                              {String(it.errorMessage || '未知错误')}
                            </div>
                            <div className="flex items-center gap-2">
                              <Button
                                variant="secondary"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  // 使用当前 prompt 直接重试（引用图由用户当前多选决定）
                                  void sendText(it.prompt || '');
                                }}
                              >
                                重试
                              </Button>
                              <Button
                                variant="secondary"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  // 仅选中生成器并聚焦输入，方便用户修改后再发
                                  setSelectedKeys([it.key]);
                                  focusQuickComposer();
                                }}
                              >
                                修改提示词
                              </Button>
                            </div>
                          </div>
                        ) : it.src ? (
                          <div className="absolute inset-0 flex items-center justify-center">
                            <img
                              src={it.src}
                              alt={it.prompt}
                              className="w-full h-full block"
                              style={{ objectFit: 'contain', borderRadius: 14 }}
                            />
                          </div>
                        ) : (
                          <div className="absolute inset-0 flex items-center justify-center" style={{ color: 'rgba(96,165,250,0.35)' }}>
                            <ImagePlus size={54} />
                          </div>
                        )}
                      </div>
                    ) : it.status === 'running' ? (
                      <div className="w-full h-full flex items-center justify-center">
                        <PrdLoader size={loaderSizeForBox(w, h)} />
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
                        <img
                          src={it.src}
                          alt={it.prompt}
                          className="w-full h-full block"
                          style={{
                            objectFit: 'contain',
                            borderRadius: 14,
                            // 规则：不制造任何“假边框”；选中仅做高亮效果（光晕），不改变尺寸/比例
                            filter: active
                              ? 'drop-shadow(0 0 2px rgba(250,204,21,0.95)) drop-shadow(0 0 14px rgba(250,204,21,0.45))'
                              : 'none',
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
                                return { ...x, naturalW: nw, naturalH: nh, w: nw, h: nh };
                              })
                            );
                          }}
                        />
                      </div>
                    )}
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
                          className="absolute px-2 py-1 rounded-[10px] text-[13px] font-semibold"
                          style={{
                            left: 0,
                            top: 0,
                            transform: 'translateY(calc(-100% - 10px)) scale(var(--invZoom))',
                            transformOrigin: 'left bottom',
                            background: 'rgba(255,255,255,0.80)',
                            border: '1px solid rgba(0,0,0,0.10)',
                            color: 'rgba(0,0,0,0.55)',
                            boxShadow: '0 10px 24px rgba(0,0,0,0.10)',
                          }}
                        >
                          Image Generator
                        </div>
                        <div
                          className="absolute px-2 py-1 rounded-[10px] text-[13px] font-semibold"
                          style={{
                            right: 0,
                            top: 0,
                            transform: 'translateY(calc(-100% - 10px)) scale(var(--invZoom))',
                            transformOrigin: 'right bottom',
                            background: 'rgba(255,255,255,0.72)',
                            border: '1px solid rgba(0,0,0,0.10)',
                            color: 'rgba(0,0,0,0.45)',
                          }}
                        >
                          {Math.round(w)} × {Math.round(h)}
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>

            {/* 交互层：选中生成器时显示快捷输入（可输入/可删除/可发送）
                注意：不能用“全屏覆盖层”接收事件，否则会挡住画布工具栏/缩放条。
                这里用屏幕坐标定位一个“仅自身大小”的浮层。 */}
            {selectedGenerator ? (
              <div
                className="absolute z-40"
                style={{
                  left: Math.round(
                    ((selectedGenerator.x ?? 0) + (selectedGenerator.w ?? 1024) / 2) * zoom + camera.x
                  ),
                  top: Math.round(
                    ((selectedGenerator.y ?? 0) + (selectedGenerator.h ?? 1024)) * zoom + camera.y + 26
                  ),
                  transform: 'translate(-50%, 0)',
                  pointerEvents: 'auto',
                }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  activeComposerRef.current = 'quick';
                  focusQuickComposer();
                }}
              >
                <div
                  className="w-[560px] max-w-[82vw] rounded-[12px]"
                  style={{
                    background: 'rgba(255,255,255,0.88)',
                    border: '1px solid rgba(0,0,0,0.10)',
                    boxShadow: '0 24px 90px rgba(0,0,0,0.18)',
                    padding: 16,
                    minHeight: 168,
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
                    placeholder="今天我们要创作什么"
                    className="w-full resize-none outline-none focus:outline-none focus-visible:outline-none"
                    style={{
                      height: 104,
                      background: 'transparent',
                      border: 'none',
                      outline: 'none',
                      boxShadow: 'none',
                      color: 'rgba(0,0,0,0.86)',
                      fontSize: 15,
                      fontWeight: 600,
                      lineHeight: '20px',
                    }}
                  />

                  <div className="mt-2 flex items-end justify-between gap-3">
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <button
                          type="button"
                          className="text-[14px] font-semibold inline-flex items-center gap-1 rounded-[10px] px-2 py-1 hover:bg-black/5"
                          style={{ color: 'rgba(0,0,0,0.92)' }}
                          title="切换绘图模型"
                        >
                          <span className="truncate max-w-[260px]">
                            {effectiveModel?.name || effectiveModel?.modelName || '自动模型'}
                          </span>
                          <span className="text-[12px]" style={{ color: 'rgba(0,0,0,0.35)' }}>
                            ▾
                          </span>
                        </button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content
                          side="top"
                          align="start"
                          sideOffset={10}
                          className="z-50 rounded-[18px] p-2"
                          style={{
                            minWidth: 320,
                            background: 'rgba(255,255,255,0.92)',
                            border: '1px solid rgba(0,0,0,0.08)',
                            boxShadow: '0 18px 60px rgba(0,0,0,0.18)',
                            color: '#0b0b0f',
                          }}
                        >
                          <div className="px-2 py-1 text-[11px] font-semibold" style={{ color: 'rgba(0,0,0,0.45)' }}>
                            绘图模型（isImageGen）
                          </div>
                          <div className="max-h-[320px] overflow-auto p-1">
                            {(models ?? [])
                              .filter((m) => m.isImageGen)
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
                                return (
                                  <button
                                    key={m.id}
                                    type="button"
                                    className="w-full text-left rounded-[12px] px-3 py-2 hover:bg-black/5 disabled:opacity-50 disabled:cursor-not-allowed"
                                    disabled={disabled}
                                    onClick={() => {
                                      setModelPrefAuto(false);
                                      setModelPrefModelId(m.id);
                                    }}
                                  >
                                    <div className="flex items-center gap-2 min-w-0">
                                      <div className="min-w-0">
                                        <div className="text-[13px] font-semibold truncate" style={{ color: '#0b0b0f' }}>
                                          {m.name || m.modelName}
                                        </div>
                                        <div className="text-[11px] mt-0.5 truncate" style={{ color: 'rgba(0,0,0,0.40)' }}>
                                          {disabled ? '已禁用（模型管理可启用）' : '已启用'}
                                        </div>
                                      </div>
                                      <div className="ml-auto shrink-0">{using ? <Check size={16} color="#0b0b0f" /> : null}</div>
                                    </div>
                                  </button>
                                );
                              })}
                          </div>
                          <DropdownMenu.Arrow className="fill-white" style={{ filter: 'drop-shadow(0 1px 0 rgba(0,0,0,0.08))' }} />
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>

                    <div className="text-[13px]" style={{ color: 'rgba(0,0,0,0.45)' }}>
                      Enter 发送，Shift+Enter 换行
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

          {/* 顶部居中：缩放浮层 */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20">
            <div
              className="h-9 rounded-[999px] px-1.5 inline-flex items-center gap-1"
              style={{
                width: 222,
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(0,0,0,0.25)',
                backdropFilter: 'blur(10px)',
                WebkitBackdropFilter: 'blur(10px)',
                boxShadow: '0 18px 60px rgba(0,0,0,0.50)',
                color: 'var(--text-secondary)',
              }}
            >
              <button
                type="button"
                className="h-8 w-8 rounded-[999px] inline-flex items-center justify-center hover:bg-white/5"
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
              <div className="px-1 text-[10px] font-semibold tabular-nums" title="缩放比例">
                {Math.round(zoom * 100)}%
              </div>
              <button
                type="button"
                className="h-8 w-8 rounded-[999px] inline-flex items-center justify-center hover:bg-white/5"
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
              <button
                type="button"
                className="h-8 px-2 rounded-[999px] text-[10px] font-semibold hover:bg-white/5"
                onClick={fitToStage}
                disabled={canvas.length === 0}
                title="适配画布"
              >
                适配
              </button>
              <button
                type="button"
                className="h-8 px-2 rounded-[999px] text-[10px] font-semibold hover:bg-white/5"
                onClick={() => {
                  const c = stageCenterClient();
                  zoomAt(c.x, c.y, 1);
                }}
                disabled={canvas.length === 0}
                title="回到 100%"
              >
                100%
              </button>
            </div>
          </div>

          {/* 左侧工具栏（图1-5 风格，除画笔外都可用） */}
          <div className="absolute left-4 top-1/2 -translate-y-1/2 z-20">
            <div
              className="rounded-[20px] p-2 flex flex-col gap-2 bg-transparent"
              style={{
                border: '1px solid rgba(255,255,255,0.12)',
                backdropFilter: 'blur(14px)',
                WebkitBackdropFilter: 'blur(14px)',
                boxShadow: '0 18px 60px rgba(0,0,0,0.35)',
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
                      className="h-11 w-11 rounded-[14px] inline-flex items-center justify-center bg-transparent transition-colors hover:bg-white/12"
                      style={{ color: 'rgba(255,255,255,0.86)' }}
                      title={activeTool === 'hand' ? 'Hand tool' : activeTool === 'mark' ? 'Mark' : 'Select'}
                      aria-label="工具"
                      onClick={() => stageRef.current?.focus()}
                    >
                      {activeTool === 'hand' ? <Hand size={18} /> : activeTool === 'mark' ? <MapPin size={18} /> : <MousePointer2 size={18} />}
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      side="right"
                      align="start"
                      sideOffset={8}
                      className="z-50 rounded-[18px] p-2"
                      style={{
                        minWidth: 220,
                        background: 'rgba(255,255,255,0.92)',
                        border: '1px solid rgba(0,0,0,0.08)',
                        boxShadow: '0 18px 60px rgba(0,0,0,0.18)',
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
                      <DropdownMenu.Arrow className="fill-white" style={{ filter: 'drop-shadow(0 1px 0 rgba(0,0,0,0.08))' }} />
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
                        minWidth: 260,
                        background: 'rgba(255,255,255,0.92)',
                        border: '1px solid rgba(0,0,0,0.08)',
                        boxShadow: '0 18px 60px rgba(0,0,0,0.18)',
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
                            fileRef.current?.click();
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
                      <DropdownMenu.Arrow className="fill-white" style={{ filter: 'drop-shadow(0 1px 0 rgba(0,0,0,0.08))' }} />
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
                        minWidth: 320,
                        background: 'rgba(255,255,255,0.92)',
                        border: '1px solid rgba(0,0,0,0.08)',
                        boxShadow: '0 18px 60px rgba(0,0,0,0.18)',
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
                      <DropdownMenu.Arrow className="fill-white" style={{ filter: 'drop-shadow(0 1px 0 rgba(0,0,0,0.08))' }} />
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
                  // 允许创建多个“生成器区域”：每次点击都新建一个（不覆盖旧的）
                  const w = 1024;
                  const h = 1024;
                  const near = stageCenterWorld();
                  const key = `generator_${Date.now()}`;
                  setCanvas((prev) => {
                    const existingRects = prev
                      .filter(
                        (x) =>
                          x.status !== 'error' &&
                          ((x.kind ?? 'image') === 'generator' ||
                            (x.kind ?? 'image') === 'shape' ||
                            (x.kind ?? 'image') === 'text' ||
                            !!x.src ||
                            x.status === 'running')
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
                    focusKeyRef.current = { key, cx: pos.x + w / 2, cy: pos.y + h / 2 };
                    return [next, ...prev].slice(0, 80);
                  });
                  setSelectedKeys([key]);
                  requestAnimationFrame(() => {
                    const f = focusKeyRef.current;
                    if (!f || f.key !== key) return;
                    animateCameraToWorldCenter(f.cx, f.cy);
                  });
                  focusQuickComposer();
                }}
              >
                <ImagePlus size={18} />
              </button>

              {/* 视频生成器 */}
              <button
                type="button"
                className="h-11 w-11 rounded-[14px] inline-flex items-center justify-center bg-transparent transition-colors hover:bg-white/12"
                style={{ color: 'rgba(255,255,255,0.86)' }}
                title="视频生成器"
                aria-label="视频生成器"
                onClick={() => {
                  pushMsg('Assistant', '视频生成器：占位（后续接入后端）。');
                }}
              >
                <Video size={18} />
              </button>

              {/* 删除选中（放到底部） */}
              <button
                type="button"
                className="h-11 w-11 rounded-[14px] inline-flex items-center justify-center bg-transparent transition-colors hover:bg-white/12 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ color: 'rgba(255,255,255,0.86)' }}
                onClick={async () => {
                  if (selectedKeys.length === 0) return;
                  const ok = await systemDialog.confirm({
                    title: '确认删除',
                    message: `确认删除选中的 ${selectedKeys.length} 项？`,
                    tone: 'danger',
                    confirmText: '删除',
                    cancelText: '取消',
                  });
                  if (!ok) return;
                  const set = new Set(selectedKeys);
                  setCanvas((prev) => prev.filter((it) => !set.has(it.key)));
                  setSelectedKeys([]);
                }}
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

          {/* splitter */}
          <div
            role="separator"
            aria-orientation="vertical"
            className="relative shrink-0 w-[10px]"
            style={{ background: 'rgba(255,255,255,0.02)' }}
            onMouseDown={(e) => {
              dragRef.current = { dragging: true, startX: e.clientX, startRight: rightWidth };
              document.body.style.cursor = 'col-resize';
              document.body.style.userSelect = 'none';
              e.preventDefault();
            }}
          >
            <div
              className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px"
              style={{ background: 'rgba(255,255,255,0.08)' }}
            />
            <div
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-10 w-1.5 rounded-[999px]"
              style={{ background: 'rgba(255,255,255,0.10)' }}
            />
          </div>

          {/* 右侧：单对话/上下文（无独立卡片隔断） */}
          <div className="shrink-0 min-h-0 flex flex-col" style={{ width: rightWidth || 280 }}>
            <div className="h-full min-h-0 flex flex-col p-3" style={{ background: 'rgba(255,255,255,0.015)' }}>
            <div className="min-w-0">
                <div className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                Hi，我是你的 AI 设计师
              </div>
                <div className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                右侧是唯一对话上下文；左侧是画板。点画板图片即可选中，未来可作为图生图首帧。
              </div>
            </div>

            <div className="mt-3 grid gap-2">
              {templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="w-full text-left rounded-[14px] px-3 py-2.5 hover:bg-white/5 transition-colors"
                  style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}
                  onClick={() => {
                    const text = buildTemplate(t.id);
                    setInput(text);
                    requestAnimationFrame(() => inputRef.current?.focus());
                  }}
                >
                  <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {t.title}
                  </div>
                  <div className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {t.desc}
                  </div>
                </button>
              ))}
            </div>

            <div ref={scrollRef} className="mt-3 flex-1 min-h-0 overflow-auto pr-1 space-y-2.5">
              {messages.map((m) => {
                const isUser = m.role === 'User';
                return (
                  <div key={m.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className="max-w-[92%] rounded-[14px] px-3 py-2.5 text-sm"
                      style={{
                        background: isUser ? 'color-mix(in srgb, var(--accent-gold) 28%, rgba(255,255,255,0.02))' : 'rgba(255,255,255,0.04)',
                        border: '1px solid var(--border-subtle)',
                        color: 'var(--text-primary)',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {m.content}
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>

            {error ? (
              <div className="mt-3 text-xs" style={{ color: 'rgba(239,68,68,0.95)' }}>
                {error}
              </div>
            ) : null}

            <div
              ref={inputPanelRef}
              className="mt-3 rounded-[18px] p-3 relative"
              style={{ border: '1px solid var(--border-subtle)', background: 'rgba(0,0,0,0.14)' }}
            >
              {/* 图6 控制条（v1：先作为输入条上方的一行） */}
              {/* 已移除：输入框上方 4 个控制按钮（模型/参考/大小/比例）与其右侧“生成”按钮；保持输入区极简 */}

              {/* @tag 高亮层（不影响 textarea 编辑/选择），让用户感知“原子化整体” */}
              <div
                ref={highlightRef}
                aria-hidden="true"
                className="absolute left-3 right-3 top-3"
                style={{
                  height: taHeight,
                  minHeight: MIN_TA_HEIGHT,
                  maxHeight: '50%',
                  overflow: 'auto',
                  pointerEvents: 'none',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: 14,
                  lineHeight: '1.25rem',
                  color: 'transparent',
                }}
              >
                {renderMentionHighlights(input)}
              </div>

              <textarea
                ref={inputRef}
                value={input}
                onFocus={() => {
                  activeComposerRef.current = 'right';
                }}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={() => {
                  composingRef.current = false;
                }}
                onChange={(e) => {
                  const v = e.target.value;
                  setInput(v);
                  refreshMention(v, e.target.selectionStart ?? v.length);
                }}
                onInput={() => {
                  recomputeTextareaHeight();
                }}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  const hl = highlightRef.current;
                  if (hl) {
                    hl.scrollTop = el.scrollTop;
                    hl.scrollLeft = el.scrollLeft;
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Backspace') {
                    if (applyAtomicDelete()) {
                      e.preventDefault();
                      return;
                    }
                  }
                  if (e.key === 'Delete') {
                    if (applyAtomicDelete()) {
                      e.preventDefault();
                      return;
                    }
                  }
                  if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
                    e.preventDefault();
                    e.currentTarget.select();
                    return;
                  }
                  if (mentionOpen && e.key === 'Escape') {
                    e.preventDefault();
                    setMentionOpen(false);
                    setMentionQuery('');
                    setMentionAtPos(null);
                    return;
                  }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    // IME 合成输入时：Enter 代表“确认候选”，不应触发发送
                    // keyCode===229 是部分浏览器/系统的合成态标志
                    const ne = e.nativeEvent as unknown as { isComposing?: boolean; keyCode?: number };
                    if (composingRef.current || ne.isComposing || ne.keyCode === 229) return;
                    e.preventDefault();
                    void onSend();
                  }
                }}
                onKeyUp={(e) => {
                  const ta = e.currentTarget;
                  refreshMention(ta.value, ta.selectionStart ?? ta.value.length);
                }}
                placeholder="请输入你的设计需求（Enter 发送，Shift+Enter 换行）"
                className="w-full resize-none rounded-none px-0 py-0 text-sm outline-none focus:outline-none focus-visible:outline-none"
                style={{
                  height: taHeight,
                  minHeight: MIN_TA_HEIGHT,
                  maxHeight: '50%',
                  overflowY: 'auto',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-primary)',
                  outline: 'none',
                  boxShadow: 'none',
                }}
                disabled={busy}
              />

              {mentionOpen ? (
                <div
                  className="absolute left-2 right-2 z-30 rounded-[14px] overflow-hidden"
                  style={{
                    bottom: 56, // 让出底部工具条高度，避免挤压
                    border: '1px solid rgba(255,255,255,0.12)',
                    background: 'rgba(0,0,0,0.32)',
                    boxShadow: '0 24px 90px rgba(0,0,0,0.65)',
                    backdropFilter: 'blur(10px)',
                    WebkitBackdropFilter: 'blur(10px)',
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
                      const visionModels = (models ?? []).filter((m) => m.enabled && m.isVision);
                      const imageModels = (models ?? []).filter((m) => m.enabled && m.isImageGen);
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
                                imageModels
                                  .slice()
                                  .sort((a, b) => Number(a.priority ?? 1e9) - Number(b.priority ?? 1e9))
                                  .map((m) => (
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

              {selectedKeys.some((k) => (canvas.find((x) => x.key === k)?.kind ?? 'image') === 'image') ? (
                <div className="mt-1 text-[12px] whitespace-pre-line" style={{ color: 'var(--text-muted)' }}>
                  {selectedKeys
                    .slice(0, 6)
                    .map((k, i) => {
                      const it = canvas.find((x) => x.key === k);
                      if (!it || (it.kind ?? 'image') !== 'image') return null;
                      const title = it?.prompt || '（无描述）';
                      return `选中图${i + 1}: ${title}`;
                    })
                    .filter(Boolean)
                    .join('\n')}
                </div>
              ) : null}

              <div className="mt-1 flex items-center justify-between gap-2">
                {/* 左侧：附件 + @（强制入口） */}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="h-10 w-10 rounded-full inline-flex items-center justify-center"
                    style={{
                      border: '1px solid rgba(255,255,255,0.10)',
                      background: 'rgba(255,255,255,0.04)',
                      color: 'var(--text-secondary)',
                    }}
                    aria-label="附件"
                    title="附件"
                    onClick={() => fileRef.current?.click()}
                    disabled={busy}
                  >
                    <Paperclip size={18} />
                  </button>

                  <button
                    type="button"
                    className="h-10 w-10 rounded-full inline-flex items-center justify-center"
                    style={{
                      border: '1px solid rgba(255,255,255,0.10)',
                      background: 'rgba(255,255,255,0.04)',
                      color: 'var(--text-secondary)',
                    }}
                    aria-label="@"
                    title="@"
                    onClick={() => insertTextAtCursor('@', { openMention: true })}
                    disabled={busy}
                  >
                    <AtSign size={18} />
                  </button>
                </div>

                {/* 右侧：模型偏好 + 发送 */}
                <div className="flex items-center gap-2">
                  {/* 图2：发送左边的按钮是“模型偏好” */}
                  <DropdownMenu.Root open={modelPrefOpen} onOpenChange={setModelPrefOpen}>
                    <DropdownMenu.Trigger asChild>
                      <button
                        type="button"
                        className="h-10 w-10 rounded-full inline-flex items-center justify-center"
                        style={{
                          border: '1px solid rgba(255,255,255,0.10)',
                          background: 'rgba(255,255,255,0.04)',
                          color: 'var(--text-secondary)',
                        }}
                        aria-label="模型偏好"
                        title="模型偏好"
                      >
                        <SlidersHorizontal size={18} />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        side="top"
                        align="end"
                        sideOffset={10}
                        className="z-50 rounded-[18px] p-4"
                        style={{
                          width: 420,
                          maxWidth: 'min(92vw, 420px)',
                          background: 'color-mix(in srgb, var(--bg-elevated) 92%, black)',
                          border: '1px solid var(--border-default)',
                          boxShadow: '0 18px 60px rgba(0,0,0,0.55)',
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
                            <Switch checked={directPrompt} onCheckedChange={(v) => setDirectPrompt(v)} ariaLabel="直连模式（不解析）" />
                          </div>
                        </div>

                        <div className="mt-3 flex items-center gap-2 rounded-[14px] p-1" style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(255,255,255,0.03)' }}>
                          <button
                            type="button"
                            className="h-8 px-3 rounded-[12px] text-[13px] font-semibold"
                            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)', color: 'var(--text-primary)' }}
                          >
                            Image
                          </button>
                          <button
                            type="button"
                            className="h-8 px-3 rounded-[12px] text-[13px] font-semibold"
                            style={{ background: 'transparent', border: '1px solid transparent', color: 'rgba(255,255,255,0.45)' }}
                            disabled
                          >
                            Video
                          </button>
                          <button
                            type="button"
                            className="h-8 px-3 rounded-[12px] text-[13px] font-semibold"
                            style={{ background: 'transparent', border: '1px solid transparent', color: 'rgba(255,255,255,0.45)' }}
                            disabled
                          >
                            3D
                          </button>
                        </div>

                        <div className="mt-3 max-h-[360px] overflow-auto pr-1">
                          {enabledImageModels.length === 0 ? (
                            <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
                              暂无启用的 isImageGen 模型（可在“模型管理”开启）
                            </div>
                          ) : (
                            <div className="space-y-2">
                              {enabledImageModels
                                .slice()
                                .sort((a, b) => Number(a.priority ?? 1e9) - Number(b.priority ?? 1e9))
                                .map((m) => {
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
                                          <div className="mt-0.5 text-[12px] truncate" style={{ color: 'var(--text-muted)' }}>
                                            {m.modelName}
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

                        <DropdownMenu.Arrow className="fill-(--bg-elevated)" style={{ filter: 'drop-shadow(0 1px 0 rgba(255,255,255,0.10))' }} />
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>

                  {/* 图2：发送（圆形箭头） */}
                  <button
                    type="button"
                    onClick={() => void onSend()}
                    disabled={busy || !input.trim()}
                    className="h-10 w-10 rounded-full inline-flex items-center justify-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{
                      border: '1px solid rgba(255,255,255,0.10)',
                      background: busy || !input.trim() ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.10)',
                      color: busy || !input.trim() ? 'rgba(255,255,255,0.45)' : 'var(--text-primary)',
                    }}
                    aria-label="生成"
                    title="生成"
                  >
                    {busy ? <Loader2 size={18} className="animate-spin" /> : <ArrowUp size={18} />}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

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
      </Card>
    </div>
  );
}


