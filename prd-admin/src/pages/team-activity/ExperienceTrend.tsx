/**
 * 趋势爆点曲线（行为洞察 Hero 视图之一）：报错/慢请求随时间的波动曲线，回答「什么时候开始变差」。
 * 数据自取：GET /api/team-activity/experience-trend（按时间桶聚合 apirequestlogs，桶粒度后端自适应 hour/day）。
 * 报错红线 + 慢琥珀线两条面积曲线叠加；突增桶（环比明显抬升）标「爆点」标记（小圆点 + +N%）。
 * 入场：曲线从左到右画出（stroke-dashoffset），爆点标记依次 pop。冷色海主题，禁止 emoji。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { TrendingUp } from 'lucide-react';
// 趋势曲线：报错/慢请求随时间的波动。数据不足（桶 < 2 或全 0）时无法成线 → 上报父级以便在四图仪表盘里隐藏本格。
import { GlassCard } from '@/components/design';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { getTeamActivityExperienceTrend } from '@/services';
import type { ExperienceTrendBucket, TeamActivityExperienceTrendData } from '@/services/contracts/teamActivity';

const ERR = '#f8717a';
const SLOW = '#fbbf24';
const VW = 1000;
// 默认视图高度（aspect-aware：实际按容器真实宽高比算，让曲线撑满格子高度，消除底部空白）。
const VH_FALLBACK = 360;
const VH_MIN = 220;
const VH_MAX = 900;
const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 18;
const PAD_B = 34;

type Pt = { x: number; y: number; bucket: ExperienceTrendBucket; burst: boolean; burstPct: number };

/** 把桶序列映射成报错/慢两条折线的屏幕坐标，并标出环比突增的「爆点」桶（vh = 当前动态视图高度） */
function buildSeries(buckets: ExperienceTrendBucket[], vh: number) {
  const n = buckets.length;
  const innerW = VW - PAD_L - PAD_R;
  const innerH = vh - PAD_T - PAD_B;
  const maxBad = Math.max(1, ...buckets.map((b) => Math.max(b.errors, b.slow)));
  const xAt = (i: number) => PAD_L + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yAt = (v: number) => PAD_T + innerH - (v / maxBad) * innerH;

  const errPts: Pt[] = [];
  const slowPts: Pt[] = [];
  buckets.forEach((b, i) => {
    // 爆点判定：总坏请求(报错+慢)较前一桶抬升 >=50% 且达基本量，标爆点
    const cur = b.errors + b.slow;
    const prev = i > 0 ? buckets[i - 1].errors + buckets[i - 1].slow : 0;
    const burstPct = prev > 0 ? Math.round(((cur - prev) / prev) * 100) : 0;
    const burst = cur >= 5 && prev > 0 && burstPct >= 50;
    errPts.push({ x: xAt(i), y: yAt(b.errors), bucket: b, burst, burstPct });
    slowPts.push({ x: xAt(i), y: yAt(b.slow), bucket: b, burst, burstPct });
  });
  return { errPts, slowPts, maxBad, innerH };
}

function toPath(pts: Pt[]): string {
  if (pts.length === 0) return '';
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
}

function toAreaPath(pts: Pt[], vh: number): string {
  if (pts.length === 0) return '';
  const base = vh - PAD_B;
  const line = pts.map((p) => `L${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  return `M${pts[0].x.toFixed(1)} ${base} ${line} L${pts[pts.length - 1].x.toFixed(1)} ${base} Z`;
}

function fmtBucket(iso: string, unit: 'hour' | 'day'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  if (unit === 'hour') return `${mm}-${dd} ${String(d.getHours()).padStart(2, '0')}:00`;
  return `${mm}-${dd}`;
}

export function ExperienceTrend({
  from,
  to,
  onSwitchHeatmap,
  onEmptyChange,
  hideWhenEmpty = false,
}: {
  from?: string;
  to?: string;
  /** 空数据引导：一键切回热力图（移动单图视图用，桌面四图仪表盘走 hideWhenEmpty 直接隐藏本格） */
  onSwitchHeatmap?: () => void;
  /** 上报「是否有可绘制趋势」给父级（桌面四图仪表盘据此把本格移出布局，让其余格自适应铺满） */
  onEmptyChange?: (empty: boolean) => void;
  /** 为真时：数据不足直接返回 null（不渲染空壳），交由父级把本格从 grid 移除 */
  hideWhenEmpty?: boolean;
}) {
  const [data, setData] = useState<TeamActivityExperienceTrendData | null>(null);
  const [loading, setLoading] = useState(true);
  const fetchIdRef = useRef(0);
  // aspect-aware：量出曲线容器真实宽高比，让曲线几何撑满格子高度（消除底部空白），ResizeObserver 量到前用回退值。
  const svgBoxRef = useRef<HTMLDivElement | null>(null);
  const [boxAspect, setBoxAspect] = useState<number | null>(null);
  const VH = useMemo(() => {
    const raw = boxAspect != null ? VW * boxAspect : VH_FALLBACK;
    return Math.min(VH_MAX, Math.max(VH_MIN, Math.round(raw)));
  }, [boxAspect]);

  useEffect(() => {
    const id = ++fetchIdRef.current;
    setLoading(true);
    void getTeamActivityExperienceTrend({ from, to }).then((res) => {
      if (fetchIdRef.current !== id) return;
      // 失败时清空旧数据，避免新选择下还残留上一个时间范围的曲线
      if (res.success) setData(res.data);
      else setData(null);
      setLoading(false);
    });
  }, [from, to]);

  const series = useMemo(() => (data ? buildSeries(data.buckets, VH) : null), [data, VH]);
  const unit = data?.bucketUnit ?? 'day';
  // 爆点画在「当前桶占主导的那条线」上：慢主导 → 黄(slow 线)，报错主导 → 红(err 线)。
  // 避免 slow-only 突增被画到红色报错线的基线位置、误判成报错爆点。
  const burstPts = useMemo(() => {
    if (!series) return [];
    return series.errPts
      .map((ep, i) => ({ ep, sp: series.slowPts[i] }))
      .filter(({ ep }) => ep.burst)
      .map(({ ep, sp }) => {
        const slowDominant = sp.bucket.slow > ep.bucket.errors;
        const pt = slowDominant ? sp : ep;
        return { x: pt.x, y: pt.y, burstPct: pt.burstPct, bucketStart: pt.bucket.bucketStart, color: slowDominant ? SLOW : ERR };
      });
  }, [series]);

  // 「有可绘制趋势」判定：至少 2 个时间桶才能连成线，且报错/慢请求并非全 0（全 0 是平线，无趋势价值）。
  const hasData = useMemo(() => {
    if (!data || series == null) return false;
    if (data.buckets.length < 2) return false;
    return data.buckets.some((b) => b.errors > 0 || b.slow > 0);
  }, [data, series]);

  // ResizeObserver 挂到曲线容器：hasData 切换会让容器挂载/卸载，故依赖 hasData 重新观测。
  useEffect(() => {
    const el = svgBoxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setBoxAspect(r.height / r.width);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasData]);

  // 数据到达后上报空/非空给父级（仅在数据加载完成后报，加载中不误判为空导致桌面格闪烁）
  useEffect(() => {
    if (loading && !data) return;
    onEmptyChange?.(!hasData);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasData, loading, data]);

  if (loading && !data) {
    // hideWhenEmpty（桌面四图仪表盘）下加载态也不占位，避免「短暂空壳格」；移动单图显示加载卡。
    if (hideWhenEmpty) return null;
    return (
      <GlassCard className="h-full" style={{ minHeight: 320 }}>
        <div className="h-full flex items-center justify-center">
          <MapSectionLoader text="正在聚合趋势曲线…" />
        </div>
      </GlassCard>
    );
  }

  // 桌面四图仪表盘：无趋势直接退出布局（父级 grid 自适应铺满剩余格）；移动单图保留空状态引导。
  if (hideWhenEmpty && !hasData) return null;

  return (
    <GlassCard className="overflow-hidden h-full flex flex-col" style={{ padding: 0, minHeight: 0 }}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between px-4 pt-3 pb-2 shrink-0">
        <span className="text-[13px] font-semibold text-white/85 inline-flex items-center gap-2.5 min-w-0 flex-wrap">
          <span className="whitespace-nowrap">趋势爆点曲线</span>
          <span className="hidden sm:inline-flex text-[11px] text-white/35 font-normal items-center gap-1.5 whitespace-nowrap">
            <TrendingUp size={12} className="text-cyan-300/70" />
            报错/慢请求随时间的波动 · 标出爆发点
          </span>
        </span>
        <div className="flex items-center gap-2.5 sm:gap-3.5 text-[11px] text-white/55 flex-wrap">
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap shrink-0">
            <i className="w-2.5 h-2.5 rounded-sm" style={{ background: ERR }} />报错
          </span>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap shrink-0">
            <i className="w-2.5 h-2.5 rounded-sm" style={{ background: SLOW }} />慢请求
          </span>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap shrink-0">
            <span className="w-2 h-2 rounded-full" style={{ background: '#fff', boxShadow: `0 0 5px ${ERR}` }} />爆点
          </span>
        </div>
      </div>
      {/* Bento 桌面：本格是「宽而矮」的 row-span-1（≈220px），曲线区给较小 min-height 以贴合矮格；
          移动单图无 grid 撑高，靠媒体查询给更高 min-height 让曲线长满首屏。见底部 voc-trend-body 样式。 */}
      <div ref={svgBoxRef} className="px-2 pb-2 flex-1 min-h-0 flex flex-col voc-trend-body">
        {!hasData || !series ? (
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2.5 text-center">
            <span className="w-3 h-3 rounded-full" style={{ background: '#34d399', boxShadow: '0 0 0 5px rgba(52,211,153,0.16)' }} />
            <span className="text-sm text-emerald-300/85">当前窗口没有可绘制的趋势数据</span>
            <span className="text-[12px] text-white/40">报错与慢请求都很少——这是好消息。可换更长时间范围，或</span>
            {onSwitchHeatmap ? (
              <button
                type="button"
                onClick={onSwitchHeatmap}
                className="mt-1 inline-flex items-center gap-1.5 px-3 h-8 rounded-lg border border-white/10 bg-white/[0.03] text-[11px] text-white/55 hover:text-white/85 hover:border-white/25 transition-colors cursor-pointer"
              >
                切回体验全景热力图
              </button>
            ) : null}
          </div>
        ) : (
          <svg viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="xMidYMid meet" style={{ width: '100%', flex: 1, minHeight: 0, height: '100%', display: 'block' }}>
            <defs>
              <linearGradient id="voc-trend-err" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={ERR} stopOpacity="0.32" />
                <stop offset="1" stopColor={ERR} stopOpacity="0" />
              </linearGradient>
              <linearGradient id="voc-trend-slow" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={SLOW} stopOpacity="0.24" />
                <stop offset="1" stopColor={SLOW} stopOpacity="0" />
              </linearGradient>
            </defs>
            {/* 基准网格线（4 等分），低饱和度不抢戏 */}
            {[0.25, 0.5, 0.75, 1].map((f) => {
              const y = PAD_T + series.innerH * (1 - f);
              return <line key={f} x1={PAD_L} y1={y} x2={VW - PAD_R} y2={y} stroke="rgba(255,255,255,0.05)" strokeWidth={1} />;
            })}
            {/* 面积（先铺底，后画线） */}
            <path d={toAreaPath(series.slowPts, VH)} fill="url(#voc-trend-slow)" style={{ animation: 'voc-trend-fade .9s ease both', animationDelay: '0.6s' }} />
            <path d={toAreaPath(series.errPts, VH)} fill="url(#voc-trend-err)" style={{ animation: 'voc-trend-fade .9s ease both', animationDelay: '0.6s' }} />
            {/* 慢请求线：从左到右画出 */}
            <TrendLine d={toPath(series.slowPts)} color={SLOW} />
            {/* 报错线：从左到右画出 */}
            <TrendLine d={toPath(series.errPts)} color={ERR} />
            {/* 爆点标记：报错线上的突增桶，依次 pop（小圆点 + +N%） */}
            {burstPts.map((p, i) => (
              <g key={`burst-${p.bucketStart}`} style={{ animation: 'voc-trend-pop .5s cubic-bezier(.34,1.56,.64,1) both', animationDelay: `${1.3 + i * 0.12}s`, transformBox: 'fill-box', transformOrigin: 'center' }}>
                <circle cx={p.x} cy={p.y} r={5.5} fill="none" stroke={p.color} strokeWidth={1.4} style={{ animation: 'voc-trend-ping 1.8s ease-out infinite', animationDelay: `${1.6 + i * 0.12}s`, transformBox: 'fill-box', transformOrigin: 'center' }} />
                <circle cx={p.x} cy={p.y} r={3} fill="#fff" style={{ filter: `drop-shadow(0 0 5px ${p.color})` }} />
                <text
                  x={p.x}
                  y={p.y - 11}
                  textAnchor="middle"
                  style={{ fill: p.color, fontSize: 11, fontWeight: 700, paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.6)', strokeWidth: 2.5 }}
                >
                  {`+${p.burstPct}%`}
                </text>
              </g>
            ))}
            {/* X 轴桶标签：稀疏取样避免拥挤（首/尾 + 等间隔约 6 个） */}
            {series.errPts.map((p, i) => {
              const n = series.errPts.length;
              const step = Math.max(1, Math.ceil(n / 6));
              const show = i === 0 || i === n - 1 || i % step === 0;
              if (!show) return null;
              return (
                <text key={`xl-${i}`} x={p.x} y={VH - 12} textAnchor="middle" style={{ fill: 'rgba(236,236,239,0.35)', fontSize: 9.5 }}>
                  {fmtBucket(p.bucket.bucketStart, unit)}
                </text>
              );
            })}
          </svg>
        )}
      </div>
      <style>{`
        /* 曲线区高度：桌面 Bento「宽而矮」格里给较小 min-height（贴合 220px row-span-1，不撑破矮格）；
           窄屏单图视图无 grid 撑高，给更高 min-height 让曲线长满首屏（呼应 mobile-first-density）。 */
        .voc-trend-body { min-height: 150px; }
        @media (max-width: 1023px) {
          .voc-trend-body { min-height: 280px; }
        }
        @keyframes voc-trend-draw { from { stroke-dashoffset: var(--len); } to { stroke-dashoffset: 0; } }
        @keyframes voc-trend-fade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes voc-trend-pop { from { opacity: 0; transform: scale(.2); } to { opacity: 1; transform: scale(1); } }
        @keyframes voc-trend-ping { 0% { opacity: .8; transform: scale(1); } 100% { opacity: 0; transform: scale(2.3); } }
      `}</style>
    </GlassCard>
  );
}

/** 单条折线：用 pathLength 归一 + stroke-dashoffset 实现「从左到右画出」入场 */
function TrendLine({ d, color }: { d: string; color: string }) {
  const ref = useRef<SVGPathElement | null>(null);
  const [len, setLen] = useState(1200);
  useEffect(() => {
    if (ref.current) {
      try {
        const l = ref.current.getTotalLength();
        if (l > 0) setLen(l);
      } catch {
        /* getTotalLength 在极端空 path 下可能抛异常，忽略走默认值 */
      }
    }
  }, [d]);
  return (
    <path
      ref={ref}
      d={d}
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinejoin="round"
      strokeLinecap="round"
      style={
        {
          '--len': `${len}px`,
          strokeDasharray: len,
          strokeDashoffset: len,
          animation: 'voc-trend-draw 1.2s cubic-bezier(.45,0,.2,1) forwards',
        } as React.CSSProperties
      }
    />
  );
}
