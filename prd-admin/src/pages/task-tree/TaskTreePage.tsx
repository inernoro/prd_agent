import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, RotateCcw } from 'lucide-react';
import {
  listTaskTrees,
  getTaskTree,
  createTaskTree,
  updateTaskNode,
  listTaskBlockers,
  type TaskTree,
  type TaskNode,
  type TaskStatus,
  type TaskBlockerItem,
} from '@/services';
import { api } from '@/services/api';
import { readSseStream } from '@/lib/sse';
import { useAuthStore } from '@/stores/authStore';
import { toast } from '@/lib/toast';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import './taskTree.css';

const STATUS: Record<TaskStatus, { label: string; color: string }> = {
  idea: { label: '想法', color: '#a3ad7e' },
  planned: { label: '已规划', color: '#54bdaf' },
  building: { label: '进行中', color: '#e6ad42' },
  done: { label: '已完成', color: '#54b96d' },
  blocked: { label: '卡点', color: '#e0563b' },
};
const STATUS_KEYS: TaskStatus[] = ['idea', 'planned', 'building', 'done', 'blocked'];

const CW = 182;
const CH = 56;
const ROWGAP = 34;
const COLGAP = 244;

type Pos = { cx: number; cy: number; x: number; y: number; depth: number };
type Cam = { x: number; y: number; w: number; h: number };

function computeLayout(nodes: TaskNode[], layout: 'h' | 'r'): Record<string, Pos> {
  const root = nodes.find((n) => !n.parentId);
  if (!root) return {};
  const childrenOf = (id: string) =>
    nodes.filter((n) => n.parentId === id).sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));

  const tidy: Record<string, Pos> = {};
  let leaf = 0;
  const walk = (id: string, depth: number): number => {
    const ks = childrenOf(id);
    let y: number;
    if (ks.length === 0) {
      y = leaf * (CH + ROWGAP);
      leaf++;
    } else {
      const ys = ks.map((k) => walk(k.id, depth + 1));
      y = (ys[0] + ys[ys.length - 1]) / 2;
    }
    tidy[id] = { depth, x: depth * COLGAP, y, cx: depth * COLGAP + CW / 2, cy: y + CH / 2 };
    return y;
  };
  walk(root.id, 0);

  if (layout === 'h') return tidy;

  // radial: 用 tidy 的 y 归一化成角度
  let maxY = 0;
  Object.values(tidy).forEach((p) => (maxY = Math.max(maxY, p.y)));
  const RING = 172;
  const pos: Record<string, Pos> = {};
  Object.keys(tidy).forEach((id) => {
    const n = tidy[id];
    const ang = (maxY ? n.y / maxY : 0) * Math.PI * 1.5 - Math.PI * 0.75 - Math.PI / 2;
    const x = Math.cos(ang) * n.depth * RING;
    const y = Math.sin(ang) * n.depth * RING;
    pos[id] = { depth: n.depth, cx: x, cy: y, x: x - CW / 2, y: y - CH / 2 };
  });
  return pos;
}

function curveH(a: Pos, b: Pos): string {
  const x1 = a.cx + CW / 2;
  const y1 = a.cy;
  const x2 = b.cx - CW / 2;
  const y2 = b.cy;
  const dx = Math.max((x2 - x1) / 2, 30);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}
function curveR(a: Pos, b: Pos): string {
  return `M ${a.cx} ${a.cy} Q ${((a.cx + b.cx) / 2) * 0.72} ${((a.cy + b.cy) / 2) * 0.72} ${b.cx} ${b.cy}`;
}

function stuckDays(blockedSince?: string | null): number {
  if (!blockedSince) return 0;
  const d = (Date.now() - new Date(blockedSince).getTime()) / 86400000;
  return Math.max(0, Math.floor(d));
}

export function TaskTreePage() {
  const [trees, setTrees] = useState<TaskTree[]>([]);
  const [treeId, setTreeId] = useState<string | null>(null);
  const [nodes, setNodes] = useState<TaskNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<'tree' | 'wall'>('tree');
  const [layout, setLayout] = useState<'h' | 'r'>('h');
  const [loading, setLoading] = useState(true);
  const [newTitle, setNewTitle] = useState('');
  const [chatText, setChatText] = useState('');
  const [chatLog, setChatLog] = useState<{ role: 'u' | 'a'; text: string }[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [blockers, setBlockers] = useState<TaskBlockerItem[]>([]);
  const [cam, setCam] = useState<Cam>({ x: -100, y: -100, w: 1200, h: 800 });

  const svgRef = useRef<SVGSVGElement | null>(null);
  const newIdsRef = useRef<Set<string>>(new Set());
  const dragRef = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);

  const pos = useMemo(() => computeLayout(nodes, layout), [nodes, layout]);

  const fit = useCallback(() => {
    const ids = Object.keys(pos);
    if (!ids.length || !svgRef.current) return;
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    ids.forEach((id) => {
      const p = pos[id];
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + CW); maxY = Math.max(maxY, p.y + CH);
    });
    const r = svgRef.current.getBoundingClientRect();
    const asp = r.width / Math.max(r.height, 1);
    const bw = (maxX - minX) * 1.16;
    const bh = (maxY - minY) * 1.16;
    const ccx = (minX + maxX) / 2;
    const ccy = (minY + maxY) / 2;
    let w: number, h: number;
    if (bw / bh > asp) { w = bw; h = bw / asp; } else { h = bh; w = bh * asp; }
    setCam({ x: ccx - w / 2, y: ccy - h / 2, w, h });
  }, [pos]);

  const loadTree = useCallback(async (id: string) => {
    const res = await getTaskTree(id);
    if (res.success && res.data) {
      newIdsRef.current = new Set(res.data.nodes.map((n) => n.id));
      setNodes(res.data.nodes);
      setSelectedId(null);
    }
  }, []);

  const loadTrees = useCallback(async () => {
    setLoading(true);
    const res = await listTaskTrees();
    if (res.success && res.data) {
      setTrees(res.data.items);
      if (res.data.items.length > 0) {
        const first = res.data.items[0];
        setTreeId(first.id);
        await loadTree(first.id);
      }
    }
    setLoading(false);
  }, [loadTree]);

  useEffect(() => { void loadTrees(); }, [loadTrees]);

  // 树/布局变化后自动适配视野
  useEffect(() => {
    const t = setTimeout(() => fit(), 60);
    return () => clearTimeout(t);
  }, [treeId, layout, fit]);

  useEffect(() => {
    if (view === 'wall') {
      void (async () => {
        const res = await listTaskBlockers();
        if (res.success && res.data) setBlockers(res.data.items);
      })();
    }
  }, [view]);

  // wheel 缩放/平移（passive:false 才能 preventDefault）
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setCam((c) => {
        if (e.ctrlKey || e.metaKey) {
          const f = e.deltaY > 0 ? 1.1 : 0.9;
          const wx = c.x + ((e.clientX - r.left) / r.width) * c.w;
          const wy = c.y + ((e.clientY - r.top) / r.height) * c.h;
          const nw = Math.min(Math.max(c.w * f, 260), 9000);
          const nh = nw * (c.h / c.w);
          return { x: wx - (wx - c.x) * (nw / c.w), y: wy - (wy - c.y) * (nh / c.h), w: nw, h: nh };
        }
        return { ...c, x: c.x + (e.deltaX * c.w) / r.width, y: c.y + (e.deltaY * c.h) / r.height };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    dragRef.current = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d || !svgRef.current) return;
    const r = svgRef.current.getBoundingClientRect();
    setCam((c) => ({ ...c, x: d.cx - ((e.clientX - d.x) * c.w) / r.width, y: d.cy - ((e.clientY - d.y) * c.h) / r.height }));
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    const moved = d && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4;
    dragRef.current = null;
    if (!moved) setSelectedId(null);
  };

  const handleCreateTree = async () => {
    const title = newTitle.trim();
    if (!title) { toast.error('请输入任务树标题'); return; }
    const res = await createTaskTree({ title });
    if (res.success && res.data) {
      setNewTitle('');
      await loadTrees();
      toast.success('任务树已创建');
    } else {
      toast.error(res.error?.message ?? '创建失败');
    }
  };

  const changeStatus = async (node: TaskNode, status: TaskStatus) => {
    const res = await updateTaskNode(node.id, { status });
    if (res.success && res.data) {
      newIdsRef.current.delete(node.id);
      setNodes((ns) => ns.map((n) => (n.id === node.id ? res.data! : n)));
    } else {
      toast.error(res.error?.message ?? '更新失败');
    }
  };

  const saveBlocker = async (node: TaskNode, blocker: string) => {
    const res = await updateTaskNode(node.id, { status: 'blocked', blocker });
    if (res.success && res.data) setNodes((ns) => ns.map((n) => (n.id === node.id ? res.data! : n)));
  };

  const sendExtract = async () => {
    const text = chatText.trim();
    if (!text || !treeId || extracting) return;
    setChatText('');
    setChatLog((l) => [...l, { role: 'u', text }, { role: 'a', text: '正在分析…' }]);
    setExtracting(true);
    const token = useAuthStore.getState().token;
    const parentId = selectedId && nodes.some((n) => n.id === selectedId) ? selectedId : undefined;
    const ctrl = new AbortController();
    let typing = '';
    try {
      const resp = await fetch(api.taskTree.trees.extract(encodeURIComponent(treeId)), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ text, parentId }),
        signal: ctrl.signal,
      });
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
      await readSseStream(resp, (evt) => {
        if (!evt.data) return;
        let data: Record<string, unknown> = {};
        try { data = JSON.parse(evt.data); } catch { /* ignore */ }
        if (evt.event === 'thinking' || evt.event === 'typing') {
          typing += String(data.text ?? '');
          setChatLog((l) => { const c = [...l]; c[c.length - 1] = { role: 'a', text: typing || '正在生成…' }; return c; });
        } else if (evt.event === 'node') {
          const node = data as unknown as TaskNode;
          newIdsRef.current = new Set([node.id]);
          setNodes((ns) => [...ns, node]);
          setSelectedId(node.id);
          setChatLog((l) => { const c = [...l]; c[c.length - 1] = { role: 'a', text: `已长出任务「${node.title}」（${STATUS[node.status]?.label ?? ''}）` }; return c; });
        } else if (evt.event === 'error') {
          setChatLog((l) => { const c = [...l]; c[c.length - 1] = { role: 'a', text: `失败：${String(data.message ?? '')}` }; return c; });
        }
      }, ctrl.signal);
    } catch (e) {
      setChatLog((l) => [...l, { role: 'a', text: `摘取失败：${(e as Error).message}` }]);
    } finally {
      setExtracting(false);
      setTimeout(() => fit(), 80);
    }
  };

  const selected = selectedId ? nodes.find((n) => n.id === selectedId) ?? null : null;
  const childrenOf = (id: string) => nodes.filter((n) => n.parentId === id);

  // ---- 渲染 ----
  if (loading) {
    return (
      <div className="tt-root" style={{ height: '100%', minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <MapSectionLoader text="正在加载任务树…" />
      </div>
    );
  }

  if (!treeId) {
    return (
      <div className="tt-root" style={{ height: '100%', minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="tt-empty">
          <h2>种下你的第一棵任务树</h2>
          <p>创世支柱 → 主干 → 枝干。把个人任务一层层展开，卡点一眼亮红，进度一目了然。</p>
          <div className="tt-empty-row">
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleCreateTree(); }}
              placeholder="例：2026 Q2 主线"
            />
            <button className="tt-btn tt-primary" onClick={() => void handleCreateTree()}>
              <Plus size={14} /> 创建
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="tt-root" style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <header className="tt-top">
        <div className="tt-brand"><b>个人任务树</b><span>注意力长在哪，卡点亮在哪</span></div>
        <div className="tt-tabs">
          <button className={view === 'tree' ? 'on' : ''} onClick={() => setView('tree')}>成长树</button>
          <button className={view === 'wall' ? 'on' : ''} onClick={() => setView('wall')}>卡点墙</button>
        </div>
        <div className="tt-spacer" />
        {trees.length > 1 && (
          <select value={treeId} onChange={(e) => { setTreeId(e.target.value); void loadTree(e.target.value); }}>
            {trees.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        )}
        <select value={layout} onChange={(e) => setLayout(e.target.value as 'h' | 'r')}>
          <option value="h">横向整齐</option>
          <option value="r">径向生命树</option>
        </select>
        <button className="tt-btn" onClick={() => fit()}><RotateCcw size={13} /> 适配</button>
      </header>

      <div className="tt-main" style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div className="tt-stage" style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          {view === 'tree' ? (
            <svg
              ref={svgRef}
              className="tt-svg"
              viewBox={`${cam.x} ${cam.y} ${cam.w} ${cam.h}`}
              preserveAspectRatio="xMidYMid meet"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            >
              {/* 依赖虚线 */}
              {nodes.flatMap((n) =>
                (n.dependsOn || []).map((dp) => {
                  const a = pos[dp]; const b = pos[n.id];
                  if (!a || !b) return null;
                  return <path key={`${n.id}-${dp}`} className="tt-dep" d={`M ${a.cx} ${a.cy} Q ${(a.cx + b.cx) / 2} ${(a.cy + b.cy) / 2 - 50} ${b.cx} ${b.cy}`} />;
                })
              )}
              {/* 父子连线 */}
              {nodes.map((n) => {
                if (!n.parentId) return null;
                const a = pos[n.parentId]; const b = pos[n.id];
                if (!a || !b) return null;
                const w = Math.max(5.5 - b.depth * 0.95, 1.7);
                return <path key={`l-${n.id}`} className="tt-link" strokeWidth={w} d={layout === 'r' ? curveR(a, b) : curveH(a, b)} />;
              })}
              {/* 节点 */}
              {nodes.map((n) => {
                const p = pos[n.id];
                if (!p) return null;
                const st = STATUS[n.status];
                const isRoot = !n.parentId;
                const grow = newIdsRef.current.has(n.id);
                return (
                  <g
                    key={n.id}
                    className="tt-node"
                    transform={`translate(${p.x} ${p.y})`}
                    onClick={(e) => { e.stopPropagation(); setSelectedId(n.id); }}
                  >
                    <g className={`tt-card${grow ? ' grow' : ''}`}>
                      {isRoot && <rect className="tt-rootring" x={-5} y={-5} width={CW + 10} height={CH + 10} rx={18} fill="none" stroke="#7c5cff" strokeWidth={2} />}
                      <rect
                        x={0} y={0} width={CW} height={CH} rx={15}
                        fill="var(--tt-card)"
                        stroke={n.id === selectedId ? '#7c5cff' : n.status === 'blocked' ? '#e0563b' : 'var(--tt-card-bd)'}
                        strokeWidth={n.id === selectedId ? 2 : 1.2}
                      />
                      <rect x={0} y={9} width={5} height={CH - 18} rx={2.5} fill={isRoot ? '#7c5cff' : st.color} />
                      <circle cx={20} cy={21} r={4} fill={isRoot ? '#a78bff' : st.color} />
                      <text x={32} y={25} className="tt-ttl">{(isRoot ? '创世支柱' : n.title).slice(0, 11)}</text>
                      <text x={18} y={44} className="tt-sub" fill={isRoot ? '#a78bff' : st.color}>
                        {(isRoot ? n.title : st.label + (n.status === 'blocked' ? ` · 卡 ${stuckDays(n.blockedSince)} 天` : '')).slice(0, 15)}
                      </text>
                      {n.status === 'blocked' && <circle className="tt-blockdot" cx={CW - 14} cy={15} r={5} fill="#e0563b" />}
                    </g>
                  </g>
                );
              })}
            </svg>
          ) : (
            <BlockersWall items={blockers} />
          )}

          {view === 'tree' && (
            <div className="tt-legend">
              {STATUS_KEYS.map((k) => (
                <span key={k} className="row"><span className="dot" style={{ background: STATUS[k].color, color: STATUS[k].color }} />{STATUS[k].label}</span>
              ))}
            </div>
          )}
        </div>

        <aside className="tt-side">
          <SidePanel
            view={view}
            node={selected}
            childrenNodes={selected ? childrenOf(selected.id) : []}
            allNodes={nodes}
            onSelect={setSelectedId}
            onStatus={changeStatus}
            onSaveBlocker={saveBlocker}
          />
        </aside>
      </div>

      <footer className="tt-chat">
        <div className="tt-chatlog">
          {chatLog.slice(-4).map((m, i) => (
            <div key={i} className={m.role === 'u' ? 'u' : 'a'}>{m.role === 'u' ? '你：' : '任务树：'}{m.text}</div>
          ))}
        </div>
        <div className="tt-chatrow">
          <input
            value={chatText}
            onChange={(e) => setChatText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void sendExtract(); }}
            placeholder="对话摘取任务：例「这周要搞周报自动化，但卡在等模型池配额」"
            disabled={extracting}
          />
          <button className="tt-btn tt-primary" onClick={() => void sendExtract()} disabled={extracting}>
            {extracting ? '分析中…' : '摘出 →'}
          </button>
        </div>
      </footer>
    </div>
  );
}

function SidePanel({
  view, node, childrenNodes, allNodes, onSelect, onStatus, onSaveBlocker,
}: {
  view: 'tree' | 'wall';
  node: TaskNode | null;
  childrenNodes: TaskNode[];
  allNodes: TaskNode[];
  onSelect: (id: string) => void;
  onStatus: (node: TaskNode, s: TaskStatus) => void;
  onSaveBlocker: (node: TaskNode, text: string) => void;
}) {
  const [blockerDraft, setBlockerDraft] = useState('');
  useEffect(() => { setBlockerDraft(node?.blocker ?? ''); }, [node?.id, node?.blocker]);

  if (view === 'wall') {
    return <div className="tt-hint">卡点墙是只读上报视图：把卡点聚到一起按卡住时长排序，并标出每个卡点<b>下游阻塞了谁</b>。当前聚合本人卡点；跨人/团队聚合需团队模型支撑，后续补充。</div>;
  }
  if (!node) {
    return <div className="tt-hint">点一个节点看详情。<br /><br />卡片=任务，左侧色条=进度，<span style={{ color: '#e0563b' }}>红点闪烁</span>=卡点。实线=父子（被依赖→下一步），<span style={{ color: '#e7b24a' }}>黄色流动虚线</span>=跨枝/跨人依赖。<br /><br />画布可拖拽平移、滚轮缩放。底部输入框用对话摘取任务。</div>;
  }
  const parent = node.parentId ? allNodes.find((n) => n.id === node.parentId) : null;
  const deps = (node.dependsOn || []).map((id) => allNodes.find((n) => n.id === id)).filter(Boolean) as TaskNode[];

  return (
    <div className="tt-detail">
      <h2>{node.title}</h2>
      <div className="tt-meta">{parent ? `属于：${parent.title}` : '创世支柱（根任务）'}</div>
      <div className="tt-field">
        <label>进度</label>
        <div className="tt-statusrow">
          {STATUS_KEYS.map((k) => (
            <span
              key={k}
              className={`tt-pill${k === node.status ? ' on' : ''}`}
              style={{ background: STATUS[k].color + '2e', color: STATUS[k].color }}
              onClick={() => onStatus(node, k)}
            >{STATUS[k].label}</span>
          ))}
        </div>
      </div>
      {node.status === 'blocked' && (
        <div className="tt-blocker">
          <div className="l">卡点{node.blockedSince ? ` · 已卡 ${stuckDays(node.blockedSince)} 天` : ''}</div>
          <textarea
            value={blockerDraft}
            onChange={(e) => setBlockerDraft(e.target.value)}
            onBlur={() => { if (blockerDraft !== (node.blocker ?? '')) onSaveBlocker(node, blockerDraft); }}
            placeholder="描述卡在哪里、需要谁帮忙…"
            rows={2}
          />
        </div>
      )}
      <div className="tt-field">
        <label>{childrenNodes.length ? '下一个任务（枝干）' : '下一步'}</label>
        {childrenNodes.length ? (
          <div className="tt-chips">
            {childrenNodes.map((c) => (
              <span key={c.id} className="chip" style={{ borderLeft: `3px solid ${STATUS[c.status].color}` }} onClick={() => onSelect(c.id)}>{c.title}</span>
            ))}
          </div>
        ) : <div className="tt-hint">末梢任务，可在下方摘出下一步。</div>}
      </div>
      {deps.length > 0 && (
        <div className="tt-field">
          <label>依赖（前置）</label>
          <div className="tt-chips">
            {deps.map((d) => (
              <span key={d.id} className="chip" style={{ borderLeft: '3px solid #e7b24a' }} onClick={() => onSelect(d.id)}>{d.title}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BlockersWall({ items }: { items: TaskBlockerItem[] }) {
  return (
    <div className="tt-wall">
      <h1>卡点墙 · 一眼看清</h1>
      <div className="sub">卡点按卡住时长排序，最久的在前。共 {items.length} 个。</div>
      {items.length === 0 ? (
        <div className="tt-hint">当前没有卡点，一切顺畅。</div>
      ) : (
        <div className="tt-wallgrid">
          {items.map((it) => (
            <div key={it.node.id} className="tt-bc">
              <div className="t"><span className="o">{it.treeTitle}</span><span className="d">卡 {it.stuckDays} 天</span></div>
              <div className="ttl">{it.node.title}</div>
              <div className="r">{it.node.blocker}</div>
              {it.blocks.length > 0 && <div className="dn">阻塞了：{it.blocks.join('、')}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
