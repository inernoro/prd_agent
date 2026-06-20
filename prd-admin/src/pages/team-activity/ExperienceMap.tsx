/**
 * 体验全景热力图（squarified treemap）：把系统接口面铺成一张地图。
 * 每块=一个端点，面积=访问量，颜色=健康——健康区走「冷色平静海」（每个模块一个色相、区内明度递变），
 * 痛点（红=报错、琥珀=慢）从平静里跳出来并带发光描边。点击痛点块 → 下钻联动到下方痛点榜对应行。
 * 配色遵循 ui-ux-pro-max 的 treemap 规范：父级不同色相、子级同色相浅色梯度；暖色只留给告警。
 * 数据源：GET /api/team-activity/experience-map（与 insights 同源 apirequestlogs，target 同口径）。
 */
import { useMemo, useRef, type CSSProperties } from 'react';
import { GlassCard } from '@/components/design';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import type { ExperienceMapGroup, ExperienceMapLeaf, TeamActivityExperienceMapData } from '@/services/contracts/teamActivity';

const VW = 1000;
const VH = 420;
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
const MORPH_XY = 'x .8s cubic-bezier(.45,0,.2,1), y .8s cubic-bezier(.45,0,.2,1)';

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
}: {
  data: TeamActivityExperienceMapData | null;
  loading: boolean;
  onSelectTarget?: (target: string) => void;
}) {
  const layout = useMemo(() => {
    if (!data || data.groups.length === 0) return { cells: [] as LeafCell[], groupRects: [] as Placed<ExperienceMapGroup>[] };
    const groupRects = squarify(data.groups, { x: PAD, y: PAD, w: VW - PAD * 2, h: VH - PAD * 2 });
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
  }, [data]);

  // 入场闸门：只在首次渲染地图时为 true（生产单次渲染可靠；dev StrictMode 下可能跳过入场，无害）
  const enteredRef = useRef(false);

  if (loading && !data) {
    return (
      <GlassCard style={{ height: 320 }}>
        <div className="h-full flex items-center justify-center">
          <MapSectionLoader text="正在铺设体验全景热力图…" />
        </div>
      </GlassCard>
    );
  }

  if (!data || data.groups.length === 0) return null;

  // 首屏入场只放一次：第一次拿到地图数据时走「写字 + 点睛」；之后换时间窗只做 morph 生长，不重演入场
  const isEntrance = !enteredRef.current;
  enteredRef.current = true;

  return (
    <>
      <GlassCard className="overflow-hidden" style={{ padding: 0 }}>
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <span className="text-[13px] font-semibold text-white/85 inline-flex items-center gap-2.5">
            体验全景热力图
            <span
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium"
              style={{ background: 'rgba(45,212,191,0.12)', color: '#5eead4', border: '1px solid rgba(45,212,191,0.32)' }}
            >
              <span className="relative inline-flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-cyan-400" style={{ opacity: 0.6, animation: 'voc-ping 1.5s cubic-bezier(0,0,.2,1) infinite' }} />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-400" />
              </span>
              实时扫描中
            </span>
            <span className="text-[11px] text-white/35 font-normal">每块=端点 · 面积=访问量 · 颜色=健康</span>
          </span>
          <div className="flex items-center gap-3.5 text-[11px] text-white/55">
            <span className="inline-flex items-center gap-1.5">
              <i className="w-2.5 h-2.5 rounded-sm" style={{ background: ERR }} />报错
            </span>
            <span className="inline-flex items-center gap-1.5">
              <i className="w-2.5 h-2.5 rounded-sm" style={{ background: SLOW }} />等待过久
            </span>
            <span className="inline-flex items-center gap-1.5">
              <i className="w-2.5 h-2.5 rounded-sm" style={{ background: 'hsl(196 36% 36%)' }} />健康
            </span>
          </div>
        </div>
        <div className="px-2 pb-2">
          <svg viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="xMidYMid meet" style={{ width: '100%', height: 'auto', display: 'block' }}>
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
                {g.rect.w > 70 && g.rect.h > 30 ? (
                  <text
                    style={{
                      x: `${g.rect.x + 5}px`,
                      y: `${g.rect.y + 11}px`,
                      transition: MORPH_XY,
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
            {/* 叶子 —— 第一遍：随扫描线经过(按 x 位置)依次写出全部 */}
            {layout.cells.map((c) => {
              const r = c.rect;
              if (r.w < 1 || r.h < 1) return null;
              const isPain = c.leaf.status === 'error' || c.leaf.status === 'slow';
              const fill = c.leaf.status === 'error' ? ERR : c.leaf.status === 'slow' ? SLOW : healthyFill(c.hue, c.idxInGroup);
              const showLabel = r.w > 46 && r.h > 20;
              const clickable = isPain && !!onSelectTarget;
              const cellCx = r.x + r.w / 2;
              const revealDelay = Math.round((cellCx / VW) * SWEEP_MS); // 按 x → 跟随扫描线
              const igniteDelay = SWEEP_MS + 140; // 第二遍：写完后再点睛
              const gStyle: CSSProperties = {
                cursor: clickable ? 'pointer' : 'default',
                transformBox: 'fill-box',
                transformOrigin: 'center',
                // 痛点辉光常驻（换时间窗 morph 时不丢）；入场写字仅首屏放一次
                filter: isPain ? `drop-shadow(0 0 6px ${fill})` : undefined,
              };
              if (isEntrance) {
                gStyle.animation = 'voc-cell-in 0.4s cubic-bezier(.34,1.56,.64,1) both';
                gStyle.animationDelay = `${revealDelay}ms`;
              }
              return (
                <g key={c.leaf.target} style={gStyle} onClick={clickable ? () => onSelectTarget!(c.leaf.target) : undefined}>
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
                  {isPain ? (
                    <>
                      {/* 点睛①：一次性扩散环(写完后 ping 一下) */}
                      <rect
                        rx={2}
                        fill="none"
                        stroke={fill}
                        strokeWidth={1.6}
                        strokeOpacity={0}
                        style={{ x: `${r.x + 1}px`, y: `${r.y + 1}px`, width: `${Math.max(0, r.w - 2)}px`, height: `${Math.max(0, r.h - 2)}px`, transformBox: 'fill-box', transformOrigin: 'center', transition: MORPH, ...(isEntrance ? { animation: 'voc-ignite 0.7s ease-out', animationDelay: `${igniteDelay}ms` } : {}) }}
                      />
                      {/* 点睛②：持续脉冲描边(写完后才开始亮) */}
                      <rect
                        rx={2}
                        fill="none"
                        stroke="#fff"
                        strokeWidth={1.4}
                        strokeOpacity={0}
                        style={{ x: `${r.x + 1}px`, y: `${r.y + 1}px`, width: `${Math.max(0, r.w - 2)}px`, height: `${Math.max(0, r.h - 2)}px`, animation: `voc-cell-glow ${2 + (c.idxInGroup % 5) * 0.2}s ease-in-out infinite`, animationDelay: isEntrance ? `${igniteDelay}ms` : '0ms', transition: MORPH }}
                      />
                    </>
                  ) : null}
                  {showLabel ? (
                    <text
                      style={{ x: `${r.x + 5}px`, y: `${r.y + 14}px`, transition: MORPH_XY, fill: '#fff', fontSize: 10, fontWeight: 600, paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.55)', strokeWidth: 2.5 }}
                    >
                      {c.leaf.label}
                    </text>
                  ) : null}
                  {isPain && showLabel && r.h > 32 ? (
                    <text
                      style={{ x: `${r.x + 5}px`, y: `${r.y + 26}px`, transition: MORPH_XY, fill: 'rgba(255,255,255,0.9)', fontSize: 9, paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.55)', strokeWidth: 2 }}
                    >
                      {c.leaf.status === 'error' ? '报错' : '慢'}
                    </text>
                  ) : null}
                </g>
              );
            })}
            {/* 扫描笔：仅首屏入场画一次(块随笔尖经过而出现)，一次画完即淡出——不空转；换时间窗走 morph 不再扫 */}
            {isEntrance ? (
              <>
                <defs>
                  <linearGradient id="voc-pen" x1="0" x2="1" y1="0" y2="0">
                    <stop offset="0" stopColor="#2dd4bf" stopOpacity="0" />
                    <stop offset="0.7" stopColor="#2dd4bf" stopOpacity="0.05" />
                    <stop offset="0.96" stopColor="#5eead4" stopOpacity="0.22" />
                    <stop offset="1" stopColor="#a5f3eb" stopOpacity="0.7" />
                  </linearGradient>
                </defs>
                <g style={{ pointerEvents: 'none' }}>
                  <rect x={-44} y={0} width={44} height={VH} fill="url(#voc-pen)">
                    <animate attributeName="x" from={-44} to={VW} dur="1.3s" repeatCount="1" fill="freeze" />
                    <animate attributeName="opacity" from="1" to="0" begin="1.2s" dur="0.35s" fill="freeze" />
                  </rect>
                </g>
              </>
            ) : null}
          </svg>
        </div>
      </GlassCard>
      <style>{`
        @keyframes voc-cell-glow { 0%,100% { stroke-opacity: .35; } 50% { stroke-opacity: 1; } }
        @keyframes voc-cell-in { from { opacity: 0; transform: scale(.45); } to { opacity: 1; transform: scale(1); } }
        @keyframes voc-grp-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes voc-ping { 75%,100% { transform: scale(2.2); opacity: 0; } }
        @keyframes voc-ignite { 0% { stroke-opacity: .9; transform: scale(1); } 100% { stroke-opacity: 0; transform: scale(1.18); } }
      `}</style>
    </>
  );
}
