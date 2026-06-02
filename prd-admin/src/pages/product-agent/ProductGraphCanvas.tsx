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
import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  MiniMap,
  Controls,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Search, GitFork, Maximize2, Minimize2, X } from 'lucide-react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { getProductGraph, type GraphNode, type GraphEdge } from '@/services/real/productAgent';

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

function ProductGraphInner({ productId }: { productId: string }) {
  const [raw, setRaw] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [typeOn, setTypeOn] = useState<Record<NodeType, boolean>>(
    () => Object.fromEntries(ALL_TYPES.map((t) => [t, true])) as Record<NodeType, boolean>,
  );
  const [stateFilter, setStateFilter] = useState('');
  const [versionFilter, setVersionFilter] = useState('');
  const [keyword, setKeyword] = useState('');
  const [mode, setMode] = useState<'collapse' | 'trace'>('collapse');
  const [traceAnchor, setTraceAnchor] = useState<string | null>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      setLoading(true);
      const res = await getProductGraph(productId);
      if (!alive) return;
      if (res.success) setRaw(res.data);
      else setError(res.error?.message ?? '加载图谱失败');
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [productId]);

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
      versionScope = new Set<string>([versionFilter, `product:${productId}`]);
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
    const rfNodes: Node[] = raw.nodes
      .filter((n) => visibleIds.has(n.id))
      .map((n) => {
        const meta = TYPE_META[n.type];
        const row = colRow[meta.col] ?? 0;
        colRow[meta.col] = row + 1;
        const desc = derived.descCount.get(n.id) ?? 0;
        const isCollapsed = collapsed.has(n.id) && desc > 0;
        return {
          id: n.id,
          position: { x: meta.col * COL_GAP, y: row * ROW_GAP },
          data: { label: `${n.label}${isCollapsed ? ` (+${desc})` : ''}${n.sub ? `\n${n.sub}` : ''}` },
          style: baseStyle(meta.color),
        };
      });
    const rfEdges: Edge[] = raw.edges
      .filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
      .map((e) => ({ id: e.id, source: e.source, target: e.target, style: { stroke: 'rgba(255,255,255,0.16)' } }));
    setNodes(rfNodes);
    setEdges(rfEdges);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey]);

  // ── 样式：搜索/追溯变化时只改样式，不重排版（拖拽位置得以保留）──
  useEffect(() => {
    const kw = keyword.trim();
    setNodes((ns) =>
      ns.map((node) => {
        const type = idType(node.id);
        const color = TYPE_META[type]?.color ?? '#888';
        let dim = false;
        let ring: string | null = null;
        if (traceIds) {
          if (node.id === traceAnchor) ring = '#FBBF24';
          else if (traceIds.has(node.id)) ring = 'rgba(251,191,36,0.6)';
          else dim = true;
        }
        if (kw) {
          if (matchIds.has(node.id)) ring = '#22D3EE';
          else if (!ring) dim = true;
        }
        return { ...node, style: { ...baseStyle(color), opacity: dim ? 0.18 : 1, ...(ring ? { boxShadow: `0 0 0 2px ${ring}` } : {}) } };
      }),
    );
    setEdges((es) =>
      es.map((e) => {
        const inTrace = traceIds && traceIds.has(e.source) && traceIds.has(e.target);
        return {
          ...e,
          animated: !!inTrace,
          style: { stroke: inTrace ? 'rgba(251,191,36,0.7)' : 'rgba(255,255,255,0.16)', opacity: traceIds && !inTrace ? 0.12 : 1 },
        };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceAnchor, traceIds, keyword, matchIds, visibleKey]);

  const onNodeClick = (_e: ReactMouseEvent, node: Node) => {
    if (mode === 'trace') {
      setTraceAnchor((prev) => (prev === node.id ? null : node.id));
      return;
    }
    // 折叠模式：有后代才可折叠/展开
    if ((derived.descCount.get(node.id) ?? 0) > 0) {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(node.id)) next.delete(node.id);
        else next.add(node.id);
        return next;
      });
    }
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
    <div className="h-full min-h-0 flex flex-col">
      {/* 控制栏 */}
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-1 pb-2">
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
          fitView
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
          {mode === 'trace' ? '点击节点：高亮其关系路径' : '点击节点：展开 / 收起子节点'}
        </div>
      </div>
    </div>
  );
}

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

export function ProductGraphCanvas({ productId }: { productId: string }) {
  return (
    <ReactFlowProvider>
      <ProductGraphInner productId={productId} />
    </ReactFlowProvider>
  );
}
