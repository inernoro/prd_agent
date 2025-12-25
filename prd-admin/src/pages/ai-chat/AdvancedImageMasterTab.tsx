import { Button } from '@/components/design/Button';
import { Card } from '@/components/design/Card';
import { Dialog } from '@/components/ui/Dialog';
import { Tooltip } from '@/components/ui/Tooltip';
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
import { Copy, Download, ImagePlus, Info, Loader2, Maximize2, MousePointer2, Trash2, Wand2, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuthStore } from '@/stores/authStore';

type CanvasImageItem = {
  key: string;
  createdAt: number;
  prompt: string;
  src: string;
  status: 'done' | 'error' | 'running';
  errorMessage?: string | null;
  refId?: number;
  checked?: boolean;
  checkedAt?: number;
  assetId?: string;
  sha256?: string;
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
  const DEFAULT_SIZE = '1024x1024';
  const DEFAULT_RESPONSE_FORMAT = 'b64_json' as const;

  const [models, setModels] = useState<Model[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const activeModel = useMemo(() => firstEnabledImageModel(models), [models]);

  const userId = useAuthStore((s) => s.user?.userId ?? '');
  const splitKey = userId ? `prdAdmin.imageMaster.splitWidth.${userId}` : '';
  const SPLIT_MIN = 240;
  const SPLIT_MAX = 420;

  const [messages, setMessages] = useState<UiMsg[]>([
    {
      id: 'assistant-hello',
      role: 'Assistant',
      content: 'Hi，我是你的 AI 设计师。描述你的需求，我会把它转成可执行的生图提示词，并把结果放到左侧画板。',
      ts: Date.now(),
    },
  ]);

  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionAtPos, setMentionAtPos] = useState<number | null>(null);
  const [asciiOpen, setAsciiOpen] = useState(false);
  const [asciiSource, setAsciiSource] = useState('');

  const [canvas, setCanvas] = useState<CanvasImageItem[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('');

  const selected = useMemo(() => canvas.find((x) => x.key === selectedKey) ?? null, [canvas, selectedKey]);

  // 画布（大图预览）缩放
  const [zoom, setZoom] = useState(1);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [selectedImageSize, setSelectedImageSize] = useState<{ w: number; h: number } | null>(null);
  const [stageSize, setStageSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [pendingFit, setPendingFit] = useState(false);

  // @imgN 占位符
  const [nextRefId, setNextRefId] = useState(1);


  // splitter：右侧宽度（px）
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [rightWidth, setRightWidth] = useState(0);
  const dragRef = useRef<{ dragging: boolean; startX: number; startRight: number } | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>('');
  const [masterSession, setMasterSession] = useState<ImageMasterSession | null>(null);
  const [booting, setBooting] = useState(false);

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

  // 启动时：按账号持久化加载/创建会话，并回放历史消息+画板资产
  useEffect(() => {
    if (!userId) return;
    if (booting) return;
    setBooting(true);
    (async () => {
      const list = await listImageMasterSessions({ limit: 10 });
      let sid = '';
      if (list.success && Array.isArray(list.data?.items) && list.data!.items.length > 0) {
        sid = list.data!.items[0].id;
      } else {
        const created = await createImageMasterSession({ title: '高级图片大师' });
        if (created.success) sid = created.data.session.id;
      }
      if (!sid) return;

      const detail = await getImageMasterSession({ id: sid, messageLimit: 200, assetLimit: 80 });
      if (!detail.success) return;
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
          }))
          .filter((x) => !!x.src)
          .slice(0, 60);
        setCanvas(items);
        if (items.length > 0) setSelectedKey((cur) => cur || items[0].key);
      }
    })().finally(() => setBooting(false));
  }, [userId, booting]);

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

  // Mac 触控板捏合缩放（Chrome/Edge 通常体现为 ctrlKey + wheel）
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;

    const onWheel = (ev: WheelEvent) => {
      // 空态不缩放
      if (!selected?.src) return;
      // pinch / ctrl+wheel
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();

      setZoom((z) => clampZoom(z * zoomFactorFromDeltaY(ev.deltaY)));
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel as EventListener);
  }, [selected?.src]);

  const pushMsg = (role: UiMsg['role'], content: string) => {
    const msg: UiMsg = { id: `${role}-${Date.now()}`, role, content, ts: Date.now() };
    setMessages((prev) => prev.concat(msg));
    if (masterSession?.id) {
      const backendRole: ImageMasterMessage['role'] = role === 'User' ? 'User' : 'Assistant';
      void addImageMasterMessage({ sessionId: masterSession.id, role: backendRole, content });
    }
  };

  const replaceMentionAtCursor = (replacement: string) => {
    const ta = inputRef.current;
    if (!ta) return;
    const value = ta.value ?? '';
    const start = mentionAtPos ?? (ta.selectionStart ?? value.length);
    const end = ta.selectionStart ?? value.length;
    const next = value.slice(0, start) + replacement + value.slice(end);
    setInput(next);
    setMentionOpen(false);
    setMentionQuery('');
    setMentionAtPos(null);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + replacement.length;
      ta.setSelectionRange(pos, pos);
    });
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

  const ensureModel = () => {
    if (modelsLoading) return { ok: false as const, reason: '模型加载中' };
    if (!activeModel) return { ok: false as const, reason: '暂无可用生图模型（请先在“模型管理”启用 isImageGen 模型）' };
    return { ok: true as const };
  };

  const runFromText = async (displayText: string, requestText: string, primaryRef: CanvasImageItem | null) => {
    const display = String(displayText ?? '').trim();
    const reqText = String(requestText ?? '').trim();
    if (!reqText) return;
    const modelCheck = ensureModel();
    if (!modelCheck.ok) {
      setError(modelCheck.reason);
      pushMsg('Assistant', modelCheck.reason);
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

    const isVolcesSeedream = /volces|doubao|seedream/i.test(String(activeModel?.modelName || ''));

    pushMsg(
      'Assistant',
      [
        `我已把需求解析成 ${items.length || 1} 条生图提示词。`,
        items.length ? '候选提示词（前 3 条）：\n' + items.slice(0, 3).map((x, i) => `${i + 1}. ${x.prompt}`).join('\n') : '',
        (primaryRef || selected) && isVolcesSeedream
          ? '你选择了首帧图。当前使用的 seedream/Volces 生图通常不支持标准图生图首帧，我会自动改为“风格提取→拼进提示词”的方式来尽量保持一致。'
          : (primaryRef || selected)
            ? '你已选中一张图片作为“首帧图”。本次将作为图生图首帧传给生图接口（若上游平台不支持，会返回参数错误）。'
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
      };
      return [placeholder, ...prev].slice(0, 60);
    });

    try {
      const initSrc = (primaryRef?.src || selected?.src) ?? '';
      const gres = await generateImageGen({
        modelId: activeModel!.id,
        prompt: firstPrompt,
        n: 1,
        size: DEFAULT_SIZE,
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
      setSelectedKey((cur) => cur || key);

      // 上传并持久化资产：把外部签名 URL / base64 转为自托管 URL（避免过期）
      if (masterSession?.id) {
        const width = DEFAULT_SIZE.startsWith('1024') ? 1024 : undefined;
        const height = DEFAULT_SIZE.endsWith('1024') ? 1024 : undefined;
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

  const ensureRefIdForKey = (key: string) => {
    const it = canvas.find((x) => x.key === key) ?? null;
    if (!it) return null;
    if (it.refId != null) return it.refId;
    const id = nextRefId;
    setNextRefId((n) => n + 1);
    setCanvas((prev) => prev.map((x) => (x.key === key ? { ...x, refId: id } : x)));
    return id;
  };

  const ensureCheckedWithRefId = (key: string, v: boolean) => {
    const now = Date.now();
    const id = v ? ensureRefIdForKey(key) : null;
    setCanvas((prev) =>
      prev.map((x) =>
        x.key === key
          ? {
              ...x,
              checked: v,
              checkedAt: v ? now : undefined,
              refId: v ? (id ?? x.refId) : x.refId,
            }
          : x
      )
    );
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
      if (it) items.push(it);
    }
    return items;
  };

  const buildRequestTextWithRefs = (rawText: string) => {
    const refsByText = extractReferencedImagesInOrder(rawText);
    const checked = canvas
      .filter((x) => x.checked)
      .slice()
      .sort((a, b) => Number(a.checkedAt ?? 0) - Number(b.checkedAt ?? 0));

    const merged: CanvasImageItem[] = [];
    const seen = new Set<string>();
    for (const it of refsByText) {
      if (seen.has(it.key)) continue;
      seen.add(it.key);
      merged.push(it);
    }
    for (const it of checked) {
      if (seen.has(it.key)) continue;
      seen.add(it.key);
      merged.push(it);
    }

    if (merged.length === 0) return { requestText: rawText, primaryRef: null as CanvasImageItem | null };
    const lines = merged.map((it) => `- @img${it.refId ?? '?'}: ${it.prompt || '（无描述）'}`);
    const requestText = `${rawText}\n\n【引用图片（按顺序）】\n${lines.join('\n')}`;
    return { requestText, primaryRef: merged[0] ?? null };
  };

  const onSend = async () => {
    const raw = input.trim();
    if (!raw) return;
    const { requestText, primaryRef } = buildRequestTextWithRefs(raw);
    setInput('');
    await runFromText(raw, requestText, primaryRef);
  };

  const onUploadImages = async (files: File[]) => {
    const list = (files ?? []).filter((f) => f && f.type && f.type.startsWith('image/'));
    if (list.length === 0) return;

    const added: CanvasImageItem[] = [];
    const now = Date.now();

    await Promise.all(
      list.slice(0, 20).map(
        (file, idx) =>
          new Promise<void>((resolve) => {
            const reader = new FileReader();
            const key = `upload_${now}_${idx}`;
            reader.onload = () => {
              const src = String(reader.result || '');
              if (src) {
                added.push({ key, createdAt: Date.now(), prompt: file.name || 'uploaded', src, status: 'done' });
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
    setCanvas((prev) => [...added.reverse(), ...prev].slice(0, 60));
    setSelectedKey((cur) => cur || added[0].key);
    pushMsg('Assistant', `已把 ${added.length} 张图片加入画板。你可以选中其中一张作为首帧，或用 @imgN 引用多张图。`);
    setPendingFit(true);

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
    const sz = selectedImageSize;
    if (!el || !sz || sz.w <= 0 || sz.h <= 0) {
      setZoom(1);
      return;
    }
    // 画布内部有 padding + 顶部/底部浮层的可视区域扣减，避免 fit 后仍被遮挡
    const w = el.clientWidth - 80;
    const h = el.clientHeight - 220;
    if (w <= 0 || h <= 0) {
      setZoom(1);
      return;
    }
    const scale = Math.min(w / sz.w, h / sz.h) * 0.98;
    setZoom(clampZoom(scale));
  };

  // 在图片加载/切换后做一次“适配 + 居中”，避免一开始出现在两边（无法左右滚动的错觉）
  useEffect(() => {
    if (!pendingFit) return;
    if (!selected?.src) return;
    if (!selectedImageSize) return;
    const el = stageRef.current;
    if (!el) return;

    // 先适配，再将滚动定位到中心（避免依赖 fitToStage 导致 lint warning）
    const w = el.clientWidth - 80;
    const h = el.clientHeight - 220;
    if (w > 0 && h > 0) {
      const scale = Math.min(w / selectedImageSize.w, h / selectedImageSize.h) * 0.98;
      setZoom(clampZoom(scale));
    }
    requestAnimationFrame(() => {
      const cx = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
      const cy = Math.max(0, (el.scrollHeight - el.clientHeight) / 2);
      el.scrollLeft = cx;
      el.scrollTop = cy;
      setPendingFit(false);
    });
  }, [pendingFit, selected?.src, selectedImageSize]);

  return (
    <div ref={containerRef} className="h-full min-h-0">
      {/* 单一框架：左右无缝拼接 */}
      <Card className="h-full min-h-0 overflow-hidden p-0!">
        <div className="h-full min-h-0 flex">
          {/* 左侧：画板 */}
          <div className="flex-1 min-w-0 min-h-0">
        <div className="h-full min-h-0 relative">
          {/* 主画布（可滚动） */}
          <div
            ref={stageRef}
            className="absolute inset-0 overflow-auto"
            style={{
              background: 'rgba(0,0,0,0.10)',
            }}
            tabIndex={0}
            onMouseDown={() => stageRef.current?.focus()}
              onClick={(e) => {
                // 点击空白处可取消选中（逆选中）
                if (e.target === e.currentTarget) {
                  setSelectedKey('');
                  setSelectedImageSize(null);
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
              const isMod = e.metaKey || e.ctrlKey;
              if (!isMod) return;
              if (e.key === '+' || e.key === '=') {
                e.preventDefault();
                  setZoom((z) => clampZoom(z * 1.07));
              } else if (e.key === '-') {
                e.preventDefault();
                  setZoom((z) => clampZoom(z / 1.07));
              } else if (e.key === '0') {
                e.preventDefault();
                setZoom(1);
              }
            }}
          >
            <div className={selected?.src ? 'min-h-full w-full px-10 pt-16 pb-[152px]' : 'min-h-full w-full px-10 py-10'}>
              {!selected?.src ? (
                <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  画布暂无图片。右侧输入需求点击“生成”，或先上传一张图片作为首帧。
                </div>
              ) : (
                <div
                  className="grid place-items-center"
                  style={{
                    minWidth: Math.max(stageSize.w || 0, selectedImageSize ? Math.round(selectedImageSize.w * zoom) : 0),
                    minHeight: Math.max(stageSize.h || 0, selectedImageSize ? Math.round(selectedImageSize.h * zoom) : 0),
                  }}
                >
                  <div
                    style={{
                      width: selectedImageSize ? Math.max(1, Math.round(selectedImageSize.w * zoom)) : 'auto',
                      height: selectedImageSize ? Math.max(1, Math.round(selectedImageSize.h * zoom)) : 'auto',
                    }}
                  >
                    <img
                      src={selected.src}
                      alt={selected.prompt}
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'contain',
                        display: 'block',
                        boxShadow: '0 24px 90px rgba(0,0,0,0.45)',
                      }}
                      onLoad={(e) => {
                        const img = e.currentTarget;
                        const w = img.naturalWidth || 0;
                        const h = img.naturalHeight || 0;
                        if (w > 0 && h > 0) {
                          setSelectedImageSize({ w, h });
                          setPendingFit(true);
                        }
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 顶部居中：缩放浮层 */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20">
            <div
              className="h-11 rounded-[999px] px-2 inline-flex items-center gap-1"
              style={{
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
                className="h-9 w-9 rounded-[999px] inline-flex items-center justify-center hover:bg-white/5"
                onClick={() => setZoom((z) => clampZoom(z / 1.07))}
                title="缩小"
                aria-label="缩小"
                disabled={!selected?.src}
              >
                <ZoomOut size={18} />
              </button>
              <div className="px-2 text-[12px] font-semibold tabular-nums" title="缩放比例">
                {Math.round(zoom * 100)}%
              </div>
              <button
                type="button"
                className="h-9 w-9 rounded-[999px] inline-flex items-center justify-center hover:bg-white/5"
                onClick={() => setZoom((z) => clampZoom(z * 1.07))}
                title="放大"
                aria-label="放大"
                disabled={!selected?.src}
              >
                <ZoomIn size={18} />
              </button>
              <div className="mx-1 h-6 w-px bg-white/10" />
              <button
                type="button"
                className="h-9 px-3 rounded-[999px] text-[12px] font-semibold hover:bg-white/5"
                onClick={fitToStage}
                disabled={!selected?.src}
                title="适配画布"
              >
                适配
              </button>
              <button
                type="button"
                className="h-9 px-3 rounded-[999px] text-[12px] font-semibold hover:bg-white/5"
                onClick={() => setZoom(1)}
                disabled={!selected?.src}
                title="回到 100%"
              >
                100%
              </button>
            </div>
          </div>

          {/* 左侧悬浮工具条 */}
          <div className="absolute left-4 top-1/2 -translate-y-1/2 z-20">
            <div
              className="rounded-[16px] p-[6px] flex flex-col gap-2"
              style={{
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(0,0,0,0.22)',
                backdropFilter: 'blur(10px)',
                WebkitBackdropFilter: 'blur(10px)',
                boxShadow: '0 18px 60px rgba(0,0,0,0.50)',
              }}
            >
              <button
                type="button"
                className="h-10 w-10 rounded-[12px] inline-flex items-center justify-center hover:bg-white/5"
                style={{ color: 'var(--text-secondary)' }}
                onClick={() => fileRef.current?.click()}
                title="上传图片到画板"
                aria-label="上传图片到画板"
              >
                <ImagePlus size={18} />
              </button>
              <button
                type="button"
                className="h-10 w-10 rounded-[12px] inline-flex items-center justify-center hover:bg-white/5"
                style={{ color: 'var(--text-secondary)' }}
                onClick={() => {
                  const ok = window.confirm('确认清空画板？');
                  if (!ok) return;
                  setCanvas([]);
                  setSelectedKey('');
                  setZoom(1);
                  setSelectedImageSize(null);
                }}
                title="清空画板"
                aria-label="清空画板"
                disabled={canvas.length === 0}
              >
                <Trash2 size={18} />
              </button>
              {/* 预留：选择/拖拽工具（先占位，后续可扩展） */}
              <button
                type="button"
                className="h-10 w-10 rounded-[12px] inline-flex items-center justify-center"
                style={{ color: 'rgba(255,255,255,0.28)' }}
                title="选择/拖拽（预留）"
                aria-label="选择/拖拽（预留）"
                disabled
              >
                <MousePointer2 size={18} />
              </button>
            </div>
          </div>

          {/* 底部缩略图条（overlay） */}
          <div className="absolute left-4 right-4 bottom-4 z-20">
            <div
              className="rounded-[18px] px-3 py-2 overflow-x-auto"
              style={{
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(0,0,0,0.22)',
                backdropFilter: 'blur(10px)',
                WebkitBackdropFilter: 'blur(10px)',
                boxShadow: '0 18px 60px rgba(0,0,0,0.50)',
              }}
            >
              {canvas.length === 0 ? (
                <div className="h-[92px] flex items-center justify-center text-xs" style={{ color: 'var(--text-muted)' }}>
                  暂无图片
                </div>
              ) : (
                <div className="flex gap-2">
                  {canvas.map((it) => {
                    const active = it.key === selectedKey;
                    const canOpen = it.status === 'done' && !!it.src;
                    return (
                      <button
                        key={it.key}
                        type="button"
                        className="shrink-0 w-[140px] h-[92px] rounded-[14px] overflow-hidden relative"
                        style={{
                          border: active ? '1px solid rgba(250,204,21,0.55)' : '1px solid rgba(255,255,255,0.10)',
                          background: 'rgba(0,0,0,0.18)',
                        }}
                        onClick={(e) => {
                          // Ctrl/Cmd + 点击：快捷插入 @imgN（不改变选中，不影响缩放）
                          if (e.metaKey || e.ctrlKey) {
                            const id = ensureRefIdForKey(it.key);
                            if (id) insertAtCursor(`@img${id} `);
                            // 让画布保持可交互（避免“插入后缩放失效”的错觉）
                            requestAnimationFrame(() => stageRef.current?.focus());
                            return;
                          }
                          // 普通点击：切换选中；再次点击取消选中
                          if (active) {
                            setSelectedKey('');
                            setSelectedImageSize(null);
                            return;
                          }
                          setSelectedKey(it.key);
                          setSelectedImageSize(null);
                          setPendingFit(true);
                        }}
                        title={it.prompt}
                      >
                        {/* 多选 checkbox：不触发选中切换 */}
                        <button
                          type="button"
                          className="absolute left-2 top-2 h-6 w-6 rounded-[8px] inline-flex items-center justify-center"
                          style={{
                            border: it.checked ? '1px solid rgba(250,204,21,0.65)' : '1px solid rgba(255,255,255,0.14)',
                            background: it.checked ? 'rgba(250,204,21,0.18)' : 'rgba(0,0,0,0.22)',
                            color: it.checked ? 'rgba(250,204,21,0.95)' : 'rgba(255,255,255,0.65)',
                            backdropFilter: 'blur(8px)',
                            WebkitBackdropFilter: 'blur(8px)',
                          }}
                          aria-label={it.checked ? '取消选择引用' : '选择引用'}
                          title={it.checked ? '取消选择引用' : '选择引用'}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            const next = !it.checked;
                            ensureCheckedWithRefId(it.key, next);
                          }}
                        >
                          {it.checked ? (
                            <span className="text-[12px] font-extrabold">✓</span>
                          ) : (
                            <span className="text-[10px] font-semibold">+</span>
                          )}
                        </button>
                        {it.status === 'running' ? (
                          <div className="w-full h-full flex items-center justify-center">
                            <Loader2 size={18} className="animate-spin" style={{ color: 'var(--text-secondary)' }} />
                          </div>
                        ) : it.status === 'error' ? (
                          <div className="w-full h-full flex items-center justify-center px-2 text-center text-[11px]" style={{ color: 'rgba(239,68,68,0.95)' }}>
                            {it.errorMessage || '失败'}
                          </div>
                        ) : (
                          <img src={it.src} alt={it.prompt} className="w-full h-full block" style={{ objectFit: 'contain' }} />
                        )}

                        {canOpen ? (
                          <button
                            type="button"
                            className="absolute left-2 bottom-2 h-7 w-7 rounded-[10px] inline-flex items-center justify-center"
                            style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.20)', color: 'var(--text-secondary)' }}
                            title="放大预览"
                            aria-label="放大预览"
                            onClick={(e) => {
                              e.stopPropagation();
                              setPreview({ open: true, src: it.src, prompt: it.prompt });
                            }}
                          >
                            <Maximize2 size={14} />
                          </button>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

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
              <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
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
                  <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
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

            <div className="mt-3 rounded-[18px] p-2.5" style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.03)' }}>
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => {
                  const v = e.target.value;
                  setInput(v);
                  refreshMention(v, e.target.selectionStart ?? v.length);
                }}
                onKeyDown={(e) => {
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
                className="w-full min-h-[86px] resize-none rounded-[14px] px-3 py-2.5 text-sm outline-none"
                style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.10)', color: 'var(--text-primary)' }}
                disabled={busy}
              />

              {mentionOpen ? (
                <div
                  className="mt-2 rounded-[14px] overflow-hidden"
                  style={{ border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.32)' }}
                >
                  <div className="px-3 py-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    @ 提示（输入 @vision 或 @ascii）
                  </div>
                  <div className="max-h-[220px] overflow-auto">
                    {(() => {
                      const q = mentionQuery || '';
                      const showVision = q === '' || 'vision'.startsWith(q) || q.startsWith('v');
                      const showAscii = q === '' || 'ascii'.startsWith(q) || q.startsWith('a');
                      const visionModels = (models ?? []).filter((m) => m.enabled && m.isVision);
                      return (
                        <div className="p-2 space-y-2">
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

              <div className="mt-2 flex items-center justify-between gap-2">
                <div className="text-[12px] truncate" style={{ color: 'var(--text-muted)' }}>
                  {selected ? `已选中首帧：${selected.prompt}` : '未选择首帧'}
                </div>
                <div className="flex items-center gap-2">
                  {/* “插入引用”改为快捷操作：Ctrl/Cmd+点击缩略图 或 左上角多选；此处不再占用主按钮位 */}
                  <Tooltip
                    content={
                      <div className="leading-relaxed">
                        <div className="font-semibold">默认生图模型</div>
                        <div className="mt-1">
                          {activeModel ? (
                            <span>
                              {activeModel.name || activeModel.modelName}
                              {activeModel.priority != null ? `（priority=${activeModel.priority}）` : ''}
                            </span>
                          ) : modelsLoading ? (
                            '加载中...'
                          ) : (
                            '暂无可用 isImageGen 模型'
                          )}
                        </div>
                      </div>
                    }
                    side="top"
                    align="end"
                  >
                    <button
                      type="button"
                      className="h-10 w-10 rounded-[12px] inline-flex items-center justify-center hover:bg-white/5"
                      style={{ border: '1px solid rgba(255,255,255,0.10)', color: 'var(--text-secondary)' }}
                      aria-label="查看默认模型"
                      title="查看默认模型"
                    >
                      <Info size={18} />
                    </button>
                  </Tooltip>
                  <Button variant="primary" onClick={() => void onSend()} disabled={busy || !input.trim()}>
                    <Wand2 size={16} />
                    {busy ? '生成中...' : '生成'}
                  </Button>
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
              className="w-full min-h-[96px] resize-none rounded-[14px] px-3 py-2.5 text-sm outline-none"
              style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.10)', color: 'var(--text-primary)' }}
              placeholder="输入要生成字符画的内容（建议英文/数字；中文也可尝试但可能宽度不一致）"
            />
            <div
              className="flex-1 min-h-0 overflow-auto rounded-[14px] p-3"
              style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.16)' }}
            >
              <pre
                className="text-[12px] leading-[1.25] whitespace-pre"
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


