/**
 * 视觉创作 · 移动端线性生成器
 *
 * 手机上的视觉创作不是"缩小的画布"，而是一条对话式的生成流：
 *   输入 prompt → 生成中占位卡（产物形状骨架 + 计时）→ 图片卡片（放大/重生成/以图改图/下载 常驻按钮）
 *
 * 与桌面画布共享同一个 workspace：
 * - 生成前把占位元素写进 canvas payload（后端按 targetKey 回填），手机生成的图回到 PC 就在画布里；
 * - userMessageContent 走后端消息存档，桌面聊天历史可见；
 * - 时间线数据源 = workspace assets（生成图 + 参考图上传），无需解析桌面聊天标记。
 *
 * 设计规则对齐：artifact-is-experience（等待期主视觉是产物骨架）、chief-designer-usability
 * （单模型池不显示选择器）、ai-model-visibility（顶部展示当前模型池）、frontend-modal（预览走 createPortal）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Download, Expand, ImagePlus, LayoutGrid, RefreshCw, Send, Wand2, X } from 'lucide-react';
import { toast } from '@/lib/toast';
import { MapSpinner } from '@/components/ui/VideoLoader';
import {
  createWorkspaceImageGenRun,
  getImageGenRun,
  getVisualAgentImageGenModels,
  getVisualAgentWorkspaceCanvas,
  getVisualAgentWorkspaceDetail,
  saveVisualAgentWorkspaceCanvas,
  streamImageGenRunWithRetry,
  uploadVisualAgentWorkspaceAsset,
} from '@/services';
import type { ImageAsset } from '@/services/contracts/visualAgent';
import type { ModelGroupForApp } from '@/types/modelGroup';
import { buildInlineImageToken, parseInlinePrompt, tryParseWxH } from '@/lib/visualAgentPromptUtils';

// 与 AdvancedVisualAgentTab 的持久化契约一致（schemaVersion=1）
const PERSIST_SCHEMA_VERSION = 1;

type PersistedElement = {
  id: string;
  kind?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  z?: number;
  name?: string;
  status?: string;
  runId?: string;
  [k: string]: unknown;
};

type PersistedState = {
  schemaVersion: number;
  meta?: Record<string, unknown>;
  elements: PersistedElement[];
};

type RefImage = { assetId: string; sha256: string; url: string; label: string };

type GenCard = {
  key: string;
  prompt: string;
  status: 'running' | 'done' | 'error';
  url?: string;
  sha256?: string;
  assetId?: string;
  errorMessage?: string;
  refUrl?: string;
  startedAt: number;
  size: string;
};

type SsePayload = {
  type?: string;
  url?: string;
  originalUrl?: string;
  originalSha256?: string;
  errorMessage?: string;
  effectiveSize?: string;
  asset?: { id?: string; sha256?: string; url?: string; originalUrl?: string; originalSha256?: string } | null;
};

const SIZE_CHOICES: Array<{ id: string; label: string }> = [
  { id: '1024x1024', label: '方形 1:1' },
  { id: '768x1024', label: '竖版 3:4' },
  { id: '1024x768', label: '横版 4:3' },
];

const EXAMPLE_PROMPTS = ['一只戴宇航员头盔的柴犬，胶片质感', '深夜便利店门口的霓虹灯雨景插画'];

function newKey() {
  return `m_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

/** 在既有画布元素右侧找一个不重叠的落点 */
function placeNewElement(elements: PersistedElement[]): { x: number; y: number } {
  if (!elements.length) return { x: 0, y: 0 };
  let maxX = -Infinity;
  let minY = Infinity;
  for (const el of elements) {
    const ex = typeof el.x === 'number' ? el.x : 0;
    const ey = typeof el.y === 'number' ? el.y : 0;
    const ew = typeof el.w === 'number' ? el.w : 1024;
    maxX = Math.max(maxX, ex + ew);
    minY = Math.min(minY, ey);
  }
  if (!Number.isFinite(maxX)) maxX = 0;
  if (!Number.isFinite(minY)) minY = 0;
  return { x: Math.round(maxX + 96), y: Math.round(minY) };
}

function cardRatio(size: string): number {
  const parsed = tryParseWxH(size);
  if (!parsed) return 1;
  return Math.min(2, Math.max(0.5, parsed.h / parsed.w));
}

export default function MobileVisualAgentEditor(props: { workspaceId: string; onOpenCanvas: () => void }) {
  const { workspaceId, onOpenCanvas } = props;
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [assets, setAssets] = useState<ImageAsset[]>([]);
  const [cards, setCards] = useState<GenCard[]>([]);
  const [input, setInput] = useState('');
  const [size, setSize] = useState<string>('1024x1024');
  const [refImage, setRefImage] = useState<RefImage | null>(null);
  const [uploadingRef, setUploadingRef] = useState(false);
  const [viewer, setViewer] = useState<{ url: string; prompt?: string } | null>(null);
  const [pools, setPools] = useState<ModelGroupForApp[]>([]);
  const [pickedPoolId, setPickedPoolId] = useState<string>('');
  const [poolSheetOpen, setPoolSheetOpen] = useState(false);
  // 每秒 tick 一次驱动"已等待 Ns"（仅有生成中卡片时才计时）
  const [, setTick] = useState(0);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const assetsRef = useRef<ImageAsset[]>([]);
  assetsRef.current = assets;
  const abortersRef = useRef<AbortController[]>([]);
  const pendingInitRef = useRef<{ text: string; size: string | null; assetId?: string | null } | null>(null);
  const initFiredRef = useRef(false);

  const enabledPools = useMemo(
    () =>
      pools.filter(
        (g) =>
          (g.models?.length ?? 0) > 0 &&
          g.models!.some((m) => (m as { healthStatus?: string }).healthStatus === 'Healthy' || (m as { healthStatus?: string }).healthStatus === 'Degraded')
      ),
    [pools]
  );
  const pickedPool = useMemo(
    () => enabledPools.find((g) => g.id === pickedPoolId) ?? enabledPools[0] ?? null,
    [enabledPools, pickedPoolId]
  );

  const hasRunning = cards.some((c) => c.status === 'running');
  useEffect(() => {
    if (!hasRunning) return;
    const t = window.setInterval(() => setTick((v) => v + 1), 1000);
    return () => window.clearInterval(t);
  }, [hasRunning]);

  // 卸载时中止 SSE 订阅（服务器权威：后端继续生成并回填画布，不受影响）
  useEffect(() => {
    const list = abortersRef.current;
    return () => list.forEach((ac) => ac.abort());
  }, []);

  // 读取列表页快捷创建传入的初始 prompt（与桌面编辑器同一把 sessionStorage 钥匙，读后即删）
  useEffect(() => {
    if (!workspaceId) return;
    const sessionKey = `visual_agent_init_${workspaceId}`;
    try {
      const stored = sessionStorage.getItem(sessionKey);
      if (!stored) return;
      sessionStorage.removeItem(sessionKey);
      const data = JSON.parse(stored) as { messageText?: string; assetId?: string | null };
      const parsed = parseInlinePrompt(String(data.messageText ?? ''));
      if (parsed.text) pendingInitRef.current = { text: parsed.text, size: parsed.size, assetId: data.assetId };
    } catch {
      // ignore
    }
  }, [workspaceId]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      setLoading(true);
      const [detailRes, modelsRes] = await Promise.all([
        getVisualAgentWorkspaceDetail({ id: workspaceId, messageLimit: 1, assetLimit: 200 }),
        getVisualAgentImageGenModels(),
      ]);
      if (!alive) return;
      if (detailRes.success && detailRes.data) {
        setTitle(detailRes.data.workspace?.title || '未命名');
        const sorted = [...(detailRes.data.assets ?? [])].sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );
        setAssets(sorted);
      } else if (!detailRes.success) {
        toast.error(detailRes.error?.message || '加载项目失败');
      }
      if (modelsRes.success) setPools(modelsRes.data ?? []);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  const scrollToBottom = useCallback(() => {
    window.requestAnimationFrame(() => {
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  const handleGenerate = useCallback(
    async (rawPrompt: string, opts?: { ref?: RefImage | null; sizeOverride?: string }) => {
      const prompt = rawPrompt.trim();
      if (!prompt) return;
      const pool = pickedPool;
      if (!pool) {
        toast.error('暂无可用生图模型', '请联系管理员配置模型池');
        return;
      }
      const first = pool.models?.[0];
      const ref = opts?.ref === undefined ? refImage : opts.ref;
      const genSize = opts?.sizeOverride || size;
      const key = newKey();
      const wh = tryParseWxH(genSize) ?? { w: 1024, h: 1024 };

      setCards((prev) => [
        ...prev,
        { key, prompt, status: 'running', refUrl: ref?.url, startedAt: Date.now(), size: genSize },
      ]);
      setInput('');
      setRefImage(null);
      scrollToBottom();

      const failCard = (msg: string) => {
        setCards((prev) => prev.map((c) => (c.key === key ? { ...c, status: 'error', errorMessage: msg } : c)));
      };

      try {
        // 1) 把占位元素写进画布（后端按 targetKey 回填；手机生成的图在 PC 画布可见）。
        //    canvas 读不到/解析失败时跳过画布写入，绝不用空画布覆盖既有内容。
        let placement = { x: 0, y: 0 };
        try {
          const canvasRes = await getVisualAgentWorkspaceCanvas({ id: workspaceId });
          if (canvasRes.success) {
            let state: PersistedState | null = null;
            const payload = canvasRes.data?.canvas?.payloadJson ?? '';
            if (payload) {
              try {
                const parsed = JSON.parse(payload) as PersistedState;
                if (parsed && Array.isArray(parsed.elements)) state = parsed;
              } catch {
                state = null;
              }
            } else {
              state = { schemaVersion: PERSIST_SCHEMA_VERSION, meta: {}, elements: [] };
            }
            if (state) {
              placement = placeNewElement(state.elements);
              state.elements = [
                ...state.elements,
                {
                  id: key,
                  kind: 'image',
                  x: placement.x,
                  y: placement.y,
                  w: wh.w,
                  h: wh.h,
                  z: state.elements.length,
                  name: prompt.slice(0, 60),
                  status: 'running',
                  ext: {},
                },
              ];
              await saveVisualAgentWorkspaceCanvas({
                id: workspaceId,
                schemaVersion: PERSIST_SCHEMA_VERSION,
                payloadJson: JSON.stringify(state),
                idempotencyKey: `mPreGen_${key}`,
              });
            }
          }
        } catch {
          // 画布写入失败不阻塞生成：图片仍会存入 workspace 资产
        }

        // 2) 创建生图 run（与桌面同一条任务化链路）
        const imageToken = ref ? buildInlineImageToken(ref.url, ref.label) : '';
        const runRes = await createWorkspaceImageGenRun({
          id: workspaceId,
          input: {
            prompt,
            targetKey: key,
            x: placement.x,
            y: placement.y,
            w: wh.w,
            h: wh.h,
            platformId: first?.platformId,
            modelId: pool.code,
            size: genSize,
            responseFormat: 'url',
            imageRefs: ref
              ? [{ refId: 1, assetSha256: ref.sha256, url: ref.url, label: '第1张图' }]
              : undefined,
            userMessageContent: `${imageToken}(@size:${genSize}) ${prompt}`,
          },
          idempotencyKey: `imRun_${workspaceId}_${key}`,
        });
        if (!runRes.success || !runRes.data?.runId) {
          failCard(runRes.success ? '未返回 runId' : runRes.error?.message || '生成失败');
          return;
        }
        const runId = runRes.data.runId;

        // 3) 订阅进度（断流后查后端真实状态兜底，不盲判失败）
        const ac = new AbortController();
        abortersRef.current.push(ac);
        const applyDone = (url: string, asset?: SsePayload['asset']) => {
          setCards((prev) =>
            prev.map((c) =>
              c.key === key
                ? {
                    ...c,
                    status: 'done',
                    url,
                    assetId: asset?.id || c.assetId,
                    sha256: asset?.sha256 || c.sha256,
                  }
                : c
            )
          );
          scrollToBottom();
        };
        void streamImageGenRunWithRetry({
          runId,
          maxAttempts: 20,
          signal: ac.signal,
          onEvent: (evt) => {
            const data = String(evt.data ?? '').trim();
            if (!data) return;
            let o: SsePayload;
            try {
              o = JSON.parse(data) as SsePayload;
            } catch {
              return;
            }
            const t = String(o.type ?? '');
            if (t === 'imageDone') {
              const url = String(o.asset?.url || o.url || '');
              if (!url) {
                failCard('生成完成但图片数据为空，请重试');
                return;
              }
              applyDone(url, o.asset);
            } else if (t === 'imageError' || t === 'error') {
              failCard(String(o.errorMessage || '生成失败'));
            }
          },
        }).then(async () => {
          let stillRunning = false;
          setCards((prev) => {
            stillRunning = prev.some((c) => c.key === key && c.status === 'running');
            return prev;
          });
          if (!stillRunning) return;
          try {
            const res = await getImageGenRun({ runId, includeItems: true, includeImages: true });
            if (res.success && res.data?.run) {
              const run = res.data.run;
              if (run.status === 'Completed') {
                const it = res.data.items?.find((i) => i.url);
                if (it?.url) {
                  applyDone(it.url);
                  return;
                }
                failCard('生成完成但无图片数据，请重试');
                return;
              }
              if (run.status === 'Queued' || run.status === 'Running') return; // 后端仍在跑，保留占位
              const errItem = res.data.items?.find((i) => i.errorMessage);
              failCard(run.status === 'Cancelled' ? '已取消' : errItem?.errorMessage || '生成失败');
              return;
            }
          } catch {
            // 查询失败走默认文案
          }
          failCard('生成超时或连接中断，请重试');
        });
      } catch (e) {
        failCard(e instanceof Error ? e.message : '生成失败');
      }
    },
    [pickedPool, refImage, size, scrollToBottom, workspaceId]
  );

  // 列表页快捷创建的初始 prompt：模型与资产就绪后自动发送一次
  useEffect(() => {
    if (loading || initFiredRef.current) return;
    const pending = pendingInitRef.current;
    if (!pending || !pickedPool) return;
    initFiredRef.current = true;
    pendingInitRef.current = null;
    let ref: RefImage | null = null;
    if (pending.assetId) {
      const a = assetsRef.current.find((x) => x.id === pending.assetId);
      if (a) ref = { assetId: a.id, sha256: a.sha256, url: a.url, label: a.prompt || '参考图' };
    }
    void handleGenerate(pending.text, { ref, sizeOverride: pending.size || undefined });
  }, [loading, pickedPool, handleGenerate]);

  const onPickFile = useCallback(
    async (file: File | null) => {
      if (!file) return;
      setUploadingRef(true);
      try {
        const dataUri = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(new Error('读取图片失败'));
          reader.readAsDataURL(file);
        });
        const res = await uploadVisualAgentWorkspaceAsset({
          id: workspaceId,
          data: dataUri,
          prompt: file.name || '参考图',
          idempotencyKey: `mRef_${workspaceId}_${Date.now()}`,
        });
        if (!res.success) {
          toast.error('参考图上传失败', res.error?.message);
          return;
        }
        const a = res.data.asset;
        setAssets((prev) => [...prev, a]);
        setRefImage({ assetId: a.id, sha256: a.sha256, url: a.url, label: file.name || '参考图' });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : '参考图上传失败');
      } finally {
        setUploadingRef(false);
      }
    },
    [workspaceId]
  );

  const setAsReference = useCallback((a: { assetId?: string; sha256?: string; url?: string; prompt?: string }) => {
    if (!a.url || !a.sha256) {
      toast.info('该图片缺少资产信息，暂不能作为参考图');
      return;
    }
    setRefImage({ assetId: a.assetId || '', sha256: a.sha256, url: a.url, label: a.prompt || '参考图' });
    toast.success('已设为参考图', '在下方输入修改指令，例如：背景换成白色');
  }, []);

  const elapsedOf = (c: GenCard) => Math.max(0, Math.round((Date.now() - c.startedAt) / 1000));

  // 时间线 = 历史资产 + 本次会话卡片（历史资产里已包含本次已完成的图时按 sha 去重）
  const doneShas = useMemo(() => new Set(cards.filter((c) => c.sha256).map((c) => c.sha256)), [cards]);
  const timelineAssets = useMemo(
    () => assets.filter((a) => !doneShas.has(a.sha256)),
    [assets, doneShas]
  );
  const empty = !loading && timelineAssets.length === 0 && cards.length === 0;

  const actionBtnCls =
    'h-8 px-2.5 inline-flex items-center gap-1 rounded-lg text-[12px] active:opacity-70';
  const actionBtnStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.08)',
    color: 'rgba(255,255,255,0.85)',
    border: '1px solid rgba(255,255,255,0.1)',
  };

  const renderImageCard = (args: {
    key: string;
    url: string;
    prompt?: string;
    sha256?: string;
    assetId?: string;
    refUrl?: string;
  }) => (
    <div key={args.key} className="rounded-2xl overflow-hidden" style={{ background: 'var(--bg-card, rgba(255,255,255,0.04))', border: '1px solid rgba(255,255,255,0.08)' }}>
      <button
        type="button"
        className="block w-full"
        onClick={() => setViewer({ url: args.url, prompt: args.prompt })}
        aria-label="放大预览"
      >
        <img src={args.url} alt={args.prompt || '生成图片'} className="w-full h-auto block" loading="lazy" />
      </button>
      <div className="px-3 py-2.5 flex flex-col gap-2">
        {args.prompt ? (
          <div className="text-[12px] leading-snug line-clamp-2" style={{ color: 'rgba(255,255,255,0.6)' }}>
            {args.prompt}
          </div>
        ) : null}
        <div className="flex items-center gap-1.5 flex-wrap">
          <button type="button" className={actionBtnCls} style={actionBtnStyle} onClick={() => setViewer({ url: args.url, prompt: args.prompt })}>
            <Expand size={13} /> 放大
          </button>
          {args.prompt ? (
            <button type="button" className={actionBtnCls} style={actionBtnStyle} onClick={() => void handleGenerate(args.prompt!)}>
              <RefreshCw size={13} /> 重新生成
            </button>
          ) : null}
          <button
            type="button"
            className={actionBtnCls}
            style={actionBtnStyle}
            onClick={() => setAsReference({ assetId: args.assetId, sha256: args.sha256, url: args.url, prompt: args.prompt })}
          >
            <Wand2 size={13} /> 以图改图
          </button>
          <button type="button" className={actionBtnCls} style={actionBtnStyle} onClick={() => window.open(args.url, '_blank', 'noopener')}>
            <Download size={13} /> 下载
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="h-full min-h-0 flex flex-col" data-tour-id="visual-editor-root" style={{ background: '#101014' }}>
      {/* 顶部栏 */}
      <div className="shrink-0 h-12 px-2 flex items-center gap-1" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <button
          type="button"
          className="h-9 w-9 inline-flex items-center justify-center rounded-lg active:opacity-70"
          style={{ color: 'rgba(255,255,255,0.8)' }}
          onClick={() => navigate('/visual-agent')}
          aria-label="返回项目列表"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1 min-w-0 text-[14px] font-medium truncate" style={{ color: 'rgba(255,255,255,0.9)' }}>
          {title || '视觉创作'}
        </div>
        {/* 模型可见性：展示当前模型池；多池可切换，单池纯展示 */}
        {pickedPool ? (
          enabledPools.length > 1 ? (
            <button
              type="button"
              className="h-8 px-2.5 rounded-lg text-[11px] font-mono truncate max-w-[120px] active:opacity-70"
              style={{ color: 'rgba(255,255,255,0.45)', background: 'rgba(255,255,255,0.06)' }}
              onClick={() => setPoolSheetOpen(true)}
            >
              {pickedPool.name}
            </button>
          ) : (
            <span className="text-[11px] font-mono truncate max-w-[120px]" style={{ color: 'rgba(255,255,255,0.35)' }}>
              {pickedPool.name}
            </span>
          )
        ) : null}
        <button
          type="button"
          className="h-8 px-2.5 inline-flex items-center gap-1 rounded-lg text-[12px] active:opacity-70"
          style={actionBtnStyle}
          onClick={onOpenCanvas}
        >
          <LayoutGrid size={13} /> 画布
        </button>
      </div>

      {/* 时间线 */}
      <div
        ref={listRef}
        className="flex-1 px-3 py-3 flex flex-col gap-3"
        style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
      >
        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <MapSpinner size={24} />
          </div>
        ) : null}

        {empty ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="text-[15px] font-medium" style={{ color: 'rgba(255,255,255,0.85)' }}>
              说一句话，生成第一张图
            </div>
            <div className="text-[12px] leading-relaxed" style={{ color: 'rgba(255,255,255,0.45)' }}>
              生成的图片会同步到这个项目的画布，电脑上打开可继续精细排版
            </div>
            <div className="flex flex-col gap-2 w-full mt-2">
              {EXAMPLE_PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="w-full px-3 py-2.5 rounded-xl text-[13px] text-left active:opacity-70"
                  style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.7)', border: '1px solid rgba(255,255,255,0.08)' }}
                  onClick={() => setInput(p)}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {timelineAssets.map((a) =>
          renderImageCard({ key: `asset_${a.id}`, url: a.url, prompt: a.prompt || undefined, sha256: a.sha256, assetId: a.id })
        )}

        {cards.map((c) => {
          if (c.status === 'done' && c.url) {
            return renderImageCard({ key: c.key, url: c.url, prompt: c.prompt, sha256: c.sha256, assetId: c.assetId, refUrl: c.refUrl });
          }
          if (c.status === 'error') {
            return (
              <div key={c.key} className="rounded-2xl px-3 py-3 flex flex-col gap-2" style={{ background: 'rgba(180,40,40,0.12)', border: '1px solid rgba(220,80,80,0.35)' }}>
                <div className="text-[12px] leading-snug" style={{ color: 'rgba(255,255,255,0.6)' }}>{c.prompt}</div>
                <div className="text-[13px]" style={{ color: 'rgba(255,140,140,0.95)' }}>{c.errorMessage || '生成失败'}</div>
                <div>
                  <button type="button" className={actionBtnCls} style={actionBtnStyle} onClick={() => void handleGenerate(c.prompt)}>
                    <RefreshCw size={13} /> 重试
                  </button>
                </div>
              </div>
            );
          }
          // 生成中：产物形状的骨架卡（按请求比例撑开）+ 计时
          return (
            <div key={c.key} className="rounded-2xl overflow-hidden" style={{ background: 'var(--bg-card, rgba(255,255,255,0.04))', border: '1px solid rgba(255,255,255,0.08)' }}>
              <div className="relative w-full" style={{ paddingBottom: `${cardRatio(c.size) * 100}%` }}>
                <div
                  className="absolute inset-0 animate-pulse"
                  style={{ background: 'linear-gradient(135deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.12) 50%, rgba(255,255,255,0.06) 100%)' }}
                />
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                  <MapSpinner size={20} />
                  <div className="text-[12px]" style={{ color: 'rgba(255,255,255,0.55)' }}>
                    正在生成 · 已等待 {elapsedOf(c)}s
                  </div>
                </div>
              </div>
              <div className="px-3 py-2.5 text-[12px] leading-snug line-clamp-2" style={{ color: 'rgba(255,255,255,0.6)' }}>
                {c.prompt}
              </div>
            </div>
          );
        })}
      </div>

      {/* 底部输入区 */}
      <div className="shrink-0 px-3 pt-2 flex flex-col gap-2" style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 10px)' }}>
        {refImage ? (
          <div className="flex items-center gap-2 px-2 py-1.5 rounded-xl" style={{ background: 'rgba(255,255,255,0.06)' }}>
            <img src={refImage.url} alt="参考图" className="h-9 w-9 rounded-lg object-cover" />
            <div className="flex-1 min-w-0 text-[12px] truncate" style={{ color: 'rgba(255,255,255,0.65)' }}>
              参考图 · {refImage.label}
            </div>
            <button
              type="button"
              className="h-7 w-7 inline-flex items-center justify-center rounded-lg active:opacity-70"
              style={{ color: 'rgba(255,255,255,0.6)' }}
              onClick={() => setRefImage(null)}
              aria-label="移除参考图"
            >
              <X size={14} />
            </button>
          </div>
        ) : null}
        <div className="flex items-center gap-1.5 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {SIZE_CHOICES.map((s) => (
            <button
              key={s.id}
              type="button"
              className="h-7 px-2.5 rounded-full text-[11px] shrink-0 whitespace-nowrap active:opacity-70"
              style={
                size === s.id
                  ? { background: 'rgba(120,120,255,0.25)', color: 'rgba(200,200,255,0.95)', border: '1px solid rgba(140,140,255,0.5)' }
                  : { background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.55)', border: '1px solid rgba(255,255,255,0.08)' }
              }
              onClick={() => setSize(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="flex items-end gap-2">
          <button
            type="button"
            className="h-10 w-10 shrink-0 inline-flex items-center justify-center rounded-xl active:opacity-70"
            style={actionBtnStyle}
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadingRef}
            aria-label="上传参考图"
          >
            {uploadingRef ? <MapSpinner size={16} /> : <ImagePlus size={17} />}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              void onPickFile(e.target.files?.[0] ?? null);
              e.target.value = '';
            }}
          />
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={1}
            placeholder={refImage ? '描述要怎么改这张图…' : '描述你想生成的画面…'}
            className="flex-1 resize-none rounded-xl px-3 py-2.5 text-[14px] outline-none"
            style={{
              background: 'rgba(255,255,255,0.06)',
              color: 'rgba(255,255,255,0.9)',
              border: '1px solid rgba(255,255,255,0.1)',
              minHeight: 40,
              maxHeight: 96,
            }}
          />
          <button
            type="button"
            className="h-10 w-10 shrink-0 inline-flex items-center justify-center rounded-xl active:opacity-70 disabled:opacity-40"
            style={{ background: 'rgba(120,120,255,0.85)', color: '#fff' }}
            onClick={() => void handleGenerate(input)}
            disabled={!input.trim() || loading}
            aria-label="生成"
          >
            <Send size={16} />
          </button>
        </div>
      </div>

      {/* 全屏预览（frontend-modal：createPortal + inline 尺寸） */}
      {viewer
        ? createPortal(
            <div
              className="fixed inset-0 z-[120] flex flex-col"
              style={{ background: 'rgba(0,0,0,0.92)' }}
              onClick={() => setViewer(null)}
            >
              <div className="shrink-0 flex justify-end p-3">
                <button
                  type="button"
                  className="h-9 w-9 inline-flex items-center justify-center rounded-full"
                  style={{ background: 'rgba(255,255,255,0.12)', color: '#fff' }}
                  aria-label="关闭预览"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="flex-1 flex items-center justify-center px-2" style={{ minHeight: 0 }}>
                <img src={viewer.url} alt={viewer.prompt || '预览'} className="max-w-full max-h-full object-contain" onClick={(e) => e.stopPropagation()} />
              </div>
              {viewer.prompt ? (
                <div className="shrink-0 px-4 py-3 text-[12px] leading-snug" style={{ color: 'rgba(255,255,255,0.6)' }}>
                  {viewer.prompt}
                </div>
              ) : null}
            </div>,
            document.body
          )
        : null}

      {/* 模型池选择（仅多池时可达） */}
      {poolSheetOpen
        ? createPortal(
            <div className="fixed inset-0 z-[120] flex flex-col justify-end" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={() => setPoolSheetOpen(false)}>
              <div
                className="rounded-t-2xl px-3 pt-3 flex flex-col gap-1"
                style={{
                  background: '#1a1a20',
                  maxHeight: '60vh',
                  overflowY: 'auto',
                  paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)',
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="text-[13px] font-medium px-1 pb-1" style={{ color: 'rgba(255,255,255,0.85)' }}>
                  选择生图模型
                </div>
                {enabledPools.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    className="w-full text-left px-3 py-3 rounded-xl active:opacity-70"
                    style={
                      g.id === pickedPool?.id
                        ? { background: 'rgba(120,120,255,0.18)', color: 'rgba(220,220,255,0.95)' }
                        : { color: 'rgba(255,255,255,0.75)' }
                    }
                    onClick={() => {
                      setPickedPoolId(g.id);
                      setPoolSheetOpen(false);
                    }}
                  >
                    <div className="text-[14px]">{g.name}</div>
                    {g.description ? (
                      <div className="text-[11px] mt-0.5" style={{ color: 'rgba(255,255,255,0.4)' }}>
                        {g.description}
                      </div>
                    ) : null}
                  </button>
                ))}
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
