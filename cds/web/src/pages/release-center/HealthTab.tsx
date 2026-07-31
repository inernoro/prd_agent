/**
 * 健康监测页签：这个环境到底健不健康，以及这个结论是怎么来的。
 *
 * 「没开监控」和「监控说它挂了」是两件完全不同的事，必须在文案上分开——
 * 把未监测显示成 0% 可用率，是一个凭空编造且与事实相反的结论。
 */

import { ExternalLink } from 'lucide-react';
import { formatAgo } from '@/lib/releaseRail';
import {
  Chip,
  InfoBlock,
  formatAvailability,
  formatDateTime,
  formatResponseTime,
  healthLabel,
  healthTone,
} from './shared';
import type { CenterRow } from './types';

export function HealthTab({ row, nowMs }: { row: CenterRow; nowMs: number }): JSX.Element {
  const health = row.health;
  const monitored = typeof health?.sampleCount24h === 'number' && health.sampleCount24h > 0;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section className="cds-surface-raised cds-hairline rounded-lg p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">当前状态</h3>
          <Chip tone={healthTone(row.healthStatus)}>{healthLabel(row.healthStatus)}</Chip>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <InfoBlock label="探测地址">
            {health?.url ? (
              <a href={health.url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 text-primary hover:underline">
                <span className="truncate font-mono text-xs">{health.url}</span>
                <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              </a>
            ) : '未配置'}
          </InfoBlock>
          <InfoBlock label="响应时间">{formatResponseTime(health?.responseTimeMs)}</InfoBlock>
          <InfoBlock label="最近检查">
            {health?.checkedAt ? `${formatDateTime(health.checkedAt)}（${formatAgo(health.checkedAt, nowMs)}）` : '未检查过'}
          </InfoBlock>
          <InfoBlock label="近 24 小时可用率">{formatAvailability(health?.availability24h)}</InfoBlock>
          <InfoBlock label="近 24 小时探测">
            {monitored ? `${health?.upCount24h ?? 0}/${health?.sampleCount24h} 次通过` : '未监测'}
          </InfoBlock>
          <InfoBlock label="近 24 小时平均延迟">{formatResponseTime(health?.avgLatencyMs24h)}</InfoBlock>
        </div>
        {health?.status === 'failed' && health.message ? (
          <div className="mt-3 rounded-md border border-red-500/35 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
            {health.message}
          </div>
        ) : null}
      </section>

      <section className="cds-surface-raised cds-hairline rounded-lg p-4">
        <h3 className="text-sm font-semibold">这个结论是怎么来的</h3>
        <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">
          发布中心读的是存活监控留下的快照，打开这一页**不会**对生产发起探测——
          否则每次打开发布中心都会按环境数放大成一串对生产的外呼。
          {monitored
            ? ' 近 24 小时的可用率与平均延迟来自同一份探测样本。'
            : ' 当前这个目标还没有累积到探测样本，所以可用率一栏显示「未监测」而不是 0%。'}
        </p>
      </section>
    </div>
  );
}
