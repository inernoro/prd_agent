/**
 * 知识库宇宙图（Graph View）。
 *
 * 数据：GET /api/mentions/stores/:storeId/graph
 * 渲染：canvas 力导向 + Obsidian 风格设置面板（Filters / Groups / Display / Forces）。
 *
 * 路由：/document-store/:storeId/universe（来自 navRegistry 的 store-scoped 入口）
 * 也支持顶层 /document-store/universe（用户自选库）。
 *
 * 详见 doc/design.knowledge-base-mention-network.md §宇宙图。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Settings as SettingsIcon, ArrowLeft, Loader2 } from 'lucide-react';
import { getStoreGraph, type GraphNode, type GraphEdge } from '@/services/real/mentions';
import { listDocumentStoresReal } from '@/services/real/documentStore';
import type { DocumentStore } from '@/services/contracts/documentStore';

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

export function UniverseGraphPage() {
  const { storeId: storeIdParam } = useParams();
  const navigate = useNavigate();
  const [storeId, setStoreId] = useState<string | undefined>(storeIdParam);
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

  // 进入页面时如未指定 storeId，先取当前用户的库列表
  useEffect(() => {
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
  }, [storeId]);

  // 拉图数据
  useEffect(() => {
    if (!storeId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getStoreGraph(storeId)
      .then((res) => {
        if (cancelled) return;
        if (!res.success) {
          setError(res.error?.message || '加载宇宙图失败');
          return;
        }
        setNodes(res.data.nodes);
        setEdges(res.data.edges);
        setStoreName(res.data.storeName);
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
  }, [storeId]);

  // ── canvas 引用 + 力导向模拟（保持在 ref 中以避免 React state 频繁渲染） ──
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simNodesRef = useRef<SimNode[]>([]);
  const adjacencyRef = useRef<Map<string, Set<string>>>(new Map());
  const viewRef = useRef({ tx: 0, ty: 0, scale: 1 });
  const sizeRef = useRef({ W: 0, H: 0 });
  const rafRef = useRef<number>();

  // 初始化模拟节点
  useEffect(() => {
    const W = window.innerWidth;
    const H = window.innerHeight;
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
    simNodesRef.current = nodes.map((n) => ({
      ...n,
      x: W / 2 + (Math.random() - 0.5) * 500,
      y: H / 2 + (Math.random() - 0.5) * 500,
      vx: 0,
      vy: 0,
      fx: 0,
      fy: 0,
      baseR: 3 + Math.sqrt(total(n.id)) * 1.4,
    }));
    // 预热
    for (let i = 0; i < 250; i++) simulate();
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
    const idMap = new Map<string, SimNode>();
    ns.forEach((n) => idMap.set(n.id, n));
    const springK = 0.003 + st.linkForce * 0.025;
    for (const e of edges) {
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

  const isNodeVisible = (n: SimNode): boolean => {
    const st = stateRef.current;
    const catKey = n.category ?? '__default__';
    if (!st.enabledCats.has(catKey)) return false;
    if (!st.showOrphans && (adjacencyRef.current.get(n.id)?.size ?? 0) === 0) return false;
    if (st.searchQuery) {
      if (!n.title?.toLowerCase().includes(st.searchQuery.toLowerCase())) return false;
    }
    return true;
  };

  const getHighlightSet = (): Set<string> | null => {
    const id = focusNodeId ?? hoverNodeId;
    if (!id) return null;
    const adj = adjacencyRef.current.get(id) ?? new Set();
    return new Set([id, ...adj]);
  };

  // ── 渲染循环 ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    const resize = () => {
      const W = window.innerWidth;
      const H = window.innerHeight;
      sizeRef.current = { W, H };
      const dpr = window.devicePixelRatio || 1;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

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
      const idMap = new Map<string, SimNode>();
      ns.forEach((n) => idMap.set(n.id, n));

      // 边
      ctx.lineWidth = st.linkWidth / sc;
      for (const e of edges) {
        const a = idMap.get(e.from);
        const b = idMap.get(e.to);
        if (!a || !b) continue;
        if (!isNodeVisible(a) || !isNodeVisible(b)) continue;
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

        if (n.id === focusNodeId) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1.5 / sc;
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 3 / sc, 0, Math.PI * 2);
          ctx.stroke();
        } else if (n.id === hoverNodeId) {
          ctx.strokeStyle = 'rgba(255,255,255,0.7)';
          ctx.lineWidth = 1 / sc;
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 2 / sc, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      // 标签
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
          ctx.fillText(n.title ?? '', n.x, n.y + r + 4 / sc);
        }
      }

      ctx.restore();
    };

    const loop = () => {
      simulate();
      render();
      rafRef.current = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', resize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edges, hoverNodeId, focusNodeId, nodes]);

  // ── 鼠标交互 ──
  const dragRef = useRef<{
    mode: 'pan' | 'node' | null;
    node?: SimNode;
    sx: number;
    sy: number;
    startTx: number;
    startTy: number;
  }>({ mode: null, sx: 0, sy: 0, startTx: 0, startTy: 0 });

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
    const n = pickNode(e.clientX, e.clientY);
    if (n) {
      dragRef.current = { mode: 'node', node: n, sx: e.clientX, sy: e.clientY, startTx: 0, startTy: 0 };
      n.dragged = true;
    } else {
      dragRef.current = {
        mode: 'pan',
        sx: e.clientX,
        sy: e.clientY,
        startTx: viewRef.current.tx,
        startTy: viewRef.current.ty,
      };
    }
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const d = dragRef.current;
    if (d.mode === 'pan') {
      viewRef.current.tx = d.startTx + (e.clientX - d.sx);
      viewRef.current.ty = d.startTy + (e.clientY - d.sy);
    } else if (d.mode === 'node' && d.node) {
      const { x, y } = screenToWorld(e.clientX, e.clientY);
      d.node.x = x;
      d.node.y = y;
      d.node.vx = 0;
      d.node.vy = 0;
    } else {
      const n = pickNode(e.clientX, e.clientY);
      setHoverNodeId(n?.id ?? null);
    }
  };

  const onMouseUp = (e: React.MouseEvent) => {
    const d = dragRef.current;
    if (d.mode === 'node' && d.node) {
      d.node.dragged = false;
      const movedDist = Math.hypot(e.clientX - d.sx, e.clientY - d.sy);
      if (movedDist < 4) {
        // 点击：聚焦 + 居中
        if (focusNodeId === d.node.id) {
          setFocusNodeId(null);
        } else {
          setFocusNodeId(d.node.id);
          const target = d.node;
          const scale = Math.max(viewRef.current.scale, 1.2);
          viewRef.current.scale = scale;
          viewRef.current.tx = sizeRef.current.W / 2 - target.x * scale;
          viewRef.current.ty = sizeRef.current.H / 2 - target.y * scale;
          setZoomBadge(Math.round(scale * 100));
        }
      }
    }
    dragRef.current = { mode: null, sx: 0, sy: 0, startTx: 0, startTy: 0 };
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.9;
    const { x, y } = screenToWorld(e.clientX, e.clientY);
    let s = viewRef.current.scale * factor;
    s = Math.max(0.25, Math.min(4, s));
    viewRef.current.scale = s;
    viewRef.current.tx = e.clientX - x * s;
    viewRef.current.ty = e.clientY - y * s;
    setZoomBadge(Math.round(s * 100));
  };

  const onDoubleClickNode = () => {
    if (focusNodeId && storeId) {
      // 把当前库 + 目标条目存到 sessionStorage，DocumentStorePage 会自动恢复选中状态
      sessionStorage.setItem('doc-store-selected-id', storeId);
      sessionStorage.setItem('doc-store-pending-entry', focusNodeId);
      navigate('/document-store');
    }
  };

  // 当前 hover 节点信息（用于浮 tooltip）
  const hoverNode = useMemo(() => simNodesRef.current.find((n) => n.id === hoverNodeId) ?? null, [hoverNodeId]);

  // 类别清单（用于 Groups 渲染）
  const categories = useMemo(() => {
    const map = new Map<string, number>();
    nodes.forEach((n) => {
      const k = n.category ?? '__default__';
      map.set(k, (map.get(k) ?? 0) + 1);
    });
    return Array.from(map.entries());
  }, [nodes]);

  // 类别启用切换
  const toggleCategory = (cat: string) => {
    const s = new Set(stateRef.current.enabledCats);
    if (s.has(cat)) s.delete(cat);
    else s.add(cat);
    stateRef.current.enabledCats = s;
    // 触发重渲染（state 没变，但 ref 变了；用 setNodes 触发即可）
    setHoverNodeId((id) => id);
  };

  if (!storeId) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ background: '#1e1e1e', color: '#cfcfcf' }}>
        <div>正在加载知识库列表...</div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col relative" style={{ background: '#1e1e1e', color: '#cfcfcf', minHeight: 0 }}>
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

      {/* 返回 + 库名 */}
      <div style={{ position: 'absolute', top: 12, left: 56, zIndex: 11, display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          onClick={() => {
            // 回到知识库详情：把当前库 ID 塞回 sessionStorage，让 DocumentStorePage 自动选中
            if (storeId) sessionStorage.setItem('doc-store-selected-id', storeId);
            navigate('/document-store');
          }}
          style={{
            background: 'rgba(45,45,45,0.85)',
            border: '1px solid #3a3a3a',
            borderRadius: 6,
            padding: '6px 10px',
            color: '#cfcfcf',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
          }}
        >
          <ArrowLeft size={12} /> 返回
        </button>
        <div style={{ fontSize: 13, color: '#8a8a8a' }}>
          {storeName} · {nodes.length} 节点 · {edges.length} 引用
        </div>
      </div>

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
            top: 56,
            left: 12,
            width: 280,
            background: 'rgba(36,36,36,0.96)',
            backdropFilter: 'blur(8px)',
            border: '1px solid #3a3a3a',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            zIndex: 12,
            maxHeight: 'calc(100vh - 80px)',
            overflowY: 'auto',
            padding: 12,
            fontSize: 12,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 10, color: '#d4d4d4' }}>Graph 设置</div>

          {/* Filters */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: '#8a8a8a', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>Filters</div>
            <input
              type="text"
              placeholder="搜索文档标题..."
              onChange={(e) => {
                stateRef.current.searchQuery = e.target.value;
                setHoverNodeId((id) => id);
              }}
              style={{
                width: '100%',
                background: '#2a2a2a',
                border: '1px solid #3a3a3a',
                borderRadius: 4,
                padding: '6px 8px',
                color: '#cfcfcf',
                fontSize: 12,
                outline: 'none',
              }}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, cursor: 'pointer', color: '#cfcfcf' }}>
              <input
                type="checkbox"
                defaultChecked
                onChange={(e) => {
                  stateRef.current.showOrphans = e.target.checked;
                  setHoverNodeId((id) => id);
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

      {/* 库切换器 */}
      {stores.length > 1 && (
        <select
          value={storeId}
          onChange={(e) => {
            setStoreId(e.target.value);
            navigate(`/document-store/${e.target.value}/universe`);
          }}
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            background: 'rgba(36,36,36,0.85)',
            border: '1px solid #3a3a3a',
            borderRadius: 6,
            padding: '6px 10px',
            color: '#cfcfcf',
            fontSize: 12,
            zIndex: 11,
          }}
        >
          {stores.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
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
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{hoverNode.title}</div>
          {hoverNode.summary && <div style={{ color: '#9a9a9a', fontSize: 11, lineHeight: 1.5 }}>{hoverNode.summary.slice(0, 120)}</div>}
          <div style={{ marginTop: 6, fontSize: 10, color: '#666' }}>
            双击进入文档
          </div>
        </div>
      )}

      {/* 缩放显示 */}
      <div
        style={{
          position: 'absolute',
          bottom: 12,
          right: 12,
          background: 'rgba(36,36,36,0.85)',
          border: '1px solid #3a3a3a',
          borderRadius: 6,
          padding: '6px 10px',
          fontSize: 11,
          color: '#8a8a8a',
          zIndex: 11,
        }}
      >
        {zoomBadge}%
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
        滚轮缩放 · 拖动平移 · 悬停看预览 · 点击聚焦 · 双击进入文档
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
    </div>
  );
}
