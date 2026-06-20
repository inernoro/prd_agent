/**
 * 痛点雷达（行为洞察 Hero 视图之一）：把体验健康度拆成 5 个维度画成雷达多边形，一眼看健康轮廓。
 * 全部从现有数据现算（insights.items + mapData），不额外请求后端。
 * 维度口径（各归一化到 0-1，越大越「痛」）：
 *  - 报错强度：api-error 类洞察的 eventCount 占全部洞察 eventCount 的比重（饱和到 1）
 *  - 延迟强度：slow-endpoint 类洞察 eventCount 占比（饱和到 1）
 *  - 影响人数：Σ未闭环洞察 userCount，按经验上限 50 人饱和到 1
 *  - 环比突增：热力图叶子中带 burstPct 的痛点数 占 痛点叶子总数 的比例
 *  - 未闭环占比：status 非 resolved/ignored 的洞察数 占 全部洞察数 的比例
 * 入场：多边形从中心展开（scale）。冷色海主题，禁止 emoji。
 */
import { useMemo } from 'react';
import { Radar as RadarIcon } from 'lucide-react';
import { GlassCard } from '@/components/design';
import type { BehaviorInsight, TeamActivityExperienceMapData } from '@/services/contracts/teamActivity';

const CYAN = '#5eead4';
const ERR = '#f8717a';

type Axis = { key: string; label: string; value: number; raw: string };

function computeAxes(items: BehaviorInsight[], mapData: TeamActivityExperienceMapData | null): Axis[] {
  const open = items.filter((i) => i.status !== 'resolved' && i.status !== 'ignored');
  const totalEvents = items.reduce((s, i) => s + i.eventCount, 0) || 1;
  const errEvents = items.filter((i) => i.kind === 'api-error').reduce((s, i) => s + i.eventCount, 0);
  const slowEvents = items.filter((i) => i.kind === 'slow-endpoint').reduce((s, i) => s + i.eventCount, 0);
  const affected = open.reduce((s, i) => s + i.userCount, 0);

  // 热力图痛点叶子（status error/slow）总数与「带突增」的占比
  const painLeaves = (mapData?.groups ?? []).flatMap((g) => g.leaves).filter((l) => l.status === 'error' || l.status === 'slow');
  const burstLeaves = painLeaves.filter((l) => l.burstPct != null && l.burstPct >= 50);

  const unresolvedRatio = items.length > 0 ? open.length / items.length : 0;

  const sat = (v: number) => Math.max(0, Math.min(1, v));
  return [
    { key: 'error', label: '报错强度', value: sat(errEvents / totalEvents), raw: `${errEvents} 次报错` },
    { key: 'slow', label: '延迟强度', value: sat(slowEvents / totalEvents), raw: `${slowEvents} 次慢请求` },
    { key: 'affected', label: '影响人数', value: sat(affected / 50), raw: `${affected} 人受影响` },
    { key: 'burst', label: '环比突增', value: sat(painLeaves.length > 0 ? burstLeaves.length / painLeaves.length : 0), raw: `${burstLeaves.length}/${painLeaves.length} 痛点突增` },
    { key: 'open', label: '未闭环', value: sat(unresolvedRatio), raw: `${open.length}/${items.length} 待处理` },
  ];
}

const CX = 250;
const CY = 230;
const R = 165;

/** 第 i 个轴（共 n 个）在半径 frac 处的坐标，从正上方开始顺时针 */
function pointAt(i: number, n: number, frac: number): { x: number; y: number } {
  const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
  return { x: CX + Math.cos(a) * R * frac, y: CY + Math.sin(a) * R * frac };
}

export function ExperienceRadar({
  items,
  mapData,
  onSwitchHeatmap,
}: {
  items: BehaviorInsight[];
  mapData: TeamActivityExperienceMapData | null;
  onSwitchHeatmap?: () => void;
}) {
  const axes = useMemo(() => computeAxes(items, mapData), [items, mapData]);
  const n = axes.length;
  const hasSignal = axes.some((a) => a.value > 0.01);

  if (!hasSignal) {
    return (
      <GlassCard className="overflow-hidden" style={{ padding: 0 }}>
        <Header />
        <div className="flex flex-col items-center justify-center gap-2.5 text-center" style={{ height: 300 }}>
          <span className="w-3 h-3 rounded-full" style={{ background: '#34d399', boxShadow: '0 0 0 5px rgba(52,211,153,0.16)' }} />
          <span className="text-sm text-emerald-300/85">体验健康轮廓接近原点</span>
          <span className="text-[12px] text-white/40">各维度信号都很弱——系统当前健康。可换时间范围，或</span>
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
      </GlassCard>
    );
  }

  const valuePoly = axes.map((a, i) => pointAt(i, n, a.value)).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  return (
    <GlassCard className="overflow-hidden" style={{ padding: 0 }}>
      <Header />
      <div className="px-2 pb-3 flex items-center justify-center">
        <svg viewBox="0 0 500 380" preserveAspectRatio="xMidYMid meet" style={{ width: '100%', maxWidth: 520, height: 'auto', display: 'block' }}>
          {/* 同心网格环（4 圈） */}
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <polygon
              key={f}
              points={axes.map((_, i) => pointAt(i, n, f)).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}
              fill="none"
              stroke="rgba(255,255,255,0.06)"
              strokeWidth={1}
            />
          ))}
          {/* 轴线 + 轴标签 */}
          {axes.map((a, i) => {
            const edge = pointAt(i, n, 1);
            const labelP = pointAt(i, n, 1.16);
            const anchor = Math.abs(labelP.x - CX) < 12 ? 'middle' : labelP.x > CX ? 'start' : 'end';
            return (
              <g key={a.key}>
                <line x1={CX} y1={CY} x2={edge.x} y2={edge.y} stroke="rgba(255,255,255,0.07)" strokeWidth={1} />
                <text x={labelP.x} y={labelP.y} textAnchor={anchor} dominantBaseline="middle" style={{ fill: 'rgba(236,236,239,0.7)', fontSize: 12, fontWeight: 600 }}>
                  {a.label}
                </text>
                <text x={labelP.x} y={labelP.y + 13} textAnchor={anchor} dominantBaseline="middle" style={{ fill: 'rgba(236,236,239,0.32)', fontSize: 9.5 }}>
                  {a.raw}
                </text>
              </g>
            );
          })}
          {/* 数值多边形：从中心展开入场 */}
          <polygon
            points={valuePoly}
            fill="rgba(94,234,212,0.16)"
            stroke={CYAN}
            strokeWidth={2}
            strokeLinejoin="round"
            style={{ transformBox: 'fill-box', transformOrigin: `${CX}px ${CY}px`, animation: 'voc-radar-grow .8s cubic-bezier(.34,1.4,.5,1) both' }}
          />
          {/* 顶点圆点：高值（>0.6）用告警色描边强调 */}
          {axes.map((a, i) => {
            const p = pointAt(i, n, a.value);
            const hot = a.value >= 0.6;
            return (
              <circle
                key={`pt-${a.key}`}
                cx={p.x}
                cy={p.y}
                r={hot ? 4.5 : 3.5}
                fill={hot ? ERR : CYAN}
                style={{ filter: hot ? `drop-shadow(0 0 5px ${ERR})` : undefined, animation: 'voc-radar-fade .6s ease both', animationDelay: '0.55s' }}
              />
            );
          })}
        </svg>
      </div>
      <style>{`
        @keyframes voc-radar-grow { from { opacity: 0; transform: scale(.04); } to { opacity: 1; transform: scale(1); } }
        @keyframes voc-radar-fade { from { opacity: 0; } to { opacity: 1; } }
      `}</style>
    </GlassCard>
  );
}

function Header() {
  return (
    <div className="flex items-center justify-between px-4 pt-3 pb-2 shrink-0">
      <span className="text-[13px] font-semibold text-white/85 inline-flex items-center gap-2.5">
        痛点雷达
        <span className="text-[11px] text-white/35 font-normal inline-flex items-center gap-1.5">
          <RadarIcon size={12} className="text-cyan-300/70" />
          五维体验健康轮廓 · 越往外越痛
        </span>
      </span>
    </div>
  );
}
