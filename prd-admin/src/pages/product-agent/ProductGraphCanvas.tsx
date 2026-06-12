/**
 * 产品管理智能体 — 知识图谱画布（P2 + 交互增强）。
 *
 * 节点=产品/版本/需求/功能/客户/追溯缺陷，边=包含/关联/落需求/连客户/追溯。
 * 交互能力：
 *  - 缩放 / 拖拽 / 平移（@xyflow/react，手势见 .claude/rules/gesture-unification.md 标准 B）
 *  - 展开 / 收起子节点（点击节点折叠其在生成树下的后代，自由探索）
 *  - 过滤：按对象类型、状态、版本筛选可见节点
 *  - 搜索：关键词定位并高亮匹配节点（绕过折叠/过滤，便于查找）
 *  - 追溯：从任一节点沿关系路径追溯（如缺陷→需求→客户），高亮整条关系网、暗化其余
 *
 * 数据来自 GET /products/{id}/graph 的全量 nodes/edges，过滤/折叠/追溯均在前端计算。
 */
import { useEffect, useMemo, useRef, useState, useCallback, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  MiniMap,
  Controls,
  Handle,
  Position,
  MarkerType,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Search, GitFork, X, Sparkles, ExternalLink, Copy, Check } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { useSseStream } from '@/lib/useSseStream';
import { StreamingText } from '@/components/streaming/StreamingText';
import { stripMarkdown } from '@/lib/stripMarkdown';

/** 富文本 → 纯文本（抽屉里展示干净摘要，不再糊出 HTML 标签）。 */
function htmlToText(html: string): string {
  if (!html) return '';
  if (typeof window === 'undefined' || typeof window.DOMParser === 'undefined') return html.replace(/<[^>]+>/g, ' ');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body.textContent || '').replace(/\s+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
}
import {
  getProductGraph,
  getOverviewGraph,
  getProduct,
  listRequirements,
  listFeatures,
  listVersions,
  listCustomers,
  listTracedDefects,
  summarizeItem,
  type GraphNode,
  type GraphEdge,
} from '@/services/real/productAgent';
import { ITEM_GRADE_LABEL, effectiveDefectGrade } from './types';
import { resolveRequirementStateLabel } from './requirementWorkflowUtils';

type NodeType = GraphNode['type'];

const TYPE_META: Record<NodeType, { color: string; col: number; label: string }> = {
  customer: { color: '#4ADE80', col: 0, label: '客户' },
  requirement: { color: '#FBBF24', col: 1, label: '需求' },
  version: { color: '#60A5FA', col: 2, label: '版本' },
  product: { color: '#22D3EE', col: 3, label: '产品' },
  feature: { color: '#A78BFA', col: 4, label: '功能' },
  defect: { color: '#F87171', col: 5, label: '缺陷' },
};
const ALL_TYPES = Object.keys(TYPE_META) as NodeType[];

/** 边类型 → 中文关系描述（画在连线中间） */
const EDGE_LABEL: Record<string, string> = {
  contains: '包含',
  includes: '关联需求',
  'feature-in-version': '纳入功能',
  implements: '实现',
  'from-customer': '来自客户',
  traces: '追溯',
};

const COL_GAP = 250;
const ROW_GAP = 78;

type Pt = { x: number; y: number };
type LayoutNode = { id: string; type: NodeType };
type LayoutEdge = { source: string; target: string };

/** 实时拖拽力导向运行态（仅离散布局拖动期间存在） */
type SimNode = { x: number; y: number; vx: number; vy: number };
type SimState = {
  pos: Map<string, SimNode>;
  pinned: Set<string>;   // 用户拖过/正在拖的点：固定不受力
  edges: [string, string][];
  dragId: string | null; // 当前正在拖的点
  raf: number | null;
  alpha: number;         // 能量，冷却到阈值停止
};

/** 「整理」布局：按类型分列（客户|需求|版本|产品|功能|缺陷），每列纵向排开。 */
function tidyLayout(nodes: LayoutNode[], view: 'card' | 'dot'): Map<string, Pt> {
  const colRow: Record<number, number> = {};
  const rowGap = view === 'dot' ? 96 : ROW_GAP;
  const m = new Map<string, Pt>();
  for (const n of nodes) {
    const meta = TYPE_META[n.type];
    const row = colRow[meta.col] ?? 0;
    colRow[meta.col] = row + 1;
    m.set(n.id, { x: meta.col * COL_GAP, y: row * rowGap });
  }
  return m;
}

/** 字符串 → [0,1) 确定性种子（FNV-1a），用于离散布局初始散点，保证每次结果一致不乱跳。 */
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

/**
 * 「离散」布局：自写轻量力导向（节点斥力 + 边弹簧 + 轻微向心），迭代定格为静态位置。
 * 参考 Obsidian 的有机团簇呈现——不太挤（大间距 + 最小距离硬排斥）、不太规则（无网格）。
 * 无第三方依赖；O(n²)·迭代，对几十~上百节点足够快；结果确定性（哈希种子）。
 */
function scatterLayout(nodes: LayoutNode[], edges: LayoutEdge[], view: 'card' | 'dot'): Map<string, Pt> {
  const n = nodes.length;
  const m = new Map<string, Pt>();
  if (n === 0) return m;
  const idealLen = view === 'dot' ? 150 : 260; // 边理想长度（卡片更宽 → 间距更大）
  const repK = view === 'dot' ? 9000 : 26000;  // 斥力强度
  const minDist = view === 'dot' ? 70 : 210;   // 最小间距（防卡片重叠）
  const R = Math.sqrt(n) * idealLen * 0.6;

  const px = new Array<number>(n);
  const py = new Array<number>(n);
  const idx = new Map<string, number>();
  nodes.forEach((nd, i) => {
    idx.set(nd.id, i);
    const a = hashSeed(nd.id) * Math.PI * 2;
    const r = (0.25 + 0.75 * hashSeed(nd.id + 'r')) * R;
    px[i] = Math.cos(a) * r;
    py[i] = Math.sin(a) * r;
  });
  const ed: [number, number][] = [];
  for (const e of edges) {
    const a = idx.get(e.source); const b = idx.get(e.target);
    if (a != null && b != null && a !== b) ed.push([a, b]);
  }

  const ITER = 320;
  for (let it = 0; it < ITER; it++) {
    const alpha = 1 - it / ITER;
    const fx = new Array<number>(n).fill(0);
    const fy = new Array<number>(n).fill(0);
    // 斥力（含最小距离硬排斥）
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = px[i] - px[j], dy = py[i] - py[j];
        const d2 = dx * dx + dy * dy || 0.01;
        const d = Math.sqrt(d2);
        let f = repK / d2;
        if (d < minDist) f += (minDist - d) * 6;
        const ux = dx / d, uy = dy / d;
        fx[i] += ux * f; fy[i] += uy * f; fx[j] -= ux * f; fy[j] -= uy * f;
      }
    }
    // 边弹簧
    for (const [a, b] of ed) {
      const dx = px[b] - px[a], dy = py[b] - py[a];
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d - idealLen) * 0.04;
      const ux = dx / d, uy = dy / d;
      fx[a] += ux * f; fy[a] += uy * f; fx[b] -= ux * f; fy[b] -= uy * f;
    }
    // 轻微向心，避免整体漂走
    const maxStep = 30 * alpha + 2;
    for (let i = 0; i < n; i++) {
      fx[i] -= px[i] * 0.002; fy[i] -= py[i] * 0.002;
      let sx = fx[i] * 0.02, sy = fy[i] * 0.02;
      const sl = Math.hypot(sx, sy);
      if (sl > maxStep) { sx = (sx / sl) * maxStep; sy = (sy / sl) * maxStep; }
      px[i] += sx; py[i] += sy;
    }
  }
  nodes.forEach((nd, i) => m.set(nd.id, { x: Math.round(px[i]), y: Math.round(py[i]) }));
  return m;
}

/** 定义生成树父子关系的边类型（用于展开/收起）：parent = source，child = target；traces 反向（缺陷是子） */
function parentChildFromEdge(e: GraphEdge): { parent: string; child: string } | null {
  switch (e.type) {
    case 'contains':
    case 'includes':
    case 'feature-in-version':
    case 'from-customer':
      return { parent: e.source, child: e.target };
    case 'traces':
      return { parent: e.target, child: e.source };
    default:
      return null; // implements 等视为横向交叉链，不参与生成树
  }
}

function idType(id: string): NodeType {
  return id.split(':', 1)[0] as NodeType;
}

function ProductGraphInner({ productId, overview, focusNodeId }: { productId?: string; overview?: boolean; focusNodeId?: string }) {
  const [raw, setRaw] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);

  // 布局模式：tidy=按类型分列「整理」 / scatter=力导向「离散」(参考 Obsidian)
  const [layout, setLayout] = useState<'tidy' | 'scatter'>('tidy');
  const [typeOn, setTypeOn] = useState<Record<NodeType, boolean>>(
    () => Object.fromEntries(ALL_TYPES.map((t) => [t, true])) as Record<NodeType, boolean>,
  );
  const [stateFilter, setStateFilter] = useState('');
  const [versionFilter, setVersionFilter] = useState('');
  const [keyword, setKeyword] = useState('');
  const [mode, setMode] = useState<'collapse' | 'trace'>('collapse');
  const [traceAnchor, setTraceAnchor] = useState<string | null>(null);
  // 悬停临时追溯锚点：移上去高亮关系网，移出取消；点击设置的 traceAnchor（固定）优先
  const [hoverAnchor, setHoverAnchor] = useState<string | null>(null);
  const [view, setView] = useState<'card' | 'dot'>('card');

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const rfRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  // 实时拖拽力导向（离散布局，Obsidian 式：拖一个点，关联点经弹簧丝滑跟随）的运行态
  const nodesRef = useRef(nodes); nodesRef.current = nodes;
  const edgesRef = useRef(edges); edgesRef.current = edges;
  const simRef = useRef<SimState | null>(null);
  const viewRef = useRef(view); viewRef.current = view;

  useEffect(() => {
    let alive = true;
    void (async () => {
      setLoading(true);
      const res = overview ? await getOverviewGraph() : await getProductGraph(productId ?? '');
      if (!alive) return;
      if (res.success) setRaw(res.data);
      else setError(res.error?.message ?? '加载图谱失败');
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [productId, overview]);

  // 聚焦节点（追溯抽屉调用）：图谱加载后自动进入追溯模式并锚定该节点，高亮其关系网
  const focusAppliedRef = useRef(false);
  useEffect(() => {
    if (!raw || !focusNodeId || focusAppliedRef.current) return;
    const target = raw.nodes.find((n) => n.id === focusNodeId);
    if (!target) return;
    focusAppliedRef.current = true;
    setMode('trace');
    setTraceAnchor(focusNodeId);
    setSelected(target);
  }, [raw, focusNodeId]);

  // ── 派生：邻接表、生成树父子、后代计数 ──
  const derived = useMemo(() => {
    const adj = new Map<string, Set<string>>();
    const parentOf = new Map<string, string>();
    const childrenOf = new Map<string, string[]>();
    const nodeById = new Map<string, GraphNode>();
    if (raw) {
      for (const n of raw.nodes) {
        nodeById.set(n.id, n);
        adj.set(n.id, new Set());
      }
      for (const e of raw.edges) {
        adj.get(e.source)?.add(e.target);
        adj.get(e.target)?.add(e.source);
        const pc = parentChildFromEdge(e);
        if (pc && !parentOf.has(pc.child)) {
          parentOf.set(pc.child, pc.parent);
          childrenOf.set(pc.parent, [...(childrenOf.get(pc.parent) ?? []), pc.child]);
        }
      }
    }
    const descCount = new Map<string, number>();
    const countDesc = (id: string): number => {
      if (descCount.has(id)) return descCount.get(id)!;
      let c = 0;
      for (const ch of childrenOf.get(id) ?? []) c += 1 + countDesc(ch);
      descCount.set(id, c);
      return c;
    };
    for (const id of nodeById.keys()) countDesc(id);
    return { adj, parentOf, childrenOf, descCount, nodeById };
  }, [raw]);

  // ── 派生：可见集合（折叠 + 过滤）；搜索匹配集合 ──
  const { visibleIds, matchIds } = useMemo(() => {
    const vis = new Set<string>();
    const match = new Set<string>();
    if (!raw) return { visibleIds: vis, matchIds: match };

    const kw = keyword.trim().toLowerCase();
    // 关键词匹配 + 其祖先链（保证可定位）
    if (kw) {
      for (const n of raw.nodes) {
        if (n.label.toLowerCase().includes(kw) || (n.sub ?? '').toLowerCase().includes(kw)) match.add(n.id);
      }
    }

    // 版本过滤：以版本为中心 2 跳可达 + 产品根
    let versionScope: Set<string> | null = null;
    if (versionFilter) {
      versionScope = new Set<string>([versionFilter]);
      if (productId) versionScope.add(`product:${productId}`);
      let frontier = [versionFilter];
      for (let hop = 0; hop < 2; hop++) {
        const next: string[] = [];
        for (const id of frontier)
          for (const nb of derived.adj.get(id) ?? []) {
            if (!versionScope.has(nb)) {
              versionScope.add(nb);
              next.push(nb);
            }
          }
        frontier = next;
      }
    }

    for (const n of raw.nodes) {
      // 搜索命中（及其祖先）始终可见，便于定位
      if (kw) {
        if (match.has(n.id)) {
          vis.add(n.id);
          let cur = derived.parentOf.get(n.id);
          while (cur) {
            vis.add(cur);
            cur = derived.parentOf.get(cur);
          }
        }
        continue;
      }
      if (!typeOn[n.type]) continue;
      if (stateFilter && (n.state ?? '') !== stateFilter) continue;
      if (versionScope && !versionScope.has(n.id)) continue;
      vis.add(n.id);
    }
    return { visibleIds: vis, matchIds: match };
  }, [raw, derived, typeOn, stateFilter, versionFilter, keyword, productId]);

  // ── 追溯集合：从锚点沿关系路径(无向)可达 ──
  const traceIds = useMemo(() => {
    const anchor = traceAnchor ?? hoverAnchor; // 固定锚点优先，否则用悬停锚点
    if (!anchor || !raw) return null;
    const reached = new Set<string>([anchor]);
    const queue = [anchor];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const nb of derived.adj.get(cur) ?? []) {
        if (!reached.has(nb)) {
          reached.add(nb);
          queue.push(nb);
        }
      }
    }
    return reached;
  }, [traceAnchor, hoverAnchor, raw, derived]);

  // 可见集合 key（仅成员变化才重排版）
  const visibleKey = useMemo(() => Array.from(visibleIds).sort().join('|'), [visibleIds]);

  // ── 成员/布局：可见集合 / 视图 / 布局模式变化时重建节点与边 ──
  useEffect(() => {
    if (!raw) return;
    const visNodes = raw.nodes.filter((n) => visibleIds.has(n.id));
    const visEdges = raw.edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target));
    // 位置：整理=按类型分列；离散=力导向有机散布
    const pos = layout === 'scatter'
      ? scatterLayout(visNodes, visEdges, view)
      : tidyLayout(visNodes, view);
    const rfNodes: Node[] = visNodes.map((n) => {
      const meta = TYPE_META[n.type];
      const desc = derived.descCount.get(n.id) ?? 0;
      const label = `${n.label}${n.sub ? `\n${n.sub}` : ''}`;
      const p = pos.get(n.id) ?? { x: 0, y: 0 };
      if (view === 'dot') {
        // 圆点视图：大小随后代数（重要度），颜色随类型，名称在圆点下方。
        // 缩小整体尺寸（原 16+desc*4 偏大），delay 让各点呼吸错峰、更像活的星图。
        const size = 9 + Math.min(desc, 10) * 2;
        return { id: n.id, type: 'dot', position: p, data: { label, color: meta.color, size, delay: hashSeed(n.id) * 2.4 }, style: {} };
      }
      return { id: n.id, position: p, data: { label }, style: baseStyle(meta.color) };
    });
    const rfEdges: Edge[] = visEdges
      .map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: EDGE_LABEL[e.type] ?? e.type,
        labelStyle: { fill: 'rgba(255,255,255,0.42)', fontSize: 9.5 },
        labelBgStyle: { fill: '#0f1014', fillOpacity: 0.7 },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 4,
        markerEnd: { type: MarkerType.ArrowClosed, width: 11, height: 11, color: 'rgba(255,255,255,0.25)' },
        style: { stroke: 'rgba(255,255,255,0.10)', strokeWidth: 0.8 },
      }));
    setNodes(rfNodes);
    setEdges(rfEdges);
    // 重排后重新居中适配
    requestAnimationFrame(() => rfRef.current?.fitView({ duration: 400, padding: 0.2 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey, view, layout]);

  // ── 样式：搜索/追溯变化时只改样式，不重排版（拖拽位置得以保留）──
  useEffect(() => {
    const kw = keyword.trim();
    const selId = selected?.id ?? null;
    setNodes((ns) =>
      ns.map((node) => {
        const type = idType(node.id);
        const color = TYPE_META[type]?.color ?? '#888';
        const isSel = node.id === selId;
        let dim = false;
        let ring: string | null = null;
        // 追溯模式：只暗化非路径节点，不改外边框（保留类型色，便于辨认类型）
        if (traceIds && !traceIds.has(node.id)) dim = true;
        // 搜索：命中加青色描边定位
        if (kw) {
          if (matchIds.has(node.id)) ring = '#22D3EE';
          else if (!traceIds) dim = true;
        }
        // 选中：白色高亮（卡片描边；圆点交给 DotNode 画圆环）
        if (isSel && view !== 'dot') ring = '#FFFFFF';
        // 激活态（选中 / 搜索命中 / 追溯路径上）的节点微微浮动，模拟"活的"知识图谱
        const isActive = !dim && (isSel || (!!kw && matchIds.has(node.id)) || (!!traceIds && traceIds.has(node.id)));
        const fxClass = isActive ? 'pa-graph-active' : undefined;
        if (view === 'dot') {
          return { ...node, data: { ...(node.data as object), selected: isSel }, className: fxClass, style: { opacity: dim ? 0.16 : 1 } };
        }
        const baseS = baseStyle(color);
        return { ...node, className: fxClass, style: { ...baseS, opacity: dim ? 0.16 : 1, ...(ring ? { boxShadow: `0 0 0 ${isSel ? 3 : 2}px ${ring}` } : {}) } };
      }),
    );
    setEdges((es) =>
      es.map((e) => {
        const inTrace = traceIds && traceIds.has(e.source) && traceIds.has(e.target);
        // 每条追溯边按各自「母体（来源节点）」的类型色着色 —— 同一追溯网呈现多种颜色
        const edgeColor = TYPE_META[idType(e.source)]?.color ?? '#fbbf24';
        return {
          ...e,
          animated: !!inTrace,
          markerEnd: inTrace
            ? { type: MarkerType.ArrowClosed, width: 13, height: 13, color: edgeColor }
            : e.markerEnd,
          style: {
            stroke: inTrace ? edgeColor : 'rgba(255,255,255,0.09)',
            strokeWidth: inTrace ? 1.4 : 0.8,
            opacity: traceIds && !inTrace ? 0.08 : inTrace ? 0.92 : 1,
          },
        };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceAnchor, hoverAnchor, traceIds, keyword, matchIds, visibleKey, view, selected]);

  const onNodeMouseEnter = useCallback((_e: ReactMouseEvent, node: Node) => { setHoverAnchor(node.id); }, []);
  const onNodeMouseLeave = useCallback(() => { setHoverAnchor(null); }, []);

  const onNodeClick = (_e: ReactMouseEvent, node: Node) => {
    if (mode === 'trace') {
      setTraceAnchor((prev) => (prev === node.id ? null : node.id));
      return;
    }
    // 默认：点击任一节点弹出右侧详情抽屉
    setSelected(raw?.nodes.find((n) => n.id === node.id) ?? null);
  };

  // 关系分析用：从锚点沿关系(无向)收集整条链的节点 + 边（带关系类型），交给后端补全字段后做 AI 分析
  const buildChain = useCallback((anchorId: string) => {
    if (!raw) return { nodes: [], edges: [] };
    const reached = new Set<string>([anchorId]);
    const q = [anchorId];
    while (q.length) {
      const cur = q.shift()!;
      for (const nb of derived.adj.get(cur) ?? []) { if (!reached.has(nb)) { reached.add(nb); q.push(nb); } }
    }
    return {
      nodes: raw.nodes.filter((n) => reached.has(n.id)).map((n) => ({ id: n.id, type: n.type, label: n.label, sub: n.sub ?? null })),
      edges: raw.edges.filter((e) => reached.has(e.source) && reached.has(e.target)).map((e) => ({ source: e.source, target: e.target, type: e.type })),
    };
  }, [raw, derived]);

  // ── 实时拖拽力导向（离散布局）：拖一个点，关联点经弹簧丝滑跟随（Obsidian 关系图谱效果）──
  const simTick = useCallback(() => {
    const s = simRef.current;
    if (!s) return;
    const dot = viewRef.current === 'dot';
    const ideal = dot ? 150 : 260;
    const kRep = dot ? 9000 : 26000;
    const kSpring = 0.05;
    const damp = 0.85;
    const ids = [...s.pos.keys()];
    const n = ids.length;
    const fx = new Map<string, number>(); const fy = new Map<string, number>();
    ids.forEach((id) => { fx.set(id, 0); fy.set(id, 0); });
    // 斥力（全对，节点数小，开销可忽略）
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = s.pos.get(ids[i])!; const b = s.pos.get(ids[j])!;
        const dx = a.x - b.x, dy = a.y - b.y;
        const d2 = dx * dx + dy * dy || 0.01; const d = Math.sqrt(d2);
        const f = kRep / d2; const ux = dx / d, uy = dy / d;
        fx.set(ids[i], fx.get(ids[i])! + ux * f); fy.set(ids[i], fy.get(ids[i])! + uy * f);
        fx.set(ids[j], fx.get(ids[j])! - ux * f); fy.set(ids[j], fy.get(ids[j])! - uy * f);
      }
    }
    // 边弹簧
    for (const [a, b] of s.edges) {
      const pa = s.pos.get(a); const pb = s.pos.get(b);
      if (!pa || !pb) continue;
      const dx = pb.x - pa.x, dy = pb.y - pa.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const f = kSpring * (d - ideal); const ux = dx / d, uy = dy / d;
      fx.set(a, fx.get(a)! + ux * f); fy.set(a, fy.get(a)! + uy * f);
      fx.set(b, fx.get(b)! - ux * f); fy.set(b, fy.get(b)! - uy * f);
    }
    let moving = false;
    for (const id of ids) {
      const p = s.pos.get(id)!;
      if (id === s.dragId || s.pinned.has(id)) { p.vx = 0; p.vy = 0; continue; }
      p.vx = (p.vx + fx.get(id)! * 0.02) * damp;
      p.vy = (p.vy + fy.get(id)! * 0.02) * damp;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > 28) { p.vx = (p.vx / sp) * 28; p.vy = (p.vy / sp) * 28; }
      if (sp > 0.15) moving = true;
      p.x += p.vx; p.y += p.vy;
    }
    setNodes((ns) => ns.map((nd) => { const p = s.pos.get(nd.id); return p ? { ...nd, position: { x: p.x, y: p.y } } : nd; }));
    s.alpha *= 0.985;
    if (s.dragId || (moving && s.alpha > 0.02)) {
      s.raf = requestAnimationFrame(simTick);
    } else {
      s.raf = null;
    }
  }, [setNodes]);

  const onNodeDragStart = useCallback((_e: ReactMouseEvent, node: Node) => {
    if (layout !== 'scatter') return; // 仅离散布局启用力导向跟随；整理布局走普通拖拽
    const pos = new Map<string, SimNode>();
    for (const nd of nodesRef.current) pos.set(nd.id, { x: nd.position.x, y: nd.position.y, vx: 0, vy: 0 });
    const pinned = simRef.current?.pinned ?? new Set<string>();
    pinned.add(node.id);
    const edgeList = edgesRef.current.map((e) => [e.source, e.target] as [string, string]);
    if (simRef.current?.raf) cancelAnimationFrame(simRef.current.raf);
    simRef.current = { pos, pinned, edges: edgeList, dragId: node.id, raf: null, alpha: 1 };
    simRef.current.raf = requestAnimationFrame(simTick);
  }, [layout, simTick]);

  const onNodeDrag = useCallback((_e: ReactMouseEvent, node: Node) => {
    const s = simRef.current; if (!s) return;
    const p = s.pos.get(node.id); if (p) { p.x = node.position.x; p.y = node.position.y; p.vx = 0; p.vy = 0; }
    s.alpha = 1;
    if (s.raf == null) s.raf = requestAnimationFrame(simTick);
  }, [simTick]);

  const onNodeDragStop = useCallback((_e: ReactMouseEvent, node: Node) => {
    const s = simRef.current; if (!s) return;
    const p = s.pos.get(node.id); if (p) { p.x = node.position.x; p.y = node.position.y; }
    s.dragId = null; // 松手后该点固定在落点，其余继续 settle
    s.alpha = Math.max(s.alpha, 0.6);
    if (s.raf == null) s.raf = requestAnimationFrame(simTick);
  }, [simTick]);

  // 卸载 / 切换布局视图成员时停掉模拟（位置由布局 effect 重置）
  useEffect(() => () => { if (simRef.current?.raf) cancelAnimationFrame(simRef.current.raf); }, []);
  useEffect(() => {
    if (simRef.current?.raf) cancelAnimationFrame(simRef.current.raf);
    simRef.current = null;
  }, [visibleKey, view, layout]);

  // 距离过滤选项
  const stateOptions = useMemo(() => {
    const s = new Set<string>();
    raw?.nodes.forEach((n) => n.state && s.add(n.state));
    return Array.from(s).sort();
  }, [raw]);
  const versionOptions = useMemo(() => (raw?.nodes ?? []).filter((n) => n.type === 'version'), [raw]);

  if (loading) return <MapSectionLoader text="正在生成知识图谱…" />;
  if (error) return <div className="text-sm text-red-300/80 text-center py-10">{error}</div>;
  if ((raw?.nodes.length ?? 0) <= 1) {
    return (
      <div className="text-center text-white/40 text-sm py-16 px-6">
        图谱还很空。先在 版本/需求/功能/客户 tab 创建对象并互相关联，关系会自动显示在这里。
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col px-4 pt-3">
      <style>{GRAPH_FX_CSS}</style>
      {/* 控制栏 */}
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-1 pb-3">
        {/* 类型过滤 */}
        <div className="flex items-center gap-1">
          {ALL_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => setTypeOn((prev) => ({ ...prev, [t]: !prev[t] }))}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border transition-colors"
              style={{
                borderColor: typeOn[t] ? TYPE_META[t].color : 'rgba(255,255,255,0.1)',
                color: typeOn[t] ? TYPE_META[t].color : 'rgba(255,255,255,0.35)',
                background: typeOn[t] ? 'rgba(255,255,255,0.04)' : 'transparent',
              }}
            >
              <span className="w-2 h-2 rounded-sm" style={{ background: typeOn[t] ? TYPE_META[t].color : 'rgba(255,255,255,0.2)' }} />
              {TYPE_META[t].label}
            </button>
          ))}
        </div>
        {/* 状态过滤 */}
        {stateOptions.length > 0 && (
          <select
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value)}
            className="px-2 py-1 rounded-md text-[11px] bg-white/5 border border-white/10 text-white/70 outline-none"
          >
            <option value="">全部状态</option>
            {stateOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
        {/* 版本过滤 */}
        {versionOptions.length > 0 && (
          <select
            value={versionFilter}
            onChange={(e) => setVersionFilter(e.target.value)}
            className="px-2 py-1 rounded-md text-[11px] bg-white/5 border border-white/10 text-white/70 outline-none"
          >
            <option value="">全部版本</option>
            {versionOptions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        )}
        {/* 搜索 */}
        <div className="flex items-center gap-1 px-2 py-1 rounded-md bg-white/5 border border-white/10">
          <Search size={12} className="text-white/40" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索定位节点"
            className="bg-transparent text-[11px] text-white outline-none w-28"
          />
        </div>
        {/* 模式切换 */}
        <button
          onClick={() => {
            setMode((m) => (m === 'trace' ? 'collapse' : 'trace'));
            setTraceAnchor(null);
          }}
          className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border ${
            mode === 'trace' ? 'border-amber-400/60 text-amber-300 bg-amber-400/10' : 'border-white/10 text-white/50 hover:bg-white/5'
          }`}
          title="追溯模式下，点击节点沿关系路径高亮"
        >
          <GitFork size={12} /> 追溯模式
        </button>
        {/* 视图切换：卡片 / 圆点 */}
        <div className="flex rounded-md border border-white/10 overflow-hidden">
          <button onClick={() => setView('card')} className={`px-2 py-1 text-[11px] ${view === 'card' ? 'bg-white/10 text-white' : 'text-white/45 hover:bg-white/5'}`}>卡片</button>
          <button onClick={() => setView('dot')} className={`px-2 py-1 text-[11px] ${view === 'dot' ? 'bg-white/10 text-white' : 'text-white/45 hover:bg-white/5'}`}>圆点</button>
        </div>
        {/* 布局切换：整理（按类型分列）/ 离散（力导向有机散布） */}
        <div className="flex rounded-md border border-white/10 overflow-hidden">
          <button onClick={() => setLayout('tidy')} className={`px-2 py-1 text-[11px] ${layout === 'tidy' ? 'bg-white/10 text-white' : 'text-white/45 hover:bg-white/5'}`} title="按类型分列排好">整理</button>
          <button onClick={() => setLayout('scatter')} className={`px-2 py-1 text-[11px] ${layout === 'scatter' ? 'bg-white/10 text-white' : 'text-white/45 hover:bg-white/5'}`} title="力导向有机散布（参考 Obsidian）">离散</button>
        </div>
        {/* 追溯中提示 */}
        {traceAnchor && (
          <span className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-amber-300 bg-amber-400/10 border border-amber-400/30">
            追溯中
            <button onClick={() => setTraceAnchor(null)} className="hover:text-white">
              <X size={11} />
            </button>
          </span>
        )}
      </div>

      {/* 画布 */}
      <div className="flex-1 min-h-0 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onInit={(inst) => { rfRef.current = inst; }}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onNodeMouseEnter={onNodeMouseEnter}
          onNodeMouseLeave={onNodeMouseLeave}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.25 }}
          minZoom={0.12}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          nodesConnectable={false}
          nodesDraggable
          elementsSelectable
          /* 手势统一，详见 .claude/rules/gesture-unification.md */
          panOnScroll
          panOnScrollSpeed={0.8}
          panOnDrag
          zoomOnScroll={false}
          zoomOnPinch
          zoomOnDoubleClick={false}
          zoomActivationKeyCode={['Meta', 'Control']}
          panActivationKeyCode="Space"
          selectionOnDrag={false}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="rgba(255,255,255,0.04)" />
          <MiniMap
            style={{ background: 'rgba(0,0,0,0.4)', borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)' }}
            maskColor="rgba(0,0,0,0.6)"
            nodeColor={(n) => TYPE_META[idType(n.id)]?.color ?? '#888'}
            pannable
            zoomable={false}
          />
          <Controls showInteractive={false} />
        </ReactFlow>
        <div className="absolute bottom-3 left-3 text-[10px] text-white/35 bg-black/40 border border-white/10 rounded-md px-2 py-1">
          {mode === 'trace' ? '点击节点：高亮其关系路径' : '点击节点：查看详情'}
        </div>

        {/* 详情抽屉 */}
        {selected && (
          <NodeDrawer
            node={selected}
            productId={selected.productId ?? productId ?? ''}
            buildChain={buildChain}
            onClose={() => setSelected(null)}
            onTrace={() => {
              setTraceAnchor(selected.id);
            }}
            onOpenDetail={() => {
              const [t, rawId] = selected.id.split(':', 2);
              const pid = selected.productId ?? productId;
              if (pid && (t === 'requirement' || t === 'feature' || t === 'defect')) window.open(`/product-agent/p/${pid}/${t}/${rawId}`, '_blank', 'noopener');
            }}
          />
        )}
      </div>
    </div>
  );
}

function NodeDrawer({
  node,
  productId,
  buildChain,
  onClose,
  onTrace,
  onOpenDetail,
}: {
  node: GraphNode;
  productId: string;
  buildChain: (anchorId: string) => { nodes: { id: string; type: string; label: string; sub: string | null }[]; edges: { source: string; target: string; type: string }[] };
  onClose: () => void;
  onTrace: () => void;
  onOpenDetail: () => void;
}) {
  const meta = TYPE_META[idType(node.id)];
  const type = idType(node.id);
  const rawId = node.id.split(':', 2)[1] ?? '';
  const canOpen = ['requirement', 'feature', 'defect'].includes(type);
  const [rows, setRows] = useState<{ label: string; value: string }[]>([]);
  const [desc, setDesc] = useState<string>('');
  const [busy, setBusy] = useState(true);
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryMsg, setSummaryMsg] = useState<string | null>(null);
  const [summaryBy, setSummaryBy] = useState<string | null>(null);
  const autoTried = useRef(false);

  // 关系分析（追溯模式下，对整条关系链 AI 流式分析）
  const [analysisStarted, setAnalysisStarted] = useState(false);
  const [analysisCopied, setAnalysisCopied] = useState(false);
  const analysis = useSseStream({ url: '/api/product/graph/relation-analysis/stream', method: 'POST' });
  const copyAnalysis = () => {
    const text = stripMarkdown(analysis.typing);
    if (!text) return;
    void navigator.clipboard?.writeText(text).then(() => {
      setAnalysisCopied(true);
      setTimeout(() => setAnalysisCopied(false), 1500);
    });
  };
  const runAnalysis = () => {
    onTrace(); // 同时点亮整条追溯链
    setAnalysisStarted(true);
    const chain = buildChain(node.id);
    void analysis.start({ body: { productId, anchorId: node.id, nodes: chain.nodes, edges: chain.edges } });
  };

  const runSummary = useCallback(async (force = false) => {
    setSummaryBusy(true);
    setSummaryMsg(null);
    const res = await summarizeItem(type, rawId, force);
    setSummaryBusy(false);
    if (res.success && res.data.summary) { setSummary(res.data.summary); setSummaryBy(res.data.generatedByName ?? null); }
    else setSummaryMsg(res.success ? (res.data.message ?? '暂无可摘要内容') : (res.error?.message ?? '摘要失败'));
  }, [type, rawId]);

  useEffect(() => {
    autoTried.current = false; setSummary(null); setSummaryMsg(null); setSummaryBy(null);
    setAnalysisStarted(false); analysis.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  // 首次展开自动摘要（系统只自动一次；之后用户点「重新摘要」）
  useEffect(() => {
    if (!busy && canOpen && desc && !autoTried.current) {
      autoTried.current = true;
      void runSummary();
    }
  }, [busy, desc, canOpen, runSummary]);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    setRows([]);
    setDesc('');
    void (async () => {
      const r: { label: string; value: string }[] = [];
      let d = '';
      if (type === 'requirement') {
        const [res, cRes, vRes] = await Promise.all([listRequirements(productId), listCustomers(), listVersions(productId)]);
        const o = res.success ? res.data.items.find((x) => x.id === rawId) : undefined;
        if (o) {
          const cName = new Map((cRes.success ? cRes.data.items : []).map((c) => [c.id, c.name] as [string, string]));
          const vName = new Map((vRes.success ? vRes.data.items : []).map((v) => [v.id, v.versionName] as [string, string]));
          r.push(
            { label: '编号', value: o.requirementNo },
            { label: '分级', value: o.grade },
            { label: '状态', value: resolveRequirementStateLabel(o.currentState) || '-' },
            { label: '关联客户', value: o.customerIds.map((id) => cName.get(id) ?? id).join('、') || '—' },
            { label: '归属版本', value: o.versionIds.map((id) => vName.get(id) ?? id).join('、') || '—' },
          );
          d = o.description ?? '';
        }
      } else if (type === 'feature') {
        const res = await listFeatures(productId);
        const o = res.success ? res.data.items.find((x) => x.id === rawId) : undefined;
        if (o) { r.push({ label: '编号', value: o.featureNo }, { label: '状态', value: o.currentState || '-' }, { label: '实现需求', value: String(o.requirementIds.length) }); d = o.description ?? ''; }
      } else if (type === 'version') {
        const res = await listVersions(productId);
        const o = res.success ? res.data.items.find((x) => x.id === rawId) : undefined;
        if (o) { r.push({ label: '生命周期', value: o.lifecycle }, { label: '大版本', value: o.isMajor ? '是' : '否' }, { label: '关联需求', value: String(o.requirementIds.length) }, { label: '纳入功能', value: String(o.featureVersionIds.length) }); d = o.description ?? ''; }
      } else if (type === 'customer') {
        const res = await listCustomers();
        const o = res.success ? res.data.items.find((x) => x.id === rawId) : undefined;
        if (o) { r.push({ label: '公司', value: o.company || '-' }, { label: '联系方式', value: o.contact || '-' }); d = o.description ?? ''; }
      } else if (type === 'defect') {
        const res = await listTracedDefects(productId);
        const o = res.success ? res.data.items.find((x) => x.id === rawId) : undefined;
        if (o) { r.push({ label: '编号', value: o.defectNo }, { label: '状态', value: o.status }, { label: '等级', value: ITEM_GRADE_LABEL[effectiveDefectGrade(o)] }, { label: '追溯', value: o.tracedRequirementId ? '需求' : o.tracedVersionId ? '版本' : '产品' }); }
      } else if (type === 'product') {
        const res = await getProduct(productId);
        const o = res.success ? res.data : undefined;
        if (o) { r.push({ label: '编号', value: o.productNo }, { label: '分级', value: o.grade }, { label: '版本', value: String(o.versionCount) }, { label: '需求', value: String(o.requirementCount) }, { label: '功能', value: String(o.featureCount) }, { label: '缺陷', value: String(o.defectCount) }); d = o.description ?? ''; }
      }
      if (alive) { setRows(r); setDesc(d); setBusy(false); }
    })();
    return () => { alive = false; };
  }, [node.id, productId, type, rawId]);

  return (
    <div className="absolute top-0 right-0 h-full w-80 max-w-[80%] bg-[#16181d] border-l border-white/10 flex flex-col shadow-2xl" style={{ zIndex: 20 }}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
        <span className="flex items-center gap-2 text-sm font-semibold" style={{ color: meta?.color ?? '#fff' }}>
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: meta?.color ?? '#888' }} />
          {meta?.label ?? '节点'}详情
        </span>
        <button onClick={onClose} className="text-white/40 hover:text-white"><X size={16} /></button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-3" style={{ overscrollBehavior: 'contain' }}>
        {/* 操作 */}
        <div className="flex items-center gap-2">
          {canOpen && (
            <button onClick={onOpenDetail} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-sm">
              <ExternalLink size={13} /> 查看详情
            </button>
          )}
          <button onClick={onTrace} className="flex-1 px-3 py-1.5 rounded-lg border border-amber-400/30 text-amber-300 hover:bg-amber-400/10 text-sm">
            追溯关系路径
          </button>
        </div>
        {/* 关系分析：对整条追溯链做 AI 流式分析（需求/功能/缺陷） */}
        {canOpen && (
          <button
            onClick={runAnalysis}
            disabled={analysis.isStreaming}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-500/15 text-violet-200 border border-violet-500/40 hover:bg-violet-500/25 disabled:opacity-50 text-sm"
          >
            {analysis.isStreaming ? <MapSpinner size={13} /> : <Sparkles size={13} />} 关系分析
          </button>
        )}
        {canOpen && analysisStarted && (
          <div className="rounded-lg border border-violet-500/25 bg-violet-500/[0.06] p-3">
            <div className="text-[11px] text-violet-200/80 mb-1.5 flex items-center gap-1">
              <Sparkles size={11} /> 关系链分析
              {analysis.phase === 'connecting' && <span className="text-white/40">· 连接中…</span>}
              {analysis.phase === 'streaming' && <span className="text-white/40">· 分析中…</span>}
              {analysis.typing && !analysis.isStreaming && (
                <button
                  onClick={copyAnalysis}
                  className="ml-auto flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-white/50 hover:text-white/90"
                  title="复制分析内容"
                >
                  {analysisCopied ? <Check size={11} /> : <Copy size={11} />} {analysisCopied ? '已复制' : '复制'}
                </button>
              )}
            </div>
            {analysis.phase === 'error' ? (
              <div className="text-amber-300/80 text-sm">{analysis.phaseMessage || '分析失败，请重试'}</div>
            ) : analysis.typing ? (
              <div className="text-[13px] text-white/85 leading-relaxed whitespace-pre-wrap">
                <StreamingText text={stripMarkdown(analysis.typing)} streaming={analysis.isStreaming} />
              </div>
            ) : (
              <div className="text-white/40 text-sm flex items-center gap-1.5"><MapSpinner size={12} /> 正在汇总关系链…</div>
            )}
          </div>
        )}
        {/* 详情直接展示 */}
        <div className="text-base text-white font-medium">{node.label}</div>
        {busy ? (
          <MapSectionLoader text="正在加载…" />
        ) : (
          <>
            <div className="flex flex-col gap-2 text-xs rounded-lg border border-white/10 bg-white/[0.02] p-3">
              {rows.length === 0 ? (
                <div className="text-white/35 text-center py-2">无更多字段</div>
              ) : (
                rows.map((row, i) => <DrawerRow key={i} label={row.label} value={row.value} />)
              )}
            </div>
            {/* 摘要：需求/功能/缺陷首次展开自动 AI 摘要；其它类型显示干净纯文本节选 */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] text-white/40 flex items-center gap-1">
                  {canOpen ? <><Sparkles size={11} className="text-cyan-300/80" /> AI 摘要</> : '描述节选'}
                </span>
                {canOpen && desc && (
                  <button
                    onClick={() => runSummary(true)}
                    disabled={summaryBusy}
                    className="flex items-center gap-1 text-[11px] text-cyan-300 hover:text-cyan-200 disabled:opacity-50"
                  >
                    {summaryBusy ? <MapSpinner size={11} /> : <Sparkles size={11} />} 重新摘要
                  </button>
                )}
              </div>
              <div className="text-sm text-white/80 whitespace-pre-wrap rounded-lg border border-white/10 bg-white/[0.02] p-3 min-h-[60px]">
                {canOpen ? (
                  summaryBusy ? (
                    <span className="text-white/40 flex items-center gap-1.5"><MapSpinner size={12} /> AI 摘要中…</span>
                  ) : summary ? (
                    <>
                      {summary}
                      {summaryBy && <div className="mt-2 text-[10px] text-white/30">由 {summaryBy} 生成 · 重新摘要可更新</div>}
                    </>
                  ) : summaryMsg ? (
                    <span className="text-amber-300/80">{summaryMsg}</span>
                  ) : !desc ? (
                    <span className="text-white/30">（未填写描述）</span>
                  ) : (
                    <span className="text-white/40">准备摘要…</span>
                  )
                ) : desc ? (
                  <span className="text-white/70">{htmlToText(desc).slice(0, 240)}{htmlToText(desc).length > 240 ? '…' : ''}</span>
                ) : (
                  <span className="text-white/30">（未填写）</span>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function DrawerRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <span className="text-white/40 w-20 shrink-0">{label}</span>
      <span className="text-white/80">{value}</span>
    </div>
  );
}

/** 圆点视图自定义节点：彩色圆点(大小随重要度) + 下方名称；选中时圆点外圈白色光环。 */
function DotNode({ data }: NodeProps) {
  const d = data as { label: string; color: string; size: number; selected?: boolean; delay?: number };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 130 }}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div
        className={`pa-dot${d.selected ? ' sel' : ''}`}
        style={{
          width: d.size,
          height: d.size,
          borderRadius: '50%',
          background: d.color,
          boxShadow: d.selected ? `0 0 0 3px #fff, 0 0 22px ${d.color}` : `0 0 14px ${d.color}99`,
          border: d.selected ? '2px solid #fff' : '2px solid rgba(255,255,255,0.3)',
          // 所有圆点常态呼吸（错峰），选中/激活时更大幅度脉冲（class 驱动，便于 reduce-motion 降级）
          animationDelay: `${d.delay ?? 0}s`,
        }}
      />
      <div style={{ marginTop: 6, fontSize: 10, color: d.selected ? '#fff' : 'rgba(255,255,255,0.78)', textAlign: 'center', whiteSpace: 'pre-line', lineHeight: 1.25 }}>
        {d.label}
      </div>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

const NODE_TYPES = { dot: DotNode };

/**
 * 图谱激活态动效。用 CSS `translate` 属性（与 ReactFlow 的 transform: translate 叠加，不抢定位）
 * 让激活节点微微浮动；圆点内圈用 transform scale 呼吸（内层 div，安全）。尊重 reduce-motion。
 */
const GRAPH_FX_CSS = `
@keyframes paGraphFloat { 0%, 100% { translate: 0 0; } 50% { translate: 0 -8px; } }
@keyframes paGraphDotPulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.42); } }
@keyframes paGraphDotBreath { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.14); } }
.pa-graph-active { animation: paGraphFloat 2.4s ease-in-out infinite; will-change: translate; }
.pa-dot { animation: paGraphDotBreath 3.2s ease-in-out infinite; will-change: transform; }
.pa-dot.sel { animation: paGraphDotPulse 1.8s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .pa-graph-active, .pa-dot, .pa-dot.sel { animation: none; }
}
`;

function baseStyle(color: string): CSSProperties {
  return {
    background: 'rgba(255,255,255,0.03)',
    border: `1px solid ${color}`,
    borderLeft: `4px solid ${color}`,
    borderRadius: 10,
    color: '#e8e8ec',
    fontSize: 11,
    width: 196,
    whiteSpace: 'pre-line',
    padding: '6px 10px',
  };
}

export function ProductGraphCanvas({ productId, overview, focusNodeId }: { productId?: string; overview?: boolean; focusNodeId?: string }) {
  return (
    <ReactFlowProvider>
      <ProductGraphInner productId={productId} overview={overview} focusNodeId={focusNodeId} />
    </ReactFlowProvider>
  );
}
