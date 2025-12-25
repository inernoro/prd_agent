import { Button } from '@/components/design/Button';
import { Card } from '@/components/design/Card';
import { Switch } from '@/components/design/Switch';
import { Dialog } from '@/components/ui/Dialog';
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
import type { ImageGenPlanResponse } from '@/services/contracts/imageGen';
import type { ImageAsset, ImageMasterMessage, ImageMasterSession } from '@/services/contracts/imageMaster';
import type { Model } from '@/types/admin';
import {
  ArrowUp,
  AtSign,
  Check,
  Copy,
  Download,
  ImagePlus,
  Loader2,
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuthStore } from '@/stores/authStore';

type CanvasImageItem = {
  key: string;
  createdAt: number;
  prompt: string;
  src: string;
  status: 'done' | 'error' | 'running';
  kind?: 'image' | 'generator';
  errorMessage?: string | null;
  refId?: number;
  checked?: boolean;
  checkedAt?: number;
  assetId?: string;
  sha256?: string;
  naturalW?: number;
  naturalH?: number;
  // “开放世界”画布位置/尺寸（基础单位，渲染时乘以 zoom）
  x?: number;
  y?: number;
  w?: number;
  h?: number;
};

type UiMsg = {
  id: string;
  role: 'User' | 'Assistant';
  content: string;
  ts: number;
};

const clampZoom = (z: number) => Math.max(0.25, Math.min(3, z));
const clampZoomFactor = (f: number) => Math.max(0.93, Math.min(1.07, f));
const zoomFactorFromDeltaY = (deltaY: number) => {
  // 更细腻：factor = exp(-dy*k)，并限制单次变化幅度，避免“一滚就跳”
  const k = 0.0016;
  return clampZoomFactor(Math.exp(-deltaY * k));
};

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
  const effectiveModel = useMemo(() => {
    const byId = modelPrefModelId ? enabledImageModels.find((m) => m.id === modelPrefModelId) ?? null : null;
    if (modelPrefAuto) return serverDefaultModel;
    return byId ?? serverDefaultModel;
  }, [enabledImageModels, modelPrefAuto, modelPrefModelId, serverDefaultModel]);

  const [messages, setMessages] = useState<UiMsg[]>([
    {
      id: 'assistant-hello',
      role: 'Assistant',
      content: 'Hi，我是你的 AI 设计师。描述你的需求，我会把它转成可执行的生图提示词，并把结果放到左侧画板。',
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
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const primarySelectedKey = selectedKeys[0] ?? '';
  const selected = useMemo(() => canvas.find((x) => x.key === primarySelectedKey) ?? null, [canvas, primarySelectedKey]);
  const isSelectedKey = (k: string) => selectedKeys.includes(k);

  // 画布（无限平面）视口：camera + zoom
  // 性能关键：高频交互（wheel/pan/drag）不走 React setState，否则会触发整棵画布重渲染导致“不跟手”
  // 用 ref + rAF 直接更新 worldRef 的 transform；state 仅用于 UI 展示（低频同步）
  const [zoom, setZoom] = useState(1);
  const [camera, setCamera] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const cameraRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const rafTransformRef = useRef<number | null>(null);
  const lastUiSyncRef = useRef(0);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const worldUiRef = useRef<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

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
      setStageSize({ w: el.clientWidth || 0, h: el.clientHeight || 0 });
    });
    ro.observe(el);
    setStageSize({ w: el.clientWidth || 0, h: el.clientHeight || 0 });
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

  // Mac 触控板捏合缩放（Chrome/Edge 通常体现为 ctrlKey + wheel）
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;

    const onWheel = (ev: WheelEvent) => {
      // 空态不缩放
      if (canvas.length === 0) return;
      // pinch / ctrl+wheel
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      const next = clampZoom(zoomRef.current * zoomFactorFromDeltaY(ev.deltaY));
      zoomAt(ev.clientX, ev.clientY, next);
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel as EventListener);
  }, [canvas.length, zoomAt]);

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
    const forcedPick = extractForcedImageModel(requestText);
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

    let plan: ImageGenPlanResponse | null = null;
    try {
      const pres = await planImageGen({ text: reqText, maxItems: 8 });
      if (!pres.success) {
        const msg = pres.error?.message || '解析失败';
        setError(msg);
        pushMsg('Assistant', `解析失败：${msg}`);
        return;
      }
      plan = pres.data ?? null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : '网络错误';
      setError(msg);
      pushMsg('Assistant', `解析失败：${msg}`);
      return;
    }

    const items = Array.isArray(plan?.items) ? plan!.items : [];
    const firstPrompt = String(items[0]?.prompt ?? '').trim() || reqText;

    const pickedIsVolcesSeedream = /volces|doubao|seedream/i.test(String(pickedModel?.modelName || ''));

    pushMsg(
      'Assistant',
      [
        `本次使用模型：${pickedModel?.name || pickedModel?.modelName}${forcedPick.forced ? '（@ 强制）' : ''}`,
        `我已把需求解析成 ${items.length || 1} 条生图提示词。`,
        items.length ? '候选提示词（前 3 条）：\n' + items.slice(0, 3).map((x, i) => `${i + 1}. ${x.prompt}`).join('\n') : '',
        (primaryRef || selected) && pickedIsVolcesSeedream
          ? '你选择了首帧图。当前使用的 seedream/Volces 生图通常不支持标准图生图首帧，我会自动改为“风格提取→拼进提示词”的方式来尽量保持一致。'
          : (primaryRef || selected)
            ? '你已选中一张图片作为参考图。本次将作为图生图参考传给生图接口（若上游平台不支持，会返回参数错误）。'
            : '',
      ]
        .filter(Boolean)
        .join('\n\n')
    );

    // 画板占位
    const key = `gen_${Date.now()}`;
    setCanvas((prev) => {
      const placeholder: CanvasImageItem = {
        key,
        createdAt: Date.now(),
        prompt: firstPrompt,
        src: '',
        status: 'running',
          // 规则：不假定尺寸；等图片真实 load 后再用 naturalWidth/Height 回填
          w: 1,
          h: 1,
      };
      return [placeholder, ...prev].slice(0, 60);
    });

    try {
      const initSrc = (primaryRef?.src || selected?.src) ?? '';
      const gres = await generateImageGen({
        modelId: pickedModel!.id,
        prompt: firstPrompt,
        n: 1,
        size: resolvedSizeForGen,
        responseFormat: DEFAULT_RESPONSE_FORMAT,
        initImageBase64: initSrc && initSrc.startsWith('data:') ? initSrc : undefined,
      });
      if (!gres.success) {
        const msg = gres.error?.message || '生成失败';
        setCanvas((prev) => prev.map((x) => (x.key === key ? { ...x, status: 'error', errorMessage: msg } : x)));
        setError(msg);
        pushMsg('Assistant', `生成失败：${msg}`);
        return;
      }
      const img0 = (gres.data?.images ?? [])[0];
      const src =
        (img0?.url ?? '') ||
        (img0?.base64 ? (img0.base64.startsWith('data:') ? img0.base64 : `data:image/png;base64,${img0.base64}`) : '');
      if (!src) {
        setCanvas((prev) => prev.map((x) => (x.key === key ? { ...x, status: 'error', errorMessage: '未返回图片' } : x)));
        setError('未返回图片');
        pushMsg('Assistant', '生成失败：未返回图片');
        return;
      }
      setCanvas((prev) => prev.map((x) => (x.key === key ? { ...x, status: 'done', src } : x)));
      // 新生成的图：确保有画布位置，并默认选中它（更符合“开放世界新增一张”）
      setCanvas((prev) => {
        const next = prev.map((x) =>
          x.key === key
            ? {
                ...x,
                status: 'done' as const,
                src,
              }
            : x
        );
        const withPos = ensureLayoutForNewItems(next, 0);
        return withPos;
      });
      setSelectedKeys([key]);

      // 上传并持久化资产：把外部签名 URL / base64 转为自托管 URL（避免过期）
      if (masterSession?.id) {
        const width = resolvedSizeForGen.startsWith('1024') ? 1024 : resolvedSizeForGen.startsWith('768') ? 768 : resolvedSizeForGen.startsWith('512') ? 512 : undefined;
        const height = resolvedSizeForGen.endsWith('1024') ? 1024 : resolvedSizeForGen.endsWith('768') ? 768 : resolvedSizeForGen.endsWith('512') ? 512 : undefined;
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
      }
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

  const resolvedSizeForGen = imageGenSize;

  const onUploadImages = async (files: File[]) => {
    const list = (files ?? []).filter((f) => f && f.type && f.type.startsWith('image/'));
    if (list.length === 0) return;

    // 选中单张“图片”时：上传单图默认“替换”而非叠加（保留 x/y/w/h）
    if (list.length === 1 && selectedKeys.length === 1) {
      const targetKey = selectedKeys[0]!;
      const target = canvas.find((x) => x.key === targetKey);
      if (!target || (target.kind ?? 'image') !== 'image') {
        // 如果当前选中的是“生成器区域”等非图片对象，则走新增逻辑
      } else {
      const file = list[0]!;
      const now = Date.now();
      const src = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => resolve('');
        reader.readAsDataURL(file);
      });
      if (!src) return;
      const dim = await readImageSizeFromSrc(src);

      setCanvas((prev) =>
        prev.map((it) =>
          it.key === targetKey
            ? {
                ...it,
                createdAt: now,
                prompt: file.name || it.prompt,
                src,
                status: 'done',
                errorMessage: null,
                assetId: undefined,
                sha256: undefined,
                // 规则：图片多大，就按其 natural 多大显示（之后只通过画布 zoom 改变）
                w: dim?.w ?? it.w,
                h: dim?.h ?? it.h,
                naturalW: dim?.w ?? it.naturalW,
                naturalH: dim?.h ?? it.naturalH,
              }
            : it
        )
      );
      pushMsg('Assistant', '已替换当前选中图片。');

      // 持久化替换后的图片
      if (masterSession?.id) {
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
                const dim = await readImageSizeFromSrc(src);
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
    setCanvas((prev) => {
      // 新增：落在当前视口中心附近（更像“开放世界”）
      const baseX = (stageSize.w / 2 - cameraRef.current.x) / zoomRef.current;
      const baseY = (stageSize.h / 2 - cameraRef.current.y) / zoomRef.current;
      const gap = 24;
      const placed = added.map((it, i) => ({
        ...it,
        // 规则：不改比例，不设默认 320x220；未知尺寸时先用 1px 占位，等 onLoad 再补齐
        w: it.w ?? 1,
        h: it.h ?? 1,
        x: (it.x ?? baseX) + (i % 3) * ((it.w ?? 1) + gap),
        y: (it.y ?? baseY) + Math.floor(i / 3) * ((it.h ?? 1) + gap),
      }));
      const merged = [...placed.reverse(), ...prev].slice(0, 60);
      return ensureLayoutForNewItems(merged, 0);
    });
    // 默认选中最新一张（更像你说的“新增到开放世界里”）
    setSelectedKeys([added[0].key]);
    pushMsg('Assistant', `已把 ${added.length} 张图片加入画板。你可以选中其中一张作为首帧，或用 @imgN 引用多张图。`);

    // 持久化：上传到后端并替换为自托管 URL（避免 dataURL 过大、也方便跨设备恢复）
    if (masterSession?.id) {
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
    }
  };

  const templates = [
    { id: 'wine', title: 'Wine List', desc: '生成一张高级红酒海报（克制、留白、金色点缀）' },
    { id: 'coffee', title: 'Coffee Shop Branding', desc: '为咖啡店生成品牌视觉方向与主视觉' },
    { id: 'story', title: 'Story Board', desc: '生成短片分镜首帧图（情绪与镜头）' },
  ] as const;

  const fitToStage = () => {
    const el = stageRef.current;
    if (!el) return;
    const itemsAll = canvas.filter(
      (x) => x.status !== 'error' && ((x.kind ?? 'image') === 'generator' || !!x.src || x.status === 'running')
    );
    const items =
      selectedKeys.length > 0 ? itemsAll.filter((x) => selectedKeys.includes(x.key)) : itemsAll;
    if (items.length === 0) {
      // 回到原点附近
      setViewport(1, { x: Math.round(stageSize.w / 2), y: Math.round(stageSize.h / 2) }, { syncUi: true });
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

  const ensureLayoutForNewItems = (items: CanvasImageItem[], baseIndexStart: number) => {
    // 让新图片自然地“出现在大画布里”：简单网格排布（开放世界的第一步）
    const gap = 24;
    const cols = Math.max(2, Math.min(5, Math.floor((stageSize.w || 900) / (420 + gap))));
    return items.map((it, i) => {
      if (it.x != null && it.y != null) return it;
      const idx = baseIndexStart + i;
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const w = it.w ?? 1;
      const h = it.h ?? 1;
      return {
        ...it,
        w,
        h,
        x: col * (w + gap),
        y: row * (h + gap),
      };
    });
  };

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
            className="absolute inset-0 overflow-hidden"
            style={{
              background: 'rgba(0,0,0,0.10)',
            }}
            tabIndex={0}
            onMouseDown={() => stageRef.current?.focus()}
            onBlur={() => {
              // 失焦时清掉框选残留
              setMarquee((prev) => (prev.active ? { ...prev, active: false, w: 0, h: 0 } : prev));
              panRef.current.active = false;
              dragItemsRef.current.active = false;
            }}
            onPointerDown={(e) => {
              // 只处理“空白区域”的 pointerdown；点击图片会 stopPropagation
              const isBlank = e.target === e.currentTarget || e.target === worldRef.current;
              if (!isBlank) return;
              stageRef.current?.focus();

              // Space + 拖拽：平移
              if (spacePressed) {
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
                    it.status !== 'error' && ((it.kind ?? 'image') === 'generator' || !!it.src || it.status === 'running')
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
              // Delete / Backspace：删除选中
              if ((e.key === 'Delete' || e.key === 'Backspace') && selectedKeys.length > 0) {
                // 避免在输入框中删除字符：这里只在画布获得焦点时触发
                e.preventDefault();
                const ok = window.confirm(`确认删除选中的 ${selectedKeys.length} 张图片？`);
                if (!ok) return;
                const set = new Set(selectedKeys);
                setCanvas((prev) => prev.filter((it) => !set.has(it.key)));
                setSelectedKeys([]);
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
                if (it.status === 'error') return null;
                const kind = it.kind ?? 'image';
                if (kind === 'image' && !it.src && it.status !== 'running') return null;
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
                      cursor: 'pointer',
                    }}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                    }}
                    onPointerDown={(e) => {
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
                      // 生成器区域：仅做选中，不做 @img 引用插入
                      if ((it.kind ?? 'image') === 'generator') {
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
                      if (e.metaKey || e.ctrlKey) {
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

                    {it.status === 'running' ? (
                      <div className="w-full h-full flex items-center justify-center">
                        <Loader2 size={18} className="animate-spin" style={{ color: 'var(--text-secondary)' }} />
                      </div>
                    ) : (it.kind ?? 'image') === 'generator' ? (
                      <div
                        className="w-full h-full rounded-[16px] relative"
                        style={{
                          background: 'rgba(96,165,250,0.16)',
                          border: active ? '2px solid rgba(96,165,250,0.85)' : '1px solid rgba(96,165,250,0.25)',
                          boxShadow: active ? '0 0 0 1px rgba(0,0,0,0.18) inset' : 'none',
                        }}
                      >
                        <div className="absolute inset-0 flex items-center justify-center" style={{ color: 'rgba(96,165,250,0.35)' }}>
                          <ImagePlus size={54} />
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
            <div ref={worldUiRef} className="absolute inset-0 z-30" style={{ transformOrigin: '0 0' }}>
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

              {/* 交互层：选中生成器时显示快捷输入（可输入/可删除/可发送） */}
              {selectedGenerator ? (
                <div
                  className="absolute"
                  style={{
                    left: Math.round((selectedGenerator.x ?? 0) + (selectedGenerator.w ?? 1024) / 2),
                    top: `calc(${Math.round((selectedGenerator.y ?? 0) + (selectedGenerator.h ?? 1024))}px + 26px * var(--invZoom))`,
                    transform: 'translate(-50%, 0) scale(var(--invZoom))',
                    transformOrigin: 'center top',
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
                      onChange={(e) => {
                        setQuickInput(e.target.value);
                      }}
                      onKeyDown={(e) => {
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
                        // 字体缩小约 1/3：22 -> 15
                        fontSize: 15,
                        fontWeight: 600,
                        lineHeight: '20px',
                      }}
                    />

                    <div className="mt-2 flex items-end justify-between gap-3">
                      <div className="text-[14px]" style={{ color: 'rgba(0,0,0,0.92)' }}>
                        {effectiveModel?.name || effectiveModel?.modelName || '自动模型'}
                      </div>
                      <div className="text-[13px]" style={{ color: 'rgba(0,0,0,0.45)' }}>
                        Enter 发送，Shift+Enter 换行
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

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
              className="rounded-[20px] p-2 flex flex-col gap-2"
              style={{
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(255,255,255,0.10)',
                backdropFilter: 'blur(14px)',
                WebkitBackdropFilter: 'blur(14px)',
                boxShadow: '0 18px 60px rgba(0,0,0,0.35)',
              }}
            >
              {/* 选择 */}
              <button
                type="button"
                className="h-11 w-11 rounded-[14px] inline-flex items-center justify-center"
                style={{ background: 'rgba(255,255,255,0.55)', color: '#1a1206' }}
                title="选择"
                aria-label="选择"
                onClick={() => stageRef.current?.focus()}
              >
                <MousePointer2 size={18} />
              </button>

              {/* +新增 */}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    className="h-11 w-11 rounded-[14px] inline-flex items-center justify-center hover:bg-black/5"
                    style={{ background: 'rgba(255,255,255,0.55)', color: '#1a1206' }}
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
                    sideOffset={12}
                    className="z-50 rounded-[18px] p-3"
                    style={{
                      minWidth: 260,
                      background: 'rgba(255,255,255,0.92)',
                      border: '1px solid rgba(0,0,0,0.08)',
                      boxShadow: '0 18px 60px rgba(0,0,0,0.18)',
                      color: '#0b0b0f',
                    }}
                  >
                    <div className="text-[14px] font-semibold" style={{ color: 'rgba(0,0,0,0.55)' }}>
                      新增
                    </div>
                    <div className="mt-3 grid gap-2">
                      <button
                        type="button"
                        className="w-full flex items-center gap-3 rounded-[14px] px-3 py-2 hover:bg-black/5"
                        onClick={() => fileRef.current?.click()}
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
                        <span className="inline-flex h-5 w-5 items-center justify-center text-[18px] font-black" style={{ color: 'rgba(11,11,15,0.65)' }}>
                          #
                        </span>
                        <span className="text-[16px] font-semibold" style={{ color: 'rgba(11,11,15,0.65)' }}>
                          智能画板
                        </span>
                        <span className="ml-auto text-[14px] font-semibold" style={{ color: 'rgba(0,0,0,0.35)' }}>
                          F
                        </span>
                      </button>
                    </div>
                    <DropdownMenu.Arrow className="fill-white" style={{ filter: 'drop-shadow(0 1px 0 rgba(0,0,0,0.08))' }} />
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>

              {/* 形状 */}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    className="h-11 w-11 rounded-[14px] inline-flex items-center justify-center hover:bg-black/5"
                    style={{ background: 'rgba(255,255,255,0.55)', color: '#1a1206' }}
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
                    sideOffset={12}
                    className="z-50 rounded-[18px] p-3"
                    style={{
                      minWidth: 320,
                      background: 'rgba(255,255,255,0.92)',
                      border: '1px solid rgba(0,0,0,0.08)',
                      boxShadow: '0 18px 60px rgba(0,0,0,0.18)',
                    }}
                  >
                    <div className="text-[14px] font-semibold" style={{ color: 'rgba(0,0,0,0.55)' }}>
                      形状
                    </div>
                    <div className="mt-3 grid grid-cols-4 gap-3">
                      <button type="button" className="h-12 rounded-[14px] bg-white hover:bg-black/5 border border-black/10" />
                      <button type="button" className="h-12 rounded-[999px] bg-white hover:bg-black/5 border border-black/10" />
                      <button type="button" className="h-12 rounded-[14px] bg-white hover:bg-black/5 border border-black/10" style={{ clipPath: 'polygon(50% 15%, 10% 85%, 90% 85%)' }} />
                      <button type="button" className="h-12 rounded-[14px] bg-white hover:bg-black/5 border border-black/10" style={{ clipPath: 'polygon(50% 10%, 61% 38%, 90% 38%, 66% 56%, 76% 86%, 50% 68%, 24% 86%, 34% 56%, 10% 38%, 39% 38%)' }} />
                    </div>
                    <div className="mt-4 text-[14px] font-semibold" style={{ color: 'rgba(0,0,0,0.55)' }}>
                      形状文本
                    </div>
                    <div className="mt-3 grid grid-cols-5 gap-3">
                      <button type="button" className="h-12 rounded-[14px] bg-white hover:bg-black/5 border border-black/10" />
                      <button type="button" className="h-12 rounded-[999px] bg-white hover:bg-black/5 border border-black/10" />
                      <button type="button" className="h-12 rounded-[14px] bg-white hover:bg-black/5 border border-black/10" />
                      <button type="button" className="h-12 rounded-[14px] bg-white hover:bg-black/5 border border-black/10" />
                      <button type="button" className="h-12 rounded-[14px] bg-white hover:bg-black/5 border border-black/10" />
                    </div>
                    <DropdownMenu.Arrow className="fill-white" style={{ filter: 'drop-shadow(0 1px 0 rgba(0,0,0,0.08))' }} />
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>

              {/* 文字 */}
              <button
                type="button"
                className="h-11 w-11 rounded-[14px] inline-flex items-center justify-center hover:bg-black/5"
                style={{ background: 'rgba(255,255,255,0.55)', color: '#1a1206' }}
                title="文字（T）"
                aria-label="文字"
                onClick={() => {
                  // v1：先只给提示，不做画布文字对象
                  pushMsg('Assistant', '文字工具：即将支持在画布中插入/编辑文本（当前为占位）。');
                }}
              >
                <Type size={18} />
              </button>

              {/* 图像生成器 */}
              <button
                type="button"
                className="h-11 w-11 rounded-[14px] inline-flex items-center justify-center hover:bg-black/5"
                style={{ background: 'rgba(255,255,255,0.55)', color: '#1a1206' }}
                title="图像生成器（A）"
                aria-label="图像生成器"
                onClick={() => {
                  // 画布中插入一个“生成器区域”（类似 Lovart），默认选中
                  const exist = canvas.find((x) => (x.kind ?? 'image') === 'generator');
                  const key = exist?.key ?? `generator_${Date.now()}`;
                  if (!exist) {
                    const w = 1024;
                    const h = 1024;
                    const baseX = (stageSize.w / 2 - cameraRef.current.x) / zoomRef.current;
                    const baseY = (stageSize.h / 2 - cameraRef.current.y) / zoomRef.current;
                    const next: CanvasImageItem = {
                      key,
                      kind: 'generator',
                      createdAt: Date.now(),
                      prompt: 'Image Generator',
                      src: '',
                      status: 'done',
                      x: Math.round(baseX - w / 2),
                      y: Math.round(baseY - h / 2),
                      w,
                      h,
                    };
                    // 放到数组最前：渲染在最底层，让图片盖在生成器区域之上
                    setCanvas((prev) => [next, ...prev].slice(0, 80));
                  }
                  setSelectedKeys([key]);
                  focusComposer();
                }}
              >
                <ImagePlus size={18} />
              </button>

              {/* 视频生成器 */}
              <button
                type="button"
                className="h-11 w-11 rounded-[14px] inline-flex items-center justify-center hover:bg-black/5"
                style={{ background: 'rgba(255,255,255,0.55)', color: '#1a1206' }}
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
                className="h-11 w-11 rounded-[14px] inline-flex items-center justify-center hover:bg-black/5 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ background: 'rgba(255,255,255,0.55)', color: '#1a1206' }}
                onClick={() => {
                  if (selectedKeys.length === 0) return;
                  const ok = window.confirm(`确认删除选中的 ${selectedKeys.length} 项？`);
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
      </Card>
    </div>
  );
}


