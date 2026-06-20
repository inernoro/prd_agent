/**
 * 趋势爆点曲线（行为洞察 Hero 视图之一）：报错/慢请求随时间的波动曲线，回答「什么时候开始变差」。
 * 数据自取：GET /api/team-activity/experience-trend（按时间桶聚合 apirequestlogs，桶粒度后端自适应 hour/day）。
 * 报错红线 + 慢琥珀线两条面积曲线叠加；突增桶（环比明显抬升）标「爆点」标记（小圆点 + +N%）。
 * 入场：曲线从左到右画出（stroke-dashoffset），爆点标记依次 pop。冷色海主题，禁止 emoji。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { TrendingUp } from 'lucide-react';
import { GlassCard } from '@/components/design';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { getTeamActivityExperienceTrend } from '@/services';
import type { ExperienceTrendBucket, TeamActivityExperienceTrendData } from '@/services/contracts/teamActivity';

const ERR = '#f8717a';
const SLOW = '#fbbf24';
const VW = 1000;
const VH = 360;
const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 18;
const PAD_B = 34;

type Pt = { x: number; y: number; bucket: ExperienceTrendBucket; burst: boolean; burstPct: number };

/** 把桶序列映射成报错/慢两条折线的屏幕坐标，并标出环比突增的「爆点」桶 */
function buildSeries(buckets: ExperienceTrendBucket[]) {
  const n = buckets.length;
  const innerW = VW - PAD_L - PAD_R;
  const innerH = VH - PAD_T - PAD_B;
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

function toAreaPath(pts: Pt[]): string {
  if (pts.length === 0) return '';
  const base = VH - PAD_B;
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
  onSwitchHeatmap,
}: {
  from?: string;
  /** 空数据引导：一键切回热力图 */
  onSwitchHeatmap?: () => void;
}) {
  const [data, setData] = useState<TeamActivityExperienceTrendData | null>(null);
  const [loading, setLoading] = useState(true);
  const fetchIdRef = useRef(0);

  useEffect(() => {
    const id = ++fetchIdRef.current;
    setLoading(true);
    void getTeamActivityExperienceTrend({ from }).then((res) => {
      if (fetchIdRef.current !== id) return;
      if (res.success) setData(res.data);
      setLoading(false);
    });
  }, [from]);

  const series = useMemo(() => (data ? buildSeries(data.buckets) : null), [data]);
  const unit = data?.bucketUnit ?? 'day';
  const burstPts = useMemo(() => (series ? series.errPts.filter((p) => p.burst) : []), [series]);

  if (loading && !data) {
    return (
      <GlassCard style={{ height: 320 }}>
        <div className="h-full flex items-center justify-center">
          <MapSectionLoader text="正在聚合趋势曲线…" />
        </div>
      </GlassCard>
    );
  }

  const hasData = !!data && data.buckets.length > 0 && series != null;

  return (
    <GlassCard className="overflow-hidden" style={{ padding: 0 }}>
      <div className="flex items-center justify-between px-4 pt-3 pb-2 shrink-0">
        <span className="text-[13px] font-semibold text-white/85 inline-flex items-center gap-2.5">
          趋势爆点曲线
          <span className="text-[11px] text-white/35 font-normal inline-flex items-center gap-1.5">
            <TrendingUp size={12} className="text-cyan-300/70" />
            报错/慢请求随时间的波动 · 标出爆发点
          </span>
        </span>
        <div className="flex items-center gap-3.5 text-[11px] text-white/55">
          <span className="inline-flex items-center gap-1.5">
            <i className="w-2.5 h-2.5 rounded-sm" style={{ background: ERR }} />报错
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="w-2.5 h-2.5 rounded-sm" style={{ background: SLOW }} />慢请求
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: '#fff', boxShadow: `0 0 5px ${ERR}` }} />爆点
          </span>
        </div>
      </div>
      <div className="px-2 pb-2">
        {!hasData ? (
          <div className="flex flex-col items-center justify-center gap-2.5 text-center" style={{ height: 300 }}>
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
          <svg viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="xMidYMid meet" style={{ width: '100%', height: 'auto', display: 'block' }}>
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
            <path d={toAreaPath(series.slowPts)} fill="url(#voc-trend-slow)" style={{ animation: 'voc-trend-fade .9s ease both', animationDelay: '0.6s' }} />
            <path d={toAreaPath(series.errPts)} fill="url(#voc-trend-err)" style={{ animation: 'voc-trend-fade .9s ease both', animationDelay: '0.6s' }} />
            {/* 慢请求线：从左到右画出 */}
            <TrendLine d={toPath(series.slowPts)} color={SLOW} />
            {/* 报错线：从左到右画出 */}
            <TrendLine d={toPath(series.errPts)} color={ERR} />
            {/* 爆点标记：报错线上的突增桶，依次 pop（小圆点 + +N%） */}
            {burstPts.map((p, i) => (
              <g key={`burst-${p.bucket.bucketStart}`} style={{ animation: 'voc-trend-pop .5s cubic-bezier(.34,1.56,.64,1) both', animationDelay: `${1.3 + i * 0.12}s`, transformBox: 'fill-box', transformOrigin: 'center' }}>
                <circle cx={p.x} cy={p.y} r={5.5} fill="none" stroke={ERR} strokeWidth={1.4} style={{ animation: 'voc-trend-ping 1.8s ease-out infinite', animationDelay: `${1.6 + i * 0.12}s`, transformBox: 'fill-box', transformOrigin: 'center' }} />
                <circle cx={p.x} cy={p.y} r={3} fill="#fff" style={{ filter: `drop-shadow(0 0 5px ${ERR})` }} />
                <text
                  x={p.x}
                  y={p.y - 11}
                  textAnchor="middle"
                  style={{ fill: ERR, fontSize: 11, fontWeight: 700, paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.6)', strokeWidth: 2.5 }}
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
