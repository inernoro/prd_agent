/**
 * 演讲播放态 — 完整复刻 mindmap-ppt (https://github.com/agegr/mindmap-ppt) 全部交互特性。
 *
 * 复刻清单：
 *  1. 2D 画布 + 镜头跟随
 *  2. preorder 遍历 + 节点逐个生长
 *  3. path 节点横铺 baseline + completed 子树堆 baseline 上方
 *  4. 末屏全树俯视
 *  5. 节点 subtitle / title / 配图三段结构
 *  6. 节点配图 — 缩略图常显，活跃节点放大
 *  7. 图片大图查看器（点击节点配图 → 全屏 lightbox，ESC 关闭）
 *  8. zoom 滑条 50%-160%
 *  9. activeScale 滑条 0.8-1.5x（活跃节点视觉权重）
 * 10. 进度滑条 + 紫色填充进度
 * 11. 键盘 ←↑PgUp →↓PgDn 空格 / ESC
 * 12. 滚轮 96px 阈值 + 200ms idle reset
 * 13. 触摸滑动（mobile）
 * 14. 单击非活跃节点 = 镜头移过去，activeIndex 不变；双击 = 跳到该节点
 * 15. 控制条可折叠
 * 16. 下一个节点预览
 * 17. 路径节点高亮（白边）+ 完成节点淡色
 * 18. SVG cubic-bezier 父子连线，路径连线紫色加粗
 * 19. 实色卡片背景（避免重叠透明遮挡）
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { X, Minus, Plus, ChevronLeft, ChevronRight, ChevronDown, ChevronUp } from 'lucide-react';
import { speechAgentApi } from '@/services/real/speechAgent';
import type { SpeechDeck, SpeechNode } from '@/services/contracts/speechAgent';
import { MapSectionLoader } from '@/components/ui/VideoLoader';

const LAYOUT = {
  minNodeWidth: 300,
  minNodeHeight: 110,
  pathGap: 88,
  rowGap: 64,
  stagePaddingX: 160,
  centerBaseline: 480,
  cameraCenterBand: 0.4,
};

const WHEEL_THRESHOLD = 96;
const WHEEL_IDLE_RESET_MS = 200;
const SWIPE_MIN_DISTANCE = 56;
const SWIPE_DOMINANCE = 1.25;

// 节点配图：根据节点 id hash 选 emoji + 渐变色（确定性，同节点永远同图）
const NODE_ICONS = ['◆', '★', '●', '▲', '✦', '◉', '◈', '✸', '❖', '✿', '☆', '◇', '❋', '✺', '◐', '⬢'];
const NODE_GRADIENTS = [
  ['#a78bfa', '#6366f1'], ['#f472b6', '#a78bfa'], ['#60a5fa', '#06b6d4'],
  ['#facc15', '#fb923c'], ['#34d399', '#10b981'], ['#f87171', '#ec4899'],
  ['#c084fc', '#a855f7'], ['#22d3ee', '#3b82f6'], ['#fde047', '#facc15'],
];

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function nodeIcon(id: string): { symbol: string; from: string; to: string } {
  const h = hashStr(id);
  return {
    symbol: NODE_ICONS[h % NODE_ICONS.length],
    from: NODE_GRADIENTS[h % NODE_GRADIENTS.length][0],
    to: NODE_GRADIENTS[h % NODE_GRADIENTS.length][1],
  };
}

function nodeSubtitle(depth: number, order: number): string {
  if (depth === 0) return '演讲';
  if (depth === 1) return `核心 ${order + 1}`;
  if (depth === 2) return `要点 ${order + 1}`;
  return `细节 ${order + 1}`;
}

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
  isCameraTarget: boolean;
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

type Model = { nodes: ModelNode[]; links: ModelLink[]; isEnd: boolean };
type Viewport = { x: number; y: number; width: number; height: number };

export default function SpeechAgentPlayPage() {
  const { deckId = '' } = useParams<{ deckId: string }>();
  const navigate = useNavigate();

  const [deck, setDeck] = useState<SpeechDeck | null>(null);
  const [rawNodes, setRawNodes] = useState<SpeechNode[]>([]);
  const [loading, setLoading] = useState(true);

  const [activeIndex, setActiveIndex] = useState(0);
  const [cameraTargetIndex, setCameraTargetIndex] = useState<number | null>(null);
  const [cameraZoom, setCameraZoom] = useState(0.9);
  const [activeScale, setActiveScale] = useState(1.12);
  const [controlsCollapsed, setControlsCollapsed] = useState(false);
  const [stageSize, setStageSize] = useState({ width: 1440, height: 900 });
  const [metrics, setMetrics] = useState<Map<string, Metric>>(new Map());
  const [imageViewer, setImageViewer] = useState<{ symbol: string; from: string; to: string; title: string } | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const wheelBufferRef = useRef(0);
  const wheelTimerRef = useRef<number | null>(null);
  const swipeStartRef = useRef<{ x: number; y: number; t: number } | null>(null);

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
      el.className = 'mind-card-measure';
      el.innerHTML = renderMeasureHTML(t);
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
      return buildEndModel(tree, preorder, metrics, cameraTargetIndex);
    }
    return buildVisibleModel(preorder, metrics, activeIndex, cameraTargetIndex);
  }, [tree, preorder, metrics, activeIndex, cameraTargetIndex]);

  const viewport: Viewport | null = useMemo(() => {
    if (!model) return null;
    return computeViewport(model, stageSize, cameraZoom);
  }, [model, stageSize, cameraZoom]);

  const goNext = useCallback(() => {
    setCameraTargetIndex(null);
    setActiveIndex((i) => Math.min(endIndex, i + 1));
  }, [endIndex]);
  const goPrev = useCallback(() => {
    setCameraTargetIndex(null);
    setActiveIndex((i) => Math.max(0, i - 1));
  }, []);
  const goExit = useCallback(() => navigate(`/speech-agent/${deckId}`), [navigate, deckId]);
  const jumpTo = useCallback((idx: number) => {
    setCameraTargetIndex(null);
    setActiveIndex(Math.max(0, Math.min(endIndex, idx)));
  }, [endIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (imageViewer) {
        if (e.key === 'Escape') { e.preventDefault(); setImageViewer(null); }
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); goExit(); return; }
      if (['ArrowRight', 'ArrowDown', ' ', 'PageDown'].includes(e.key)) { e.preventDefault(); goNext(); return; }
      if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); goPrev(); return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goNext, goPrev, goExit, imageViewer]);

  const handleWheel = useCallback((e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey || imageViewer) return;
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
  }, [goNext, goPrev, imageViewer]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length !== 1 || imageViewer) return;
    const t = e.touches[0];
    swipeStartRef.current = { x: t.clientX, y: t.clientY, t: Date.now() };
  }, [imageViewer]);
  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!swipeStartRef.current) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - swipeStartRef.current.x;
    const dy = t.clientY - swipeStartRef.current.y;
    swipeStartRef.current = null;
    if (Math.abs(dx) < SWIPE_MIN_DISTANCE && Math.abs(dy) < SWIPE_MIN_DISTANCE) return;
    if (Math.abs(dx) > Math.abs(dy) * SWIPE_DOMINANCE) {
      if (dx < 0) goNext(); else goPrev();
    } else if (Math.abs(dy) > Math.abs(dx) * SWIPE_DOMINANCE) {
      if (dy < 0) goNext(); else goPrev();
    }
  }, [goNext, goPrev]);

  // 单击非活跃节点：镜头移过去但 activeIndex 不变（cameraTargetIndex）
  const onNodeClick = useCallback((node: ModelNode) => {
    if (node.isActive) return;
    setCameraTargetIndex(node.preorderIndex);
  }, []);
  // 双击：真正跳到该节点
  const onNodeDoubleClick = useCallback((node: ModelNode) => {
    jumpTo(node.preorderIndex);
  }, [jumpTo]);

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
  const sliderPct = endIndex === 0 ? 0 : (activeIndex / endIndex) * 100;

  return (
    <div
      className="fixed inset-0 z-[100] bg-[#08080c] flex flex-col"
      data-tour-id="speech-play-fullscreen"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* 顶部标题面板 */}
      <div className="absolute top-6 left-6 z-30 max-w-[420px] px-5 py-3.5 rounded-2xl bg-[#13121a]/90 backdrop-blur-xl border border-white/10 shadow-2xl">
        <div className="text-[10px] uppercase tracking-[0.3em] text-violet-300/70 mb-1">演讲</div>
        <div className="text-base font-medium text-white/95 leading-tight">{deck.title}</div>
      </div>

      {/* 退出按钮 */}
      <button
        type="button"
        onClick={goExit}
        aria-label="退出 (ESC)"
        className="absolute top-6 right-6 z-30 w-10 h-10 rounded-full bg-[#13121a]/90 hover:bg-[#1d1a26] backdrop-blur-xl border border-white/10 flex items-center justify-center text-white/75 transition-colors"
      >
        <X size={16} />
      </button>

      {/* 主舞台 */}
      <div ref={stageRef} className="flex-1 min-h-0 relative overflow-hidden">
        <div className="absolute inset-0 opacity-50 pointer-events-none" style={{
          background: 'radial-gradient(ellipse at 30% 20%, rgba(139,92,246,0.10) 0%, transparent 50%), radial-gradient(ellipse at 70% 80%, rgba(236,72,153,0.06) 0%, transparent 50%)',
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
            <svg className="absolute" style={{ overflow: 'visible', pointerEvents: 'none' }} width="2000" height="1400">
              {model.links.map((link) => (
                <path
                  key={link.id}
                  d={linkPath(link)}
                  fill="none"
                  stroke={link.isPathLink ? 'rgba(167, 139, 250, 0.75)' : 'rgba(255,255,255,0.14)'}
                  strokeWidth={link.isPathLink ? 2.2 : 1.2}
                  className="mind-link"
                />
              ))}
            </svg>

            <div className="absolute" style={{ width: 0, height: 0 }}>
              {model.nodes.map((n) => (
                <MindCard
                  key={n.id}
                  node={n}
                  activeScale={activeScale}
                  onClick={() => onNodeClick(n)}
                  onDoubleClick={() => onNodeDoubleClick(n)}
                  onImageClick={() => {
                    const icon = nodeIcon(n.id);
                    setImageViewer({ ...icon, title: n.raw.title });
                  }}
                />
              ))}
            </div>
          </div>
        )}

        <div ref={measureRef} className="mind-measurer" aria-hidden />
      </div>

      {/* 底部控制条（可折叠） */}
      <footer className={`shrink-0 bg-[#13121a]/95 backdrop-blur-xl border-t border-white/10 transition-all duration-300 ${
        controlsCollapsed ? 'py-2 px-6' : 'px-6 py-3.5'
      }`}>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => setControlsCollapsed((v) => !v)}
            className="shrink-0 w-7 h-7 rounded-md hover:bg-white/10 flex items-center justify-center text-white/55"
            aria-label={controlsCollapsed ? '展开控制条' : '收起控制条'}
          >
            {controlsCollapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>

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
              onChange={(e) => jumpTo(Number(e.target.value))}
              className="flex-1 mind-slider"
              style={{ ['--p' as 'color']: `${sliderPct}%` } as React.CSSProperties}
              aria-label="演讲进度"
            />
            <div className="shrink-0 text-xs text-white/55 font-mono w-16 text-right">{counterText}</div>
          </div>

          <button
            type="button"
            onClick={goNext}
            disabled={isEnd}
            className="shrink-0 w-9 h-9 rounded-full bg-violet-500/90 hover:bg-violet-400 disabled:opacity-30 disabled:bg-white/10 flex items-center justify-center text-white shadow-lg shadow-violet-500/30"
            aria-label="下一个 (→ / 空格)"
          >
            <ChevronRight size={16} />
          </button>
        </div>

        {!controlsCollapsed && (
          <div className="mt-3 flex items-center gap-4">
            {/* zoom */}
            <div className="shrink-0 flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-white/40">缩放</span>
              <button
                type="button"
                onClick={() => setCameraZoom((z) => Math.max(0.4, +(z - 0.1).toFixed(2)))}
                className="w-6 h-6 rounded-md hover:bg-white/10 flex items-center justify-center text-white/65"
                aria-label="缩小"
              ><Minus size={11} /></button>
              <input
                type="range" min={40} max={160} value={Math.round(cameraZoom * 100)}
                onChange={(e) => setCameraZoom(Number(e.target.value) / 100)}
                className="mind-slider-small"
                aria-label="缩放滑条"
              />
              <button
                type="button"
                onClick={() => setCameraZoom((z) => Math.min(1.6, +(z + 0.1).toFixed(2)))}
                className="w-6 h-6 rounded-md hover:bg-white/10 flex items-center justify-center text-white/65"
                aria-label="放大"
              ><Plus size={11} /></button>
              <span className="text-[10px] font-mono text-white/55 w-9 text-right">{Math.round(cameraZoom * 100)}%</span>
            </div>

            {/* activeScale */}
            <div className="shrink-0 flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-white/40">活跃节点</span>
              <input
                type="range" min={80} max={150} value={Math.round(activeScale * 100)}
                onChange={(e) => setActiveScale(Number(e.target.value) / 100)}
                className="mind-slider-small"
                aria-label="活跃节点缩放"
              />
              <span className="text-[10px] font-mono text-white/55 w-9 text-right">{activeScale.toFixed(2)}x</span>
            </div>

            {/* next node preview */}
            {nextNode && !isEnd && (
              <div className="flex-1 min-w-0 max-w-[320px] px-3 py-2 rounded-lg bg-violet-500/10 border border-violet-400/25 flex items-center gap-2.5">
                <NodeIconBadge id={nextNode.id} size={28} />
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-wider text-violet-300/70">下一个</div>
                  <div className="text-xs text-white/85 truncate font-medium">{nextNode.raw.title}</div>
                </div>
              </div>
            )}
            {isEnd && (
              <div className="flex-1 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-400/25 text-xs text-emerald-200 max-w-[200px]">已是结束总览</div>
            )}

            {/* keyboard hints */}
            <div className="shrink-0 hidden lg:flex items-center gap-3 text-[10px] text-white/35 font-mono">
              <span>空格/→ 下一个</span>
              <span>← 上一个</span>
              <span>单击节点 镜头移过去</span>
              <span>双击 跳节点</span>
              <span>ESC 退出</span>
            </div>
          </div>
        )}
      </footer>

      {/* 图片大图查看器 */}
      {imageViewer && (
        <div
          className="fixed inset-0 z-[200] bg-black/85 backdrop-blur-md flex items-center justify-center cursor-zoom-out"
          onClick={() => setImageViewer(null)}
          role="dialog"
          aria-label="节点配图大图"
        >
          <div className="relative max-w-[80vw] max-h-[80vh] flex flex-col items-center gap-6" onClick={(e) => e.stopPropagation()}>
            <div
              className="w-[420px] h-[420px] rounded-3xl flex items-center justify-center text-[200px] shadow-2xl"
              style={{ background: `linear-gradient(135deg, ${imageViewer.from} 0%, ${imageViewer.to} 100%)` }}
            >
              <span style={{ filter: 'drop-shadow(0 8px 24px rgba(0,0,0,0.3))' }}>{imageViewer.symbol}</span>
            </div>
            <div className="text-white/90 text-lg font-medium">{imageViewer.title}</div>
            <button
              type="button"
              onClick={() => setImageViewer(null)}
              className="absolute top-2 right-2 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white"
              aria-label="关闭大图"
            >
              <X size={18} />
            </button>
            <div className="text-[11px] text-white/40">点击任意位置关闭 · ESC 关闭</div>
          </div>
        </div>
      )}

      <style>{`
        .mind-measurer {
          position: absolute; left: -99999px; top: 0; width: 0; height: 0; overflow: hidden; pointer-events: none;
        }
        .mind-card-measure {
          font-family: inherit; font-size: 14px; line-height: 1.5; box-sizing: border-box;
          width: ${LAYOUT.minNodeWidth}px; padding: 14px 56px 14px 18px;
        }
        .mind-card-measure .m-subtitle { font-size: 10px; line-height: 1.2; letter-spacing: 0.15em; text-transform: uppercase; margin-bottom: 6px; }
        .mind-card-measure .m-title { font-size: 15px; font-weight: 600; line-height: 1.35; margin-bottom: 8px; }
        .mind-card-measure .m-bullet { font-size: 12px; line-height: 1.55; padding-left: 11px; margin-top: 4px; position: relative; }
        .mind-link { transition: stroke 500ms ease, stroke-width 500ms ease; }
        .mind-slider {
          -webkit-appearance: none; appearance: none; height: 4px; border-radius: 2px; outline: none;
          background: linear-gradient(to right,
            rgba(167, 139, 250, 0.85) 0%,
            rgba(167, 139, 250, 0.85) var(--p),
            rgba(255,255,255,0.1) var(--p),
            rgba(255,255,255,0.1) 100%);
        }
        .mind-slider::-webkit-slider-thumb,
        .mind-slider-small::-webkit-slider-thumb {
          -webkit-appearance: none; appearance: none;
          width: 14px; height: 14px; background: white; border-radius: 50%; cursor: pointer;
          box-shadow: 0 2px 8px rgba(139, 92, 246, 0.5);
        }
        .mind-slider-small {
          -webkit-appearance: none; appearance: none;
          width: 110px; height: 3px; border-radius: 2px; outline: none;
          background: rgba(255,255,255,0.1);
        }
      `}</style>
    </div>
  );
}

// ── 节点卡片 ──

function MindCard({
  node, activeScale, onClick, onDoubleClick, onImageClick,
}: {
  node: ModelNode;
  activeScale: number;
  onClick: () => void;
  onDoubleClick: () => void;
  onImageClick: () => void;
}) {
  const left = node.x - node.width / 2;
  const top = node.y - node.height / 2;
  const isActive = node.isActive;
  const isCamTarget = node.isCameraTarget;
  const bullets = node.raw.bulletPoints.slice(0, 3);
  const subtitle = nodeSubtitle(node.depth, node.raw.order);
  const icon = nodeIcon(node.id);

  // 实色背景，避免重叠透明遮挡
  const bg = isActive
    ? 'linear-gradient(135deg, #2a1b45 0%, #1f1532 100%)'
    : node.isPath
      ? '#161522'
      : '#101019';

  const borderColor = isActive
    ? 'rgba(167, 139, 250, 0.75)'
    : isCamTarget
      ? 'rgba(167, 139, 250, 0.45)'
      : node.isPath
        ? 'rgba(255,255,255,0.22)'
        : 'rgba(255,255,255,0.10)';

  const scale = isActive ? activeScale : 1;
  const zIndex = isActive ? 30 : (isCamTarget ? 25 : (node.isPath ? 20 : 10));

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick(); }}
      className="absolute text-left rounded-2xl transition-all duration-500 group"
      style={{
        left, top,
        width: node.width,
        minHeight: node.height,
        padding: '14px 56px 14px 18px',
        background: bg,
        border: `1px solid ${borderColor}`,
        boxShadow: isActive
          ? '0 24px 60px rgba(139, 92, 246, 0.4), 0 0 0 1px rgba(167, 139, 250, 0.3)'
          : node.isPath
            ? '0 8px 24px rgba(0,0,0,0.5)'
            : '0 4px 12px rgba(0,0,0,0.4)',
        transform: `scale(${scale})`,
        transformOrigin: 'left center',
        zIndex,
      }}
    >
      {/* 节点配图（右上角） */}
      <div
        onClick={(e) => { e.stopPropagation(); onImageClick(); }}
        onDoubleClick={(e) => e.stopPropagation()}
        className="absolute top-3 right-3 rounded-xl flex items-center justify-center cursor-zoom-in transition-all"
        style={{
          width: isActive ? 44 : 36,
          height: isActive ? 44 : 36,
          background: `linear-gradient(135deg, ${icon.from} 0%, ${icon.to} 100%)`,
          fontSize: isActive ? 24 : 18,
          color: 'white',
          boxShadow: isActive ? '0 6px 16px rgba(0,0,0,0.4)' : '0 3px 8px rgba(0,0,0,0.3)',
        }}
        role="button"
        aria-label="点击查看大图"
      >
        <span style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.4))' }}>{icon.symbol}</span>
      </div>

      {/* subtitle */}
      <div
        className="text-[10px] uppercase tracking-[0.18em] mb-1.5"
        style={{ color: isActive ? 'rgba(216, 180, 254, 0.95)' : 'rgba(255,255,255,0.4)' }}
      >
        {subtitle}
      </div>

      {/* title */}
      <div
        className="font-semibold leading-snug"
        style={{
          color: isActive ? 'white' : 'rgba(255,255,255,0.9)',
          fontSize: isActive ? 16 : 14,
        }}
      >
        {node.raw.title}
      </div>

      {/* bullets */}
      {bullets.length > 0 && (
        <ul className="mt-2 space-y-1">
          {bullets.map((b, i) => (
            <li
              key={i}
              className="text-xs leading-relaxed pl-2.5 relative"
              style={{ color: isActive ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.6)' }}
            >
              <span
                className="absolute left-0 top-1.5 w-1 h-1 rounded-full"
                style={{ background: isActive ? '#c4b5fd' : 'rgba(255,255,255,0.3)' }}
              />
              {b}
            </li>
          ))}
          {node.raw.bulletPoints.length > 3 && (
            <li className="text-[10px] pl-2.5" style={{ color: 'rgba(255,255,255,0.35)' }}>
              …还有 {node.raw.bulletPoints.length - 3} 条
            </li>
          )}
        </ul>
      )}
    </button>
  );
}

function NodeIconBadge({ id, size = 24 }: { id: string; size?: number }) {
  const icon = nodeIcon(id);
  return (
    <div
      className="shrink-0 rounded-lg flex items-center justify-center text-white"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, ${icon.from} 0%, ${icon.to} 100%)`,
        fontSize: Math.round(size * 0.5),
      }}
    >
      {icon.symbol}
    </div>
  );
}

// ── 算法 ──

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
  return Math.max(m.height, childHeights.reduce((a, b) => a + b, 0) + (childHeights.length - 1) * LAYOUT.rowGap);
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
  preorder: TreeNode[],
  metrics: Map<string, Metric>,
  activeIndex: number,
  cameraTargetIndex: number | null,
): Model {
  const activeNode = preorder[activeIndex];
  const path = pathToRoot(activeNode);
  const pathIds = new Set(path.map((n) => n.id));
  const visibleIds = new Set(preorder.slice(0, activeIndex + 1).map((n) => n.id));
  const positions = new Map<string, { x: number; y: number }>();

  const baseline = LAYOUT.centerBaseline;
  let cursorX = LAYOUT.stagePaddingX;
  for (const n of path) {
    const m = getMetric(n.id, metrics);
    positions.set(n.id, { x: cursorX + m.width / 2, y: baseline });
    cursorX += m.width + LAYOUT.pathGap;
  }

  const completedSubtrees: { child: TreeNode; depthIndex: number; height: number }[] = [];
  path.forEach((n, depthIndex) => {
    const completeKids = n.children.filter((c) => visibleIds.has(c.id) && !pathIds.has(c.id));
    completeKids.forEach((c) => {
      completedSubtrees.push({ child: c, depthIndex, height: measureSubtree(c, visibleIds, metrics) });
    });
  });

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

  return buildModel(visibleIds, positions, metrics, pathIds, activeNode.id, cameraTargetIndex, preorder, false);
}

function buildEndModel(
  root: TreeNode,
  preorder: TreeNode[],
  metrics: Map<string, Metric>,
  cameraTargetIndex: number | null,
): Model {
  const visibleIds = new Set(preorder.map((n) => n.id));
  const positions = new Map<string, { x: number; y: number }>();
  const rootMetric = getMetric(root.id, metrics);
  placeSubtree(root, visibleIds, metrics, positions, {
    x: LAYOUT.stagePaddingX + rootMetric.width / 2,
    y: LAYOUT.centerBaseline,
  });
  return buildModel(visibleIds, positions, metrics, new Set(), null, cameraTargetIndex, preorder, true);
}

function buildModel(
  visibleIds: Set<string>,
  positions: Map<string, { x: number; y: number }>,
  metrics: Map<string, Metric>,
  pathIds: Set<string>,
  activeNodeId: string | null,
  cameraTargetIndex: number | null,
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
      id, raw: t.raw,
      x: pos.x, y: pos.y, width: m.width, height: m.height,
      depth: t.depth, preorderIndex: t.preorderIndex,
      isPath: pathIds.has(id),
      isActive: id === activeNodeId,
      isCameraTarget: cameraTargetIndex !== null && t.preorderIndex === cameraTargetIndex,
    });
    if (t.parent && positions.has(t.parent.id)) {
      const pMetric = getMetric(t.parent.id, metrics);
      const pPos = positions.get(t.parent.id)!;
      links.push({
        id: `${t.parent.id}->${t.id}`,
        fromX: pPos.x, fromY: pPos.y, fromWidth: pMetric.width,
        toX: pos.x, toY: pos.y, toWidth: m.width,
        isPathLink: pathIds.has(t.parent.id) && pathIds.has(t.id),
      });
    }
  });

  return { nodes, links, isEnd };
}

function computeViewport(model: Model, stageSize: { width: number; height: number }, zoom: number): Viewport {
  const logical = { width: stageSize.width / zoom, height: stageSize.height / zoom };
  if (model.nodes.length === 0) return { x: 0, y: 0, ...logical };

  const camTargetNode = model.nodes.find((n) => n.isCameraTarget);
  const target = camTargetNode
    ? { x: camTargetNode.x, y: camTargetNode.y }
    : (model.isEnd
        ? boundsCenter(model.nodes)
        : (model.nodes.find((n) => n.isActive) ?? boundsCenter(model.nodes)));

  let vx = target.x - logical.width / 2;
  let vy = target.y - logical.height / 2;

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
  const factor = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
  return e.deltaY * factor;
}

function renderMeasureHTML(t: TreeNode): string {
  const safe = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
  const sub = nodeSubtitle(t.depth, t.raw.order);
  const bullets = t.raw.bulletPoints.slice(0, 3).map((b) => `<div class="m-bullet">• ${safe(b)}</div>`).join('');
  return `<div class="m-subtitle">${safe(sub)}</div><div class="m-title">${safe(t.raw.title)}</div>${bullets}`;
}
