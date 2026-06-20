/**
 * 体验全景热力图（squarified treemap）：把系统接口面铺成一张地图。
 * 每块=一个端点，面积=访问量，颜色=健康——健康区走「冷色平静海」（每个模块一个色相、区内明度递变），
 * 痛点（红=报错、琥珀=慢）从平静里跳出来并带发光描边。点击痛点块 → 下钻联动到下方痛点榜对应行。
 * 配色遵循 ui-ux-pro-max 的 treemap 规范：父级不同色相、子级同色相浅色梯度；暖色只留给告警。
 * 数据源：GET /api/team-activity/experience-map（与 insights 同源 apirequestlogs，target 同口径）。
 */
import { useMemo, useRef, useState, type CSSProperties } from 'react';
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
  onSelectTarget?: (target: string, fallback: { label: string; metric: string }) => void;
}) {
  // 两个范围模式：all=全域(全部端点按访问量) / pain=痛点(只看病灶，按问题严重度放大)
  const [mode, setMode] = useState<'all' | 'pain'>('all');
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
  }, [data, mode]);

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
            <span className="text-[11px] text-white/35 font-normal">
              {mode === 'all' ? '每块=端点 · 面积=访问量 · 颜色=健康' : '只看病灶 · 面积=问题严重度 · 点击下钻'}
            </span>
          </span>
          <div className="flex items-center gap-3.5 text-[11px] text-white/55">
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
            <span className="w-px h-3.5 bg-white/10" />
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
          {layout.groupRects.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 text-center" style={{ height: 300 }}>
              <span className="w-3 h-3 rounded-full" style={{ background: '#34d399', boxShadow: '0 0 0 5px rgba(52,211,153,0.16)' }} />
              <span className="text-sm text-emerald-300/85">当前范围内没有痛点</span>
              <span className="text-[12px] text-white/40">系统体验健康，切回「全域」看全部端点</span>
            </div>
          ) : (
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
            {/* 叶子 —— 第一遍：随扫描线经过(按 x 位置)依次写出全部 */}
            {layout.cells.map((c) => {
              const r = c.rect;
              if (r.w < 1 || r.h < 1) return null;
              const isPain = c.leaf.status === 'error' || c.leaf.status === 'slow';
              const hasBurst = c.leaf.burstPct != null && c.leaf.burstPct >= 50;
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
                <g key={c.leaf.target} style={gStyle} onClick={clickable ? () => onSelectTarget!(c.leaf.target, { label: `${c.group.label} · ${c.leaf.label}`, metric: c.leaf.metric }) : undefined}>
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
                      x={r.x + 5}
                      y={r.y + 14}
                      style={{ fill: '#fff', fontSize: 10, fontWeight: 600, paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.55)', strokeWidth: 2.5 }}
                    >
                      {c.leaf.label}
                    </text>
                  ) : null}
                  {isPain && showLabel && r.h > 32 ? (
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
                  {/* 突增彗星：环比突增 >=50% 的痛点块，右下角一道斜飞的彗星（尾巴 + 白点头），常驻循环 */}
                  {hasBurst && r.w > 48 && r.h > 30 ? (
                    <g
                      style={{
                        transformBox: 'fill-box',
                        transformOrigin: 'center',
                        animation: `voc-comet ${2.2 + (c.idxInGroup % 4) * 0.25}s ease-out infinite`,
                      }}
                    >
                      <line
                        x1={r.x + r.w - 12}
                        y1={r.y + r.h - 12}
                        x2={r.x + r.w - 27}
                        y2={r.y + r.h + 3}
                        stroke={SLOW}
                        strokeWidth={2}
                        strokeLinecap="round"
                      />
                      <circle cx={r.x + r.w - 12} cy={r.y + r.h - 12} r={3.5} fill="#fff" />
                    </g>
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
          )}
        </div>
      </GlassCard>
      <style>{`
        @keyframes voc-cell-glow { 0%,100% { stroke-opacity: .35; } 50% { stroke-opacity: 1; } }
        @keyframes voc-cell-in { from { opacity: 0; transform: scale(.45); } to { opacity: 1; transform: scale(1); } }
        @keyframes voc-grp-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes voc-ping { 75%,100% { transform: scale(2.2); opacity: 0; } }
        @keyframes voc-ignite { 0% { stroke-opacity: .9; transform: scale(1); } 100% { stroke-opacity: 0; transform: scale(1.18); } }
        @keyframes voc-comet { 0% { transform: translate(0,0); opacity: 0; } 15% { opacity: 1; } 100% { transform: translate(42px,-42px); opacity: 0; } }
      `}</style>
    </>
  );
}
