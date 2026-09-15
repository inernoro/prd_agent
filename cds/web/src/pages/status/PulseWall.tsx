/*
 * 脉搏墙 —— 「我盯的业务」的第二种排布。
 *
 * 卡片回答「这条业务怎么样」，脉搏墙回答另一个问题：**这一屏到底还是不是活的**。
 * 一行一条心跳线，线高是那一段的平均响应耗时（数据来自监控摘要里已有的 buckets，
 * 不额外发请求）。
 *
 * 这张图的全部价值在一条判据上：**没有采样的那一段真的断开。**
 * 把空桶补成 0 会让一段没人检查的时间渲染成一条贴着地板的、看起来很健康的线——
 * 那正是这条链要治的病的图形版本。判据在 lib/pulseWall.ts，这里只负责画。
 *
 * 底部那条节拍线是「他干活了吗」的第二个答案：光点扫完全宽 = 一轮探测。
 * 探测器停摆时它停住并转灰，整墙同时挂上停摆说明——静止本身就是证据。
 */
import { useMemo } from 'react';
import { Activity, ArrowRight, Waves } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatDuration, formatRelative } from '@/lib/monitorCenter';
import { PULSE_GEOMETRY, buildPulse, describePulse, expectedSamples, hasPulseInk } from '@/lib/pulseWall';
import { ENVIRONMENT_SHORT, shortPredicate, type BusinessRow, type CellHealth } from '@/lib/ownerBoard';

const LINE: Record<CellHealth, string> = {
  down: 'hsl(var(--bad))',
  overdue: 'hsl(var(--warn))',
  stale: 'hsl(var(--warn))',
  unknown: 'hsl(var(--muted-foreground))',
  up: 'hsl(var(--ok))',
};

const DOT: Record<CellHealth, string> = {
  down: 'bg-bad',
  overdue: 'bg-warn',
  stale: 'bg-warn',
  unknown: 'bg-[hsl(var(--hairline-strong))]',
  up: 'bg-ok',
};

function PulseRow({
  row,
  now,
  stalled,
  onOpen,
}: {
  row: BusinessRow;
  now: number;
  stalled: boolean;
  onOpen: (targetId: string) => void;
}): JSX.Element {
  // 多环境的行取最差那一格画线：出问题时要看的是不对的那条，不是随便一条。
  const cell = row.cells.find((c) => c.health === row.worst) ?? row.cells[0];
  const pulse = useMemo(() => buildPulse(cell?.buckets ?? []), [cell?.buckets]);
  // 「点这么少正不正常」只有跟它自己的间隔比才知道 —— 6 小时探一次的监控在 24 小时里
  // 本来就只有四个点，那不是断线。
  const expected = expectedSamples(cell?.intervalSeconds, 24 * 3600 * 1000, pulse.total);
  const everyLabel = cell?.intervalSeconds ? `每 ${formatDuration(cell.intervalSeconds * 1000)}` : '';
  const ModeIcon = row.observeMode === 'passive' ? Waves : ArrowRight;
  const stroke = LINE[row.worst];

  return (
    <button
      type="button"
      onClick={() => onOpen(cell?.targetId ?? '')}
      className="grid w-full grid-cols-[minmax(0,1fr)] items-center gap-2 border-b border-[hsl(var(--hairline))] px-4 py-2.5 text-left transition-colors last:border-b-0 hover:bg-[hsl(var(--surface-sunken))] lg:grid-cols-[15rem_minmax(0,1fr)_9.5rem]"
    >
      <div className="flex min-w-0 flex-col gap-0.5 lg:pr-4">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', DOT[row.worst])} />
          <ModeIcon className={cn('h-3 w-3 shrink-0', row.observeMode === 'passive' ? 'text-info' : 'text-primary-ink')} />
          <span className="truncate text-[0.8125rem] font-medium">{row.name}</span>
          <div className="ml-auto flex shrink-0 gap-0.5">
            {row.cells.map((c) => (
              <span key={c.targetId} className="rounded border border-[hsl(var(--hairline))] px-1 font-mono text-[0.625rem] leading-4 text-muted-foreground">
                {ENVIRONMENT_SHORT[c.environment]}
              </span>
            ))}
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-[0.625rem] text-muted-foreground">
            {row.probe ? shortPredicate(row.probe) : '没有写判据'}
          </span>
          {/* 间隔摆在这里，四个孤立点才读得懂：它不是断线，是它本来就隔这么久查一次 */}
          {everyLabel ? (
            <span className="shrink-0 rounded border border-[hsl(var(--hairline))] px-1 font-mono text-[0.625rem] leading-4 text-muted-foreground">
              {everyLabel}
            </span>
          ) : null}
        </div>
      </div>

      <div className="relative h-11">
        {hasPulseInk(pulse) ? (
          <svg
            viewBox={`0 0 ${PULSE_GEOMETRY.width} ${PULSE_GEOMETRY.height}`}
            preserveAspectRatio="none"
            className="block h-11 w-full"
            role="img"
            aria-label={`${row.name} 近 24 小时响应耗时`}
          >
            <line
              x1="0" y1={PULSE_GEOMETRY.height - PULSE_GEOMETRY.pad}
              x2={PULSE_GEOMETRY.width} y2={PULSE_GEOMETRY.height - PULSE_GEOMETRY.pad}
              stroke="hsl(var(--hairline))" strokeWidth="1"
            />
            {/* 分段画：中间断开的地方不连线，也不补 0 —— 缺口就是证据 */}
            {pulse.segments.map((points, i) => (
              <polyline
                key={i}
                points={points}
                fill="none"
                stroke={stroke}
                strokeWidth="1.4"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {/* 孤立样本画成点。6 小时探一次的监控在 24 小时里只有四个样本，全是孤立点；
                因为「连不成线」就丢掉它们，整行会凭空消失，看起来像这条监控不存在。 */}
            {pulse.dots.map((d, i) => (
              <circle key={`d${i}`} cx={d.x} cy={d.y} r="1.8" fill={d.down ? 'hsl(var(--bad))' : stroke} vectorEffect="non-scaling-stroke" />
            ))}
            {pulse.downs.map((d, i) => (
              <circle key={i} cx={d.x} cy={d.y} r="1.6" fill="hsl(var(--bad))" vectorEffect="non-scaling-stroke" />
            ))}
          </svg>
        ) : (
          <div className="flex h-11 items-center">
            <span className="font-mono text-[0.625rem] text-muted-foreground">{describePulse(pulse, expected)}</span>
          </div>
        )}
        {/* 只有「真的漏过」才出话。以前不管三七二十一都盖一句「线是断的」，
            对 6 小时探一次的监控纯属冤枉——它一次没漏。 */}
        {hasPulseInk(pulse) && typeof expected === 'number' && pulse.filled < expected * 0.6 ? (
          <span className="pointer-events-none absolute right-0 top-0 rounded bg-warn-soft px-1 font-mono text-[0.625rem] text-warn">
            {describePulse(pulse, expected)}
          </span>
        ) : null}
        {/* 节拍点：探测器在跑时它跳，停摆时它不跳也不亮 */}
        <span
          aria-hidden
          className={cn(
            'absolute right-0 top-1/2 h-1.5 w-1.5 -translate-y-1/2 translate-x-1 rounded-full',
            stalled ? 'bg-[hsl(var(--hairline-strong))]' : cn(DOT[row.worst], 'animate-pulse'),
          )}
        />
      </div>

      <div className="flex items-center justify-between gap-2 lg:flex-col lg:items-end lg:justify-center lg:gap-0.5">
        <span className="font-mono text-[0.8125rem] leading-5">
          {cell?.availability24h === null || cell?.availability24h === undefined
            ? <span className="text-muted-foreground">—</span>
            : `${(cell.availability24h * 100).toFixed(cell.availability24h >= 0.9995 ? 0 : 2)}%`}
        </span>
        <span className="font-mono text-[0.625rem] text-muted-foreground">
          {typeof cell?.lastProbeAt === 'number' ? formatRelative(Math.min(cell.lastProbeAt, now), now) : '还没检查过'}
        </span>
      </div>
    </button>
  );
}

export function PulseWall({
  rows,
  now,
  prober,
  intervalSeconds,
  onOpen,
}: {
  rows: ReadonlyArray<BusinessRow>;
  now: number;
  /** 拿不到就传 null。**不许兜一个 stalled:false** —— 那等于探测器一挂就替它撒谎。 */
  prober: { stalled: boolean; lastCycleAt: number | null } | null;
  /** 一轮探测的间隔，用来说「多久扫一遍」。拿不到就不说。 */
  intervalSeconds?: number;
  onOpen: (targetId: string) => void;
}): JSX.Element {
  const stalled = Boolean(prober?.stalled);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))]">
      <div className="grid shrink-0 grid-cols-[minmax(0,1fr)] gap-2 border-b border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-4 py-2 lg:grid-cols-[15rem_minmax(0,1fr)_9.5rem]">
        <span className="font-mono text-[0.625rem] tracking-widest text-muted-foreground">业务 / 判据</span>
        <span className="hidden font-mono text-[0.625rem] tracking-widest text-muted-foreground lg:block">
          近 24 小时 · 线高 = 响应耗时 · 断开 = 那一段没有采样
        </span>
        <span className="hidden text-right font-mono text-[0.625rem] tracking-widest text-muted-foreground lg:block">可用率 · 上次检查</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.map((row) => (
          <PulseRow key={row.key} row={row} now={now} stalled={stalled} onOpen={onOpen} />
        ))}
      </div>

      {/* 节拍条。它是「他干活了吗」的第二个答案：停摆时整条转灰并直说。 */}
      <div className={cn(
        'flex shrink-0 items-center gap-2 border-t px-4 py-2',
        stalled ? 'border-bad/40 bg-bad-soft' : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]',
      )}>
        <Activity className={cn('h-3 w-3 shrink-0', stalled ? 'text-bad' : 'animate-pulse text-primary-ink')} />
        {stalled ? (
          <span className="text-[0.6875rem] text-bad">
            探测器停摆
            {prober?.lastCycleAt ? `，上一轮在 ${formatRelative(prober.lastCycleAt, now)}` : '，一轮都没跑完'}
            {' '}—— 上面这些线全是旧闻，画得再好看也不代表业务现在还能用
          </span>
        ) : (
          <span className="text-[0.6875rem] text-muted-foreground">
            探测器在跑
            {prober?.lastCycleAt ? `，上一轮 ${formatRelative(prober.lastCycleAt, now)}` : ''}
            {intervalSeconds ? ` · 每 ${formatDuration(intervalSeconds * 1000)}扫一遍` : ''}
            {' '}—— 线在动就是它还在干活
          </span>
        )}
      </div>
    </div>
  );
}
