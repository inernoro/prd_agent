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
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Search, GitFork, Maximize2, Minimize2, X, Sparkles, ExternalLink } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';

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

function ProductGraphInner({ productId, overview }: { productId?: string; overview?: boolean }) {
  const [raw, setRaw] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [typeOn, setTypeOn] = useState<Record<NodeType, boolean>>(
    () => Object.fromEntries(ALL_TYPES.map((t) => [t, true])) as Record<NodeType, boolean>,
  );
  const [stateFilter, setStateFilter] = useState('');
  const [versionFilter, setVersionFilter] = useState('');
  const [keyword, setKeyword] = useState('');
  const [mode, setMode] = useState<'collapse' | 'trace'>('collapse');
  const [traceAnchor, setTraceAnchor] = useState<string | null>(null);
  const [view, setView] = useState<'card' | 'dot'>('card');

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

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

    // 折叠：祖先链上有任一被折叠则隐藏
    const ancestorCollapsed = (id: string) => {
      let cur = derived.parentOf.get(id);
      while (cur) {
        if (collapsed.has(cur)) return true;
        cur = derived.parentOf.get(cur);
      }
      return false;
    };

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
      if (ancestorCollapsed(n.id)) continue;
      vis.add(n.id);
    }
    return { visibleIds: vis, matchIds: match };
  }, [raw, derived, collapsed, typeOn, stateFilter, versionFilter, keyword, productId]);

  // ── 追溯集合：从锚点沿关系路径(无向)可达 ──
  const traceIds = useMemo(() => {
    if (!traceAnchor || !raw) return null;
    const reached = new Set<string>([traceAnchor]);
    const queue = [traceAnchor];
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
  }, [traceAnchor, raw, derived]);

  // 可见集合 key（仅成员变化才重排版）
  const visibleKey = useMemo(() => Array.from(visibleIds).sort().join('|'), [visibleIds]);

  // ── 成员/布局：可见集合变化时重建节点与边（列布局，紧凑）──
  useEffect(() => {
    if (!raw) return;
    const colRow: Record<number, number> = {};
    const dotRowGap = 96;
    const rfNodes: Node[] = raw.nodes
      .filter((n) => visibleIds.has(n.id))
      .map((n) => {
        const meta = TYPE_META[n.type];
        const row = colRow[meta.col] ?? 0;
        colRow[meta.col] = row + 1;
        const desc = derived.descCount.get(n.id) ?? 0;
        const isCollapsed = collapsed.has(n.id) && desc > 0;
        const label = `${n.label}${isCollapsed ? ` (+${desc})` : ''}${n.sub ? `\n${n.sub}` : ''}`;
        if (view === 'dot') {
          // 圆点视图：大小随后代数（重要度），颜色随类型，名称在圆点下方
          const size = 16 + Math.min(desc, 10) * 4;
          return {
            id: n.id,
            type: 'dot',
            position: { x: meta.col * COL_GAP, y: row * dotRowGap },
            data: { label, color: meta.color, size },
            style: {},
          };
        }
        return {
          id: n.id,
          position: { x: meta.col * COL_GAP, y: row * ROW_GAP },
          data: { label },
          style: baseStyle(meta.color),
        };
      });
    const rfEdges: Edge[] = raw.edges
      .filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
      .map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: EDGE_LABEL[e.type] ?? e.type,
        labelStyle: { fill: 'rgba(255,255,255,0.55)', fontSize: 10 },
        labelBgStyle: { fill: '#0f1014', fillOpacity: 0.85 },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 4,
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: 'rgba(255,255,255,0.45)' },
        style: { stroke: 'rgba(255,255,255,0.18)' },
      }));
    setNodes(rfNodes);
    setEdges(rfEdges);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey, view]);

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
        if (view === 'dot') {
          return { ...node, data: { ...(node.data as object), selected: isSel }, style: { opacity: dim ? 0.16 : 1 } };
        }
        const baseS = baseStyle(color);
        return { ...node, style: { ...baseS, opacity: dim ? 0.16 : 1, ...(ring ? { boxShadow: `0 0 0 ${isSel ? 3 : 2}px ${ring}` } : {}) } };
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
            ? { type: MarkerType.ArrowClosed, width: 16, height: 16, color: edgeColor }
            : e.markerEnd,
          style: {
            stroke: inTrace ? edgeColor : 'rgba(255,255,255,0.16)',
            strokeWidth: inTrace ? 2 : 1,
            opacity: traceIds && !inTrace ? 0.1 : 1,
          },
        };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceAnchor, traceIds, keyword, matchIds, visibleKey, view, selected]);

  const onNodeClick = (_e: ReactMouseEvent, node: Node) => {
    if (mode === 'trace') {
      setTraceAnchor((prev) => (prev === node.id ? null : node.id));
      return;
    }
    // 默认：点击任一节点弹出右侧详情抽屉
    setSelected(raw?.nodes.find((n) => n.id === node.id) ?? null);
  };

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
        {/* 全部展开/收起 */}
        <button
          onClick={() => setCollapsed(new Set())}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border border-white/10 text-white/50 hover:bg-white/5"
        >
          <Maximize2 size={12} /> 全部展开
        </button>
        <button
          onClick={() => {
            // 收起到产品：折叠所有有后代的非产品节点
            const next = new Set<string>();
            raw?.nodes.forEach((n) => {
              if (n.type !== 'product' && (derived.descCount.get(n.id) ?? 0) > 0) next.add(n.id);
            });
            setCollapsed(next);
          }}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border border-white/10 text-white/50 hover:bg-white/5"
        >
          <Minimize2 size={12} /> 收起
        </button>
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
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
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
  onClose,
  onTrace,
  onOpenDetail,
}: {
  node: GraphNode;
  productId: string;
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

  const runSummary = useCallback(async (force = false) => {
    setSummaryBusy(true);
    setSummaryMsg(null);
    const res = await summarizeItem(type, rawId, force);
    setSummaryBusy(false);
    if (res.success && res.data.summary) { setSummary(res.data.summary); setSummaryBy(res.data.generatedByName ?? null); }
    else setSummaryMsg(res.success ? (res.data.message ?? '暂无可摘要内容') : (res.error?.message ?? '摘要失败'));
  }, [type, rawId]);

  useEffect(() => { autoTried.current = false; setSummary(null); setSummaryMsg(null); setSummaryBy(null); }, [node.id]);

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
        const [res, cRes, vRes] = await Promise.all([listRequirements(productId), listCustomers(productId), listVersions(productId)]);
        const o = res.success ? res.data.items.find((x) => x.id === rawId) : undefined;
        if (o) {
          const cName = new Map((cRes.success ? cRes.data.items : []).map((c) => [c.id, c.name] as [string, string]));
          const vName = new Map((vRes.success ? vRes.data.items : []).map((v) => [v.id, v.versionName] as [string, string]));
          r.push(
            { label: '编号', value: o.requirementNo },
            { label: '分级', value: o.grade },
            { label: '状态', value: o.currentState || '-' },
            { label: '关联客户', value: o.customerIds.map((id) => cName.get(id) ?? id).join('、') || '—' },
            { label: '归属版本', value: o.versionIds.map((id) => vName.get(id) ?? id).join('、') || '—' },
          );
          d = o.description ?? '';
        }
      } else if (type === 'feature') {
        const res = await listFeatures(productId);
        const o = res.success ? res.data.items.find((x) => x.id === rawId) : undefined;
        if (o) { r.push({ label: '编号', value: o.featureNo }, { label: '分级', value: o.grade }, { label: '状态', value: o.currentState || '-' }, { label: '实现需求', value: String(o.requirementIds.length) }); d = o.description ?? ''; }
      } else if (type === 'version') {
        const res = await listVersions(productId);
        const o = res.success ? res.data.items.find((x) => x.id === rawId) : undefined;
        if (o) { r.push({ label: '生命周期', value: o.lifecycle }, { label: '大版本', value: o.isMajor ? '是' : '否' }, { label: '关联需求', value: String(o.requirementIds.length) }, { label: '纳入功能', value: String(o.featureVersionIds.length) }); d = o.description ?? ''; }
      } else if (type === 'customer') {
        const res = await listCustomers(productId);
        const o = res.success ? res.data.items.find((x) => x.id === rawId) : undefined;
        if (o) { r.push({ label: '公司', value: o.company || '-' }, { label: '联系方式', value: o.contact || '-' }); d = o.description ?? ''; }
      } else if (type === 'defect') {
        const res = await listTracedDefects(productId);
        const o = res.success ? res.data.items.find((x) => x.id === rawId) : undefined;
        if (o) { r.push({ label: '编号', value: o.defectNo }, { label: '状态', value: o.status }, { label: '严重度', value: o.severity || '-' }, { label: '追溯', value: o.tracedRequirementId ? '需求' : o.tracedVersionId ? '版本' : '产品' }); }
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
  const d = data as { label: string; color: string; size: number; selected?: boolean };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 130 }}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div
        style={{
          width: d.size,
          height: d.size,
          borderRadius: '50%',
          background: d.color,
          boxShadow: d.selected ? `0 0 0 3px #fff, 0 0 14px ${d.color}` : `0 0 10px ${d.color}66`,
          border: d.selected ? '2px solid #fff' : '2px solid rgba(255,255,255,0.25)',
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

export function ProductGraphCanvas({ productId, overview }: { productId?: string; overview?: boolean }) {
  return (
    <ReactFlowProvider>
      <ProductGraphInner productId={productId} overview={overview} />
    </ReactFlowProvider>
  );
}
