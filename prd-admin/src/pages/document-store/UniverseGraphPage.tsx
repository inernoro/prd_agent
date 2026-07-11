/**
 * 知识库宇宙图（Graph View）。
 *
 * 数据：GET /api/mentions/stores/:storeId/graph
 * 渲染：canvas 力导向 + Obsidian 风格设置面板（Filters / Groups / Display / Forces）。
 *
 * 布局：实体顶栏（返回/库名/统计/搜索/生成双链/标题模式/库切换/星系）+ 画布容器（flex-1）。
 * 视口：目标值 + 帧率无关指数缓动（滚轮缩放/聚焦居中丝滑,拖拽 1:1 跟手）。
 * 生成双链：SSE progress 携带 newLinks 明细,增量加边 + 沿线段 0→1 的亮色生长动画。
 *
 * 路由：/document-store/:storeId/universe（来自 navRegistry 的 store-scoped 入口）
 * 也支持顶层 /document-store/universe（用户自选库）。
 *
 * 详见 doc/design.knowledge-base.mention-network.md §宇宙图。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Settings as SettingsIcon, ArrowLeft, Loader2, Orbit, Link2, Search, ToggleLeft, ToggleRight, Maximize2 } from 'lucide-react';
import { getStoreGraph, type GraphNode, type GraphEdge } from '@/services/real/mentions';
import { listDocumentStoresReal, startAutoLink, getAgentRun, getDocumentContent } from '@/services/real/documentStore';
import { deriveContentTitle } from '@/lib/contentTitle';
import { useSseStream } from '@/lib/useSseStream';
import { api } from '@/services/api';
import type { DocumentStore } from '@/services/contracts/documentStore';
import { ReaderPanel } from './ReaderPanel';

// ── 类别上色（简化版：按 category 字段 hash 取色；空 category 走默认） ──
const PALETTE = [
  '#7c5cff', '#5b9eff', '#ff9c5b', '#5bcc8a',
  '#ff5b7a', '#5bcfd8', '#ffd84d', '#c47cff',
];
function colorForCategory(cat?: string | null): string {
  if (!cat) return PALETTE[0];
  let hash = 0;
  for (let i = 0; i < cat.length; i++) hash = (hash * 31 + cat.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}
interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number;
  fy: number;
  baseR: number;
  dragged?: boolean;
}

interface GraphState {
  textFade: number;
  nodeSize: number;
  linkWidth: number;
  centerForce: number;
  repelForce: number;
  linkForce: number;
  linkLength: number;
  showOrphans: boolean;
  searchQuery: string;
  enabledCats: Set<string>;
}

/** 新边生长动画时长（沿线段 0→1）与亮色渐隐回常规色的时长（ms） */
const EDGE_GROW_MS = 900;
const EDGE_GLOW_MS = 2600;

/** 顶栏按钮通用样式（对齐知识星球顶栏 token） */
const topBtnStyle: React.CSSProperties = {
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  background: 'rgba(45,45,55,0.85)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6,
  padding: '5px 9px',
  color: '#cfcfd6',
  cursor: 'pointer',
  fontSize: 12,
};

export interface UniverseGraphPageProps {
  storeIdOverride?: string;
  storeNameOverride?: string;
  loadGraph?: (storeId: string) => ReturnType<typeof getStoreGraph>;
  /** 阅读面板拉正文的函数（分享页注入免登录端点;默认走登录态 getDocumentContent） */
  loadContent?: (entryId: string) => ReturnType<typeof getDocumentContent>;
  onBack?: () => void;
  onOpenGalaxy?: () => void;
}

export function UniverseGraphPage({ storeIdOverride, storeNameOverride, loadGraph, loadContent, onBack, onOpenGalaxy }: UniverseGraphPageProps = {}) {
  const { storeId: storeIdParam } = useParams();
  const navigate = useNavigate();
  const [storeId, setStoreId] = useState<string | undefined>(storeIdOverride ?? storeIdParam);
  const [stores, setStores] = useState<DocumentStore[]>([]);
  const [storeName, setStoreName] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [zoomBadge, setZoomBadge] = useState<number>(100);
  // 标签显示模式：正文标题（frontmatter title 派生,默认）↔ 结构名（entry.Title）
  const [labelMode, setLabelMode] = useState<'structural' | 'content'>('content');
  // 阅读面板：单击节点打开正文预览
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);
  const [readerWidth, setReaderWidth] = useState<number>(() => {
    // 与知识星球共用同一宽度偏好（纯 UI 偏好,允许 localStorage,见 no-localstorage 规则例外）
    const saved = Number(localStorage.getItem('galaxy-reader-width'));
    return saved >= 360 && saved <= 4000 ? saved : 560;
  });
  // 一键生成双链任务状态（Run/Worker + SSE 进度）
  const [autoLinkRunId, setAutoLinkRunId] = useState<string | null>(null);
  const [autoLink, setAutoLink] = useState<{
    status: 'idle' | 'running' | 'done' | 'failed';
    processed: number;
    total: number;
    changed: number;
    linksAdded: number;
    message?: string;
  }>({ status: 'idle', processed: 0, total: 0, changed: 0, linksAdded: 0 });
  // 自增触发图数据重拉（补链完成后全量校准;增量 diff 保坐标,不会炸布局）
  const [reloadToken, setReloadToken] = useState(0);

  // 力导向参数 + 显示 / 过滤选项（可调）
  const stateRef = useRef<GraphState>({
    textFade: 0.5,
    nodeSize: 1,
    linkWidth: 1,
    centerForce: 0.5,
    repelForce: 0.5,
    linkForce: 0.5,
    linkLength: 130,
    showOrphans: true,
    searchQuery: '',
    enabledCats: new Set<string>(),
  });

  // ── ref 镜像：渲染循环只挂一次（deps=[]）,每帧从 ref 读最新值,state 仅驱动 React UI ──
  const edgesRef = useRef<GraphEdge[]>([]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);
  const hoverNodeIdRef = useRef<string | null>(null);
  useEffect(() => { hoverNodeIdRef.current = hoverNodeId; }, [hoverNodeId]);
  const focusNodeIdRef = useRef<string | null>(null);
  useEffect(() => { focusNodeIdRef.current = focusNodeId; }, [focusNodeId]);
  const labelModeRef = useRef(labelMode);
  useEffect(() => { labelModeRef.current = labelMode; }, [labelMode]);
  const readerWidthRef = useRef(readerWidth);
  useEffect(() => { readerWidthRef.current = readerWidth; }, [readerWidth]);
  const openEntryIdRef = useRef<string | null>(null);
  useEffect(() => { openEntryIdRef.current = openEntryId; }, [openEntryId]);

  // 正文标题派生（frontmatter title 剥文件名前缀;数据源 = 后端已投影的 node.summary,零额外请求）
  const displayTitles = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of nodes) {
      const t = deriveContentTitle(n.summary, n.title);
      if (t) m.set(n.id, t);
    }
    return m;
  }, [nodes]);
  const displayTitlesRef = useRef(displayTitles);
  useEffect(() => { displayTitlesRef.current = displayTitles; }, [displayTitles]);
  const displayTitleOf = (n: { id: string; title: string }) =>
    labelModeRef.current === 'content' ? (displayTitlesRef.current.get(n.id) ?? n.title) : n.title;

  // 进入页面时如未指定 storeId，先取当前用户的库列表
  useEffect(() => {
    if (storeIdOverride) {
      setStoreId(storeIdOverride);
      if (storeNameOverride) setStoreName(storeNameOverride);
      return;
    }
    let cancelled = false;
    listDocumentStoresReal(1, 50).then((res) => {
      if (cancelled || !res.success) return;
      setStores(res.data.items);
      if (!storeId && res.data.items.length > 0) {
        setStoreId(res.data.items[0].id);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [storeId, storeIdOverride, storeNameOverride]);

  // 拉图数据
  useEffect(() => {
    if (!storeId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const loadGraphFn = loadGraph ?? getStoreGraph;
    loadGraphFn(storeId)
      .then((res) => {
        if (cancelled) return;
        if (!res.success) {
          setError(res.error?.message || '加载宇宙图失败');
          return;
        }
        setNodes(res.data.nodes);
        setEdges(res.data.edges);
        setStoreName(storeNameOverride || res.data.storeName);
        // 初始化启用全部类别
        const cats = new Set<string>();
        res.data.nodes.forEach((n) => cats.add(n.category ?? '__default__'));
        stateRef.current.enabledCats = cats;
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [storeId, loadGraph, storeNameOverride, reloadToken]);

  // 切库：断开旧 run 的 SSE、清进度 chip 与生长台账、关阅读面板（run 在服务端照常跑完,server-authority）
  useEffect(() => {
    const bornMap = edgeBornRef.current;
    return () => {
      setAutoLinkRunId(null);
      setAutoLink({ status: 'idle', processed: 0, total: 0, changed: 0, linksAdded: 0 });
      bornMap.clear();
      setOpenEntryId(null);
      setFocusNodeId(null);
    };
  }, [storeId]);

  // ── 一键生成双链：启动任务 + SSE 进度（含 newLinks 增量长边）+ 完成后刷新图 ──
  const autoLinkStreamUrl = useMemo(
    () => (autoLinkRunId ? `${api.documentStore.stores.agentRunStream(autoLinkRunId)}?afterSeq=0` : ''),
    [autoLinkRunId],
  );

  const finishAutoLink = (generatedText?: string | null) => {
    let summary = { scanned: 0, changed: 0, linksAdded: 0 };
    try {
      if (generatedText) summary = { ...summary, ...(JSON.parse(generatedText) as Partial<typeof summary>) };
    } catch { /* 汇总解析失败时保留默认值 */ }
    setAutoLink({
      status: 'done',
      processed: summary.scanned,
      total: summary.scanned,
      changed: summary.changed,
      linksAdded: summary.linksAdded,
    });
    setAutoLinkRunId(null);
    setReloadToken((t) => t + 1);
  };

  /** progress 事件带来的本篇新增链接 → 增量加边 + 记 bornAt 供生长动画（不重排既有布局） */
  const appendNewEdges = (links: Array<{ from: string; to: string; anchorText: string }>) => {
    if (!links.length) return;
    const nodeIds = new Set(simNodesRef.current.map((n) => n.id));
    setEdges((prev) => {
      const seen = new Set(prev.map((e) => `${e.from}|${e.to}`));
      const add = links
        .filter((l) => nodeIds.has(l.from) && nodeIds.has(l.to)) // 防切库串台/脏数据
        .filter((l) => !seen.has(`${l.from}|${l.to}`))
        .map((l) => ({
          id: `auto:${l.from}:${l.to}`,
          from: l.from,
          to: l.to,
          anchorText: l.anchorText,
          isAutoDetected: false,
        }));
      if (!add.length) return prev;
      const now = performance.now();
      for (const e of add) edgeBornRef.current.set(`${e.from}|${e.to}`, now);
      return [...prev, ...add];
    });
  };

  const { start: startAutoLinkStream, abort: abortAutoLinkStream } = useSseStream({
    url: autoLinkStreamUrl,
    onEvent: {
      progress: (data) => {
        const d = data as {
          processed?: number; total?: number; changed?: number; linksAdded?: number;
          newLinks?: Array<{ from: string; to: string; anchorText: string }> | null;
        };
        setAutoLink((s) => ({
          ...s,
          status: 'running',
          processed: d.processed ?? s.processed,
          total: d.total ?? s.total,
          changed: d.changed ?? s.changed,
          linksAdded: d.linksAdded ?? s.linksAdded,
        }));
        appendNewEdges(d.newLinks ?? []);
      },
      done: (data) => {
        const d = data as { generatedText?: string };
        finishAutoLink(d.generatedText);
      },
      error: (data) => {
        const d = data as { message?: string };
        setAutoLink((s) => ({ ...s, status: 'failed', message: d.message ?? '任务失败' }));
        setAutoLinkRunId(null);
      },
    },
    onError: (msg) => {
      setAutoLink((s) => ({ ...s, status: 'failed', message: msg }));
      setAutoLinkRunId(null);
    },
  });

  // runId 就绪后订阅 SSE，并兜底拉状态：
  // 1) 启动即拉一次（任务可能已跑完）；
  // 2) 流自然关闭后再拉一次 —— Worker 先落库终态再发 done 事件且事件写入失败会被吞，
  //    终态事件漏发时流会正常关闭而 done 回调不触发，不兜底会让按钮永远卡「生成中」（Codex P2）。
  useEffect(() => {
    if (!autoLinkRunId) return;
    let cancelled = false;
    const finalizeFromServer = async () => {
      const res = await getAgentRun(autoLinkRunId);
      if (cancelled || !res.success) return;
      if (res.data.status === 'done') finishAutoLink(res.data.generatedText);
      else if (res.data.status === 'failed') {
        setAutoLink((s) => ({ ...s, status: 'failed', message: res.data.errorMessage ?? '任务失败' }));
        setAutoLinkRunId(null);
      }
    };
    void startAutoLinkStream().finally(() => {
      if (!cancelled) void finalizeFromServer();
    });
    void finalizeFromServer();
    return () => {
      cancelled = true;
      abortAutoLinkStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLinkRunId]);

  // 完成/失败提示 chip 数秒后自动淡出回 idle
  useEffect(() => {
    if (autoLink.status !== 'done' && autoLink.status !== 'failed') return;
    const timer = window.setTimeout(() => {
      setAutoLink((s) => (s.status === 'done' || s.status === 'failed' ? { ...s, status: 'idle' } : s));
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [autoLink.status]);

  const handleAutoLink = async () => {
    if (!storeId || autoLink.status === 'running') return;
    setAutoLink({ status: 'running', processed: 0, total: 0, changed: 0, linksAdded: 0 });
    const res = await startAutoLink(storeId);
    if (!res.success) {
      setAutoLink((s) => ({ ...s, status: 'failed', message: res.error?.message ?? '启动任务失败' }));
      return;
    }
    setAutoLinkRunId(res.data.runId);
  };

  // ── canvas 引用 + 力导向模拟（保持在 ref 中以避免 React state 频繁渲染） ──
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simNodesRef = useRef<SimNode[]>([]);
  const idMapRef = useRef<Map<string, SimNode>>(new Map());
  const adjacencyRef = useRef<Map<string, Set<string>>>(new Map());
  // 视口：current（画面）+ target（交互写入）,渲染循环每帧指数缓动逼近 → 丝滑
  const viewRef = useRef({ tx: 0, ty: 0, scale: 1, targetTx: 0, targetTy: 0, targetScale: 1 });
  const sizeRef = useRef({ W: 0, H: 0 });
  const rafRef = useRef<number>();
  const lastFrameRef = useRef(performance.now());
  const zoomBadgeRef = useRef(100);
  // 新边生长台账："from|to" → bornAt(ms)。生长+渐隐结束后移除,走常规绘制
  const edgeBornRef = useRef<Map<string, number>>(new Map());

  // 初始化/增量更新模拟节点：按 id diff,已有节点保留坐标与速度（生成双链增量加边不炸布局）;
  // 仅首建（或切库全 miss）时随机撒点 + 250 步预热
  useEffect(() => {
    const W = sizeRef.current.W || window.innerWidth;
    const H = sizeRef.current.H || window.innerHeight;
    const inDeg = new Map<string, number>();
    const outDeg = new Map<string, number>();
    edges.forEach((e) => {
      inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
      outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
    });
    const total = (id: string) => (inDeg.get(id) ?? 0) + (outDeg.get(id) ?? 0);
    const adj = new Map<string, Set<string>>();
    nodes.forEach((n) => adj.set(n.id, new Set()));
    edges.forEach((e) => {
      adj.get(e.from)?.add(e.to);
      adj.get(e.to)?.add(e.from);
    });
    adjacencyRef.current = adj;

    const prev = new Map(simNodesRef.current.map((n) => [n.id, n]));
    const firstBuild = prev.size === 0 || nodes.every((n) => !prev.has(n.id));
    simNodesRef.current = nodes.map((n) => {
      const old = firstBuild ? undefined : prev.get(n.id);
      const baseR = 3 + Math.sqrt(total(n.id)) * 1.4;
      if (old) return { ...old, ...n, baseR, dragged: false };
      return {
        ...n,
        x: W / 2 + (Math.random() - 0.5) * 500,
        y: H / 2 + (Math.random() - 0.5) * 500,
        vx: 0,
        vy: 0,
        fx: 0,
        fy: 0,
        baseR,
      };
    });
    idMapRef.current = new Map(simNodesRef.current.map((n) => [n.id, n]));
    if (firstBuild && nodes.length > 0) {
      for (let i = 0; i < 250; i++) simulate();
      // 预热后自动适配视野:内容居中撑满(增量刷新/生成双链不重置视野)
      fitView();
    }
    // fitView/simulate 只读 refs,每次渲染都是新引用,纳入 deps 会让本 effect 无意义重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges]);

  // 物理模拟一步
  const simulate = () => {
    const st = stateRef.current;
    const W = sizeRef.current.W || window.innerWidth;
    const H = sizeRef.current.H || window.innerHeight;
    const ns = simNodesRef.current;
    for (const n of ns) {
      n.fx = 0;
      n.fy = 0;
    }
    // 排斥
    const REPULSION = 1500 + st.repelForce * 8000;
    for (let i = 0; i < ns.length; i++) {
      for (let j = i + 1; j < ns.length; j++) {
        const a = ns[i];
        const b = ns[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d2 = dx * dx + dy * dy + 1;
        const d = Math.sqrt(d2);
        const f = REPULSION / d2;
        a.fx -= (dx / d) * f;
        a.fy -= (dy / d) * f;
        b.fx += (dx / d) * f;
        b.fy += (dy / d) * f;
      }
    }
    // 弹簧
    const idMap = idMapRef.current;
    const springK = 0.003 + st.linkForce * 0.025;
    for (const e of edgesRef.current) {
      const a = idMap.get(e.from);
      const b = idMap.get(e.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.001;
      const f = (d - st.linkLength) * springK;
      a.fx += (dx / d) * f;
      a.fy += (dy / d) * f;
      b.fx -= (dx / d) * f;
      b.fy -= (dy / d) * f;
    }
    // 中心
    const gravity = 0.001 + st.centerForce * 0.012;
    for (const n of ns) {
      n.fx += (W / 2 - n.x) * gravity;
      n.fy += (H / 2 - n.y) * gravity;
    }
    const DAMPING = 0.82;
    for (const n of ns) {
      if (n.dragged) continue;
      n.vx = (n.vx + n.fx) * DAMPING;
      n.vy = (n.vy + n.fy) * DAMPING;
      n.x += n.vx;
      n.y += n.vy;
    }
  };

  /** 视野适配:把可见节点的包围盒带边距平滑居中。无论力导向曾把节点推到哪,内容都会回到画面中央。 */
  const fitView = () => {
    const ns = simNodesRef.current.filter((n) => isNodeVisible(n));
    if (ns.length === 0) return;
    const W = sizeRef.current.W >= 40 ? sizeRef.current.W : window.innerWidth;
    const H = sizeRef.current.H >= 40 ? sizeRef.current.H : window.innerHeight;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of ns) {
      minX = Math.min(minX, n.x);
      maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y);
      maxY = Math.max(maxY, n.y);
    }
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const s = Math.max(0.25, Math.min(4, Math.min(W / bw, H / bh) * 0.85));
    const v = viewRef.current;
    v.targetScale = s;
    v.targetTx = W / 2 - ((minX + maxX) / 2) * s;
    v.targetTy = H / 2 - ((minY + maxY) / 2) * s;
  };

  const isNodeVisible = (n: SimNode): boolean => {
    const st = stateRef.current;
    const catKey = n.category ?? '__default__';
    if (!st.enabledCats.has(catKey)) return false;
    if (!st.showOrphans && (adjacencyRef.current.get(n.id)?.size ?? 0) === 0) return false;
    if (st.searchQuery) {
      const q = st.searchQuery.toLowerCase();
      // 双字段匹配：结构名 + 正文标题（对齐星系页搜索口径）
      const byTitle = n.title?.toLowerCase().includes(q);
      const byContent = displayTitlesRef.current.get(n.id)?.toLowerCase().includes(q);
      if (!byTitle && !byContent) return false;
    }
    return true;
  };

  const getHighlightSet = (): Set<string> | null => {
    const id = focusNodeIdRef.current ?? hoverNodeIdRef.current;
    if (!id) return null;
    const adj = adjacencyRef.current.get(id) ?? new Set();
    return new Set([id, ...adj]);
  };

  // ── 渲染循环（只挂一次;所有可变输入走 ref） ──
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext('2d')!;

    const resize = () => {
      // canvas 挂在画布容器内（顶栏下方）,尺寸取容器而非视口,否则会被顶栏顶出一截。
      // 布局未就绪时容器可能量出 0 尺寸——跳过本次写入,等 ResizeObserver 下一次真实尺寸,
      // 否则 0 高度会把力导向重心钉在 y=0(节点全挤在顶栏下沿,2026-07-08 用户截图)。
      const W = container.clientWidth;
      const H = container.clientHeight;
      if (W < 40 || H < 40) return;
      sizeRef.current = { W, H };
      const dpr = window.devicePixelRatio || 1;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    window.addEventListener('resize', resize);

    // 视口缓动：帧率无关的指数逼近（时间常数 ~110ms）,拖拽时 current 与 target 同写故不受影响
    const easeView = () => {
      const v = viewRef.current;
      const now = performance.now();
      const dt = Math.min(64, now - lastFrameRef.current);
      lastFrameRef.current = now;
      const k = 1 - Math.exp(-dt / 110);
      v.tx += (v.targetTx - v.tx) * k;
      v.ty += (v.targetTy - v.ty) * k;
      v.scale += (v.targetScale - v.scale) * k;
      // 收敛截断,避免尾部无限逼近
      if (Math.abs(v.targetScale - v.scale) < 0.0005) v.scale = v.targetScale;
      if (Math.abs(v.targetTx - v.tx) < 0.05) v.tx = v.targetTx;
      if (Math.abs(v.targetTy - v.ty) < 0.05) v.ty = v.targetTy;
      const b = Math.round(v.scale * 100);
      if (b !== zoomBadgeRef.current) {
        zoomBadgeRef.current = b;
        setZoomBadge(b);
      }
    };

    const render = () => {
      const { W, H } = sizeRef.current;
      const v = viewRef.current;
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.translate(v.tx, v.ty);
      ctx.scale(v.scale, v.scale);

      const hi = getHighlightSet();
      const st = stateRef.current;
      const sc = v.scale;
      const ns = simNodesRef.current;
      const idMap = idMapRef.current;
      const nowMs = performance.now();

      // 边（新边走生长动画：沿线段 0→1 长出,亮色渐隐回常规色 —— 用户要的「一根根长出经脉」）
      ctx.lineWidth = st.linkWidth / sc;
      for (const e of edgesRef.current) {
        const a = idMap.get(e.from);
        const b = idMap.get(e.to);
        if (!a || !b) continue;
        if (!isNodeVisible(a) || !isNodeVisible(b)) continue;

        const bornKey = `${e.from}|${e.to}`;
        const born = edgeBornRef.current.get(bornKey);
        if (born !== undefined) {
          const age = nowMs - born;
          if (age > EDGE_GROW_MS + EDGE_GLOW_MS) {
            edgeBornRef.current.delete(bornKey);
          } else {
            const t = Math.min(1, age / EDGE_GROW_MS);
            const grow = 1 - Math.pow(1 - t, 3); // easeOutCubic
            const ex = a.x + (b.x - a.x) * grow;
            const ey = a.y + (b.y - a.y) * grow;
            const glow = 1 - Math.max(0, (age - EDGE_GROW_MS) / EDGE_GLOW_MS);
            ctx.strokeStyle = `rgba(143,196,255,${0.18 + 0.72 * glow})`;
            ctx.lineWidth = (st.linkWidth * (1 + glow)) / sc;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(ex, ey);
            ctx.stroke();
            // 生长头部亮点
            if (t < 1) {
              ctx.fillStyle = 'rgba(191,224,255,0.95)';
              ctx.beginPath();
              ctx.arc(ex, ey, 2.4 / sc, 0, Math.PI * 2);
              ctx.fill();
            }
            ctx.lineWidth = st.linkWidth / sc;
            continue;
          }
        }

        let alpha: number;
        if (hi) alpha = hi.has(a.id) && hi.has(b.id) ? 0.55 : 0.05;
        else alpha = 0.18;
        ctx.strokeStyle = `rgba(180,180,200,${alpha})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      // 节点
      const focusId = focusNodeIdRef.current;
      const hoverId = hoverNodeIdRef.current;
      for (const n of ns) {
        if (!isNodeVisible(n)) continue;
        const r = n.baseR * st.nodeSize;
        const color = colorForCategory(n.category);
        let alpha = 1;
        if (hi && !hi.has(n.id)) alpha = 0.2;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fill();

        if (n.id === focusId) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1.5 / sc;
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 3 / sc, 0, Math.PI * 2);
          ctx.stroke();
        } else if (n.id === hoverId) {
          ctx.strokeStyle = 'rgba(255,255,255,0.7)';
          ctx.lineWidth = 1 / sc;
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 2 / sc, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      // 标签（正文标题模式下显示 frontmatter 派生标题,回退结构名）
      const showLabels = sc > st.textFade;
      if (showLabels || hi) {
        ctx.font = `${12 / sc}px -apple-system, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (const n of ns) {
          if (!isNodeVisible(n)) continue;
          const isHi = hi ? hi.has(n.id) : false;
          const isBig = n.baseR >= 6;
          if (!showLabels && !isHi) continue;
          if (showLabels && !isBig && !isHi && hi) continue;
          const r = n.baseR * st.nodeSize;
          const fadeAlpha = isHi ? 1 : Math.min(1, (sc - st.textFade) * 2.2);
          ctx.fillStyle = `rgba(220,220,220,${fadeAlpha})`;
          ctx.fillText(displayTitleOf(n), n.x, n.y + r + 4 / sc);
        }
      }

      ctx.restore();
    };

    const loop = () => {
      easeView();
      simulate();
      render();
      rafRef.current = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      window.removeEventListener('resize', resize);
    };
    // 渲染循环只挂一次：所有可变输入（edges/hover/focus/labelMode/displayTitles）都走 ref。
  }, []);

  // ── 鼠标交互 ──
  const dragRef = useRef<{
    mode: 'pan' | 'node' | null;
    node?: SimNode;
    sx: number;
    sy: number;
    startTx: number;
    startTy: number;
  }>({ mode: null, sx: 0, sy: 0, startTx: 0, startTy: 0 });

  /** 事件坐标 → canvas 容器相对坐标（canvas 不再从视口 (0,0) 开始,必须换算） */
  const toLocal = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { sx: e.clientX, sy: e.clientY };
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
  };

  const screenToWorld = (sx: number, sy: number) => {
    const v = viewRef.current;
    return { x: (sx - v.tx) / v.scale, y: (sy - v.ty) / v.scale };
  };

  const pickNode = (sx: number, sy: number): SimNode | null => {
    const { x, y } = screenToWorld(sx, sy);
    const ns = simNodesRef.current;
    const st = stateRef.current;
    for (let i = ns.length - 1; i >= 0; i--) {
      const n = ns[i];
      if (!isNodeVisible(n)) continue;
      const r = n.baseR * st.nodeSize + 4 / viewRef.current.scale;
      const dx = n.x - x;
      const dy = n.y - y;
      if (dx * dx + dy * dy <= r * r) return n;
    }
    return null;
  };

  const onMouseDown = (e: React.MouseEvent) => {
    const { sx, sy } = toLocal(e);
    const n = pickNode(sx, sy);
    const v = viewRef.current;
    if (n) {
      dragRef.current = { mode: 'node', node: n, sx, sy, startTx: 0, startTy: 0 };
      n.dragged = true;
    } else {
      // 手抓住画布即接管：目标值对齐当前画面,终止残余缓动,拖拽 1:1 跟手
      v.targetTx = v.tx;
      v.targetTy = v.ty;
      v.targetScale = v.scale;
      dragRef.current = { mode: 'pan', sx, sy, startTx: v.tx, startTy: v.ty };
    }
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const { sx, sy } = toLocal(e);
    const d = dragRef.current;
    const v = viewRef.current;
    if (d.mode === 'pan') {
      v.tx = v.targetTx = d.startTx + (sx - d.sx);
      v.ty = v.targetTy = d.startTy + (sy - d.sy);
    } else if (d.mode === 'node' && d.node) {
      const { x, y } = screenToWorld(sx, sy);
      d.node.x = x;
      d.node.y = y;
      d.node.vx = 0;
      d.node.vy = 0;
    } else {
      const n = pickNode(sx, sy);
      setHoverNodeId(n?.id ?? null);
    }
  };

  /** 聚焦某节点并把它平滑居中（阅读面板打开时居中于左侧可见区） */
  const centerOnNode = (target: SimNode, panelOpenNow: boolean) => {
    const v = viewRef.current;
    const { W, H } = sizeRef.current;
    const panelW = panelOpenNow ? Math.min(readerWidthRef.current + 24, W * 0.94) : 0;
    const s = Math.max(v.targetScale, 1.2);
    v.targetScale = s;
    v.targetTx = (W - panelW) / 2 - target.x * s;
    v.targetTy = H / 2 - target.y * s;
  };

  const onMouseUp = (e: React.MouseEvent) => {
    const { sx, sy } = toLocal(e);
    const d = dragRef.current;
    if (d.mode === 'node' && d.node) {
      d.node.dragged = false;
      const movedDist = Math.hypot(sx - d.sx, sy - d.sy);
      if (movedDist < 4) {
        // 单击：聚焦 + 打开正文预览面板 + 平滑居中;再点同一节点取消
        if (focusNodeIdRef.current === d.node.id) {
          setFocusNodeId(null);
          setOpenEntryId(null);
        } else {
          setFocusNodeId(d.node.id);
          setOpenEntryId(d.node.id);
          centerOnNode(d.node, true);
        }
      }
    }
    dragRef.current = { mode: null, sx: 0, sy: 0, startTx: 0, startTy: 0 };
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const { sx, sy } = toLocal(e);
    const v = viewRef.current;
    const factor = e.deltaY < 0 ? 1.18 : 0.85;
    // 锚点数学全部在 target 空间做：动画途中连续滚动,锚点不漂移
    const wx = (sx - v.targetTx) / v.targetScale;
    const wy = (sy - v.targetTy) / v.targetScale;
    const s = Math.max(0.25, Math.min(4, v.targetScale * factor));
    v.targetScale = s;
    v.targetTx = sx - wx * s;
    v.targetTy = sy - wy * s;
  };

  const onDoubleClickNode = (e: React.MouseEvent) => {
    const { sx, sy } = toLocal(e);
    const n = pickNode(sx, sy);
    if (!n || !storeId) return;
    // 把当前库 + 目标条目存到 sessionStorage，DocumentStorePage 会自动恢复选中状态
    sessionStorage.setItem('doc-store-selected-id', storeId);
    sessionStorage.setItem('doc-store-pending-entry', n.id);
    navigate('/document-store');
  };

  // 当前 hover 节点信息（用于浮 tooltip）
  const hoverNode = useMemo(() => simNodesRef.current.find((n) => n.id === hoverNodeId) ?? null, [hoverNodeId]);
  // 阅读面板标题：正文标题优先
  const openNode = useMemo(() => simNodesRef.current.find((n) => n.id === openEntryId) ?? null, [openEntryId]);

  // 类别清单（用于 Groups 渲染）
  const categories = useMemo(() => {
    const map = new Map<string, number>();
    nodes.forEach((n) => {
      const k = n.category ?? '__default__';
      map.set(k, (map.get(k) ?? 0) + 1);
    });
    return Array.from(map.entries());
  }, [nodes]);

  // 类别启用切换（渲染循环每帧读 stateRef,改完下一帧自动生效）
  const toggleCategory = (cat: string) => {
    const s = new Set(stateRef.current.enabledCats);
    if (s.has(cat)) s.delete(cat);
    else s.add(cat);
    stateRef.current.enabledCats = s;
  };

  const setReaderWidthPersist = (w: number) => {
    const clamped = Math.max(360, Math.min(w, Math.round(window.innerWidth * 0.94)));
    setReaderWidth(clamped);
    try {
      localStorage.setItem('galaxy-reader-width', String(clamped));
    } catch {
      /* 隐私模式 setItem 可能抛错，忽略 */
    }
  };

  // 注意:不做「!storeId 早退渲染另一棵树」——渲染循环 effect deps=[] 只在 mount 挂一次,
  // 早退会让顶层路由(/document-store/universe)首进时 canvas 不存在、循环永远没挂上。
  // 始终渲染完整布局,加载态由画布容器内的覆盖层承担。
  return (
    <div className="h-full flex-1 flex flex-col" style={{ background: '#16161d', color: '#cfcfcf', minHeight: 0 }}>
      {/* ── 实体顶栏（对齐知识星球顶栏 token,不再让控件浮在画布上看不清） ── */}
      <div
        className="shrink-0"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          background: 'rgba(18,18,26,0.92)',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          zIndex: 15,
        }}
      >
        <button
          type="button"
          onClick={() => {
            if (onBack) {
              onBack();
              return;
            }
            // 回到知识库详情：把当前库 ID 塞回 sessionStorage，让 DocumentStorePage 自动选中
            if (storeId) sessionStorage.setItem('doc-store-selected-id', storeId);
            navigate('/document-store');
          }}
          style={topBtnStyle}
        >
          <ArrowLeft size={13} /> 返回
        </button>
        <span style={{ flexShrink: 0, fontSize: 13, fontWeight: 600, color: '#eaeaf0', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={storeName}>
          {storeName || '加载中…'}
        </span>
        <span style={{ flexShrink: 0, fontSize: 11, color: '#8a8a96', whiteSpace: 'nowrap' }}>
          {nodes.length} 节点 · {edges.length} 引用
        </span>
        <span style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.12)', flexShrink: 0 }} />

        {/* 搜索（结构名 + 正文标题双字段过滤,直接作用于画布） */}
        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 8,
            padding: '4px 8px',
          }}
        >
          <Search size={13} style={{ color: '#8a8c9a', flexShrink: 0 }} />
          <input
            placeholder="搜索文档…"
            onChange={(e) => {
              stateRef.current.searchQuery = e.target.value;
            }}
            style={{ background: 'transparent', border: 'none', outline: 'none', color: '#e8e8ee', fontSize: 12, width: 150 }}
          />
        </div>

        <div style={{ flex: 1, minWidth: 8 }} />

        {/* 完成/失败结果 chip（数秒后自动淡出） */}
        {autoLink.status === 'done' && (
          <div
            style={{
              flexShrink: 0,
              background: 'rgba(35,60,45,0.9)',
              border: '1px solid #3c6a4e',
              borderRadius: 6,
              padding: '5px 9px',
              color: '#9fdcb4',
              fontSize: 12,
              whiteSpace: 'nowrap',
            }}
          >
            {autoLink.linksAdded > 0
              ? `扫描 ${autoLink.total} 篇 · 改写 ${autoLink.changed} 篇 · 新增 ${autoLink.linksAdded} 条链接`
              : '没有可新增的双链'}
          </div>
        )}
        {autoLink.status === 'failed' && (
          <div
            style={{
              flexShrink: 0,
              background: 'rgba(70,38,38,0.9)',
              border: '1px solid #7a4444',
              borderRadius: 6,
              padding: '5px 9px',
              color: '#ffb4b4',
              fontSize: 12,
              maxWidth: 280,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={autoLink.message}
          >
            生成双链失败:{autoLink.message ?? '未知错误'}
          </div>
        )}

        {/* 一键生成双链（仅默认认证模式;分享页注入 loadGraph 时不显示） */}
        {!loadGraph && storeId && (
          <button
            type="button"
            onClick={() => { void handleAutoLink(); }}
            disabled={autoLink.status === 'running'}
            title="扫描本库全部文档,把正文中出现的其他文档标题改写为 [[标题]] 双链(只链每篇首次出现,跳过代码块,可在版本历史回滚)"
            style={{
              ...topBtnStyle,
              cursor: autoLink.status === 'running' ? 'default' : 'pointer',
              color: autoLink.status === 'running' ? '#8a8a96' : '#cfcfd6',
            }}
          >
            {autoLink.status === 'running' ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Link2 size={13} />
            )}
            {autoLink.status === 'running'
              ? autoLink.total > 0
                ? `生成中 ${autoLink.processed}/${autoLink.total}`
                : '生成中'
              : '生成双链'}
          </button>
        )}

        {/* 标签显示模式：正文标题 ↔ 结构名 */}
        <button
          type="button"
          onClick={() => setLabelMode((m) => (m === 'content' ? 'structural' : 'content'))}
          title={
            labelMode === 'content'
              ? '当前：显示正文标题（frontmatter title）。点击切回结构名'
              : '当前：显示结构名（文件名 / 点分命名）。点击切到正文标题'
          }
          style={topBtnStyle}
        >
          {labelMode === 'content' ? <ToggleRight size={14} style={{ color: '#8ab4ff' }} /> : <ToggleLeft size={14} />}
          {labelMode === 'content' ? '正文标题' : '结构名'}
        </button>

        {/* 库切换器 */}
        {stores.length > 1 && (
          <select
            value={storeId}
            onChange={(e) => {
              setStoreId(e.target.value);
              navigate(`/document-store/${e.target.value}/universe`);
            }}
            style={{
              flexShrink: 0,
              background: 'rgba(45,45,55,0.85)',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 6,
              padding: '5px 8px',
              color: '#cfcfd6',
              fontSize: 12,
            }}
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        )}

        {/* 进入 3D 星系（独立全屏页） */}
        {storeId && (
          <button
            type="button"
            onClick={() => {
              if (onOpenGalaxy) {
                onOpenGalaxy();
                return;
              }
              navigate(`/document-store/${storeId}/galaxy`);
            }}
            style={topBtnStyle}
          >
            <Orbit size={13} /> 星系
          </button>
        )}
      </div>

      {/* ── 画布容器（canvas 与全部浮层相对它定位） ── */}
      <div ref={containerRef} className="flex-1 min-h-0 relative" style={{ background: '#1e1e1e' }}>
        <canvas
          ref={canvasRef}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
          onWheel={onWheel}
          onDoubleClick={onDoubleClickNode}
          style={{ position: 'absolute', inset: 0, cursor: hoverNodeId ? 'pointer' : dragRef.current.mode === 'pan' ? 'grabbing' : 'grab' }}
        />

        {/* 齿轮按钮 */}
        <button
          onClick={() => setPanelOpen(!panelOpen)}
          style={{
            position: 'absolute',
            top: 12,
            left: 12,
            width: 32,
            height: 32,
            background: 'rgba(45,45,45,0.85)',
            border: '1px solid #3a3a3a',
            borderRadius: 6,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 11,
            color: '#a8a8a8',
          }}
        >
          <SettingsIcon size={16} />
        </button>

        {/* 设置面板 */}
        {panelOpen && (
          <div
            style={{
              position: 'absolute',
              top: 52,
              left: 12,
              width: 280,
              background: 'rgba(36,36,36,0.96)',
              backdropFilter: 'blur(8px)',
              border: '1px solid #3a3a3a',
              borderRadius: 8,
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
              zIndex: 12,
              maxHeight: 'calc(100% - 64px)',
              overflowY: 'auto',
              padding: 12,
              fontSize: 12,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 10, color: '#d4d4d4' }}>Graph 设置</div>

            {/* Filters（搜索已上移顶栏） */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: '#8a8a8a', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>Filters</div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: '#cfcfcf' }}>
                <input
                  type="checkbox"
                  defaultChecked
                  onChange={(e) => {
                    stateRef.current.showOrphans = e.target.checked;
                  }}
                />
                显示孤岛节点
              </label>
            </div>

            {/* Groups */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: '#8a8a8a', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>Groups</div>
              {categories.map(([cat, count]) => (
                <label key={cat} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', cursor: 'pointer', color: '#cfcfcf' }}>
                  <input
                    type="checkbox"
                    defaultChecked
                    onChange={() => toggleCategory(cat)}
                  />
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: colorForCategory(cat === '__default__' ? null : cat) }} />
                  <div style={{ flex: 1 }}>{cat === '__default__' ? '未分类' : cat}</div>
                  <div style={{ color: '#666', fontSize: 10 }}>{count}</div>
                </label>
              ))}
            </div>

            {/* Display */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: '#8a8a8a', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>Display</div>
              {([
                { key: 'textFade', label: '文字淡出阈值', min: 0, max: 1, step: 0.01, def: 0.5 },
                { key: 'nodeSize', label: '节点尺寸', min: 0.5, max: 2, step: 0.05, def: 1 },
                { key: 'linkWidth', label: '连接线粗细', min: 0.3, max: 3, step: 0.1, def: 1 },
              ] as const).map((s) => (
                <div key={s.key} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 10, color: '#8a8a8a', marginBottom: 2 }}>{s.label}</div>
                  <input
                    type="range"
                    min={s.min}
                    max={s.max}
                    step={s.step}
                    defaultValue={s.def}
                    onChange={(e) => {
                      (stateRef.current as unknown as Record<string, number>)[s.key] = parseFloat(e.target.value);
                    }}
                    style={{ width: '100%' }}
                  />
                </div>
              ))}
            </div>

            {/* Forces */}
            <div>
              <div style={{ fontSize: 11, color: '#8a8a8a', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>Forces</div>
              {([
                { key: 'centerForce', label: '中心力', min: 0, max: 1, step: 0.01, def: 0.5 },
                { key: 'repelForce', label: '排斥力', min: 0, max: 1, step: 0.01, def: 0.5 },
                { key: 'linkForce', label: '连接力', min: 0, max: 1, step: 0.01, def: 0.5 },
                { key: 'linkLength', label: '连接长度', min: 60, max: 260, step: 2, def: 130 },
              ] as const).map((s) => (
                <div key={s.key} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 10, color: '#8a8a8a', marginBottom: 2 }}>{s.label}</div>
                  <input
                    type="range"
                    min={s.min}
                    max={s.max}
                    step={s.step}
                    defaultValue={s.def}
                    onChange={(e) => {
                      (stateRef.current as unknown as Record<string, number>)[s.key] = parseFloat(e.target.value);
                    }}
                    style={{ width: '100%' }}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* hover 浮卡 */}
        {hoverNode && (
          <div
            style={{
              position: 'absolute',
              background: 'rgba(36,36,36,0.96)',
              border: '1px solid #3a3a3a',
              borderRadius: 6,
              padding: '8px 12px',
              color: '#fff',
              fontSize: 12,
              zIndex: 100,
              pointerEvents: 'none',
              left: 16,
              bottom: 56,
              maxWidth: 340,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{displayTitleOf(hoverNode)}</div>
            {labelMode === 'content' && displayTitles.get(hoverNode.id) && (
              <div style={{ color: '#77798a', fontSize: 10, marginBottom: 4 }}>{hoverNode.title}</div>
            )}
            {hoverNode.summary && <div style={{ color: '#9a9a9a', fontSize: 11, lineHeight: 1.5 }}>{hoverNode.summary.slice(0, 120)}</div>}
            <div style={{ marginTop: 6, fontSize: 10, color: '#666' }}>
              单击预览 · 双击进入文档
            </div>
          </div>
        )}

        {/* 右下角:适配视图 + 缩放显示 */}
        <div style={{ position: 'absolute', bottom: 12, right: 12, zIndex: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            onClick={fitView}
            title="适配视图:把全部节点居中撑满画布"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              background: 'rgba(36,36,36,0.85)',
              border: '1px solid #3a3a3a',
              borderRadius: 6,
              color: '#a8a8a8',
              cursor: 'pointer',
            }}
          >
            <Maximize2 size={13} />
          </button>
          <div
            style={{
              background: 'rgba(36,36,36,0.85)',
              border: '1px solid #3a3a3a',
              borderRadius: 6,
              padding: '6px 10px',
              fontSize: 11,
              color: '#8a8a8a',
            }}
          >
            {zoomBadge}%
          </div>
        </div>

        {/* 左下提示 */}
        <div
          style={{
            position: 'absolute',
            bottom: 12,
            left: 12,
            fontSize: 11,
            color: '#555',
            zIndex: 5,
          }}
        >
          滚轮缩放 · 拖动平移 · 悬停看预览 · 单击预览正文 · 双击进入文档
        </div>

        {loading && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(30,30,30,0.6)',
              zIndex: 50,
            }}
          >
            <Loader2 size={24} className="animate-spin" style={{ color: '#7c5cff' }} />
          </div>
        )}

        {error && !loading && (
          <div
            style={{
              position: 'absolute',
              top: 80,
              left: '50%',
              transform: 'translateX(-50%)',
              background: 'rgba(60,30,30,0.95)',
              border: '1px solid rgba(255,90,90,0.5)',
              borderRadius: 8,
              padding: '12px 16px',
              color: '#ffd0d0',
              fontSize: 13,
              zIndex: 50,
            }}
          >
            加载失败：{error}
          </div>
        )}

        {!loading && !error && nodes.length === 0 && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#666',
              fontSize: 14,
              zIndex: 5,
              pointerEvents: 'none',
              textAlign: 'center',
            }}
          >
            <div>
              <div style={{ fontSize: 16, marginBottom: 8 }}>这个库还没有节点</div>
              <div>在文档里写 <code style={{ background: '#2a2a2a', padding: '2px 6px', borderRadius: 3 }}>[[标题]]</code> 即可织出第一条边。</div>
            </div>
          </div>
        )}

        {/* 单击节点 → 正文预览面板（与知识星球共用 ReaderPanel） */}
        {openEntryId && (
          <ReaderPanel
            entryId={openEntryId}
            displayTitle={openNode ? displayTitleOf(openNode) : undefined}
            width={readerWidth}
            onResize={setReaderWidthPersist}
            loadContent={loadContent}
            onClose={() => setOpenEntryId(null)}
          />
        )}
      </div>
    </div>
  );
}
