/*
 * 响应时间曲线（纯 SVG，无图表库）。
 *
 *   - 面积 + 折线走 primary token，故障桶的点用 destructive 标出来，双主题都成立；
 *   - 悬停给最近一点的时间 / 响应 / 成功率读数，不靠 title 提示；
 *   - 只有 1 个点画不出线，退化成「样本不足」的空态，不画一条假的平线。
 */
import { useMemo, useState } from 'react';

import {
  formatClock,
  formatLatency,
  formatShortClock,
  latencySeries,
  type HistoryRange,
  type UptimeBucket,
} from '@/lib/monitorCenter';

const W = 640;
const H = 180;
const PAD = { top: 12, right: 12, bottom: 22, left: 44 };

function formatAxisTime(ms: number, range: HistoryRange): string {
  if (range === '24h') return formatShortClock(ms);
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function LatencyChart({ points, range }: { points: ReadonlyArray<UptimeBucket>; range: HistoryRange }): JSX.Element {
  const series = useMemo(() => latencySeries(points), [points]);
  const [hover, setHover] = useState<number | null>(null);

  if (series.points.length < 2) {
    return (
      <div className="flex h-44 items-center justify-center rounded-lg border border-dashed border-[hsl(var(--hairline-strong))] text-xs text-muted-foreground">
        {series.points.length === 0 ? '这个时间范围内还没有采样' : '样本不足，至少两个时间桶才能画出曲线'}
      </div>
    );
  }

  const xs = series.points.map((p) => p.t);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const yMax = Math.max(series.max || 1, 1) * 1.15;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const sx = (t: number): number => PAD.left + ((t - x0) / Math.max(1, x1 - x0)) * plotW;
  const sy = (ms: number): number => PAD.top + plotH - (ms / yMax) * plotH;

  const linePath = series.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.t).toFixed(1)},${sy(p.ms).toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${sx(x1).toFixed(1)},${(PAD.top + plotH).toFixed(1)} L${sx(x0).toFixed(1)},${(PAD.top + plotH).toFixed(1)} Z`;
  const gridValues = [0, 0.5, 1].map((f) => Math.round(yMax * f));
  const active = hover !== null ? series.points[hover] : null;
  const activeBucket = active ? points.find((b) => (b.from + b.to) / 2 === active.t) : undefined;

  const onMove = (event: React.MouseEvent<SVGSVGElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    series.points.forEach((p, i) => {
      const d = Math.abs(sx(p.t) - px);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    setHover(best);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
        <span className="text-muted-foreground">
          最小 <span className="font-mono text-foreground">{formatLatency(series.min)}</span>
        </span>
        <span className="text-muted-foreground">
          平均 <span className="font-mono text-foreground">{formatLatency(series.avg)}</span>
        </span>
        <span className="text-muted-foreground">
          最大 <span className="font-mono text-foreground">{formatLatency(series.max)}</span>
        </span>
        <span className="ml-auto min-h-4 font-mono text-[11px] text-muted-foreground" aria-live="polite">
          {active
            ? `${range === '24h' ? formatClock(active.t) : formatAxisTime(active.t, range)} · ${formatLatency(active.ms)}${activeBucket ? ` · 成功 ${activeBucket.up}/${activeBucket.up + activeBucket.down}` : ''}`
            : '把鼠标放到曲线上看读数'}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-44 w-full"
        role="img"
        aria-label="响应时间曲线"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {gridValues.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={sy(v)} y2={sy(v)} stroke="hsl(var(--hairline-strong))" strokeWidth={1} strokeDasharray={v === 0 ? undefined : '3 3'} />
            <text x={PAD.left - 6} y={sy(v) + 4} textAnchor="end" fontSize={11} fontWeight={600} fill="hsl(var(--foreground))" fontFamily="ui-monospace, monospace">
              {v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`}
            </text>
          </g>
        ))}
        <path d={areaPath} fill="hsl(var(--primary) / 0.22)" />
        <path d={linePath} fill="none" stroke="hsl(var(--primary-ink))" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        {series.points.map((p, i) => (
          p.status !== 'up' ? (
            <g key={p.t}>
              <circle cx={sx(p.t)} cy={sy(p.ms)} r={5} fill="hsl(var(--destructive))" stroke="hsl(var(--surface-raised))" strokeWidth={2}>
                <title>{`${formatClock(p.t)} 存在失败采样`}</title>
              </circle>
              {i === hover || series.points.filter((q) => q.status !== 'up').length <= 3 ? (
                <text x={Math.min(sx(p.t) + 8, W - PAD.right - 90)} y={Math.max(sy(p.ms) - 8, PAD.top + 10)} fontSize={11} fontWeight={600} fill="hsl(var(--destructive))" fontFamily="ui-monospace, monospace">
                  {formatLatency(p.ms)} · 有失败
                </text>
              ) : null}
            </g>
          ) : (i === hover ? <circle key={p.t} cx={sx(p.t)} cy={sy(p.ms)} r={4} fill="hsl(var(--primary-ink))" stroke="hsl(var(--surface-raised))" strokeWidth={2} /> : null)
        ))}
        {active ? (
          <line x1={sx(active.t)} x2={sx(active.t)} y1={PAD.top} y2={PAD.top + plotH} stroke="hsl(var(--hairline-strong))" strokeDasharray="3 3" />
        ) : null}
        <text x={PAD.left} y={H - 6} fontSize={11} fontWeight={600} fill="hsl(var(--foreground))" fontFamily="ui-monospace, monospace">{formatAxisTime(x0, range)}</text>
        <text x={W - PAD.right} y={H - 6} textAnchor="end" fontSize={11} fontWeight={600} fill="hsl(var(--foreground))" fontFamily="ui-monospace, monospace">{formatAxisTime(x1, range)}</text>
      </svg>
    </div>
  );
}
