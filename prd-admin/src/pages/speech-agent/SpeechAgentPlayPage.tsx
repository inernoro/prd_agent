/**
 * 演讲播放态 — 借鉴 mindmap-ppt (https://github.com/agegr/mindmap-ppt) 的核心交互范式：
 * 2D 画布 + 镜头跟随 + 节点逐个生长 + 路径骨架横向铺 + 完成子树围着父节点散开。
 *
 * 不是 PPT 翻页。每按一次"下一个"，preorder 序列里的下一个节点出现，相机平移聚焦它。
 * 已展示过的节点不消失，会留在画布上形成一棵越长越大的真实思维导图。
 *
 * 算法移植自原版 src/main.js：buildVisibleModel / placeSubtree / measureSubtree / computeViewport。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { X, Minus, Plus, ChevronLeft, ChevronRight } from 'lucide-react';
import { speechAgentApi } from '@/services/real/speechAgent';
import type { SpeechDeck, SpeechNode } from '@/services/contracts/speechAgent';
import { MapSectionLoader } from '@/components/ui/VideoLoader';

const LAYOUT = {
  minNodeWidth: 280,
  minNodeHeight: 96,
  pathGap: 84,
  rowGap: 44,
  stagePaddingX: 140,
  centerBaseline: 460,
  cameraCenterBand: 0.4,
};

const WHEEL_THRESHOLD = 96;
const WHEEL_IDLE_RESET_MS = 200;

type TreeNode = {
  id: string;
  raw: SpeechNode;
  parent: TreeNode | null;
  children: TreeNode[];
  depth: number;
  preorderIndex: number;
};

type Metric = { width: number; height: number };

type ModelNode = {
  id: string;
  raw: SpeechNode;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  preorderIndex: number;
  isPath: boolean;
  isActive: boolean;
};

type ModelLink = {
  id: string;
  fromX: number;
  fromY: number;
  fromWidth: number;
  toX: number;
  toY: number;
  toWidth: number;
  isPathLink: boolean;
};

type Model = {
  nodes: ModelNode[];
  links: ModelLink[];
  isEnd: boolean;
};

type Viewport = { x: number; y: number; width: number; height: number };

export default function SpeechAgentPlayPage() {
  const { deckId = '' } = useParams<{ deckId: string }>();
  const navigate = useNavigate();

  const [deck, setDeck] = useState<SpeechDeck | null>(null);
  const [rawNodes, setRawNodes] = useState<SpeechNode[]>([]);
  const [loading, setLoading] = useState(true);

  const [activeIndex, setActiveIndex] = useState(0);
  const [cameraZoom, setCameraZoom] = useState(0.95);
  const [stageSize, setStageSize] = useState({ width: 1440, height: 900 });
  const [metrics, setMetrics] = useState<Map<string, Metric>>(new Map());

  const stageRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const wheelBufferRef = useRef(0);
  const wheelTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!deckId) return;
    let cancel = false;
    setLoading(true);
    speechAgentApi.getDeck(deckId).then((res) => {
      if (cancel) return;
      if (res.success && res.data) {
        setDeck(res.data.deck);
        setRawNodes(res.data.nodes);
      }
      setLoading(false);
    });
    return () => { cancel = true; };
  }, [deckId]);

  const { tree, preorder } = useMemo(() => buildTreeAndPreorder(rawNodes), [rawNodes]);
  const endIndex = preorder.length;

  useEffect(() => {
    if (activeIndex > endIndex) setActiveIndex(endIndex);
  }, [endIndex, activeIndex]);

  useLayoutEffect(() => {
    if (preorder.length === 0 || !measureRef.current) return;
    const container = measureRef.current;
    container.innerHTML = '';
    const els: HTMLElement[] = [];
    preorder.forEach((t) => {
      const el = document.createElement('div');
      el.className = 'mind-card mind-card-measure';
      el.style.width = `${LAYOUT.minNodeWidth}px`;
      el.innerHTML = renderCardHTML(t.raw);
      container.appendChild(el);
      els.push(el);
    });
    const m = new Map<string, Metric>();
    els.forEach((el, i) => {
      const rect = el.getBoundingClientRect();
      m.set(preorder[i].id, {
        width: Math.max(LAYOUT.minNodeWidth, Math.ceil(rect.width)),
        height: Math.max(LAYOUT.minNodeHeight, Math.ceil(rect.height)),
      });
    });
    container.innerHTML = '';
    setMetrics(m);
  }, [preorder]);

  useLayoutEffect(() => {
    if (!stageRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (e) setStageSize({ width: e.contentRect.width, height: e.contentRect.height });
    });
    ro.observe(stageRef.current);
    return () => ro.disconnect();
  }, []);

  const model: Model | null = useMemo(() => {
    if (!tree || preorder.length === 0 || metrics.size === 0) return null;
    if (activeIndex >= preorder.length) {
      return buildEndModel(tree, preorder, metrics);
    }
    return buildVisibleModel(tree, preorder, metrics, activeIndex);
  }, [tree, preorder, metrics, activeIndex]);

  const viewport: Viewport | null = useMemo(() => {
    if (!model) return null;
    return computeViewport(model, stageSize, cameraZoom, activeIndex, preorder);
  }, [model, stageSize, cameraZoom, activeIndex, preorder]);

  const goNext = useCallback(() => setActiveIndex((i) => Math.min(endIndex, i + 1)), [endIndex]);
  const goPrev = useCallback(() => setActiveIndex((i) => Math.max(0, i - 1)), []);
  const goExit = useCallback(() => navigate(`/speech-agent/${deckId}`), [navigate, deckId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); goExit(); return; }
      if (['ArrowRight', 'ArrowDown', ' ', 'PageDown'].includes(e.key)) { e.preventDefault(); goNext(); return; }
      if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); goPrev(); return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goNext, goPrev, goExit]);

  const handleWheel = useCallback((e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const delta = normalizeWheelDelta(e);
    wheelBufferRef.current += delta;
    if (wheelTimerRef.current) window.clearTimeout(wheelTimerRef.current);
    wheelTimerRef.current = window.setTimeout(() => { wheelBufferRef.current = 0; }, WHEEL_IDLE_RESET_MS);
    while (wheelBufferRef.current >= WHEEL_THRESHOLD) {
      wheelBufferRef.current -= WHEEL_THRESHOLD;
      goNext();
    }
    while (wheelBufferRef.current <= -WHEEL_THRESHOLD) {
      wheelBufferRef.current += WHEEL_THRESHOLD;
      goPrev();
    }
  }, [goNext, goPrev]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  if (loading) return <div className="h-full bg-[#0a0a0c]"><MapSectionLoader text="加载演讲…" /></div>;
  if (!deck || preorder.length === 0) {
    return (
      <div className="h-full bg-[#0a0a0c] flex flex-col items-center justify-center text-center">
        <p className="text-white/70">演讲没有节点，无法播放。</p>
        <button onClick={goExit} className="mt-4 px-4 py-2 rounded-lg bg-violet-500/90 text-white text-sm">返回编辑器</button>
      </div>
    );
  }

  const isEnd = activeIndex >= endIndex;
  const nextNode = preorder[activeIndex + 1] ?? null;
  const counterText = `${Math.min(activeIndex + 1, endIndex + 1)} / ${endIndex + 1}`;

  return (
    <div className="fixed inset-0 z-[100] bg-[#0a0a0c] flex flex-col" data-tour-id="speech-play-fullscreen">
      {/* 顶部标题面板（玻璃质感） */}
      <div className="absolute top-6 left-6 z-30 max-w-[420px] px-5 py-3.5 rounded-2xl bg-white/[0.04] backdrop-blur-xl border border-white/10 shadow-2xl">
        <div className="text-[10px] uppercase tracking-[0.3em] text-violet-300/70 mb-1">演讲</div>
        <div className="text-base font-medium text-white/95 leading-tight">{deck.title}</div>
      </div>

      {/* 退出按钮 */}
      <button
        type="button"
        onClick={goExit}
        aria-label="退出 (ESC)"
        className="absolute top-6 right-6 z-30 w-10 h-10 rounded-full bg-white/[0.06] hover:bg-white/[0.12] backdrop-blur-xl border border-white/10 flex items-center justify-center text-white/75 transition-colors"
      >
        <X size={16} />
      </button>

      {/* 主舞台 */}
      <div ref={stageRef} className="flex-1 min-h-0 relative overflow-hidden">
        {/* 渐变背景星点 */}
        <div className="absolute inset-0 opacity-50 pointer-events-none" style={{
          background: 'radial-gradient(ellipse at 30% 20%, rgba(139,92,246,0.12) 0%, transparent 50%), radial-gradient(ellipse at 70% 80%, rgba(236,72,153,0.08) 0%, transparent 50%)',
        }} />

        {viewport && model && (
          <div
            className="absolute top-0 left-0"
            style={{
              transform: `translate3d(${-viewport.x * cameraZoom}px, ${-viewport.y * cameraZoom}px, 0) scale(${cameraZoom})`,
              transformOrigin: '0 0',
              transition: 'transform 700ms cubic-bezier(0.22, 1, 0.36, 1)',
              willChange: 'transform',
            }}
          >
            <svg
              className="absolute"
              style={{ overflow: 'visible', pointerEvents: 'none' }}
              width="2000"
              height="1200"
            >
              {model.links.map((link) => (
                <path
                  key={link.id}
                  d={linkPath(link)}
                  fill="none"
                  stroke={link.isPathLink ? 'rgba(167, 139, 250, 0.65)' : 'rgba(255,255,255,0.12)'}
                  strokeWidth={link.isPathLink ? 2 : 1.2}
                  className="mind-link"
                />
              ))}
            </svg>

            <div className="absolute" style={{ width: 0, height: 0 }}>
              {model.nodes.map((n) => (
                <MindCard key={n.id} node={n} onClick={() => setActiveIndex(n.preorderIndex)} />
              ))}
            </div>
          </div>
        )}

        {/* 隐藏的测量层 */}
        <div ref={measureRef} className="mind-measurer" aria-hidden />
      </div>

      {/* 底部控制条 */}
      <footer className="shrink-0 px-6 py-4 bg-white/[0.03] backdrop-blur-xl border-t border-white/10 flex items-center gap-5">
        <button
          type="button"
          onClick={goPrev}
          disabled={activeIndex === 0}
          className="shrink-0 w-9 h-9 rounded-full bg-white/[0.06] hover:bg-white/[0.12] disabled:opacity-30 flex items-center justify-center text-white/75"
          aria-label="上一个 (←)"
        >
          <ChevronLeft size={16} />
        </button>

        <div className="flex-1 min-w-0 flex items-center gap-4">
          <input
            type="range"
            min={0}
            max={endIndex}
            value={activeIndex}
            onChange={(e) => setActiveIndex(Number(e.target.value))}
            className="flex-1 mind-slider"
            aria-label="演讲进度"
          />
          <div className="shrink-0 text-xs text-white/55 font-mono w-16 text-right">{counterText}</div>
        </div>

        <div className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/[0.04] border border-white/10">
          <button
            type="button"
            onClick={() => setCameraZoom((z) => Math.max(0.4, +(z - 0.1).toFixed(2)))}
            className="w-6 h-6 rounded-md hover:bg-white/10 flex items-center justify-center text-white/65"
            aria-label="缩小"
          >
            <Minus size={12} />
          </button>
          <span className="text-[11px] font-mono text-white/55 w-10 text-center">{Math.round(cameraZoom * 100)}%</span>
          <button
            type="button"
            onClick={() => setCameraZoom((z) => Math.min(1.6, +(z + 0.1).toFixed(2)))}
            className="w-6 h-6 rounded-md hover:bg-white/10 flex items-center justify-center text-white/65"
            aria-label="放大"
          >
            <Plus size={12} />
          </button>
        </div>

        {nextNode && !isEnd && (
          <div className="shrink-0 max-w-[260px] px-3 py-2 rounded-lg bg-violet-500/10 border border-violet-400/25">
            <div className="text-[10px] uppercase tracking-wider text-violet-300/70">下一个</div>
            <div className="text-xs text-white/85 truncate font-medium mt-0.5">{nextNode.raw.title}</div>
          </div>
        )}
        {isEnd && (
          <div className="shrink-0 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-400/25 text-xs text-emerald-200">已是结束总览</div>
        )}

        <button
          type="button"
          onClick={goNext}
          disabled={isEnd}
          className="shrink-0 w-9 h-9 rounded-full bg-violet-500/90 hover:bg-violet-400 disabled:opacity-30 disabled:bg-white/10 flex items-center justify-center text-white shadow-lg shadow-violet-500/30"
          aria-label="下一个 (→ / 空格)"
        >
          <ChevronRight size={16} />
        </button>
      </footer>

      <style>{`
        .mind-measurer {
          position: absolute;
          left: -99999px;
          top: 0;
          width: 0;
          height: 0;
          overflow: hidden;
          pointer-events: none;
        }
        .mind-card-measure {
          font-family: inherit;
          font-size: 14px;
          line-height: 1.45;
          padding: 14px 18px;
          box-sizing: border-box;
        }
        .mind-card-measure .c-title {
          font-size: 15px;
          font-weight: 600;
          line-height: 1.35;
          margin-bottom: 8px;
        }
        .mind-card-measure .c-bullet {
          font-size: 12px;
          line-height: 1.5;
          padding-left: 10px;
          position: relative;
          margin-top: 4px;
          color: rgba(255,255,255,0.7);
        }
        .mind-link {
          transition: stroke 500ms ease, stroke-width 500ms ease;
        }
        .mind-slider {
          -webkit-appearance: none;
          appearance: none;
          background: linear-gradient(to right,
            rgba(167, 139, 250, 0.8) 0%,
            rgba(167, 139, 250, 0.8) ${endIndex === 0 ? 0 : (activeIndex / endIndex) * 100}%,
            rgba(255,255,255,0.1) ${endIndex === 0 ? 0 : (activeIndex / endIndex) * 100}%,
            rgba(255,255,255,0.1) 100%);
          height: 4px;
          border-radius: 2px;
          outline: none;
        }
        .mind-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 14px;
          height: 14px;
          background: white;
          border-radius: 50%;
          cursor: pointer;
          box-shadow: 0 2px 8px rgba(139, 92, 246, 0.5);
        }
        .mind-slider::-moz-range-thumb {
          width: 14px;
          height: 14px;
          background: white;
          border-radius: 50%;
          cursor: pointer;
          border: none;
        }
      `}</style>
    </div>
  );
}

// ── 节点卡片组件 ──

function MindCard({ node, onClick }: { node: ModelNode; onClick: () => void }) {
  const left = node.x - node.width / 2;
  const top = node.y - node.height / 2;
  const isActive = node.isActive;
  const bullets = node.raw.bulletPoints.slice(0, 3);

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`mind-card absolute text-left rounded-2xl border transition-all duration-500 ${
        isActive
          ? 'bg-gradient-to-br from-violet-500/30 to-fuchsia-500/15 border-violet-300/70 shadow-2xl shadow-violet-500/30 scale-[1.05] z-20'
          : node.isPath
            ? 'bg-white/[0.06] border-white/30 shadow-lg z-10'
            : 'bg-white/[0.03] border-white/12 z-0'
      }`}
      style={{
        left,
        top,
        width: node.width,
        minHeight: node.height,
        padding: '14px 18px',
        animation: isActive ? 'mindCardActiveIn 600ms cubic-bezier(0.22, 1, 0.36, 1)' : undefined,
      }}
    >
      {node.depth === 0 && (
        <div className="text-[10px] uppercase tracking-[0.2em] text-violet-300/80 mb-1.5">演讲</div>
      )}
      {node.depth > 0 && (
        <div className="text-[10px] uppercase tracking-wider text-white/35 mb-1">
          Level {node.depth}
        </div>
      )}
      <div className={`font-semibold leading-snug ${isActive ? 'text-white text-base' : 'text-white/90 text-sm'}`}>
        {node.raw.title}
      </div>
      {bullets.length > 0 && (
        <ul className="mt-2 space-y-1">
          {bullets.map((b, i) => (
            <li key={i} className={`text-xs leading-relaxed pl-2.5 relative ${isActive ? 'text-white/90' : 'text-white/55'}`}>
              <span className={`absolute left-0 top-1.5 w-1 h-1 rounded-full ${isActive ? 'bg-violet-300' : 'bg-white/30'}`} />
              {b}
            </li>
          ))}
          {node.raw.bulletPoints.length > 3 && (
            <li className="text-[10px] text-white/35 pl-2.5">…还有 {node.raw.bulletPoints.length - 3} 条</li>
          )}
        </ul>
      )}
      <style>{`
        @keyframes mindCardActiveIn {
          from { opacity: 0.6; transform: scale(0.92) translateY(8px); filter: blur(4px); }
          to { opacity: 1; transform: scale(1.05) translateY(0); filter: blur(0); }
        }
      `}</style>
    </button>
  );
}

// ── 算法：树构建 + preorder + 布局 + 视口 ──

function buildTreeAndPreorder(raw: SpeechNode[]): { tree: TreeNode | null; preorder: TreeNode[] } {
  if (raw.length === 0) return { tree: null, preorder: [] };
  const byId = new Map<string, TreeNode>();
  for (const n of raw) {
    byId.set(n.id, { id: n.id, raw: n, parent: null, children: [], depth: 0, preorderIndex: 0 });
  }
  let root: TreeNode | null = null;
  for (const t of byId.values()) {
    if (!t.raw.parentId) {
      root = t;
    } else {
      const p = byId.get(t.raw.parentId);
      if (p) { t.parent = p; p.children.push(t); }
    }
  }
  if (!root) return { tree: null, preorder: [] };
  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) => a.raw.order - b.raw.order);
    n.children.forEach(sortRec);
  };
  sortRec(root);
  const flat: TreeNode[] = [];
  const walk = (n: TreeNode, depth: number) => {
    n.depth = depth;
    n.preorderIndex = flat.length;
    flat.push(n);
    n.children.forEach((c) => walk(c, depth + 1));
  };
  walk(root, 0);
  return { tree: root, preorder: flat };
}

function getMetric(id: string, metrics: Map<string, Metric>): Metric {
  return metrics.get(id) ?? { width: LAYOUT.minNodeWidth, height: LAYOUT.minNodeHeight };
}

function measureSubtree(n: TreeNode, visibleIds: Set<string>, metrics: Map<string, Metric>): number {
  const visKids = n.children.filter((c) => visibleIds.has(c.id));
  const m = getMetric(n.id, metrics);
  if (visKids.length === 0) return m.height;
  const childHeights = visKids.map((c) => measureSubtree(c, visibleIds, metrics));
  return Math.max(
    m.height,
    childHeights.reduce((a, b) => a + b, 0) + (childHeights.length - 1) * LAYOUT.rowGap,
  );
}

function placeSubtree(
  n: TreeNode,
  visibleIds: Set<string>,
  metrics: Map<string, Metric>,
  positions: Map<string, { x: number; y: number }>,
  anchor: { x: number; y: number },
) {
  positions.set(n.id, anchor);
  const visKids = n.children.filter((c) => visibleIds.has(c.id));
  if (visKids.length === 0) return;
  const measures = visKids.map((c) => ({ child: c, height: measureSubtree(c, visibleIds, metrics) }));
  const totalH = measures.reduce((a, b) => a + b.height, 0) + (measures.length - 1) * LAYOUT.rowGap;
  let cursorY = anchor.y - totalH / 2;
  for (const { child, height } of measures) {
    const childY = cursorY + height / 2;
    const nMetric = getMetric(n.id, metrics);
    const cMetric = getMetric(child.id, metrics);
    placeSubtree(child, visibleIds, metrics, positions, {
      x: anchor.x + nMetric.width / 2 + LAYOUT.pathGap + cMetric.width / 2,
      y: childY,
    });
    cursorY += height + LAYOUT.rowGap;
  }
}

function pathToRoot(n: TreeNode): TreeNode[] {
  const path: TreeNode[] = [];
  let cur: TreeNode | null = n;
  while (cur) { path.unshift(cur); cur = cur.parent; }
  return path;
}

function buildVisibleModel(
  _root: TreeNode,
  preorder: TreeNode[],
  metrics: Map<string, Metric>,
  activeIndex: number,
): Model {
  const activeNode = preorder[activeIndex];
  const path = pathToRoot(activeNode);
  const pathIds = new Set(path.map((n) => n.id));
  const visibleIds = new Set(preorder.slice(0, activeIndex + 1).map((n) => n.id));
  const positions = new Map<string, { x: number; y: number }>();

  // 路径节点横向铺在 baseline
  const baseline = LAYOUT.centerBaseline;
  let cursorX = LAYOUT.stagePaddingX;
  for (const n of path) {
    const m = getMetric(n.id, metrics);
    positions.set(n.id, { x: cursorX + m.width / 2, y: baseline });
    cursorX += m.width + LAYOUT.pathGap;
  }

  // 收集每个路径节点的"已完成子树"（visible 但不在 path 上的子节点）
  const completedSubtrees: { child: TreeNode; depthIndex: number; height: number }[] = [];
  path.forEach((n, depthIndex) => {
    const completeKids = n.children.filter((c) => visibleIds.has(c.id) && !pathIds.has(c.id));
    completeKids.forEach((c) => {
      completedSubtrees.push({
        child: c,
        depthIndex,
        height: measureSubtree(c, visibleIds, metrics),
      });
    });
  });

  // 完成子树围着 baseline 上下散开（统一在 baseline 上方堆叠）
  const completedHeight = completedSubtrees.reduce((a, b) => a + b.height, 0) +
    Math.max(0, completedSubtrees.length - 1) * LAYOUT.rowGap;
  let cursorY = baseline - LAYOUT.rowGap - completedHeight;
  for (const st of completedSubtrees) {
    const parentNode = path[st.depthIndex];
    const parentPos = positions.get(parentNode.id)!;
    const parentMetric = getMetric(parentNode.id, metrics);
    const childMetric = getMetric(st.child.id, metrics);
    placeSubtree(st.child, visibleIds, metrics, positions, {
      x: parentPos.x + parentMetric.width / 2 + LAYOUT.pathGap + childMetric.width / 2,
      y: cursorY + st.height / 2,
    });
    cursorY += st.height + LAYOUT.rowGap;
  }

  return buildModel(visibleIds, positions, metrics, pathIds, activeNode.id, preorder, false);
}

function buildEndModel(root: TreeNode, preorder: TreeNode[], metrics: Map<string, Metric>): Model {
  const visibleIds = new Set(preorder.map((n) => n.id));
  const positions = new Map<string, { x: number; y: number }>();
  const rootMetric = getMetric(root.id, metrics);
  placeSubtree(root, visibleIds, metrics, positions, {
    x: LAYOUT.stagePaddingX + rootMetric.width / 2,
    y: LAYOUT.centerBaseline,
  });
  return buildModel(visibleIds, positions, metrics, new Set(), null, preorder, true);
}

function buildModel(
  visibleIds: Set<string>,
  positions: Map<string, { x: number; y: number }>,
  metrics: Map<string, Metric>,
  pathIds: Set<string>,
  activeNodeId: string | null,
  preorder: TreeNode[],
  isEnd: boolean,
): Model {
  const nodes: ModelNode[] = [];
  const links: ModelLink[] = [];
  const byId = new Map(preorder.map((n) => [n.id, n] as const));

  visibleIds.forEach((id) => {
    const t = byId.get(id);
    const pos = positions.get(id);
    if (!t || !pos) return;
    const m = getMetric(id, metrics);
    nodes.push({
      id,
      raw: t.raw,
      x: pos.x,
      y: pos.y,
      width: m.width,
      height: m.height,
      depth: t.depth,
      preorderIndex: t.preorderIndex,
      isPath: pathIds.has(id),
      isActive: id === activeNodeId,
    });
    if (t.parent && positions.has(t.parent.id)) {
      const pMetric = getMetric(t.parent.id, metrics);
      const pPos = positions.get(t.parent.id)!;
      links.push({
        id: `${t.parent.id}->${t.id}`,
        fromX: pPos.x,
        fromY: pPos.y,
        fromWidth: pMetric.width,
        toX: pos.x,
        toY: pos.y,
        toWidth: m.width,
        isPathLink: pathIds.has(t.parent.id) && pathIds.has(t.id),
      });
    }
  });

  return { nodes, links, isEnd };
}

function computeViewport(
  model: Model,
  stageSize: { width: number; height: number },
  zoom: number,
  _activeIndex: number,
  _preorder: TreeNode[],
): Viewport {
  const logical = { width: stageSize.width / zoom, height: stageSize.height / zoom };
  if (model.nodes.length === 0) return { x: 0, y: 0, ...logical };

  const target = model.isEnd
    ? boundsCenter(model.nodes)
    : (model.nodes.find((n) => n.isActive) ?? boundsCenter(model.nodes));

  let vx = target.x - logical.width / 2;
  let vy = target.y - logical.height / 2;

  // 让 target 落在视口中心带（避免过度震动）
  const band = LAYOUT.cameraCenterBand;
  const minX = target.x - logical.width * (0.5 + band / 2);
  const maxX = target.x - logical.width * (0.5 - band / 2);
  if (vx < minX) vx = minX;
  if (vx > maxX) vx = maxX;
  const minY = target.y - logical.height * (0.5 + band / 2);
  const maxY = target.y - logical.height * (0.5 - band / 2);
  if (vy < minY) vy = minY;
  if (vy > maxY) vy = maxY;

  return { x: vx, y: vy, width: logical.width, height: logical.height };
}

function boundsCenter(nodes: ModelNode[]): { x: number; y: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.width / 2);
    maxX = Math.max(maxX, n.x + n.width / 2);
    minY = Math.min(minY, n.y - n.height / 2);
    maxY = Math.max(maxY, n.y + n.height / 2);
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

function linkPath(link: ModelLink): string {
  const sx = link.fromX + link.fromWidth / 2;
  const sy = link.fromY;
  const ex = link.toX - link.toWidth / 2;
  const ey = link.toY;
  const midX = sx + Math.max(36, (ex - sx) * 0.5);
  return `M ${sx} ${sy} C ${midX} ${sy}, ${midX} ${ey}, ${ex} ${ey}`;
}

function normalizeWheelDelta(e: WheelEvent): number {
  // deltaMode: 0=pixel, 1=line, 2=page
  const factor = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
  return e.deltaY * factor;
}

function renderCardHTML(n: SpeechNode): string {
  const safe = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
  const bullets = n.bulletPoints.slice(0, 3).map((b) => `<div class="c-bullet">• ${safe(b)}</div>`).join('');
  return `<div class="c-title">${safe(n.title)}</div>${bullets}`;
}
