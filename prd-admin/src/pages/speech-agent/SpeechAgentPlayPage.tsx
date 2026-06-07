/**
 * 演讲播放态 — 严格对齐 mindmap-ppt 原版视觉与交互
 *
 * 视觉规格（直接抄 src/styles.css 真值，不再凭印象）：
 * - 全局背景 米白 #fcfcf8，body linear-gradient(180deg, #ffffff, #fbfbf7)
 * - 4 层背景视差漂移（::before/::after × 2 = a/b/c/d 共 4 层，18s/21s/14s/12s linear infinite）
 *   蓝色/橙色/绿色/暖色径向渐变 + blur 26px 雾化
 * - 节点白底 #fff + 2px 边框 rgba(26,42,49,0.18) + 8px 圆角 + inset highlight
 * - 节点 active: 深青底 #183a4a + 3px 橙边 #d8894f + 白字 + 14px 橙光晕
 * - 节点 path: 米色底 #fffdf8 + 深青边 rgba(38,77,92,0.34)
 * - 节点 complete: 浅薄荷 #eef7f3 + 翡翠边 rgba(37,126,103,0.35)
 * - subtitle 14px olive #6b745d weight 850 + 间距字号
 * - title 21px weight 800 印刷质感
 * - 连线 stroke rgba(42,55,68,0.3) 3px / path-link rgba(24,58,74,0.74) 4px
 * - 节点 transition 920ms cubic-bezier(0.18, 1.08, 0.32, 1) 微弹
 * - map-layer transition 640ms cubic-bezier(0.22, 1, 0.36, 1) 平滑
 * - 节点配图 161×84 缩略；激活时展开到 min(70vw, 437px) × 600px
 * - 节点配图：6 套 inline SVG 简笔插画（白/橙/青/绿 调色）
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { X, Minus, Plus, ChevronLeft, ChevronRight, ChevronDown, ChevronUp } from 'lucide-react';
import { speechAgentApi } from '@/services/real/speechAgent';
import type { SpeechDeck, SpeechNode } from '@/services/contracts/speechAgent';
import { MapSectionLoader } from '@/components/ui/VideoLoader';

const LAYOUT = {
  minNodeWidth: 240,
  minNodeHeight: 100,
  pathGap: 99,
  rowGap: 75,
  stagePaddingX: 114,
  centerBaseline: 520,
  cameraCenterBand: 0.4,
};

const WHEEL_THRESHOLD = 72;
const WHEEL_IDLE_RESET_MS = 180;

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

// ── 简笔插画库（inline SVG，原版 #d8894f 橙 + #183a4a 青 + #6b745d 橄榄 调色）──
const ILLUSTRATIONS: { id: string; svg: string }[] = [
  // 演讲台
  { id: 'stage', svg: `<svg viewBox="0 0 161 84" xmlns="http://www.w3.org/2000/svg"><rect width="161" height="84" fill="#fafaf5"/><rect x="58" y="22" width="46" height="36" rx="3" fill="#fff" stroke="#183a4a" stroke-width="2"/><circle cx="81" cy="14" r="4" fill="#d8894f"/><line x1="81" y1="58" x2="81" y2="68" stroke="#183a4a" stroke-width="2"/><line x1="71" y1="72" x2="91" y2="72" stroke="#183a4a" stroke-width="2"/><circle cx="71" cy="36" r="3" fill="#d8894f"/><circle cx="91" cy="36" r="3" fill="#6b745d"/><line x1="74" y1="36" x2="88" y2="36" stroke="#a3a89a" stroke-width="1"/><path d="M 35 30 Q 50 26 56 32" stroke="#a3a89a" stroke-width="1.5" fill="none" stroke-dasharray="3 2"/><path d="M 106 32 Q 112 26 127 30" stroke="#a3a89a" stroke-width="1.5" fill="none" stroke-dasharray="3 2"/></svg>` },
  // 文档+图表
  { id: 'doc-chart', svg: `<svg viewBox="0 0 161 84" xmlns="http://www.w3.org/2000/svg"><rect width="161" height="84" fill="#fafaf5"/><rect x="22" y="16" width="44" height="52" rx="4" fill="#fff" stroke="#183a4a" stroke-width="2"/><line x1="28" y1="26" x2="60" y2="26" stroke="#6b745d" stroke-width="1.5"/><line x1="28" y1="32" x2="56" y2="32" stroke="#a3a89a" stroke-width="1.5"/><line x1="28" y1="38" x2="60" y2="38" stroke="#a3a89a" stroke-width="1.5"/><line x1="28" y1="44" x2="50" y2="44" stroke="#a3a89a" stroke-width="1.5"/><rect x="80" y="22" width="58" height="44" rx="4" fill="#fff" stroke="#183a4a" stroke-width="2"/><rect x="88" y="46" width="6" height="14" fill="#d8894f"/><rect x="98" y="38" width="6" height="22" fill="#183a4a"/><rect x="108" y="32" width="6" height="28" fill="#d8894f"/><rect x="118" y="42" width="6" height="18" fill="#6b745d"/><line x1="88" y1="60" x2="130" y2="60" stroke="#183a4a" stroke-width="1.5"/></svg>` },
  // 工作流
  { id: 'workflow', svg: `<svg viewBox="0 0 161 84" xmlns="http://www.w3.org/2000/svg"><rect width="161" height="84" fill="#fafaf5"/><circle cx="34" cy="42" r="14" fill="#fff" stroke="#183a4a" stroke-width="2"/><text x="34" y="46" text-anchor="middle" font-family="Inter" font-size="11" fill="#183a4a" font-weight="bold">1</text><circle cx="80" cy="42" r="14" fill="#fff" stroke="#d8894f" stroke-width="2"/><text x="80" y="46" text-anchor="middle" font-family="Inter" font-size="11" fill="#d8894f" font-weight="bold">2</text><circle cx="126" cy="42" r="14" fill="#fff" stroke="#6b745d" stroke-width="2"/><text x="126" y="46" text-anchor="middle" font-family="Inter" font-size="11" fill="#6b745d" font-weight="bold">3</text><line x1="48" y1="42" x2="66" y2="42" stroke="#183a4a" stroke-width="2"/><polygon points="62,38 70,42 62,46" fill="#183a4a"/><line x1="94" y1="42" x2="112" y2="42" stroke="#183a4a" stroke-width="2"/><polygon points="108,38 116,42 108,46" fill="#183a4a"/></svg>` },
  // 灯泡/想法
  { id: 'idea', svg: `<svg viewBox="0 0 161 84" xmlns="http://www.w3.org/2000/svg"><rect width="161" height="84" fill="#fafaf5"/><circle cx="80" cy="36" r="18" fill="#fff7e6" stroke="#d8894f" stroke-width="2"/><path d="M 74 40 Q 80 30 86 40" stroke="#d8894f" stroke-width="2" fill="none"/><line x1="76" y1="56" x2="84" y2="56" stroke="#183a4a" stroke-width="2"/><line x1="76" y1="60" x2="84" y2="60" stroke="#183a4a" stroke-width="2"/><line x1="78" y1="64" x2="82" y2="64" stroke="#183a4a" stroke-width="2"/><line x1="80" y1="10" x2="80" y2="14" stroke="#d8894f" stroke-width="2"/><line x1="56" y1="20" x2="60" y2="22" stroke="#d8894f" stroke-width="2"/><line x1="104" y1="20" x2="100" y2="22" stroke="#d8894f" stroke-width="2"/><line x1="50" y1="40" x2="54" y2="40" stroke="#d8894f" stroke-width="2"/><line x1="110" y1="40" x2="106" y2="40" stroke="#d8894f" stroke-width="2"/></svg>` },
  // 拼图/组合
  { id: 'puzzle', svg: `<svg viewBox="0 0 161 84" xmlns="http://www.w3.org/2000/svg"><rect width="161" height="84" fill="#fafaf5"/><rect x="36" y="18" width="36" height="30" rx="3" fill="#fff" stroke="#183a4a" stroke-width="2"/><rect x="72" y="18" width="36" height="30" rx="3" fill="#fff" stroke="#d8894f" stroke-width="2"/><rect x="36" y="48" width="36" height="22" rx="3" fill="#fff" stroke="#6b745d" stroke-width="2"/><rect x="72" y="48" width="36" height="22" rx="3" fill="#eef7f3" stroke="#256e57" stroke-width="2"/><circle cx="72" cy="33" r="4" fill="#fafaf5"/><circle cx="54" cy="48" r="4" fill="#fafaf5"/><circle cx="90" cy="48" r="4" fill="#fafaf5"/></svg>` },
  // 雷达/分析
  { id: 'radar', svg: `<svg viewBox="0 0 161 84" xmlns="http://www.w3.org/2000/svg"><rect width="161" height="84" fill="#fafaf5"/><circle cx="80" cy="42" r="28" fill="none" stroke="#a3a89a" stroke-width="1" stroke-dasharray="2 2"/><circle cx="80" cy="42" r="18" fill="none" stroke="#a3a89a" stroke-width="1" stroke-dasharray="2 2"/><circle cx="80" cy="42" r="8" fill="none" stroke="#a3a89a" stroke-width="1" stroke-dasharray="2 2"/><polygon points="80,18 96,38 88,60 72,60 64,38" fill="rgba(216,137,79,0.25)" stroke="#d8894f" stroke-width="2"/><circle cx="80" cy="18" r="3" fill="#183a4a"/><circle cx="96" cy="38" r="3" fill="#183a4a"/><circle cx="88" cy="60" r="3" fill="#183a4a"/><circle cx="72" cy="60" r="3" fill="#183a4a"/><circle cx="64" cy="38" r="3" fill="#183a4a"/></svg>` },
];

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function nodeIllustration(id: string): { svg: string } {
  const h = hashStr(id);
  return ILLUSTRATIONS[h % ILLUSTRATIONS.length];
}

function nodeSubtitle(depth: number, order: number): string {
  if (depth === 0) return '主题';
  if (depth === 1) return `第 ${order + 1} 章`;
  if (depth === 2) return `要点 ${order + 1}`;
  return `细节`;
}

export default function SpeechAgentPlayPage() {
  const { deckId = '' } = useParams<{ deckId: string }>();
  const navigate = useNavigate();

  const [deck, setDeck] = useState<SpeechDeck | null>(null);
  const [rawNodes, setRawNodes] = useState<SpeechNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [activeIndex, setActiveIndex] = useState(0);
  const [cameraTargetIndex, setCameraTargetIndex] = useState<number | null>(null);
  const [cameraZoom, setCameraZoom] = useState(0.85);
  const [activeScale, setActiveScale] = useState(1.5);
  const [controlsCollapsed, setControlsCollapsed] = useState(false);
  const [stageSize, setStageSize] = useState({ width: 1440, height: 900 });
  const [metrics, setMetrics] = useState<Map<string, Metric>>(new Map());
  const [imageViewer, setImageViewer] = useState<{ svg?: string; imageUrl?: string; title: string } | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const wheelBufferRef = useRef(0);
  const wheelTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!deckId) return;
    let cancel = false;
    setLoading(true);
    setLoadError(null);
    speechAgentApi.getDeck(deckId).then((res) => {
      if (cancel) return;
      if (res.success && res.data) {
        setDeck(res.data.deck);
        setRawNodes(res.data.nodes);
      } else {
        // 区分加载失败 / 无权限 / 不存在,避免回到「无节点」空状态误导用户
        // (Bugbot Medium "Play load errors show empty")
        setLoadError(res.error?.message ?? '加载演讲失败');
      }
      setLoading(false);
    }).catch((err) => {
      if (cancel) return;
      setLoadError(err?.message ?? '加载演讲失败');
      setLoading(false);
    });
    return () => { cancel = true; };
  }, [deckId]);

  const { tree, preorder } = useMemo(() => buildTreeAndPreorder(rawNodes), [rawNodes]);
  const endIndex = preorder.length;

  useEffect(() => { if (activeIndex > endIndex) setActiveIndex(endIndex); }, [endIndex, activeIndex]);

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
    if (activeIndex >= preorder.length) return buildEndModel(tree, preorder, metrics, cameraTargetIndex);
    return buildVisibleModel(preorder, metrics, activeIndex, cameraTargetIndex);
  }, [tree, preorder, metrics, activeIndex, cameraTargetIndex]);

  const viewport: Viewport | null = useMemo(() => {
    if (!model) return null;
    return computeViewport(model, stageSize, cameraZoom);
  }, [model, stageSize, cameraZoom]);

  const goNext = useCallback(() => { setCameraTargetIndex(null); setActiveIndex((i) => Math.min(endIndex, i + 1)); }, [endIndex]);
  const goPrev = useCallback(() => { setCameraTargetIndex(null); setActiveIndex((i) => Math.max(0, i - 1)); }, []);
  const goExit = useCallback(() => navigate(`/speech-agent/${deckId}`), [navigate, deckId]);
  const jumpTo = useCallback((idx: number) => { setCameraTargetIndex(null); setActiveIndex(Math.max(0, Math.min(endIndex, idx))); }, [endIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (imageViewer) { if (e.key === 'Escape') { e.preventDefault(); setImageViewer(null); } return; }
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
    const factor = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    wheelBufferRef.current += e.deltaY * factor;
    if (wheelTimerRef.current) window.clearTimeout(wheelTimerRef.current);
    wheelTimerRef.current = window.setTimeout(() => { wheelBufferRef.current = 0; }, WHEEL_IDLE_RESET_MS);
    while (wheelBufferRef.current >= WHEEL_THRESHOLD) { wheelBufferRef.current -= WHEEL_THRESHOLD; goNext(); }
    while (wheelBufferRef.current <= -WHEEL_THRESHOLD) { wheelBufferRef.current += WHEEL_THRESHOLD; goPrev(); }
  }, [goNext, goPrev, imageViewer]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  const onNodeClick = useCallback((node: ModelNode) => {
    if (node.isActive) return;
    setCameraTargetIndex(node.preorderIndex);
  }, []);
  const onNodeDoubleClick = useCallback((node: ModelNode) => { jumpTo(node.preorderIndex); }, [jumpTo]);

  if (loading) return <div className="h-full" style={{ background: '#fcfcf8' }}><MapSectionLoader text="加载演讲…" /></div>;
  if (loadError || !deck) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center" style={{ background: '#fcfcf8' }}>
        <p style={{ color: '#172033' }}>{loadError ?? '演讲不存在或无权限访问'}</p>
        <button onClick={goExit} className="mt-4 px-4 py-2 rounded-lg text-sm" style={{ background: '#183a4a', color: '#fff' }}>返回编辑器</button>
      </div>
    );
  }
  if (preorder.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center" style={{ background: '#fcfcf8' }}>
        <p style={{ color: '#172033' }}>演讲没有节点，无法播放。</p>
        <button onClick={goExit} className="mt-4 px-4 py-2 rounded-lg text-sm" style={{ background: '#183a4a', color: '#fff' }}>返回编辑器</button>
      </div>
    );
  }

  const isEnd = activeIndex >= endIndex;
  const nextNode = preorder[activeIndex + 1] ?? null;
  const counterText = `${Math.min(activeIndex + 1, endIndex + 1)} / ${endIndex + 1}`;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col speech-play-shell" data-tour-id="speech-play-fullscreen">
      {/* 4 层背景视差漂移（::before/::after × 2 = a/b/c/d）— 永不停的缓慢漂移舒缓视觉 */}
      <div className="speech-bg-frame" aria-hidden />

      {/* 顶部标题面板 */}
      <div className="absolute top-7 left-8 z-30 max-w-[440px]">
        <div className="text-[11px] uppercase tracking-[0.25em] mb-1" style={{ color: '#6b745d', fontWeight: 850 }}>MINDMAP PPT</div>
        <div className="text-[28px] leading-tight" style={{ color: '#172033', fontWeight: 800 }}>{deck.title}</div>
      </div>

      <button
        type="button"
        onClick={goExit}
        aria-label="退出 (ESC)"
        className="absolute top-7 right-8 z-30 w-10 h-10 rounded-full flex items-center justify-center"
        style={{ background: 'rgba(255,255,255,0.7)', border: '1px solid rgba(26,42,49,0.18)', color: '#183a4a' }}
      >
        <X size={16} />
      </button>

      {/* 主舞台 */}
      <div ref={stageRef} className="flex-1 min-h-0 relative overflow-hidden">
        {viewport && model && (
          <div
            className="absolute top-0 left-0 map-layer"
            style={{
              transform: `scale(${cameraZoom}) translate(${-viewport.x}px, ${-viewport.y}px)`,
              transformOrigin: '0 0',
              transition: 'transform 640ms cubic-bezier(0.22, 1, 0.36, 1)',
              willChange: 'transform',
            }}
          >
            <svg className="absolute" style={{ overflow: 'visible', pointerEvents: 'none' }} width="2400" height="1600">
              {model.links.map((link) => (
                <path
                  key={link.id}
                  d={linkPath(link)}
                  fill="none"
                  stroke={link.isPathLink ? 'rgba(24, 58, 74, 0.74)' : 'rgba(42, 55, 68, 0.3)'}
                  strokeWidth={link.isPathLink ? 4 : 3}
                  strokeLinecap="round"
                  style={{ transition: 'stroke 240ms ease, stroke-width 240ms ease' }}
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
                    if (n.raw.imageUrl) {
                      setImageViewer({ imageUrl: n.raw.imageUrl, title: n.raw.title });
                    } else {
                      const ill = nodeIllustration(n.id);
                      setImageViewer({ svg: ill.svg, title: n.raw.title });
                    }
                  }}
                />
              ))}
            </div>
          </div>
        )}

        <div ref={measureRef} className="mind-measurer" aria-hidden />
      </div>

      {/* 底部控制条 — 玻璃质感面板 */}
      <footer className="shrink-0 relative z-20" style={{
        background: 'rgba(255,255,255,0.72)',
        backdropFilter: 'blur(16px)',
        borderTop: '1px solid rgba(26,42,49,0.12)',
      }}>
        <div className={`transition-all ${controlsCollapsed ? 'py-2 px-7' : 'px-7 py-4'}`}>
          <div className="flex items-center gap-4">
            <button type="button" onClick={() => setControlsCollapsed((v) => !v)}
              className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center hover:bg-black/5"
              style={{ color: '#6b745d' }}
              aria-label={controlsCollapsed ? '展开控制条' : '收起控制条'}
            >{controlsCollapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>

            <button type="button" onClick={goPrev} disabled={activeIndex === 0}
              className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center disabled:opacity-30"
              style={{ background: '#fff', border: '1px solid rgba(26,42,49,0.18)', color: '#183a4a' }}
              aria-label="上一个 (←)"
            ><ChevronLeft size={16} /></button>

            <div className="flex-1 min-w-0 flex items-center gap-3">
              <span className="text-[10px] uppercase tracking-wider shrink-0" style={{ color: '#6b745d', fontWeight: 800 }}>顺序</span>
              <input
                type="range" min={0} max={endIndex} value={activeIndex}
                onChange={(e) => jumpTo(Number(e.target.value))}
                className="flex-1 mind-slider"
                style={{ ['--p' as 'color']: `${endIndex === 0 ? 0 : (activeIndex / endIndex) * 100}%` } as React.CSSProperties}
                aria-label="演讲进度"
              />
              <div className="shrink-0 text-[12px] font-mono w-16 text-right" style={{ color: '#172033', fontWeight: 700 }}>{counterText}</div>
            </div>

            <button type="button" onClick={goNext} disabled={isEnd}
              className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center disabled:opacity-30"
              style={{ background: '#183a4a', color: '#fff', boxShadow: '0 2px 8px rgba(24,58,74,0.3)' }}
              aria-label="下一个 (→ / 空格)"
            ><ChevronRight size={16} /></button>
          </div>

          {!controlsCollapsed && (
            <div className="mt-3 flex items-center gap-6 flex-wrap">
              <div className="shrink-0 flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-wider" style={{ color: '#6b745d', fontWeight: 800 }}>缩放</span>
                <button type="button" onClick={() => setCameraZoom((z) => Math.max(0.4, +(z - 0.1).toFixed(2)))}
                  className="w-6 h-6 rounded-md flex items-center justify-center hover:bg-black/5" style={{ color: '#6b745d' }}><Minus size={11} /></button>
                <input type="range" min={40} max={160} value={Math.round(cameraZoom * 100)}
                  onChange={(e) => setCameraZoom(Number(e.target.value) / 100)} className="mind-slider-small" />
                <button type="button" onClick={() => setCameraZoom((z) => Math.min(1.6, +(z + 0.1).toFixed(2)))}
                  className="w-6 h-6 rounded-md flex items-center justify-center hover:bg-black/5" style={{ color: '#6b745d' }}><Plus size={11} /></button>
                <span className="text-[11px] font-mono w-12 text-right" style={{ color: '#172033', fontWeight: 700 }}>{Math.round(cameraZoom * 100)}%</span>
              </div>

              <div className="shrink-0 flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-wider" style={{ color: '#6b745d', fontWeight: 800 }}>活跃节点</span>
                <input type="range" min={80} max={180} value={Math.round(activeScale * 100)}
                  onChange={(e) => setActiveScale(Number(e.target.value) / 100)} className="mind-slider-small" />
                <span className="text-[11px] font-mono w-12 text-right" style={{ color: '#172033', fontWeight: 700 }}>{activeScale.toFixed(2)}x</span>
              </div>

              {nextNode && !isEnd && (
                <div className="flex-1 min-w-0 max-w-[340px] px-3.5 py-2 rounded-lg flex items-center gap-2.5"
                  style={{ background: '#fff', border: '1px solid rgba(26,42,49,0.14)' }}>
                  <div className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center" style={{ background: '#d8894f', color: '#fff' }}>
                    <ChevronRight size={14} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-wider" style={{ color: '#6b745d', fontWeight: 800 }}>下一个</div>
                    <div className="text-[12px] truncate" style={{ color: '#172033', fontWeight: 700 }}>{nextNode.raw.title}</div>
                  </div>
                </div>
              )}
              {isEnd && (
                <div className="flex-1 px-3.5 py-2 rounded-lg text-[12px]" style={{ background: '#eef7f3', border: '1px solid rgba(37,126,103,0.35)', color: '#256e57', fontWeight: 700 }}>已是结束总览</div>
              )}

              <div className="shrink-0 hidden lg:flex items-center gap-3 text-[10px] font-mono" style={{ color: '#6b745d' }}>
                <span>空格/→ 下一个</span>
                <span>← 上一个</span>
                <span>单击 镜头</span>
                <span>双击 跳节点</span>
                <span>ESC 退出</span>
              </div>
            </div>
          )}
        </div>
      </footer>

      {/* 图片大图查看器 */}
      {imageViewer && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center cursor-zoom-out"
          style={{ background: 'rgba(252,252,248,0.92)', backdropFilter: 'blur(8px)' }}
          onClick={() => setImageViewer(null)}
        >
          <div className="relative max-w-[80vw] max-h-[80vh] flex flex-col items-center gap-6" onClick={(e) => e.stopPropagation()}>
            {imageViewer.imageUrl ? (
              <div className="bg-white rounded-2xl shadow-2xl overflow-hidden flex items-center justify-center" style={{ maxWidth: 'min(70vw, 800px)', maxHeight: '70vh', border: '1px solid rgba(26,42,49,0.14)' }}>
                <img
                  src={imageViewer.imageUrl}
                  alt={imageViewer.title}
                  style={{ width: '100%', height: 'auto', maxHeight: '70vh', objectFit: 'contain', display: 'block' }}
                />
              </div>
            ) : (
              <div className="bg-white rounded-2xl shadow-2xl p-8" style={{ width: 'min(70vw, 600px)', border: '1px solid rgba(26,42,49,0.14)' }}
                dangerouslySetInnerHTML={{ __html: (imageViewer.svg ?? '').replace('viewBox="0 0 161 84"', 'viewBox="0 0 161 84" style="width:100%;height:auto"') }}
              />
            )}
            <div className="text-[16px]" style={{ color: '#172033', fontWeight: 700 }}>{imageViewer.title}</div>
            <button type="button" onClick={() => setImageViewer(null)}
              className="absolute -top-3 -right-3 w-10 h-10 rounded-full flex items-center justify-center shadow-lg"
              style={{ background: '#183a4a', color: '#fff' }} aria-label="关闭大图"
            ><X size={18} /></button>
            <div className="text-[11px]" style={{ color: '#6b745d' }}>点击任意位置关闭 · ESC 关闭</div>
          </div>
        </div>
      )}

      <style>{`
        .speech-play-shell {
          color: #172033;
          background: #fcfcf8;
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
        }
        .speech-bg-frame {
          position: absolute; inset: 0; z-index: 0;
          background:
            radial-gradient(circle at 18% 18%, rgba(226, 236, 242, 0.28) 0%, rgba(226, 236, 242, 0.14) 18%, rgba(255,255,255,0) 34%),
            radial-gradient(circle at 82% 78%, rgba(247, 231, 213, 0.24) 0%, rgba(247, 231, 213, 0.11) 16%, rgba(255,255,255,0) 30%),
            linear-gradient(180deg, rgba(255,255,255,0.992), rgba(251,251,247,0.972));
          pointer-events: none;
        }
        .speech-bg-frame::before,
        .speech-bg-frame::after {
          content: ""; position: absolute; border-radius: 999px; pointer-events: none;
          filter: blur(26px); opacity: 0.9; will-change: transform;
        }
        .speech-bg-frame::before {
          top: -12vh; left: -8vw;
          width: min(48vw, 760px); height: min(48vw, 760px);
          background: radial-gradient(circle, rgba(219,233,241,0.6) 0%, rgba(219,233,241,0.34) 24%, rgba(219,233,241,0.12) 40%, rgba(255,255,255,0) 64%);
          animation: bg-orbit-a 18s linear infinite;
        }
        .speech-bg-frame::after {
          top: -12vh; right: -8vw;
          width: min(44vw, 700px); height: min(44vw, 700px);
          background: radial-gradient(circle, rgba(247,228,206,0.58) 0%, rgba(247,228,206,0.3) 24%, rgba(247,228,206,0.12) 40%, rgba(255,255,255,0) 64%);
          animation: bg-orbit-b 21s linear infinite;
        }
        @keyframes bg-orbit-a {
          0% { transform: translate3d(0,0,0) scale(1); }
          25% { transform: translate3d(28vw,-4vh,0) scale(1.08); }
          50% { transform: translate3d(42vw,20vh,0) scale(0.96); }
          75% { transform: translate3d(10vw,42vh,0) scale(1.04); }
          100% { transform: translate3d(0,0,0) scale(1); }
        }
        @keyframes bg-orbit-b {
          0% { transform: translate3d(0,0,0) scale(1); }
          25% { transform: translate3d(-28vw,-4vh,0) scale(1.06); }
          50% { transform: translate3d(-42vw,19vh,0) scale(0.93); }
          75% { transform: translate3d(-10vw,41vh,0) scale(1.02); }
          100% { transform: translate3d(0,0,0) scale(1); }
        }
        .mind-measurer {
          position: absolute; left: -99999px; top: 0; width: 0; height: 0; overflow: hidden; pointer-events: none;
        }
        .mind-card-measure {
          font-family: inherit; box-sizing: border-box; width: ${LAYOUT.minNodeWidth}px;
          padding: 12px 24px 16px; text-align: center;
        }
        .mind-card-measure .m-subtitle { font-size: 13px; line-height: 1.1; font-weight: 850; margin-bottom: 3px; }
        .mind-card-measure .m-title { font-size: 19px; line-height: 1.25; font-weight: 800; margin-bottom: 4px; }
        .mind-card-measure .m-image { display: block; width: 145px; height: 76px; margin: 4px auto 0; }
        .mind-slider {
          -webkit-appearance: none; appearance: none; height: 4px; border-radius: 2px; outline: none;
          background: linear-gradient(to right, #d8894f 0%, #d8894f var(--p), rgba(26,42,49,0.12) var(--p), rgba(26,42,49,0.12) 100%);
        }
        .mind-slider::-webkit-slider-thumb,
        .mind-slider-small::-webkit-slider-thumb {
          -webkit-appearance: none; appearance: none;
          width: 14px; height: 14px; background: #183a4a; border-radius: 50%; cursor: pointer;
          box-shadow: 0 2px 6px rgba(24,58,74,0.4);
        }
        .mind-slider-small {
          -webkit-appearance: none; appearance: none;
          width: 110px; height: 3px; border-radius: 2px; outline: none;
          background: rgba(26,42,49,0.12);
        }
      `}</style>
    </div>
  );
}

// ── 节点卡片 — 严格对齐原版样式 ──

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
  const subtitle = nodeSubtitle(node.depth, node.raw.order);
  const illustration = nodeIllustration(node.id);

  // 按原版 .mind-node.active/path-node/complete-node 配色
  let background = '#ffffff';
  let borderColor = 'rgba(26, 42, 49, 0.18)';
  let borderWidth = 2;
  let color = '#172033';
  let boxShadow = 'inset 0 1px 0 rgba(255, 255, 255, 0.94)';

  if (isActive) {
    background = '#183a4a';
    borderColor = '#d8894f';
    borderWidth = 3;
    color = '#ffffff';
    boxShadow = '0 0 14px rgba(216, 137, 79, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.08)';
  } else if (node.isPath) {
    background = '#fffdf8';
    borderColor = 'rgba(38, 77, 92, 0.34)';
  } else {
    background = '#eef7f3';
    borderColor = 'rgba(37, 126, 103, 0.35)';
  }

  if (isCamTarget && !isActive) {
    borderColor = 'rgba(216, 137, 79, 0.7)';
  }

  const scale = isActive ? activeScale : 1;
  const zIndex = isActive ? 30 : (isCamTarget ? 25 : (node.isPath ? 20 : 10));

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick(); }}
      className="absolute"
      style={{
        left, top,
        width: node.width,
        minHeight: node.height,
        padding: '12px 24px 16px',
        background,
        border: `${borderWidth}px solid ${borderColor}`,
        borderRadius: 8,
        color,
        boxShadow,
        textAlign: 'center',
        transform: `scale(${scale})`,
        transformOrigin: 'center',
        zIndex,
        transition: 'transform 920ms cubic-bezier(0.18, 1.08, 0.32, 1), background-color 620ms ease, border-color 620ms ease, border-width 620ms ease, color 620ms ease, box-shadow 620ms ease',
      }}
    >
      <div style={{ fontSize: 13, lineHeight: 1.1, fontWeight: 850, color: isActive ? 'rgba(255,255,255,0.72)' : '#6b745d', marginBottom: 3 }}>{subtitle}</div>
      <div style={{ fontSize: 19, lineHeight: 1.25, fontWeight: 800, color, marginBottom: 6 }}>{node.raw.title}</div>

      {/* 节点配图 — 已 AI 生成走 imageUrl <img>，否则降级到 hash 选的 inline SVG 简笔 */}
      <div
        onClick={(e) => { e.stopPropagation(); onImageClick(); }}
        onDoubleClick={(e) => e.stopPropagation()}
        className="mx-auto"
        style={{
          width: 145, height: 76, marginTop: 4,
          border: '1px solid rgba(31,52,56,0.12)',
          borderRadius: 7,
          background: 'rgba(255,255,255,0.7)',
          overflow: 'hidden',
          cursor: 'zoom-in',
        }}
        role="button"
        aria-label="点击查看大图"
        {...(node.raw.imageUrl
          ? {}
          : { dangerouslySetInnerHTML: { __html: illustration.svg.replace('width="161" height="84"', 'width="100%" height="100%"').replace('viewBox="0 0 161 84"', 'viewBox="0 0 161 84" preserveAspectRatio="xMidYMid meet"') } })}
      >
        {node.raw.imageUrl && (
          <img
            src={node.raw.imageUrl}
            alt={node.raw.title}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        )}
      </div>
    </button>
  );
}

// ── 算法部分（沿用上版本，未改）──

function buildTreeAndPreorder(raw: SpeechNode[]): { tree: TreeNode | null; preorder: TreeNode[] } {
  if (raw.length === 0) return { tree: null, preorder: [] };
  const byId = new Map<string, TreeNode>();
  for (const n of raw) byId.set(n.id, { id: n.id, raw: n, parent: null, children: [], depth: 0, preorderIndex: 0 });
  let root: TreeNode | null = null;
  for (const t of byId.values()) {
    if (!t.raw.parentId) root = t;
    else { const p = byId.get(t.raw.parentId); if (p) { t.parent = p; p.children.push(t); } }
  }
  if (!root) return { tree: null, preorder: [] };
  const sortRec = (n: TreeNode) => { n.children.sort((a, b) => a.raw.order - b.raw.order); n.children.forEach(sortRec); };
  sortRec(root);
  const flat: TreeNode[] = [];
  const walk = (n: TreeNode, depth: number) => { n.depth = depth; n.preorderIndex = flat.length; flat.push(n); n.children.forEach((c) => walk(c, depth + 1)); };
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

function placeSubtree(n: TreeNode, visibleIds: Set<string>, metrics: Map<string, Metric>, positions: Map<string, { x: number; y: number }>, anchor: { x: number; y: number }) {
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
    placeSubtree(child, visibleIds, metrics, positions, { x: anchor.x + nMetric.width / 2 + LAYOUT.pathGap + cMetric.width / 2, y: childY });
    cursorY += height + LAYOUT.rowGap;
  }
}

function pathToRoot(n: TreeNode): TreeNode[] {
  const path: TreeNode[] = [];
  let cur: TreeNode | null = n;
  while (cur) { path.unshift(cur); cur = cur.parent; }
  return path;
}

function buildVisibleModel(preorder: TreeNode[], metrics: Map<string, Metric>, activeIndex: number, cameraTargetIndex: number | null): Model {
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
    completeKids.forEach((c) => completedSubtrees.push({ child: c, depthIndex, height: measureSubtree(c, visibleIds, metrics) }));
  });
  const completedHeight = completedSubtrees.reduce((a, b) => a + b.height, 0) + Math.max(0, completedSubtrees.length - 1) * LAYOUT.rowGap;
  let cursorY = baseline - LAYOUT.rowGap - completedHeight;
  for (const st of completedSubtrees) {
    const parentNode = path[st.depthIndex];
    const parentPos = positions.get(parentNode.id)!;
    const parentMetric = getMetric(parentNode.id, metrics);
    const childMetric = getMetric(st.child.id, metrics);
    placeSubtree(st.child, visibleIds, metrics, positions, { x: parentPos.x + parentMetric.width / 2 + LAYOUT.pathGap + childMetric.width / 2, y: cursorY + st.height / 2 });
    cursorY += st.height + LAYOUT.rowGap;
  }
  return buildModel(visibleIds, positions, metrics, pathIds, activeNode.id, cameraTargetIndex, preorder, false);
}

function buildEndModel(root: TreeNode, preorder: TreeNode[], metrics: Map<string, Metric>, cameraTargetIndex: number | null): Model {
  const visibleIds = new Set(preorder.map((n) => n.id));
  const positions = new Map<string, { x: number; y: number }>();
  const rootMetric = getMetric(root.id, metrics);
  placeSubtree(root, visibleIds, metrics, positions, { x: LAYOUT.stagePaddingX + rootMetric.width / 2, y: LAYOUT.centerBaseline });
  return buildModel(visibleIds, positions, metrics, new Set(), null, cameraTargetIndex, preorder, true);
}

function buildModel(visibleIds: Set<string>, positions: Map<string, { x: number; y: number }>, metrics: Map<string, Metric>, pathIds: Set<string>, activeNodeId: string | null, cameraTargetIndex: number | null, preorder: TreeNode[], isEnd: boolean): Model {
  const nodes: ModelNode[] = [];
  const links: ModelLink[] = [];
  const byId = new Map(preorder.map((n) => [n.id, n] as const));
  visibleIds.forEach((id) => {
    const t = byId.get(id);
    const pos = positions.get(id);
    if (!t || !pos) return;
    const m = getMetric(id, metrics);
    nodes.push({ id, raw: t.raw, x: pos.x, y: pos.y, width: m.width, height: m.height, depth: t.depth, preorderIndex: t.preorderIndex, isPath: pathIds.has(id), isActive: id === activeNodeId, isCameraTarget: cameraTargetIndex !== null && t.preorderIndex === cameraTargetIndex });
    if (t.parent && positions.has(t.parent.id)) {
      const pMetric = getMetric(t.parent.id, metrics);
      const pPos = positions.get(t.parent.id)!;
      links.push({ id: `${t.parent.id}->${t.id}`, fromX: pPos.x, fromY: pPos.y, fromWidth: pMetric.width, toX: pos.x, toY: pos.y, toWidth: m.width, isPathLink: pathIds.has(t.parent.id) && pathIds.has(t.id) });
    }
  });
  return { nodes, links, isEnd };
}

function computeViewport(model: Model, stageSize: { width: number; height: number }, zoom: number): Viewport {
  const logical = { width: stageSize.width / zoom, height: stageSize.height / zoom };
  if (model.nodes.length === 0) return { x: 0, y: 0, ...logical };
  const camTargetNode = model.nodes.find((n) => n.isCameraTarget);
  const target = camTargetNode ? { x: camTargetNode.x, y: camTargetNode.y } : (model.isEnd ? boundsCenter(model.nodes) : (model.nodes.find((n) => n.isActive) ?? boundsCenter(model.nodes)));
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

function renderMeasureHTML(t: TreeNode): string {
  const safe = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
  const sub = nodeSubtitle(t.depth, t.raw.order);
  return `<div class="m-subtitle">${safe(sub)}</div><div class="m-title">${safe(t.raw.title)}</div><div class="m-image"></div>`;
}
