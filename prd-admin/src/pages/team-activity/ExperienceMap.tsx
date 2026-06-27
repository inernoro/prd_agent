/**
 * 体验全景热力图（squarified treemap）：把系统接口面铺成一张地图。
 * 每块=一个端点，面积=访问量，颜色=健康——健康区走「冷色平静海」（每个模块一个色相、区内明度递变），
 * 痛点（红=报错、琥珀=慢）从平静里跳出来并带发光描边。点击痛点块 → 下钻联动到下方痛点榜对应行。
 * 配色遵循 ui-ux-pro-max 的 treemap 规范：父级不同色相、子级同色相浅色梯度；暖色只留给告警。
 * 数据源：GET /api/team-activity/experience-map（与 insights 同源 apirequestlogs，target 同口径）。
 */
import { useCallback, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { GlassCard } from '@/components/design';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import type { ExperienceMapGroup, ExperienceMapLeaf, TeamActivityExperienceMapData } from '@/services/contracts/teamActivity';

// 量到容器真实像素前的回退尺寸（SSR / ResizeObserver 首帧）。运行时 viewBox 用容器真实像素，
// 使 viewBox 宽高比恒等于容器 → preserveAspectRatio="meet" 退化为恒等变换 → treemap 永远铺满整格、零 letterbox。
const VW_FALLBACK = 1000;
const VH_FALLBACK = 560;
const PAD = 3;
const HDR = 14;

// 模块色相（冷色平静海：蓝→青→绿协调，避开告警的暖色与紫）
const GROUP_HUES = [222, 200, 186, 170, 150, 210, 234, 132, 196, 176, 160, 214, 140, 188, 206, 246];
const ERR = '#f8717a';
const SLOW = '#fbbf24';
// 第一遍「写字」时长：扫描线从左扫到右、把所有块写出来；写完后第二遍才给痛点点睛
const SWEEP_MS = 1300;
// 换时间窗时块「生长」补间：几何尺寸/位置平滑过渡到新值，让用户看见谁在长大/缩小
const MORPH = 'x .8s cubic-bezier(.45,0,.2,1), y .8s cubic-bezier(.45,0,.2,1), width .8s cubic-bezier(.45,0,.2,1), height .8s cubic-bezier(.45,0,.2,1)';

type Rect = { x: number; y: number; w: number; h: number };
type Placed<T> = T & { rect: Rect };

function worstRatio(row: { value: number }[], side: number, scale: number): number {
  const areas = row.map((r) => r.value * scale);
  const sum = areas.reduce((a, b) => a + b, 0);
  const mx = Math.max(...areas);
  const mn = Math.min(...areas);
  return Math.max((side * side * mx) / (sum * sum), (sum * sum) / (side * side * mn));
}

/** 标准 squarified treemap：把 items 按 value 比例铺满 rect，返回带 rect 的副本 */
function squarify<T extends { value: number }>(items: T[], rect: Rect): Placed<T>[] {
  const sorted = items
    .filter((i) => i.value > 0)
    .map((i) => ({ ...i }))
    .sort((a, b) => b.value - a.value) as Placed<T>[];
  const out: Placed<T>[] = [];
  const free: Rect = { ...rect };
  let freeTotal = sorted.reduce((s, i) => s + i.value, 0);
  let i = 0;
  while (i < sorted.length && freeTotal > 0 && free.w > 0.5 && free.h > 0.5) {
    const scale = (free.w * free.h) / freeTotal;
    const side = Math.min(free.w, free.h);
    const row: Placed<T>[] = [sorted[i]];
    let last = worstRatio(row, side, scale);
    let j = i + 1;
    while (j < sorted.length) {
      row.push(sorted[j]);
      const w = worstRatio(row, side, scale);
      if (w > last) {
        row.pop();
        break;
      }
      last = w;
      j++;
    }
    const rowVal = row.reduce((s, r) => s + r.value, 0);
    const rowArea = rowVal * scale;
    if (free.w >= free.h) {
      const colW = rowArea / free.h;
      let yy = free.y;
      row.forEach((r) => {
        const rh = (r.value * scale) / colW;
        r.rect = { x: free.x, y: yy, w: colW, h: rh };
        yy += rh;
        out.push(r);
      });
      free.x += colW;
      free.w -= colW;
    } else {
      const rowH = rowArea / free.w;
      let xx = free.x;
      row.forEach((r) => {
        const rw = (r.value * scale) / rowH;
        r.rect = { x: xx, y: free.y, w: rw, h: rowH };
        xx += rw;
        out.push(r);
      });
      free.y += rowH;
      free.h -= rowH;
    }
    freeTotal -= rowVal;
    i = j;
  }
  return out;
}

function healthyFill(hue: number, idx: number): string {
  const l = 29 + (idx % 5) * 3.4;
  return `hsl(${hue} 36% ${l.toFixed(0)}%)`;
}

type LeafCell = {
  group: ExperienceMapGroup;
  leaf: ExperienceMapLeaf;
  hue: number;
  idxInGroup: number;
  rect: Rect;
};

export function ExperienceMap({
  data,
  loading,
  onSelectTarget,
  fullscreen = false,
  onRequestFullscreen,
  onExitFullscreen,
  headerExtra,
}: {
  data: TeamActivityExperienceMapData | null;
  loading: boolean;
  onSelectTarget?: (target: string, fallback: { label: string; metric: string; kind?: string }) => void;
  /** 全屏态：放大视口 + 显示更多标签层级（块更大、标签阈值放宽） */
  fullscreen?: boolean;
  /** 非全屏时点右上角「全屏」按钮触发（父组件挂全屏浮层） */
  onRequestFullscreen?: () => void;
  /** 全屏态点「退出全屏」按钮触发 */
  onExitFullscreen?: () => void;
  /** 头部右侧额外控件（四图仪表盘里注入 热力图⇄站点地图 子切换器） */
  headerExtra?: ReactNode;
}) {
  // 两个范围模式：all=全域(全部端点按访问量) / pain=痛点(只看病灶，按问题严重度放大)
  const [mode, setMode] = useState<'all' | 'pain'>('all');
  // SVG gradient id 唯一化：全屏浮层与格内地图同时挂载同一组件时，固定 id 会冲突导致渐变互相覆盖。
  // useId 返回 ':r0:' 形态，去掉冒号以符合 SVG id 规范。
  const uid = useId().replace(/:/g, '');
  const cometGradId = `voc-comet-grad-${uid}`;
  const penId = `voc-pen-${uid}`;
  // aspect-aware：量出 SVG 容器真实像素宽高比，让 treemap 布局高度跟容器同比例铺满，消除上下 letterbox 空白。
  // ResizeObserver 量到前用回退值（避免 SSR/首帧白屏）。
  const [boxDims, setBoxDims] = useState<{ w: number; h: number } | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  // 用「回调 ref」而非 useLayoutEffect(deps=[fullscreen]) 来测量：首屏会先渲染 loader 早退（此时 SVG 容器还没挂载），
  // effect 跑在 el=null 上直接 bail，且依赖不变后不会重跑 → boxDims 永远是 null → 回退到 1000×560 比例 →
  // preserveAspectRatio="meet" 把 treemap 装进信箱框、四周留白（时填满时不填满的随机感即源于此）。
  // 回调 ref 保证「容器一挂载即测量并 observe，一卸载即 disconnect」，根治该 letterbox。
  const measureBoxRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 4 && r.height > 4) {
        setBoxDims((prev) => (prev && Math.abs(prev.w - r.width) < 1 && Math.abs(prev.h - r.height) < 1 ? prev : { w: Math.round(r.width), h: Math.round(r.height) }));
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    roRef.current = ro;
  }, []);
  // 像素级 viewBox：viewBox 宽高 = 容器真实像素，使 viewBox 宽高比恒等于容器宽高比，
  // preserveAspectRatio="meet" 退化为恒等变换 → treemap 永远铺满整格、零 letterbox、无拉伸变形。
  const VW = boxDims?.w ?? VW_FALLBACK;
  const VH = boxDims?.h ?? VH_FALLBACK;
  const layout = useMemo(() => {
    if (!data || data.groups.length === 0) return { cells: [] as LeafCell[], groupRects: [] as Placed<ExperienceMapGroup>[] };
    let srcGroups = data.groups;
    if (mode === 'pain') {
      // 痛点模式：只留病灶端点，面积改用「问题严重度」(访问量 × 报错/慢率 ≈ 坏请求数)，让病灶占满画布
      srcGroups = data.groups
        .map((g) => {
          const leaves = g.leaves
            .filter((l) => l.status === 'error' || l.status === 'slow')
            .map((l) => ({ ...l, value: Math.max(1, Math.round(l.value * Math.max(l.errorRate, l.slowRate))) }));
          return { ...g, leaves, value: leaves.reduce((s, l) => s + l.value, 0) };
        })
        .filter((g) => g.leaves.length > 0);
    }
    if (srcGroups.length === 0) return { cells: [] as LeafCell[], groupRects: [] as Placed<ExperienceMapGroup>[] };
    const groupRects = squarify(srcGroups, { x: PAD, y: PAD, w: VW - PAD * 2, h: VH - PAD * 2 });
    const cells: LeafCell[] = [];
    groupRects.forEach((g, gi) => {
      const hue = GROUP_HUES[gi % GROUP_HUES.length];
      const inner: Rect = { x: g.rect.x + 2, y: g.rect.y + HDR, w: g.rect.w - 4, h: g.rect.h - HDR - 2 };
      if (inner.w < 4 || inner.h < 4) return;
      const placed = squarify(g.leaves, inner);
      placed.forEach((lf, li) => {
        cells.push({ group: g, leaf: lf, hue, idxInGroup: li, rect: lf.rect });
      });
    });
    return { cells, groupRects };
  }, [data, mode, VW, VH]);

  // 入场闸门：只在首次渲染地图时为 true（生产单次渲染可靠；dev StrictMode 下可能跳过入场，无害）
  const enteredRef = useRef(false);

  if (loading && !data) {
    return (
      <GlassCard className="h-full" style={{ minHeight: 320 }}>
        <div className="h-full flex items-center justify-center">
          <MapSectionLoader text="正在铺设体验全景热力图…" />
        </div>
      </GlassCard>
    );
  }

  if (!data || data.groups.length === 0) return null;

  // 首屏入场只放一次：第一次拿到地图数据时走「写字 + 点睛」；之后换时间窗只做 morph 生长，不重演入场。
  // 闸门绑在「已拿到真实测量尺寸(boxDims)的首帧」——回退尺寸那一帧不点亮入场，避免随后 boxDims 落地、
  // 布局重算时把正在播的入场动画吃掉（旧实现里这正是入场动画时有时无的根因）。
  const isEntrance = !!boxDims && !enteredRef.current;
  if (boxDims) enteredRef.current = true;

  // 放宽标签阈值让更多（含较小）块也显示标题——「标题显示不下就铺满」（按宽度截断到能放下的字数，不外溢）
  const labelMinW = fullscreen ? 26 : 30;
  const labelMinH = fullscreen ? 13 : 15;
  const subLabelMinH = fullscreen ? 26 : 32;
  const grpMinW = fullscreen ? 54 : 70;
  const grpMinH = fullscreen ? 24 : 30;

  return (
    <>
      <GlassCard
        className="overflow-hidden h-full flex flex-col"
        style={fullscreen ? { padding: 0, height: '100%', minHeight: 0 } : { padding: 0, minHeight: 0 }}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between px-4 pt-3 pb-2 shrink-0">
          <span className="text-[13px] font-semibold text-white/85 inline-flex items-center gap-2.5 min-w-0 flex-wrap">
            <span className="whitespace-nowrap">体验全景热力图</span>
            <span
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap shrink-0"
              style={{ background: 'rgba(45,212,191,0.12)', color: '#5eead4', border: '1px solid rgba(45,212,191,0.32)' }}
            >
              <span className="relative inline-flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-cyan-400" style={{ opacity: 0.6, animation: 'voc-ping 1.5s cubic-bezier(0,0,.2,1) infinite' }} />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-400" />
              </span>
              实时扫描中
            </span>
            <span className="hidden sm:inline text-[11px] text-white/35 font-normal whitespace-nowrap">
              {mode === 'all' ? '每块=端点 · 面积=访问量 · 颜色=健康' : '只看病灶 · 面积=问题严重度 · 点击下钻'}
            </span>
          </span>
          <div className="flex items-center gap-2.5 sm:gap-3.5 text-[11px] text-white/55 flex-wrap min-w-0">
            <div className="inline-flex rounded-lg border border-white/10 bg-white/[0.03] p-0.5">
              <button
                type="button"
                onClick={() => setMode('all')}
                className={`px-2.5 py-1 rounded-md text-[11px] transition-colors cursor-pointer ${mode === 'all' ? 'bg-cyan-500/15 text-cyan-200' : 'text-white/45 hover:text-white/75'}`}
              >
                全域
              </button>
              <button
                type="button"
                onClick={() => setMode('pain')}
                className={`px-2.5 py-1 rounded-md text-[11px] transition-colors cursor-pointer ${mode === 'pain' ? 'bg-rose-500/15 text-rose-200' : 'text-white/45 hover:text-white/75'}`}
              >
                痛点
              </button>
            </div>
            {headerExtra ? <span className="shrink-0">{headerExtra}</span> : null}
            <span className="hidden sm:inline w-px h-3.5 bg-white/10" />
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap shrink-0">
              <i className="w-2.5 h-2.5 rounded-sm" style={{ background: ERR }} />报错
            </span>
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap shrink-0">
              <i className="w-2.5 h-2.5 rounded-sm" style={{ background: SLOW }} />等待过久
            </span>
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap shrink-0">
              <i className="w-2.5 h-2.5 rounded-sm" style={{ background: 'hsl(196 36% 36%)' }} />健康
            </span>
            {fullscreen ? (
              onExitFullscreen ? (
                <button
                  type="button"
                  onClick={onExitFullscreen}
                  title="退出全屏（ESC）"
                  className="inline-flex items-center justify-center w-7 h-7 rounded-md border border-white/10 bg-white/[0.03] text-white/55 hover:text-white/90 hover:border-white/25 transition-colors cursor-pointer"
                >
                  <Minimize2 size={14} />
                </button>
              ) : null
            ) : onRequestFullscreen ? (
              <button
                type="button"
                onClick={onRequestFullscreen}
                title="全屏放大热力图"
                className="inline-flex items-center justify-center w-7 h-7 rounded-md border border-white/10 bg-white/[0.03] text-white/55 hover:text-white/90 hover:border-white/25 transition-colors cursor-pointer"
              >
                <Maximize2 size={14} />
              </button>
            ) : null}
          </div>
        </div>
        <div
          ref={measureBoxRef}
          className={`px-2 pb-2 flex-1 min-h-0 flex flex-col${fullscreen ? '' : ' voc-map-body'}`}
        >
          {layout.groupRects.length === 0 ? (
            <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 text-center">
              <span className="w-3 h-3 rounded-full" style={{ background: '#34d399', boxShadow: '0 0 0 5px rgba(52,211,153,0.16)' }} />
              <span className="text-sm text-emerald-300/85">当前范围内没有痛点</span>
              <span className="text-[12px] text-white/40">系统体验健康，切回「全域」看全部端点</span>
            </div>
          ) : (
          <svg
            viewBox={`0 0 ${VW} ${VH}`}
            preserveAspectRatio="xMidYMid meet"
            style={{ width: '100%', flex: 1, minHeight: 0, height: '100%', display: 'block' }}
          >
            {/* 分区边框 + 标签 */}
            {layout.groupRects.map((g) => (
              <g key={`grp-${g.key}`} style={{ animation: 'voc-grp-in .4s ease both' }}>
                <rect
                  rx={4}
                  fill="none"
                  stroke="rgba(255,255,255,0.10)"
                  strokeWidth={1}
                  style={{ x: `${g.rect.x}px`, y: `${g.rect.y}px`, width: `${g.rect.w}px`, height: `${g.rect.h}px`, transition: MORPH }}
                />
                {g.rect.w > grpMinW && g.rect.h > grpMinH ? (
                  <text
                    x={g.rect.x + 5}
                    y={g.rect.y + 11}
                    style={{
                      fill: 'rgba(236,236,239,0.82)',
                      fontSize: 10.5,
                      fontWeight: 700,
                      letterSpacing: '0.3px',
                      paintOrder: 'stroke',
                      stroke: 'rgba(0,0,0,0.6)',
                      strokeWidth: 2.5,
                    }}
                  >
                    {g.label}
                    {g.errorLeaves + g.slowLeaves > 0 ? (
                      <tspan style={{ fill: g.errorLeaves > 0 ? ERR : SLOW, fontSize: 9.5 }}>
                        {'  '}
                        {g.errorLeaves + g.slowLeaves} 处告警
                      </tspan>
                    ) : null}
                  </text>
                ) : null}
              </g>
            ))}
            {/* 叶子块体 —— 第一遍：随扫描线经过(按 x 位置)依次写出全部实心块与文字。
                注意：痛点辉光/点睛/彗星不放这里——块体按文档序绘制会互相覆盖，辉光会被相邻块裁掉，
                故所有「会溢出块边界」的光效统一移到下方顶层装饰层，保证永不被遮挡。 */}
            {layout.cells.map((c) => {
              const r = c.rect;
              if (r.w < 1 || r.h < 1) return null;
              const isPain = c.leaf.status === 'error' || c.leaf.status === 'slow';
              const hasBurst = c.leaf.burstPct != null && c.leaf.burstPct >= 50;
              const fill = c.leaf.status === 'error' ? ERR : c.leaf.status === 'slow' ? SLOW : healthyFill(c.hue, c.idxInGroup);
              const showLabel = r.w > labelMinW && r.h > labelMinH;
              const clickable = isPain && !!onSelectTarget;
              const cellCx = r.x + r.w / 2;
              const revealDelay = Math.round((cellCx / VW) * SWEEP_MS); // 按 x → 跟随扫描线
              const gStyle: CSSProperties = {
                cursor: clickable ? 'pointer' : 'default',
                transformBox: 'fill-box',
                transformOrigin: 'center',
              };
              if (isEntrance) {
                gStyle.animation = 'voc-cell-in 0.4s cubic-bezier(.34,1.56,.64,1) both';
                gStyle.animationDelay = `${revealDelay}ms`;
              }
              return (
                <g key={c.leaf.target} style={gStyle} onClick={clickable ? () => onSelectTarget!(c.leaf.target, { label: `${c.group.label} · ${c.leaf.label}`, metric: c.leaf.metric, kind: c.leaf.status === 'error' ? 'api-error' : c.leaf.status === 'slow' ? 'slow-endpoint' : undefined }) : undefined}>
                  <title>{`${c.group.label} · ${c.leaf.label}\n${c.leaf.target}\n${c.leaf.metric}`}</title>
                  <rect
                    rx={2}
                    stroke="rgba(255,255,255,0.07)"
                    strokeWidth={1}
                    style={{
                      x: `${r.x + 0.5}px`,
                      y: `${r.y + 0.5}px`,
                      width: `${Math.max(0, r.w - 1)}px`,
                      height: `${Math.max(0, r.h - 1)}px`,
                      fill,
                      transition: `${MORPH}, fill .5s ease`,
                    }}
                  />
                  {showLabel ? (() => {
                    // 「铺满」：窄块用更小字号 + 按可用宽度截断到放得下的字数（多余省略号），标题不外溢到邻块
                    const labelFont = r.w < 56 ? 9 : 10;
                    const maxChars = Math.max(1, Math.floor((r.w - 8) / (labelFont * 0.6)));
                    const full = c.leaf.label ?? '';
                    const text = full.length > maxChars ? `${full.slice(0, Math.max(1, maxChars - 1))}…` : full;
                    return (
                      <text
                        x={r.x + 5}
                        y={r.y + (labelFont < 10 ? 13 : 14)}
                        style={{ fill: '#fff', fontSize: labelFont, fontWeight: 600, paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.55)', strokeWidth: 2.5 }}
                      >
                        {text}
                      </text>
                    );
                  })() : null}
                  {isPain && showLabel && r.h > subLabelMinH ? (
                    <text
                      x={r.x + 5}
                      y={r.y + 26}
                      style={{ fill: 'rgba(255,255,255,0.9)', fontSize: 9, paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.55)', strokeWidth: 2 }}
                    >
                      {hasBurst && r.h > 30
                        ? `突增 +${c.leaf.burstPct}%`
                        : c.leaf.status === 'error'
                          ? '报错'
                          : '慢'}
                    </text>
                  ) : null}
                </g>
              );
            })}
            {/* 顶层痛点装饰层 —— 在所有块体之上绘制辉光描边/点睛/突增流星，pointer-events:none 让点击穿透到下方块体。
                这样辉光溢出块边界的部分不会被相邻块覆盖（修复「边框光效被遮挡」）。 */}
            <defs>
              {/* 流星尾：尾端透明 → 头端高亮（objectBoundingBox，按每条线自身斜向 bbox 取向，无需逐块算坐标） */}
              <linearGradient id={cometGradId} gradientUnits="objectBoundingBox" x1="0" y1="1" x2="1" y2="0">
                <stop offset="0" stopColor={SLOW} stopOpacity="0" />
                <stop offset="0.7" stopColor={SLOW} stopOpacity="0.55" />
                <stop offset="1" stopColor="#fff" stopOpacity="0.95" />
              </linearGradient>
            </defs>
            {layout.cells.map((c) => {
              const r = c.rect;
              const isPain = c.leaf.status === 'error' || c.leaf.status === 'slow';
              if (!isPain || r.w < 1 || r.h < 1) return null;
              const fill = c.leaf.status === 'error' ? ERR : SLOW;
              const hasBurst = c.leaf.burstPct != null && c.leaf.burstPct >= 50;
              const igniteDelay = SWEEP_MS + 140; // 写完后再点睛
              return (
                <g key={`deco-${c.leaf.target}`} style={{ pointerEvents: 'none', transformBox: 'fill-box', transformOrigin: 'center' }}>
                  {/* 辉光描边：顶层薄描边 + drop-shadow 外晕，永不被相邻块覆盖 */}
                  <rect
                    rx={2}
                    fill="none"
                    stroke={fill}
                    strokeWidth={1.4}
                    strokeOpacity={isEntrance ? undefined : 0.85}
                    style={{
                      x: `${r.x + 0.7}px`,
                      y: `${r.y + 0.7}px`,
                      width: `${Math.max(0, r.w - 1.4)}px`,
                      height: `${Math.max(0, r.h - 1.4)}px`,
                      filter: `drop-shadow(0 0 6px ${fill})`,
                      transition: MORPH,
                      ...(isEntrance ? { animation: 'voc-halo-in .5s ease both', animationDelay: `${igniteDelay}ms` } : {}),
                    }}
                  />
                  {/* 点睛①：一次性扩散环(写完后 ping 一下) */}
                  {isEntrance ? (
                    <rect
                      rx={2}
                      fill="none"
                      stroke={fill}
                      strokeWidth={1.6}
                      strokeOpacity={0}
                      style={{ x: `${r.x + 1}px`, y: `${r.y + 1}px`, width: `${Math.max(0, r.w - 2)}px`, height: `${Math.max(0, r.h - 2)}px`, transformBox: 'fill-box', transformOrigin: 'center', transition: MORPH, animation: 'voc-ignite 0.7s ease-out', animationDelay: `${igniteDelay}ms` }}
                    />
                  ) : null}
                  {/* 点睛②：持续脉冲白描边(写完后才开始亮) */}
                  <rect
                    rx={2}
                    fill="none"
                    stroke="#fff"
                    strokeWidth={1.4}
                    strokeOpacity={0}
                    style={{ x: `${r.x + 1}px`, y: `${r.y + 1}px`, width: `${Math.max(0, r.w - 2)}px`, height: `${Math.max(0, r.h - 2)}px`, animation: `voc-cell-glow ${2 + (c.idxInGroup % 5) * 0.2}s ease-in-out infinite`, animationDelay: isEntrance ? `${igniteDelay}ms` : '0ms', transition: MORPH }}
                  />
                  {/* 突增流星：环比突增 >=50% 的痛点块，块内右上角一道斜向上飞的流星（尾→头渐隐），
                      仅在飞行途中可见(静止帧透明)，永远落在块内——不再是停在角落的「棒棒糖」。 */}
                  {hasBurst && r.w > 52 && r.h > 34 ? (
                    <g style={{ transformBox: 'fill-box', transformOrigin: 'center', animation: `voc-comet ${2.4 + (c.idxInGroup % 4) * 0.25}s ease-out infinite` }}>
                      <line
                        x1={r.x + r.w - 25}
                        y1={r.y + 23}
                        x2={r.x + r.w - 10}
                        y2={r.y + 9}
                        stroke={`url(#${cometGradId})`}
                        strokeWidth={1.6}
                        strokeLinecap="round"
                      />
                      <circle cx={r.x + r.w - 10} cy={r.y + 9} r={1.6} fill="#fff" />
                    </g>
                  ) : null}
                </g>
              );
            })}
            {/* 扫描笔：仅首屏入场画一次(块随笔尖经过而出现)，一次画完即淡出——不空转；换时间窗走 morph 不再扫 */}
            {isEntrance ? (
              <>
                <defs>
                  <linearGradient id={penId} x1="0" x2="1" y1="0" y2="0">
                    <stop offset="0" stopColor="#2dd4bf" stopOpacity="0" />
                    <stop offset="0.7" stopColor="#2dd4bf" stopOpacity="0.05" />
                    <stop offset="0.96" stopColor="#5eead4" stopOpacity="0.22" />
                    <stop offset="1" stopColor="#a5f3eb" stopOpacity="0.7" />
                  </linearGradient>
                </defs>
                <g style={{ pointerEvents: 'none' }}>
                  <rect x={-44} y={0} width={44} height={VH} fill={`url(#${penId})`}>
                    <animate attributeName="x" from={-44} to={VW} dur="1.3s" repeatCount="1" fill="freeze" />
                    <animate attributeName="opacity" from="1" to="0" begin="1.2s" dur="0.35s" fill="freeze" />
                  </rect>
                </g>
              </>
            ) : null}
          </svg>
          )}
        </div>
      </GlassCard>
      <style>{`
        /* 非全屏地图体：grid 格内靠 flex 拉满格子高度（等高仪表盘）。给一个 min-height 兜底，
           确保移动单图（无 grid 撑高）/ 桌面格也不会塌成只剩头部。 */
        .voc-map-body { min-height: 320px; }
        /* 窄屏：让地图长满首屏主要高度（≈视口 66%），吃掉卡片下方空白、块也看得清点得到
           （呼应 mobile-first-density 规则：内容占视口≥60%）。 */
        @media (max-width: 639px) {
          .voc-map-body { min-height: 340px; height: min(66vh, 600px); }
        }
        @keyframes voc-cell-glow { 0%,100% { stroke-opacity: .35; } 50% { stroke-opacity: 1; } }
        @keyframes voc-cell-in { from { opacity: 0; transform: scale(.45); } to { opacity: 1; transform: scale(1); } }
        @keyframes voc-grp-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes voc-ping { 75%,100% { transform: scale(2.2); opacity: 0; } }
        @keyframes voc-ignite { 0% { stroke-opacity: .9; transform: scale(1); } 100% { stroke-opacity: 0; transform: scale(1.18); } }
        @keyframes voc-halo-in { from { stroke-opacity: 0; } to { stroke-opacity: .85; } }
        @keyframes voc-comet { 0% { transform: translate(-7px,7px); opacity: 0; } 20% { opacity: 1; } 80% { opacity: .9; } 100% { transform: translate(6px,-6px); opacity: 0; } }
      `}</style>
    </>
  );
}
